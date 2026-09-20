// Inventory domain service (spec §33/§35) — F-PROCURE implements the real
// business rules. Signatures below are the contract the dispatcher expects:
// every function is atomic with its StockMovement append and returns a
// { inventoryItemId, movement, closingQty } result shape.
//
// DB-2 hardening: every write path runs in ONE db.$transaction (the wallet /
// ledger house pattern — guards INSIDE the transaction, not before it);
// consume/transfer project the closing balance from the movements that
// already exist BEFORE persisting, so over-consumption throws without
// leaving a row; transfers write their out+in legs as one atomic unit; and
// every result reports the REAL derived closingQty (return/damage/adjust
// used to hardcode 0). #147 closes the one write path that had escaped this
// discipline: updateQuote's header edit + deleteMany/recreate line rewrite
// is one transaction too — a mid-rewrite failure can no longer leave a
// quote with a partial (or empty) line set.
//
// Input validation (#210): the movement ledger is the single source of truth
// for stock (nothing is stored), so a bad quantity poisons every derived
// number downstream with no error at write time. Every action therefore
// parses its qty through parseMovementQty at the top of its transaction —
// same fail-closed posture as receiveDelivery's moneyNumber checks: finite
// number, > 0 for the six unsigned types, finite non-zero for adjust (signed
// by design), inside sane bounds. unitCost (where accepted) is KSh at the
// payload boundary, parsed to integer cents via parseUnitCost (#282).

import { db } from '@/backend/lib/db'
import { MAX_MONEY_KES, nonNegativeKesToCents, parseNonNegativeMoneyCents, type Cents } from '@/backend/lib/money'
import type { TxClient } from '@/backend/modules/ledger/service'
import { notify } from '@/backend/modules/notify/service'
import { derivedClosingQty } from './repository'
import { isLowStock, movementInflowQty } from './low-stock'

export interface MovementResult {
  inventoryItemId: string
  materialName: string
  unit: string
  movementId: string
  type: string
  quantity: number
  closingQty: number
  /** #207: this movement flipped the item from not-low to low (the notify
   * trigger — reported so callers/tests can see the crossing, not just the
   * notification it fired). */
  lowStockCrossing: boolean
}

/** Sanity cap per movement (#210): finite ≠ sensible — a qty above this is a
 * unit mistake (grams vs bags), not stock. Generous enough for bulk sites. */
const MAX_MOVEMENT_QTY = 1_000_000_000

/**
 * Parse + validate a movement quantity at the service boundary (#210).
 * Numeric strings coerce (moneyNumber semantics — the offline outbox replays
 * JSON where qty is a number, but being strict about typeof would reject
 * honest replays); anything non-finite, non-positive (unsigned types), zero
 * (adjust), or absurd throws BEFORE any row is written.
 */
