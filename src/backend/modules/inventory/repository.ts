// Inventory slice loaders for the project payload (spec §33/§35).
// Derived closing stock from append-only movements — never stored.

import { db } from '@/backend/lib/db'
import { centsToKes, mulQtyCents, sumCents } from '@/backend/lib/money'
import { isLowStock, movementInflowQty } from './low-stock'
import { countCadenceState } from './count-cadence'
import type { InventorySlice, BoqSlice, StockMovementRow, StockMovementType, StockCountRow, StockCountStatus } from './types'

/**
 * Signed quantity for a single movement: out-flows (consumed / damaged /
 * transferred_out) are negative, every other movement type adds to closing
 * stock. Shared by the slice loader and every inventory service write path so
 * "derived closing" has exactly one definition (DB-2).
 */
export function movementDelta(type: string, quantity: number): number {
  return type === 'consumed' || type === 'damaged' || type === 'transferred_out' ? -quantity : quantity
}

/**
 * Derived closing stock = Σ movementDelta over the append-only movement log.
 * Never stored — always projected (spec §33/§35).
 */
export function derivedClosingQty(movements: readonly { type: string; quantity: number }[]): number {
  return movements.reduce((sum, m) => sum + movementDelta(m.type, m.quantity), 0)
}

/**
 * Signed variance of a counted line (issue #194): expected − counted.
 * >0 means the book (derived closing) OVERSTATES the physical stock; <0
 * means it understates. NOT a stored column — computed here so variance has
 * exactly one definition, the same discipline as movementDelta. The
 * adjustment posted from a line is its NEGATION (counted − expected) because
 * the ledger must move TOWARD the count.
 */
export function countVariance(line: { expectedQty: number; countedQty: number }): number {
  return line.expectedQty - line.countedQty
}

/** How many count sessions the payload slice carries (bounded read, newest first). */
const COUNT_HISTORY_TAKE = 20