function parseMovementQty(action: string, raw: unknown, opts: { signed?: boolean } = {}): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${action}: qty must be a finite number (got ${typeof raw === 'string' ? `"${raw}"` : String(raw)})`)
  }
  if (opts.signed) {
    if (n === 0) throw new Error(`${action}: qty cannot be zero — adjust up with a positive number, down with a negative one`)
  } else if (n <= 0) {
    throw new Error(`${action}: qty must be greater than zero`)
  }
  if (Math.abs(n) > MAX_MOVEMENT_QTY) {
    throw new Error(`${action}: qty ${n} exceeds the per-movement cap of ${MAX_MOVEMENT_QTY.toLocaleString('en-US')} — check the unit (bags, tonnes…), not the digits`)
  }
  return n
}

/**
 * Optional unit cost (#210, #282) — THE KSh→cents boundary for
 * StockMovement.unitCost. The action payload carries KSh (the frontend
 * contract is "Unit cost (KSh)"; the offline outbox replays the same JSON),
 * and the BigInt column stores integer cents — the ledger-never-lies
 * convention (money.ts): KSh exists ONLY at this boundary and at the
 * loadInventorySlice read boundary (centsToKes). Absent/null/'' → null
 * (no cost recorded); present → non-negative, ≤ MAX_MONEY_KES, at most 2
 * decimal places (parseNonNegativeMoneyCents — a cost is money, never
 * negative, and sub-KSh precision is exactly 2 dp).
 */
function parseUnitCost(action: string, raw: unknown): Cents | null {
  if (raw === undefined || raw === null || raw === '') return null
  const cents = parseNonNegativeMoneyCents(raw)
  if (cents === null) {
    throw new Error(
      `${action}: unitCost must be a non-negative KSh amount of at most ${MAX_MONEY_KES.toLocaleString('en-US')} with no more than 2 decimal places (got ${typeof raw === 'string' ? `"${raw}"` : String(raw)})`,
    )
  }
  return cents
}

/**
 * Optional per-item reorder level (#207) — the explicit low-stock threshold.
 * Absent/nullish → undefined = "not provided": the item's stored level is
 * LEFT ALONE on upsert-update (and is null on create). Present → finite,
 * ≥ 0 (0 = "alert only at stockout" — a legitimate setting), within the
 * same sanity cap as quantities. Same coercion posture as parseMovementQty
 * (numeric strings accepted — honest outbox replays).
 */
function parseReorderLevel(action: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${action}: reorderLevel must be zero or more (got ${typeof raw === 'string' ? `"${raw}"` : String(raw)})`)
  }
  if (n > MAX_MOVEMENT_QTY) {
    throw new Error(`${action}: reorderLevel ${n} exceeds the cap of ${MAX_MOVEMENT_QTY.toLocaleString('en-US')} — check the unit (bags, tonnes…), not the digits`)
  }
  return n
}

/**
 * #207: did appending `movement` flip the item INTO low stock? Pure — the
 * same ONE rule as the slice loader (low-stock.ts) evaluated over the
 * movement log before and after the append. A crossing (and only a
 * crossing: already-low items staying low never re-notify, and recovering
 * out of low is not an event) is the notify trigger — one notification per
 * crossing, never per read.
 */
function crossedIntoLowStock(
  item: { reorderLevel: number | null },
  movementsBefore: readonly { type: string; quantity: number }[],
  movement: { type: string; quantity: number },
): boolean {
  // An empty log is not a stock state — it is the item being BORN. Its
  // first movement landing at/below the threshold (only an explicit
  // reorderLevel can do it; the derived default cannot fire when closing
  // equals inflow) is an honest first crossing, so "before" is not-low.
  const before = movementsBefore.length > 0 && lowOf(movementsBefore, item.reorderLevel)
  const after = lowOf(movementsBefore.concat([movement]), item.reorderLevel)
  return !before && after
}

/** The ONE rule (low-stock.ts) over a movement log + threshold. */
function lowOf(
  movements: readonly { type: string; quantity: number }[],
  reorderLevel: number | null,
): boolean {
  return isLowStock({
    closingQty: derivedClosingQty(movements),
    inflowQty: movementInflowQty(movements),
    reorderLevel,
  })
}

/**
 * Fire the low-stock notification AFTER the movement transaction committed —
 * a notification must never be emitted for a rolled-back write, and never
 * fail an already-committed one (belt-and-braces catch; notify() itself
 * never throws into the channel seam). Audience: the roles that reorder
 * (contractor — the notify seam's audienceRole), kind 'stock.low'.
 */
async function notifyLowStockCrossing(
  projectId: string,
  r: { materialName: string; unit: string; closingQty: number; lowStockCrossing?: boolean },
): Promise<void> {
  if (!r.lowStockCrossing) return
  try {
    await notify(
      projectId,
      `Low stock: ${r.materialName}`,
      `${r.materialName} is down to ${r.closingQty.toLocaleString('en-US')} ${r.unit} — at or below the low-stock threshold. Reorder before the next pour.`,
      { kind: 'stock.low', audienceRole: 'contractor' },
    )
  } catch {
    // never fail a committed movement over a notification
  }
}

async function upsertItem(
  tx: TxClient,
  projectId: string,
  materialName: string,
  unit: string,
  location: string,
  supplierId?: string | null,
  reorderLevel?: number,
) {
  // DB-9 (issue #127, ADR 0010): supplierId is a soft FK — validate it at this
  // ONE write seam (open/receive/transfer all flow through here) instead of
  // leaving dangling ids for readers. Suppliers have no delete path anywhere
  // in the app, so a miss here is caller garbage, not a deletion race. Empty
  // string normalizes to "no link" (it used to be stored as '' — a dangling-
  // shaped value nothing could render).
  const sid = supplierId ? String(supplierId) : null
  if (sid) {
    const supplier = await tx.supplier.findUnique({ where: { id: sid } })
    if (!supplier) throw new Error(`Supplier not found: ${sid}`)
  }
  return tx.inventoryItem.upsert({
    where: { projectId_materialName_location: { projectId, materialName, location } },
    // reorderLevel: undefined = payload didn't mention it → keep the stored
    // level; a number = set it (#207 — the upsert is the one existing seam
    // through which an operator can configure the threshold).
    update: { unit, supplierId: sid ?? undefined, ...(reorderLevel !== undefined ? { reorderLevel } : {}) },
    create: { projectId, materialName, unit, location, supplierId: sid, reorderLevel: reorderLevel ?? null },
    include: { movements: true },
  })
}

async function appendMovement(
  tx: TxClient,
  projectId: string,
  inventoryItemId: string,
  type: string,
  quantity: number,
  unitCost: Cents | null, // integer cents (#282) — converted at parseUnitCost, never a KSh number
  reference: string | null,
  note: string | null,
  recordedBy: string,
) {
  return tx.stockMovement.create({
    data: { projectId, inventoryItemId, type, quantity, unitCost, reference, note, recordedBy },
  })
}

/** Item scoped to the project, WITH its movement log, inside a transaction. */
async function findItem(tx: TxClient, projectId: string, inventoryItemId: string) {
  const item = await tx.inventoryItem.findFirst({ where: { id: inventoryItemId, projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  return item
}

export async function openStock(projectId: string, p: any): Promise<MovementResult> {
  const result = await db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.open', p.qty)
    const unitCost = parseUnitCost('inventory.open', p.unitCost)
    const reorderLevel = parseReorderLevel('inventory.open', p.reorderLevel)
    const item = await upsertItem(tx, projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null, reorderLevel)
    const movement = await appendMovement(tx, projectId, item.id, 'opening', qty, unitCost, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return {
      inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing,
      // #207: a brand-new line opened below its own reorder point is low
      // from birth — an honest crossing, not noise.
      lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
    }
  })
  await notifyLowStockCrossing(projectId, result)
  return result
}

export async function receiveStock(projectId: string, p: any): Promise<MovementResult> {
  const result = await db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.receive', p.qty)
    const unitCost = parseUnitCost('inventory.receive', p.unitCost)
    const reorderLevel = parseReorderLevel('inventory.receive', p.reorderLevel)
    const item = await upsertItem(tx, projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null, reorderLevel)
    const movement = await appendMovement(tx, projectId, item.id, 'received', qty, unitCost, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return {
      inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing,
      // #207: receiving normally lifts stock OUT of low — but a delivery
      // that still leaves the item at/below its threshold is a crossing
      // when it started not-low (e.g. a first delivery under the level).
      lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
    }
  })
  await notifyLowStockCrossing(projectId, result)
  return result
}

export async function consumeStock(projectId: string, p: any): Promise<MovementResult> {
  const result = await db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.consume', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    // DB-2: project the closing balance from the movements that ALREADY exist
    // before touching the database — over-consumption must throw without
    // persisting a row (the old code appended first and only then checked).
    if (derivedClosingQty(item.movements) - qty < 0) {
      throw new Error('Cannot consume more than closing stock')
    }
    const movement = await appendMovement(tx, projectId, item.id, 'consumed', qty, null, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return {
      inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing,
      lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
    }
  })
  await notifyLowStockCrossing(projectId, result)
  return result
}