export async function loadInventorySlice(projectId: string): Promise<InventorySlice> {
  const [items, counts, lastCount, project] = await Promise.all([
    db.inventoryItem.findMany({
      where: { projectId },
      include: { movements: { orderBy: { createdAt: 'desc' } } },
    }),
    // Stock reconciliation history (issue #194) — newest first, bounded like
    // the payload's other take-capped reads (SQLite demo scale: a handful of
    // sessions, each bounded by the project's own line count).
    db.stockCount.findMany({
      where: { projectId },
      include: { items: { include: { inventoryItem: true } } },
      orderBy: { createdAt: 'desc' },
      take: COUNT_HISTORY_TAKE,
    }),
    // REC-1 (#359): the LATEST physical count by countedAt (not createdAt —
    // a backdated count recorded late was still the last time bags were
    // counted). One bounded read; the cadence derives from it on read.
    db.stockCount.findFirst({
      where: { projectId },
      orderBy: { countedAt: 'desc' },
      select: { countedAt: true },
    }),
    db.project.findUnique({
      where: { id: projectId },
      select: { countIntervalDays: true },
    }),
  ])
  const rows = items.map((item) => {
    const sum = (type: string) =>
      item.movements.filter((m) => m.type === type).reduce((s, m) => s + m.quantity, 0)
    const openingQty = sum('opening')
    const receivedQty = sum('received')
    const consumedQty = sum('consumed')
    const transferredQty = sum('transferred_out') - sum('transferred_in')
    const returnedQty = sum('returned')
    const damagedQty = sum('damaged')
    const adjustedQty = sum('adjusted')
    const closingQty = derivedClosingQty(item.movements)
    const lastCost = item.movements.find((m) => m.unitCost != null)?.unitCost ?? 0n
    // #282: unitCost is integer CENTS in the column (writers convert at the
    // action boundary) — this DTO is the KSh read boundary (centsToKes), the
    // mirror of the service's parseUnitCost. stockValue = closing × lastCost
    // is computed in cents (mulQtyCents) and only then converted to KSh.
    const movements: StockMovementRow[] = item.movements.map((m) => ({
      id: m.id,
      inventoryItemId: m.inventoryItemId,
      materialName: item.materialName,
      unit: item.unit,
      type: m.type as StockMovementType,
      quantity: m.quantity,
      unitCost: m.unitCost === null ? null : centsToKes(m.unitCost),
      reference: m.reference,
      // #203: consumption attribution rides the payload — the BOQ-vs-actual
      // "consumed" column joins on it client-side (supply/insights.ts
      // boqProgress), same pure-shared-math pattern as the rest of the slice.
      requestLineId: m.requestLineId,
      note: m.note,
      recordedBy: m.recordedBy,
      createdAt: m.createdAt.toISOString(),
    }))
    return {
      id: item.id,
      materialName: item.materialName,
      unit: item.unit,
      location: item.location,
      supplierId: item.supplierId,
      openingQty,
      receivedQty,
      consumedQty,
      transferredQty,
      returnedQty,
      damagedQty,
      adjustedQty,
      closingQty,
      // mulQtyCents refuses qty ≤ 0 by design (money never negative) — a
      // line consumed to zero (a legal state: the over-consumption guard
      // only refuses going BELOW zero) or adjusted negative has an honest
      // zero stock value. Same floor the v1 materials rollup applies.
      stockValue: closingQty > 0 ? centsToKes(mulQtyCents(closingQty, lastCost)) : 0,
      // #207: honest lowStock — ONE rule (low-stock.ts), computed in the
      // same pass as the sums above. Explicit reorderLevel governs when
      // set; else the derived default: closing ≤ 10% of opening+received+
      // returned, and a zero-inflow item is never low.
      reorderLevel: item.reorderLevel,
      lowStock: isLowStock({
        closingQty,
        inflowQty: movementInflowQty(item.movements),
        reorderLevel: item.reorderLevel,
      }),
      updatedAt: item.updatedAt.toISOString(),
      movements,
    }
  })
  // Flatten movements newest-first across items
  const allMovements = rows
    .flatMap((r) => r.movements)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const itemsWithoutMovements = rows.map(({ movements, ...rest }) => rest)

  // ---- Stock reconciliation history (issue #194) -----------------------------
  // Per count: the counted lines (with the COMPUTED variance — one
  // definition, countVariance) plus the items that were NOT part of the
  // session, listed separately with their derived closing AS OF countedAt
  // (the movement log is append-only, so history is queryable — an uncounted
  // line's "expected at count time" is reconstructable, never invented).
  const countRows: StockCountRow[] = counts.map((c) => {
    const countedIds = new Set(c.items.map((line) => line.inventoryItemId))
    const uncounted = items
      .filter((item) => !countedIds.has(item.id))
      .map((item) => ({
        inventoryItemId: item.id,
        materialName: item.materialName,
        unit: item.unit,
        location: item.location,
        expectedQty: derivedClosingQty(
          item.movements.filter((m) => m.createdAt <= c.countedAt),
        ),
      }))
    return {
      id: c.id,
      countedBy: c.countedBy,
      countedAt: c.countedAt.toISOString(),
      note: c.note,
      blind: c.blind,
      status: c.status as StockCountStatus,
      postedAt: c.postedAt ? c.postedAt.toISOString() : null,
      postedBy: c.postedBy,
      itemCount: c.items.length,
      items: c.items.map((line) => ({
        id: line.id,
        inventoryItemId: line.inventoryItemId,
        materialName: line.inventoryItem.materialName,
        unit: line.inventoryItem.unit,
        location: line.inventoryItem.location,
        countedQty: line.countedQty,
        expectedQty: line.expectedQty,
        variance: countVariance(line),
        postedQty: line.postedQty,
      })),
      uncounted,
      createdAt: c.createdAt.toISOString(),
    }
  })

  // REC-1 (#359): the derived count cadence — last physical count + the
  // stored interval, computed HERE (one definition, count-cadence.ts) so
  // the client never derives a schedule itself.
  const countCadence = countCadenceState({
    intervalDays: project?.countIntervalDays ?? null,
    lastCountAt: lastCount?.countedAt ?? null,
    now: new Date(),
  })

  return { items: itemsWithoutMovements, movements: allMovements, counts: countRows, countCadence }
}

export async function loadBoqSlice(projectId: string): Promise<BoqSlice> {
  const boqs = await db.boq.findMany({
    where: { projectId },
    include: { lines: true },
    orderBy: { createdAt: 'desc' },
  })
  return {
    boqs: boqs.map((b) => ({
      id: b.id,
      name: b.name,
      version: b.version,
      status: b.status,
      total: centsToKes(sumCents(b.lines.map((l) => mulQtyCents(l.qty, l.estUnitPrice)))),
      lines: b.lines.map((l) => ({
        id: l.id,
        materialName: l.materialName,
        unit: l.unit,
        qty: l.qty,
        estUnitPrice: centsToKes(l.estUnitPrice),
        category: l.category,
        note: l.note,
      })),
      createdAt: b.createdAt.toISOString(),
    })),
  }
}