export async function transferStock(projectId: string, p: any): Promise<any> {
  // DB-2: the out and in legs are ONE atomic unit — the old code wrote them
  // back-to-back with no transaction, so a failure between them stranded the
  // "out" half and silently lost stock. The out leg is guarded by the same
  // negative-stock projection as consume.
  const result = await db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.transfer', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    if (derivedClosingQty(item.movements) - qty < 0) {
      throw new Error('Cannot transfer more than closing stock')
    }
    const out = await appendMovement(tx, projectId, item.id, 'transferred_out', qty, null, null, `→ ${p.toLocation}: ${p.note ?? ''}`, p.recordedBy ?? 'Site Manager')
    // The destination carries the source's reorder point when it is new —
    // the threshold belongs to the material, and a transfer should not
    // silently drop it. An existing destination keeps its own level
    // (undefined = leave alone).
    const to = await upsertItem(tx, projectId, item.materialName, item.unit, String(p.toLocation), item.supplierId, item.reorderLevel ?? undefined)
    const into = await appendMovement(tx, projectId, to.id, 'transferred_in', qty, null, null, `← ${item.location}`, p.recordedBy ?? 'Site Manager')
    return {
      from: {
        inventoryItemId: item.id, movementId: out.id,
        materialName: item.materialName, unit: item.unit, type: out.type, quantity: out.quantity,
        closingQty: derivedClosingQty(item.movements.concat([out])),
        lowStockCrossing: crossedIntoLowStock(item, item.movements, out),
      },
      to: {
        inventoryItemId: to.id, movementId: into.id,
        materialName: to.materialName, unit: to.unit, type: into.type, quantity: into.quantity,
        closingQty: derivedClosingQty(to.movements.concat([into])),
        lowStockCrossing: crossedIntoLowStock(to, to.movements, into),
      },
    }
  })
  // Both legs are checked: the source can cross DOWN (stock left behind
  // under the threshold), the destination can arrive still under its own.
  await notifyLowStockCrossing(projectId, result.from)
  await notifyLowStockCrossing(projectId, result.to)
  return result
}

export async function returnStock(projectId: string, p: any): Promise<MovementResult> {
  const result = await db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.return', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'returned', qty, null, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return {
      inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing,
      lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
    }
  })
  await notifyLowStockCrossing(projectId, result)
  return result
}

export async function damageStock(projectId: string, p: any): Promise<MovementResult> {
  const result = await db.$transaction(async (tx) => {
    const qty = parseMovementQty('inventory.damage', p.qty)
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'damaged', qty, null, null, String(p.damageNote ?? 'damaged'), p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return {
      inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing,
      lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
    }
  })
  await notifyLowStockCrossing(projectId, result)
  return result
}

export async function adjustStock(projectId: string, p: any): Promise<MovementResult> {
  const result = await db.$transaction(async (tx) => {
    // Signed by design: negative adjusts down, positive adjusts up — zero is
    // a no-op that would only pollute the ledger.
    const qty = parseMovementQty('inventory.adjust', p.qty, { signed: true })
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'adjusted', qty, null, null, String(p.reason ?? 'count correction'), p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return {
      inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing,
      lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
    }
  })
  await notifyLowStockCrossing(projectId, result)
  return result
}

// ---- Stock reconciliation (issue #194) ---------------------------------------
// The count → variance → count-linked adjustment loop. Design invariants:
//
//   · EXPECTED IS A SNAPSHOT. expectedQty is the derived closing AS OF the
//     count's countedAt (movements with createdAt ≤ countedAt). A count
//     recorded offline and flushed hours later still snapshots the world the
//     site actually saw when the bags were counted — movements logged in
//     between are excluded.
//   · VARIANCE HAS ONE DEFINITION. variance = expected − counted (>0: the
//     book overstates physical stock). It is computed on read
//     (repository.countVariance), never stored — the same discipline as
//     movementDelta.
//   · THE LEDGER NEVER EDITS HISTORY. Posting from a count APPENDS one
//     `adjusted` movement per non-zero-variance line (qty = counted −
//     expected, the negation of variance — the ledger moves TOWARD the
//     count) and then flips the count row open → posted. No existing
//     StockMovement row is ever touched.
//   · POSTING IS IDEMPOTENT-BY-REFUSAL. A count whose status is already
//     'posted' refuses with an honest error instead of double-adjusting.
//     (The offline outbox's §57 idem key already stops the same queued item
//     from applying twice; this guard is the second, payload-level lock.)
//   · ADJUSTMENTS ARE RELATIVE TO THE SNAPSHOT. Movements recorded between
//     the count and the post stay in the ledger on top of the adjustment —
//     the post-count closing is expected + adjustment + everything since,
//     and the audit trail says exactly why.

/** Movement-ledger reference convention for count-linked adjustments (lineage). */
export function countReference(countId: string): string {
  return `count:${countId}`
}

/** One counted line as dispatched (offline payload shape — raw numbers). */
interface CountLineInput {
  inventoryItemId: string
  countedQty: number
}

/** Validate + normalise one counted line: finite, ≥ 0 (a count can find zero), sane cap. */
function parseCountedQty(line: { inventoryItemId?: unknown; countedQty?: unknown }): CountLineInput {
  const id = String(line.inventoryItemId ?? '')
  if (!id) throw new Error('inventory.count: every counted line needs an inventoryItemId')
  const qty = Number(line.countedQty)
  if (!Number.isFinite(qty) || qty < 0) {
    throw new Error(`inventory.count: countedQty must be zero or more (got ${typeof line.countedQty === 'string' ? `"${line.countedQty}"` : String(line.countedQty)})`)
  }
  if (qty > MAX_MOVEMENT_QTY) {
    throw new Error(`inventory.count: countedQty ${qty} exceeds the cap of ${MAX_MOVEMENT_QTY.toLocaleString('en-US')} — check the unit (bags, tonnes…), not the digits`)
  }
  return { inventoryItemId: id, countedQty: qty }
}

export interface RecordCountResult {
  countId: string
  countedBy: string
  countedAt: string
  itemCount: number
  variances: Array<{
    inventoryItemId: string
    materialName: string
    unit: string
    expectedQty: number
    countedQty: number
    variance: number
  }>
}

/**
 * Record a physical stock count session (inventory.count): one StockCount
 * row + one StockCountItem per counted line, with the expected snapshot
 * pinned at countedAt. Atomic — a bad line writes nothing.
 */
export async function recordStockCount(projectId: string, p: any): Promise<RecordCountResult> {
  return db.$transaction(async (tx) => {
    const countedBy = String(p.countedBy ?? '').trim()
    if (!countedBy) {
      throw new Error('inventory.count: countedBy is required — record who ran the physical count')
    }
    const rawCounts = Array.isArray(p.counts) ? p.counts : []
    if (rawCounts.length === 0) {
      throw new Error('inventory.count: at least one counted line is required — an empty session records nothing')
    }
    const countedAt = p.countedAt ? new Date(p.countedAt) : new Date()
    if (Number.isNaN(countedAt.getTime())) {
      throw new Error('inventory.count: countedAt must be a valid date')
    }

    // Validate + dedupe every line BEFORE any write (the DB unique
    // (countId, inventoryItemId) is the second lock, not the first).
    const lines = new Map<string, number>()
    for (const raw of rawCounts) {
      const line = parseCountedQty(raw ?? {})
      if (lines.has(line.inventoryItemId)) {
        throw new Error(`inventory.count: inventory item ${line.inventoryItemId} is counted twice in one session`)
      }
      lines.set(line.inventoryItemId, line.countedQty)
    }

    // Project-scoped read of every counted item WITH its movement log — the
    // snapshot is derived from exactly these rows.
    const items = await tx.inventoryItem.findMany({
      where: { projectId, id: { in: [...lines.keys()] } },
      include: { movements: true },
    })
    if (items.length !== lines.size) {
      throw new Error('inventory.count: one or more inventory items were not found in this project')
    }

    const count = await tx.stockCount.create({
      data: {
        projectId,
        countedBy,
        countedAt,
        note: p.note ? String(p.note) : null,
        status: 'open',
      },
    })

    const variances: RecordCountResult['variances'] = []
    for (const item of items) {
      const countedQty = lines.get(item.id)!
      // THE SNAPSHOT: derived closing as of countedAt (append-only log →
      // history is queryable; later movements cannot rewrite it).
      const expectedQty = derivedClosingQty(
        item.movements.filter((m) => m.createdAt <= countedAt),
      )
      await tx.stockCountItem.create({
        data: { countId: count.id, inventoryItemId: item.id, countedQty, expectedQty },
      })
      variances.push({
        inventoryItemId: item.id,
        materialName: item.materialName,
        unit: item.unit,
        expectedQty,
        countedQty,
        variance: expectedQty - countedQty,
      })
    }

    return {
      countId: count.id,
      countedBy,
      countedAt: countedAt.toISOString(),
      itemCount: items.length,
      variances,
    }
  })
}

export interface PostCountResult {
  countId: string
  postedAt: string
  postedBy: string
  movements: Array<{
    inventoryItemId: string
    materialName: string
    unit: string
    movementId: string | null
    adjustment: number
    closingQty: number
    /** #207: this posted line flipped the item into low stock. */
    lowStockCrossing: boolean
  }>
}

/**
 * Post the count-linked adjustments for a recorded count
 * (inventory.count.post): append one `adjusted` StockMovement per
 * non-zero-variance line (reference 'count:<countId>' — the auditable
 * lineage), stamp each line's postedQty, then flip the count open → posted.
 * Refuses an already-posted count (idempotent-by-refusal). NEVER edits an
 * existing movement row.
 */
export async function postCountAdjustments(projectId: string, p: any): Promise<PostCountResult> {
  const result = await db.$transaction(async (tx) => {
    const countId = String(p.countId ?? '')
    if (!countId) throw new Error('inventory.count.post: countId is required')
    const postedBy = String(p.postedBy ?? p.recordedBy ?? 'Site Manager')

    // Project-scoped fetch with the counted lines and their items' movement logs.
    const count = await tx.stockCount.findFirst({
      where: { id: countId, projectId },
      include: { items: { include: { inventoryItem: { include: { movements: true } } } } },
    })
    if (!count) throw new Error('Stock count not found')
    if (count.status === 'posted') {
      throw new Error(
        `Stock count ${countId} is already posted${count.postedAt ? ` (${count.postedAt.toISOString()})` : ''} — posting twice would double-adjust. Record a new count instead.`,
      )
    }
    if (count.items.length === 0) {
      throw new Error(`Stock count ${countId} has no counted lines — nothing to post`)
    }

    const reference = countReference(count.id)
    const note = `stock count ${count.id.slice(-6)} by ${count.countedBy}`
    const movements: PostCountResult['movements'] = []
    for (const line of count.items) {
      // One definition, negated: the adjustment moves the ledger TOWARD the
      // count (counted − expected). Zero-variance lines post NO movement.
      const adjustment = line.countedQty - line.expectedQty
      const item = line.inventoryItem
      if (adjustment === 0) {
        await tx.stockCountItem.update({ where: { id: line.id }, data: { postedQty: 0 } })
        movements.push({
          inventoryItemId: line.inventoryItemId,
          materialName: item.materialName,
          unit: item.unit,
          movementId: null,
          adjustment: 0,
          closingQty: derivedClosingQty(item.movements),
          lowStockCrossing: false, // no movement appended — nothing could cross
        })
        continue
      }
      const movement = await appendMovement(
        tx,
        projectId,
        line.inventoryItemId,
        'adjusted',
        adjustment,
        null,
        reference,
        `${note}: expected ${line.expectedQty}, counted ${line.countedQty}`,
        postedBy,
      )
      await tx.stockCountItem.update({ where: { id: line.id }, data: { postedQty: adjustment } })
      movements.push({
        inventoryItemId: line.inventoryItemId,
        materialName: item.materialName,
        unit: item.unit,
        movementId: movement.id,
        adjustment,
        closingQty: derivedClosingQty(item.movements.concat([movement])),
        lowStockCrossing: crossedIntoLowStock(item, item.movements, movement),
      })
    }

    const postedAt = new Date()
    await tx.stockCount.update({
      where: { id: count.id },
      data: { status: 'posted', postedAt, postedBy },
    })

    return { countId: count.id, postedAt: postedAt.toISOString(), postedBy, movements }
  })
  // #207: a count that finds less than the book expected can cross an item
  // INTO low — notify after the post committed, once per crossing line.
  for (const m of result.movements) {
    await notifyLowStockCrossing(projectId, m)
  }
  return result
}

// ---- BOQ ----

// #285 (twin of #282, different column): BoqLine.estUnitPrice is integer
// CENTS end-to-end. The action payload contract stays KSh (the boq-card
// price input — "Est. KSh/u"), so BOTH writers convert at this boundary
// through nonNegativeKesToCents (nullish/empty → 0n, >2-dp/negative/garbage
// refused with the shared honest error). Readers (loadBoqSlice, the intel
// BOQ estimate, jobs) already assume cents and stay untouched.

export async function createBoq(projectId: string, p: any) {
  const count = await db.boq.count({ where: { projectId } })
  const boq = await db.boq.create({
    data: { projectId, name: String(p.name ?? `BOQ v${count + 1}`), version: count + 1 },
  })
  if (Array.isArray(p.lines)) {
    for (const l of p.lines) {
      await db.boqLine.create({
        data: {
          boqId: boq.id,
          materialName: String(l.materialName),
          unit: String(l.unit ?? 'unit'),
          qty: Number(l.qty ?? 1),
          // #285: KSh in the payload → integer cents in the column.
          estUnitPrice: nonNegativeKesToCents(l.estUnitPrice),
          category: l.category ?? null,
          note: l.note ?? null,
        },
      })
    }
  }
  return { id: boq.id, name: boq.name, version: boq.version, lines: (p.lines ?? []).length }
}

export async function upsertBoqLine(projectId: string, p: any) {
  const boq = await db.boq.findFirst({ where: { id: String(p.boqId), projectId } })
  if (!boq) throw new Error('BOQ not found')
  const data = {
    materialName: String(p.materialName),
    unit: String(p.unit ?? 'unit'),
    qty: Number(p.qty ?? 1),
    // #285: KSh in the payload → integer cents in the column.
    estUnitPrice: nonNegativeKesToCents(p.estUnitPrice),
    category: p.category ?? null,
    note: p.note ?? null,
  }
  if (!p.id) {
    const created = await db.boqLine.create({ data: { boqId: boq.id, ...data } })
    return { id: created.id }
  }
  // #286: the update path resolves the LINE through the caller's project
  // scope (deleteBoqLine's findFirst pattern — the pre-fix bare-id update
  // let a foreign project's line id rewrite that project's line) AND
  // requires the line to belong to the scoped BOQ, so a same-project line
  // from another BOQ version can't be rewritten through this BOQ either.
  // Foreign/unknown/mismatched line ids are refused with the honest error
  // and no row is touched.
  const line = await db.boqLine.findFirst({
    where: { id: String(p.id), boq: { projectId } },
  })
  if (!line || line.boqId !== boq.id) throw new Error('BOQ line not found')
  const updated = await db.boqLine.update({ where: { id: line.id }, data })
  return { id: updated.id }
}

export async function deleteBoqLine(projectId: string, p: any) {
  const line = await db.boqLine.findFirst({
    where: { id: String(p.id), boq: { projectId } },
  })
  if (!line) throw new Error('BOQ line not found')
  await db.boqLine.delete({ where: { id: line.id } })
  return { id: line.id }
}

export async function approveBoq(projectId: string, p: any) {
  const boq = await db.boq.findFirst({ where: { id: String(p.id), projectId } })
  if (!boq) throw new Error('BOQ not found')
  if (boq.status === 'approved') throw new Error('BOQ already approved')
  return db.boq.update({ where: { id: boq.id }, data: { status: 'approved' } })
}

export async function boqToRequest(projectId: string, p: any) {
  const boq = await db.boq.findFirst({
    where: { id: String(p.id), projectId },
    include: { lines: true },
  })
  if (!boq) throw new Error('BOQ not found')
  const lines = p.lineIds?.length ? boq.lines.filter((l) => p.lineIds.includes(l.id)) : boq.lines
  if (!lines.length) throw new Error('BOQ has no lines')
  const count = await db.materialRequest.count({ where: { projectId } })
  const requestCode = `MR-${1000 + count + 1}`
  const request = await db.materialRequest.create({
    data: {
      projectId,
      requestCode,
      requestedByRole: p.requestedByRole ?? 'contractor',
      requestedByName: p.requestedByName ?? 'Site Manager',
      notes: `From BOQ "${boq.name}" v${boq.version}`,
      status: 'draft',
      lines: {
        create: lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
      },
    },
  })
  return { id: request.id, requestCode, lines: lines.length }
}

// ---- Supplier shortlist & quote detail ----

export async function saveSupplier(projectId: string, p: any) {
  const supplier = await db.supplier.findUnique({ where: { id: String(p.supplierId) } })
  if (!supplier) throw new Error('Supplier not found')
  const saved = await db.savedSupplier.upsert({
    where: { projectId_supplierId: { projectId, supplierId: supplier.id } },
    update: { note: p.note ?? undefined },
    create: { projectId, supplierId: supplier.id, savedBy: p.savedBy ?? 'Site Manager', note: p.note ?? null },
  })
  return { id: saved.id }
}

export async function unsaveSupplier(projectId: string, p: any) {
  const saved = await db.savedSupplier.findFirst({
    where: { projectId, supplierId: String(p.supplierId) },
  })
  if (saved) await db.savedSupplier.delete({ where: { id: saved.id } })
  return { removed: true }
}

export async function updateQuote(projectId: string, p: any) {
  // #147 (the DB-2 class on the quote-editing path): the header update AND
  // the full line rewrite run in ONE db.$transaction — the same house pattern
  // as the movement paths above and supply's receiveDelivery (#196). The old
  // shape `deleteMany`d ALL of the quote's QuoteLine rows and recreated them
  // one-by-one with no transaction, so a failure mid-loop left a PARTIAL line
  // set that read as a valid quote with fewer items (silent corruption feeding
  // supplier comparison and PO creation), and a concurrent reader between the
  // deleteMany and the loop saw an empty quote. Now: either every line is
  // replaced or none is, and the header edit rides the same unit — a mid-rewrite
  // throw rolls the deleteMany, the partial creates AND the header update back
  // to the original quote. The scoping guard runs INSIDE the transaction too
  // (guards inside, not before — the file's DB-2 discipline).
  return db.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({
      where: { id: String(p.id), request: { projectId } },
    })
    if (!quote) throw new Error('Quote not found')
    const updated = await tx.quote.update({
      where: { id: quote.id },
      data: {
        validUntil: p.validUntil ? new Date(p.validUntil) : undefined,
        terms: p.terms ?? undefined,
      },
    })
    if (Array.isArray(p.lines)) {
      await tx.quoteLine.deleteMany({ where: { quoteId: quote.id } })
      for (const l of p.lines) {
        await tx.quoteLine.create({
          data: {
            quoteId: quote.id,
            name: String(l.name),
            unit: String(l.unit ?? 'unit'),
            qty: Number(l.qty ?? 1),
            unitPrice: Number(l.unitPrice ?? 0),
            lineTotal: Number(l.qty ?? 1) * Number(l.unitPrice ?? 0),
          },
        })
      }
    }
    return { id: updated.id, validUntil: updated.validUntil, terms: updated.terms }
  })
}
