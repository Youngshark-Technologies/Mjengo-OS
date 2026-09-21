/**
 * Stock reconciliation (issue #194) — src/backend/modules/inventory/service.ts:
 * the count → variance → count-linked adjustment loop.
 *
 * Same idiom as tests/unit/inventory-atomicity.test.ts: @/backend/lib/db is
 * swapped for an in-memory stub whose $transaction snapshots state and
 * restores it on throw. Pinned invariants:
 *
 *  · VARIANCE MATH — variance is expected − counted (one definition,
 *    repository.countVariance); the adjustment posted from a line is its
 *    negation (counted − expected) because the ledger moves TOWARD the count.
 *  · EXPECTED IS A SNAPSHOT — expectedQty is the derived closing AS OF the
 *    count's countedAt; a backdated count excludes later movements, and a
 *    count recorded now pins the current derived closing.
 *  · POSTING FROM A COUNT — appends `adjusted` movements whose reference is
 *    'count:<countId>' (the movement ledger's source-link convention), stamps
 *    each line's postedQty, flips the count open → posted.
 *  · ZERO-VARIANCE COUNTS POST NOTHING — no movement rows; the count still
 *    closes (posted with postedQty 0 per line).
 *  · DOUBLE-POST REFUSAL — an already-posted count refuses with an honest
 *    error instead of double-adjusting.
 *  · RECONCILIATION NEVER EDITS HISTORY — after posting, every pre-existing
 *    movement row is byte-identical (same ids, quantities, types); posting
 *    only appends.
 *  · PROJECT SCOPING — a count (and its posting) cannot see or touch another
 *    project's items.
 *  · INPUT VALIDATION — countedBy required, ≥1 line, countedQty finite ≥ 0
 *    and under the per-movement cap, no duplicate lines; a bad session
 *    writes NOTHING (transaction rollback).
 *  · OFFLINE-FIRST SURFACE — the two actions are dispatched exactly like the
 *    other inventory movements (INVENTORY_ACTIONS + applyInventoryAction
 *    routing + the materials-tab dispatch calls), so they queue through the
 *    outbox and replay through POST /api/sync unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// In-memory Prisma stub: inventoryItem / stockMovement / stockCount /
// stockCountItem — just enough for the reconciliation core. __state exposes
// the tables; failOn injects a write failure for rollback tests.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    items: new Map<string, Record<string, unknown>>(),
    movements: new Map<string, Record<string, unknown>>(),
    counts: new Map<string, Record<string, unknown>>(),
    countItems: new Map<string, Record<string, unknown>>(),
    projects: new Map<string, Record<string, unknown>>(), // REC-1 (#359): countIntervalDays lives on the project row
    failOn: null as string | null, // 'stockCountItem.create' | 'stockCount.update' | …
    // Pin the movement clock for snapshot tests: when set, stockMovement.create
    // stamps createdAt = nowMs instead of Date.now() (backdated-count scenarios).
    nowMs: null as number | null,
    reset() {
      state.items.clear()
      state.movements.clear()
      state.counts.clear()
      state.countItems.clear()
      state.projects.clear()
      state.seq = 0
      state.failOn = null
      state.nowMs = null
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const movementsFor = (itemId: string) =>
    [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)
  const failIfInjected = (model: string, op: string) => {
    if (state.failOn === `${model}.${op}`) throw new Error(`stub: simulated failure on ${model}.${op}`)
  }

  const inventoryItem = {
    async upsert({ where, update, create }: { where: { projectId_materialName_location: Record<string, string> }; update: Record<string, unknown>; create: Record<string, unknown> }) {
      const key = where.projectId_materialName_location
      const existing = [...state.items.values()].find(
        (i) => i.projectId === key.projectId && i.materialName === key.materialName && i.location === key.location,
      )
      if (existing) {
        const updated = { ...existing, unit: update.unit }
        state.items.set(updated.id as string, updated)
        return { ...updated, movements: movementsFor(updated.id as string) }
      }
      const item: Record<string, unknown> = { id: nid('item'), ...create }
      state.items.set(item.id as string, item)
      return { ...item, movements: [] }
    },
    async findFirst({ where }: { where: { id: string; projectId: string } }) {
      const item = state.items.get(where.id)
      return item && item.projectId === where.projectId
        ? { ...item, movements: movementsFor(where.id) }
        : null
    },
    async findMany({ where }: { where: { projectId: string; id?: { in: string[] } } }) {
      return [...state.items.values()]
        .filter((i) => i.projectId === where.projectId)
        .filter((i) => (where.id?.in ? where.id.in.includes(i.id as string) : true))
        .map((i) => ({ ...i, movements: movementsFor(i.id as string) }))
    },
  }
  const stockMovement = {
    async create({ data }: { data: Record<string, unknown> }) {
      failIfInjected('stockMovement', 'create')
      const m: Record<string, unknown> = {
        id: nid('mv'),
        createdAt: new Date(state.nowMs ?? Date.now()),
        ...data,
      }
      state.movements.set(m.id as string, m)
      return { ...m }
    },
  }
  const stockCount = {
    async create({ data }: { data: Record<string, unknown> }) {
      failIfInjected('stockCount', 'create')
      const c: Record<string, unknown> = { id: nid('count'), createdAt: new Date(), ...data }
      state.counts.set(c.id as string, c)
      return { ...c }
    },
    async findFirst({ where }: { where: { id: string; projectId?: string } }) {
      const c = state.counts.get(where.id)
      if (!c) return null
      if (where.projectId && c.projectId !== where.projectId) return null
      const lines = [...state.countItems.values()].filter((l) => l.countId === c.id)
      return {
        ...c,
        items: lines.map((l) => {
          const item = state.items.get(l.inventoryItemId as string)!
          return { ...l, inventoryItem: { ...item, movements: movementsFor(item.id as string) } }
        }),
      }
    },
    async findMany({ where }: { where: { projectId: string } }) {
      return [...state.counts.values()]
        .filter((c) => c.projectId === where.projectId)
        .map((c) => ({ ...c, items: [...state.countItems.values()].filter((l) => l.countId === c.id) }))
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      failIfInjected('stockCount', 'update')
      const c = state.counts.get(where.id)
      if (!c) throw new Error('stub: stockCount.update on missing row')
      const updated = { ...c, ...data }
      state.counts.set(where.id, updated)
      return { ...updated }
    },
  }
  const stockCountItem = {
    async create({ data }: { data: Record<string, unknown> }) {
      failIfInjected('stockCountItem', 'create')
      const l: Record<string, unknown> = { id: nid('cntline'), ...data }
      state.countItems.set(l.id as string, l)
      return { ...l }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      failIfInjected('stockCountItem', 'update')
      const l = state.countItems.get(where.id)
      if (!l) throw new Error('stub: stockCountItem.update on missing row')
      const updated = { ...l, ...data }
      state.countItems.set(where.id, updated)
      return { ...updated }
    },
  }
  const project = {
    async findUnique({ where }: { where: { id: string } }) {
      const p = state.projects.get(where.id)
      return p ? { ...p } : null
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const p = state.projects.get(where.id)
      if (!p) throw new Error('stub: project.update on missing row')
      const updated = { ...p, ...data }
      state.projects.set(where.id, updated)
      return { ...updated }
    },
  }
  const db = {
    inventoryItem,
    stockMovement,
    stockCount,
    stockCountItem,
    project,
    async $transaction(fn: (tx: typeof db) => unknown) {
      const snapshot = {
        items: new Map(state.items),
        movements: new Map(state.movements),
        counts: new Map(state.counts),
        countItems: new Map(state.countItems),
      }
      try {
        return await fn(db)
      } catch (err) {
        state.items = snapshot.items
        state.movements = snapshot.movements
        state.counts = snapshot.counts
        state.countItems = snapshot.countItems
        throw err
      }
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { countVariance, derivedClosingQty } from '@/backend/modules/inventory/repository'
import {
  countReference,
  openStock,
  postCountAdjustments,
  recordStockCount,
  receiveStock,
} from '@/backend/modules/inventory/service'
import { INVENTORY_ACTIONS, applyInventoryAction } from '@/backend/actions/inventory'

type StubState = {
  items: Map<string, Record<string, unknown>>
  movements: Map<string, Record<string, unknown>>
  counts: Map<string, Record<string, unknown>>
  countItems: Map<string, Record<string, unknown>>
  projects: Map<string, Record<string, unknown>>
  failOn: string | null
  nowMs: number | null
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state
const movementsOf = (itemId: string) =>
  [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)
const movementRows = () => [...state.movements.values()]

const P = 'proj-1'
const OTHER = 'proj-2'

/** Seed two stock lines in P (Cement 100 @ Site Store, Ballast 10 @ Site Store). */
async function seed() {
  state.projects.set(P, { id: P })
  state.projects.set(OTHER, { id: OTHER })
  const cement = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 100, location: 'Site Store' })
  const ballast = await openStock(P, { materialName: 'Ballast', unit: 'tonne', qty: 10, location: 'Site Store' })
  return { cementId: cement.inventoryItemId, ballastId: ballast.inventoryItemId }
}

beforeEach(() => {
  state.reset()
})

// ---------------------------------------------------------------- variance math

describe('variance math — one definition: expected − counted', () => {
  it('countVariance signs the gap: >0 book overstates, <0 book understates', () => {
    expect(countVariance({ expectedQty: 100, countedQty: 95 })).toBe(5)
    expect(countVariance({ expectedQty: 100, countedQty: 108 })).toBe(-8)
    expect(countVariance({ expectedQty: 42, countedQty: 42 })).toBe(0)
  })

  it('the posted adjustment is the negation of variance (ledger moves toward the count)', () => {
    const variance = countVariance({ expectedQty: 100, countedQty: 95 })
    // expected 100, counted 95 → the book overstates by 5 (variance +5) → the
    // adjustment must be counted − expected = −5 (adjust DOWN to reach the count).
    expect(variance).toBe(5)
    expect(95 - 100).toBe(-5)
    expect(-(95 - 100)).toBe(variance)
  })
})

// ------------------------------------------------------- recordStockCount

describe('recordStockCount — session + expected snapshot', () => {
  it('records a session: per-line expected snapshot (derived closing), variance, status open', async () => {
    const { cementId, ballastId } = await seed()
    const r = await recordStockCount(P, {
      countedBy: 'Otieno (storekeeper)',
      note: 'end-of-month stocktake',
      counts: [
        { inventoryItemId: cementId, countedQty: 94 },
        { inventoryItemId: ballastId, countedQty: 10 },
      ],
    })
    expect(r.itemCount).toBe(2)
    expect(r.countedBy).toBe('Otieno (storekeeper)')
    const cement = r.variances.find((v) => v.inventoryItemId === cementId)!
    expect(cement.expectedQty).toBe(100)
    expect(cement.countedQty).toBe(94)
    expect(cement.variance).toBe(6) // expected − counted
    const ballast = r.variances.find((v) => v.inventoryItemId === ballastId)!
    expect(ballast.variance).toBe(0)

    // Rows: one StockCount (open) + two StockCountItems with pinned snapshots.
    expect(state.counts.size).toBe(1)
    const count = [...state.counts.values()][0]
    expect(count.status).toBe('open')
    expect(count.countedBy).toBe('Otieno (storekeeper)')
    expect(count.note).toBe('end-of-month stocktake')
    expect(state.countItems.size).toBe(2)
    for (const line of state.countItems.values()) {
      expect(line.expectedQty).toBe(line.inventoryItemId === cementId ? 100 : 10)
      expect(line.postedQty).toBeUndefined() // not yet posted
    }
    // A count records COUNT rows only — never a movement.
    expect(state.movements.size).toBe(2) // the two openings
  })

  it('backdated countedAt snapshots the world at count time (later movements excluded)', async () => {
    // Seed at T0 (two minutes ago), then a delivery lands NOW; the physical
    // count happened between them (offline flush of the count session).
    state.nowMs = Date.now() - 120_000
    const { cementId } = await seed()
    state.nowMs = null // the receive below is stamped with the real clock
    await receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 50, location: 'Site Store' })
    const countedAt = new Date(Date.now() - 60_000).toISOString() // after the seed, before the receive
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      countedAt,
      counts: [{ inventoryItemId: cementId, countedQty: 100 }],
    })
    const line = r.variances[0]
    expect(line.expectedQty).toBe(100) // the 50 bags received after the count are excluded
    expect(line.variance).toBe(0)
  })

  it('counts against the same clock as now pin the current derived closing', async () => {
    const { cementId } = await seed()
    await receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 50, location: 'Site Store' })
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: cementId, countedQty: 140 }],
    })
    expect(r.variances[0].expectedQty).toBe(150)
    expect(r.variances[0].variance).toBe(10)
  })

  it('counts zero of a line (ground truth can be "none left")', async () => {
    const { cementId } = await seed()
    const r = await recordStockCount(P, { countedBy: 'Otieno', counts: [{ inventoryItemId: cementId, countedQty: 0 }] })
    expect(r.variances[0].variance).toBe(100)
  })

  it('refuses items from another project (project scoping)', async () => {
    await seed()
    const foreign = await openStock(OTHER, { materialName: 'Cement', unit: 'bag', qty: 5, location: 'Site Store' })
    await expect(
      recordStockCount(P, { countedBy: 'X', counts: [{ inventoryItemId: foreign.inventoryItemId, countedQty: 5 }] }),
    ).rejects.toThrow('inventory.count: one or more inventory items were not found in this project')
    expect(state.counts.size).toBe(0) // nothing written
  })

  it('refuses an unknown count id from the right project at POST time too', async () => {
    const { cementId } = await seed()
    const r = await recordStockCount(P, { countedBy: 'X', counts: [{ inventoryItemId: cementId, countedQty: 1 }] })
    await expect(postCountAdjustments(OTHER, { countId: r.countId })).rejects.toThrow('Stock count not found')
    await expect(postCountAdjustments(P, { countId: 'nope' })).rejects.toThrow('Stock count not found')
  })

  it('validates the session before any write: counter, lines, qty, duplicates', async () => {
    const { cementId, ballastId } = await seed()
    await expect(recordStockCount(P, { countedBy: '', counts: [{ inventoryItemId: cementId, countedQty: 1 }] }))
      .rejects.toThrow('inventory.count: countedBy is required')
    await expect(recordStockCount(P, { countedBy: 'X', counts: [] }))
      .rejects.toThrow('inventory.count: at least one counted line is required')
    await expect(recordStockCount(P, { countedBy: 'X', counts: [{ inventoryItemId: cementId, countedQty: -3 }] }))
      .rejects.toThrow('inventory.count: countedQty must be zero or more')
    await expect(recordStockCount(P, { countedBy: 'X', counts: [{ inventoryItemId: cementId, countedQty: NaN }] }))
      .rejects.toThrow('inventory.count: countedQty must be zero or more')
    await expect(recordStockCount(P, { countedBy: 'X', counts: [{ inventoryItemId: cementId, countedQty: 2e9 }] }))
      .rejects.toThrow(/exceeds the cap/)
    await expect(
      recordStockCount(P, { countedBy: 'X', counts: [
        { inventoryItemId: cementId, countedQty: 1 },
        { inventoryItemId: cementId, countedQty: 2 },
      ] }),
    ).rejects.toThrow('counted twice in one session')
    expect(state.counts.size).toBe(0)
    expect(state.countItems.size).toBe(0)
  })

  it('a failing line write rolls the whole session back (atomic)', async () => {
    const { cementId } = await seed()
    state.failOn = 'stockCountItem.create'
    await expect(
      recordStockCount(P, { countedBy: 'X', counts: [{ inventoryItemId: cementId, countedQty: 1 }] }),
    ).rejects.toThrow('stub: simulated failure on stockCountItem.create')
    expect(state.counts.size).toBe(0) // the StockCount row did not survive
    expect(state.countItems.size).toBe(0)
  })
})

// ---------------------------------------------------- postCountAdjustments

describe('postCountAdjustments — count-linked adjustments', () => {
  it('posts one adjusted movement per non-zero-variance line, referencing the count', async () => {
    const { cementId, ballastId } = await seed()
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      counts: [
        { inventoryItemId: cementId, countedQty: 94 }, // variance +6 → adjust −6
        { inventoryItemId: ballastId, countedQty: 12 }, // variance −2 → adjust +2
      ],
    })

    const posted = await postCountAdjustments(P, { countId: r.countId, postedBy: 'Akinyi (QS)' })
    expect(posted.countId).toBe(r.countId)
    expect(posted.postedBy).toBe('Akinyi (QS)')

    const cementMv = posted.movements.find((m) => m.inventoryItemId === cementId)!
    expect(cementMv.movementId).toBeTruthy()
    expect(cementMv.adjustment).toBe(-6) // counted − expected
    expect(cementMv.closingQty).toBe(94) // the ledger now matches the count

    const ballastMv = posted.movements.find((m) => m.inventoryItemId === ballastId)!
    expect(ballastMv.adjustment).toBe(2)
    expect(ballastMv.closingQty).toBe(12)

    // LINEAGE: the appended movements carry reference 'count:<countId>'.
    const ref = countReference(r.countId)
    for (const row of movementsOf(cementId).concat(movementsOf(ballastId))) {
      if (row.type === 'adjusted') {
        expect(row.reference).toBe(ref)
        expect(String(row.note)).toContain('expected')
      }
    }
    const adjusted = movementRows().filter((m) => m.type === 'adjusted')
    expect(adjusted).toHaveLength(2)
    expect(adjusted.every((m) => m.reference === ref)).toBe(true)

    // The count flipped posted; each line's postedQty is the adjustment.
    const count = state.counts.get(r.countId)!
    expect(count.status).toBe('posted')
    expect(count.postedBy).toBe('Akinyi (QS)')
    expect(count.postedAt).toBeTruthy()
    const lines = [...state.countItems.values()]
    expect(lines.find((l) => l.inventoryItemId === cementId)!.postedQty).toBe(-6)
    expect(lines.find((l) => l.inventoryItemId === ballastId)!.postedQty).toBe(2)

    // And the derived closing is exactly what was counted.
    expect(derivedClosingQty(movementsOf(cementId))).toBe(94)
    expect(derivedClosingQty(movementsOf(ballastId))).toBe(12)
  })

  it('a count with zero variance posts NOTHING (no movement rows) but still closes', async () => {
    const { cementId, ballastId } = await seed()
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      counts: [
        { inventoryItemId: cementId, countedQty: 100 },
        { inventoryItemId: ballastId, countedQty: 10 },
      ],
    })
    const before = movementRows().length
    const posted = await postCountAdjustments(P, { countId: r.countId })
    expect(movementRows().length).toBe(before) // nothing appended
    expect(posted.movements).toHaveLength(2)
    expect(posted.movements.every((m) => m.movementId === null && m.adjustment === 0)).toBe(true)
    expect(state.counts.get(r.countId)!.status).toBe('posted')
    for (const line of state.countItems.values()) expect(line.postedQty).toBe(0)
  })

  it('refuses a double post (idempotent-by-refusal, no extra movements)', async () => {
    const { cementId } = await seed()
    const r = await recordStockCount(P, { countedBy: 'Otieno', counts: [{ inventoryItemId: cementId, countedQty: 90 }] })
    await postCountAdjustments(P, { countId: r.countId })
    const afterFirst = movementRows().length
    await expect(postCountAdjustments(P, { countId: r.countId })).rejects.toThrow(/already posted/)
    expect(movementRows().length).toBe(afterFirst) // no double-adjustment
    expect(derivedClosingQty(movementsOf(cementId))).toBe(90)
  })

  it('NEVER edits historical movements — posting only appends', async () => {
    const { cementId, ballastId } = await seed()
    await receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 25, location: 'Site Store' })
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      counts: [
        { inventoryItemId: cementId, countedQty: 120 },
        { inventoryItemId: ballastId, countedQty: 9 },
      ],
    })
    const before = movementRows().map((m) => ({ ...m }))
    await postCountAdjustments(P, { countId: r.countId })
    const after = movementRows()
    expect(after.length).toBe(before.length + 2) // two appended adjustments
    // Every pre-existing row is byte-identical (same id, type, quantity,
    // reference, note, recordedBy, createdAt) — history was not touched.
    for (const row of before) {
      const now = state.movements.get(row.id as string)!
      expect(now).toEqual(row)
    }
    const appended = after.filter((m) => !before.some((b) => b.id === m.id))
    expect(appended.every((m) => m.type === 'adjusted')).toBe(true)
  })

  it('adjustments are relative to the snapshot: movements since the count stay on top', async () => {
    state.nowMs = Date.now() - 120_000
    const { cementId } = await seed()
    state.nowMs = null
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      countedAt: new Date(Date.now() - 60_000).toISOString(), // after the seed
      counts: [{ inventoryItemId: cementId, countedQty: 100 }],
    })
    // A delivery is logged AFTER the count (it was not part of the counted world).
    await receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 30, location: 'Site Store' })
    const posted = await postCountAdjustments(P, { countId: r.countId })
    const cementMv = posted.movements[0]
    expect(cementMv.adjustment).toBe(0) // counted === snapshot (100), so nothing posts…
    // …and the 30 bags received since stay in the ledger on top:
    expect(derivedClosingQty(movementsOf(cementId))).toBe(130)
    expect(cementMv.closingQty).toBe(130)
  })

  it('a failing movement write rolls the posting back (no partial count flip)', async () => {
    const { cementId } = await seed()
    const r = await recordStockCount(P, { countedBy: 'Otieno', counts: [{ inventoryItemId: cementId, countedQty: 90 }] })
    state.failOn = 'stockMovement.create'
    await expect(postCountAdjustments(P, { countId: r.countId })).rejects.toThrow('stub: simulated failure on stockMovement.create')
    expect(state.counts.get(r.countId)!.status).toBe('open') // not flipped
    expect(movementRows().filter((m) => m.type === 'adjusted')).toHaveLength(0)
    for (const line of state.countItems.values()) expect(line.postedQty).toBeUndefined()
  })
})

// ------------------------------------------------- dispatcher + offline surface

describe('actions surface — inventory.count / inventory.count.post', () => {
  it('INVENTORY_ACTIONS declares both reconciliation actions', () => {
    expect(INVENTORY_ACTIONS).toContain('inventory.count')
    expect(INVENTORY_ACTIONS).toContain('inventory.count.post')
  })

  it('applyInventoryAction routes both actions to the service (offline replay path)', async () => {
    const { cementId } = await seed()
    const r = await applyInventoryAction('inventory.count', {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: cementId, countedQty: 95 }],
    }, P)
    expect(r.countId).toBeTruthy()
    const posted = await applyInventoryAction('inventory.count.post', { countId: r.countId }, P)
    expect(posted.movements[0].closingQty).toBe(95)
    // Both are ordinary inventory actions: the outbox drain (POST /api/sync →
    // applyAction) replays them unchanged, like every inventory movement.
    expect(derivedClosingQty(movementsOf(cementId))).toBe(95)
  })
})

// ------------------------------------------------- REC-1 (#359): blind counts

describe('blind-count mode — the session flag (per-count, auditable)', () => {
  it('blind: true records the session blind and echoes it in the result; the variance view still returns AFTER the write (that IS the submission)', async () => {
    const { cementId } = await seed()
    const r = await recordStockCount(P, {
      countedBy: 'Otieno',
      blind: true,
      counts: [{ inventoryItemId: cementId, countedQty: 95 }],
    })
    expect(r.blind).toBe(true)
    // The row carries the mode — the reconciliation history + CSV export read it.
    expect(state.counts.get(r.countId)!.blind).toBe(true)
    // The variances (with expectedQty) exist ONLY in the post-save result —
    // the server has no pre-submission expected-qty surface to leak (the
    // row is written inside the same transaction; the result IS submission).
    expect(r.variances[0].expectedQty).toBe(100)
    expect(r.variances[0].variance).toBe(5)
  })

  it('blind is opt-in per session: absent / false / truthy-but-not-true all record NOT blind', async () => {
    const { cementId } = await seed()
    const a = await recordStockCount(P, { countedBy: 'Otieno', counts: [{ inventoryItemId: cementId, countedQty: 95 }] })
    expect(a.blind).toBe(false)
    expect(state.counts.get(a.countId)!.blind).toBe(false)
    const b = await recordStockCount(P, { countedBy: 'Otieno', blind: false, counts: [{ inventoryItemId: cementId, countedQty: 95 }] })
    expect(b.blind).toBe(false)
    // 'yes' is a string — only the literal boolean true claims blindness
    // (an accidentally-truthy payload must not fabricate the stronger claim).
    const c = await recordStockCount(P, { countedBy: 'Otieno', blind: 'yes', counts: [{ inventoryItemId: cementId, countedQty: 95 }] })
    expect(c.blind).toBe(false)
    expect(state.counts.get(c.countId)!.blind).toBe(false)
  })

  it('a blind session posts exactly like a visible one — the mode changes evidence, never the ledger math', async () => {
    const { cementId } = await seed()
    const r = await recordStockCount(P, { countedBy: 'Otieno', blind: true, counts: [{ inventoryItemId: cementId, countedQty: 95 }] })
    const posted = await postCountAdjustments(P, { countId: r.countId })
    const adjusted = movementRows().find((m) => m.type === 'adjusted')!
    expect(adjusted.quantity).toBe(-5) // counted − expected, toward the count
    expect(adjusted.reference).toBe(countReference(r.countId))
    expect(posted.movements[0].closingQty).toBe(95)
  })

  it('applyInventoryAction routes the blind payload through unchanged (offline replay path)', async () => {
    const { cementId } = await seed()
    const r = await applyInventoryAction('inventory.count', {
      countedBy: 'Otieno',
      blind: true,
      counts: [{ inventoryItemId: cementId, countedQty: 95 }],
    }, P)
    expect(r.blind).toBe(true)
  })
})

// ------------------------------------------- REC-1 (#359): scheduled count cadence

describe('inventory.count.schedule — the stored cadence interval', () => {
  it('sets the interval on the session\'s own project row', async () => {
    await seed()
    const r = await applyInventoryAction('inventory.count.schedule', { intervalDays: 7 }, P)
    expect(r).toEqual({ intervalDays: 7, cleared: false })
    expect(state.projects.get(P)!.countIntervalDays).toBe(7)
    // Project scoping is inherent: the OTHER project\'s row is untouched.
    expect(state.projects.get(OTHER)!.countIntervalDays).toBeUndefined()
  })

  it('null clears the cadence (the honest off state — no fake zero)', async () => {
    await seed()
    await applyInventoryAction('inventory.count.schedule', { intervalDays: 7 }, P)
    const r = await applyInventoryAction('inventory.count.schedule', { intervalDays: null }, P)
    expect(r).toEqual({ intervalDays: null, cleared: true })
    expect(state.projects.get(P)!.countIntervalDays).toBeNull()
  })

  it('refuses dishonest intervals: fractional, zero, negative, over-cap, garbage — writing NOTHING', async () => {
    await seed()
    for (const bad of [0, -3, 2.5, 366, 'weekly', true]) {
      await expect(
        applyInventoryAction('inventory.count.schedule', { intervalDays: bad }, P),
        `intervalDays=${String(bad)}`,
      ).rejects.toThrow(/inventory\.count\.schedule: intervalDays/)
    }
    expect(state.projects.get(P)!.countIntervalDays).toBeUndefined() // never written
  })

  it('INVENTORY_ACTIONS declares the schedule action (outbox replay + audit surface)', () => {
    expect(INVENTORY_ACTIONS).toContain('inventory.count.schedule')
  })
})

// ------------------------------------------------------ source pins (house style)

describe('source pins — offline-first wiring + UI + export', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

  it('materials-tab dispatches both actions through the shared dispatch (outbox queueing)', () => {
    const src = read('src/frontend/mjengo/materials-tab.tsx')
    expect(src).toContain("dispatch('inventory.count'")
    expect(src).toContain("dispatch('inventory.count.post'")
    expect(src).toContain("'inventory.count.schedule'") // the cadence action (multi-line dispatch)
    // countedAt is stamped client-side at count time (offline snapshot honesty).
    expect(src).toContain('countedAt: new Date().toISOString()')
    // The run-count dialog + the post-adjustment action + the CSV export exist.
    expect(src).toContain("t('mat.count.dialog.title')")
    expect(src).toContain("t('mat.count.post')")
    expect(src).toContain('reconciliationCSV(t, data)')
  })

  it('blind mode hides the book figures in the count dialog — the expected qty renders ONLY on the non-blind branch', () => {
    const src = read('src/frontend/mjengo/materials-tab.tsx')
    // The toggle exists and rides the dispatch payload (auditable per session).
    expect(src).toContain('setCountBlind')
    expect(src).toContain('blind: countBlind || undefined')
    // THE LEAK FIX: the count line is a conditional — blind renders the
    // qty-free label, visible renders the expected-qty label. The book
    // figure (i.closingQty) appears ONLY inside the countLine branch.
    expect(src).toContain("countBlind\n                        ? t('mat.count.blind.line', { name: i.materialName, location: i.location })")
    expect(src).toContain("t('mat.count.countLine', { name: i.materialName, location: i.location, qty: i.closingQty, unit: i.unit })")
    // The dialog description swaps to the blind variant while counting.
    expect(src).toContain("countBlind ? t('mat.count.blind.desc') : t('mat.count.dialog.desc')")
    // The toggle resets per session (an explicit choice, never sticky).
    expect(src).toContain('setCountBlind(false)')
  })

  it('the cadence surface: the select dispatches the schedule action, the due note reads the derived slice', () => {
    const src = read('src/frontend/mjengo/materials-tab.tsx')
    // The control dispatches the action (off → null).
    expect(src).toContain("days === null ? { intervalDays: null } : { intervalDays: days }")
    // The due note reads ONLY the server-derived slice — no client recompute.
    expect(src).toContain('countCadence.due')
    expect(src).toContain('countCadence.intervalDays')
    expect(src).toContain("t('mat.count.due.next'")
    expect(src).toContain("t('mat.count.due.overdue'")
    expect(src).toContain("t('mat.count.due.never'")
    // The whole cadence surface is gated on the slice being present — a
    // pre-#359 persisted payload (the #78 offline boot serves it verbatim)
    // hides the schedule instead of crashing or guessing one.
    expect(src).toContain('const countCadence = data.inventory.countCadence ?? null')
    expect(src).toContain('!isClient && countCadence !== null && (')
    expect(src).toContain('countCadence !== null && countCadence.intervalDays !== null && (')
  })

  it('export-utils carries reconciliationCSV over the payload count history', async () => {
    const src = read('src/frontend/mjengo/export-utils.ts')
    expect(src).toContain('export function reconciliationCSV(')
    expect(src).toContain('p.inventory.counts')
    // #125: the header row flows through t() (csv.rec.*) so the export
    // honors the active locale — the EN value keeps the same wording.
    expect(src).toContain("t('csv.rec.variance')")
    // REC-1 (#359): the blind mode rides the export (the evidential weight
    // of each session's rows).
    expect(src).toContain("t('csv.rec.blind')")
    expect(src).toContain("c.blind ? t('csv.rec.blindYes') : t('csv.rec.blindNo')")
    const { enDict } = await import('@/frontend/i18n/dicts/en')
    const { swDict } = await import('@/frontend/i18n/dicts/sw')
    expect(enDict['csv.rec.variance' as keyof typeof enDict]).toBe('Variance (Expected − Counted)')
    expect(swDict['csv.rec.variance' as keyof typeof swDict]).toBe('Tofauti (Inayotarajiwa − Iliyopimwa)')
  })

  it('the i18n key family exists in BOTH dictionaries (spot values via the dicts)', async () => {
    const { enDict } = await import('@/frontend/i18n/dicts/en')
    const { swDict } = await import('@/frontend/i18n/dicts/sw')
    const keys = [
      'mat.count.run', 'mat.count.dialog.title', 'mat.count.label.countedBy',
      'mat.count.col.expected', 'mat.count.col.counted', 'mat.count.col.variance',
      'mat.count.historyTitle', 'mat.count.record', 'mat.count.post',
      'mat.count.export', 'mat.count.status.open', 'mat.count.status.posted',
      'mat.count.saved', 'mat.count.zeroVariance',
      // REC-1 (#359) — blind mode + cadence families
      'mat.count.blind.label', 'mat.count.blind.hint', 'mat.count.blind.desc',
      'mat.count.blind.line', 'mat.count.blind.badge',
      'mat.count.cadence.label', 'mat.count.cadence.off', 'mat.count.cadence.option',
      'mat.count.cadence.saved', 'mat.count.cadence.cleared', 'mat.count.cadence.failed',
      'mat.count.due.never', 'mat.count.due.overdue', 'mat.count.due.next',
      'csv.rec.blind', 'csv.rec.blindYes', 'csv.rec.blindNo',
    ]
    for (const key of keys) {
      expect(enDict[key as keyof typeof enDict], `en missing ${key}`).toBeTruthy()
      expect(swDict[key as keyof typeof swDict], `sw missing ${key}`).toBeTruthy()
    }
  })

  it('audit summarize + kind routing cover the new actions', async () => {
    const { summarizeAction, kindForAction } = await import('@/backend/lib/audit')
    expect(kindForAction('inventory.count')).toBe('inventory')
    expect(kindForAction('inventory.count.post')).toBe('inventory')
    expect(kindForAction('inventory.count.schedule')).toBe('inventory')
    expect(summarizeAction('inventory.count', { counts: [{}, {}], countedBy: 'Otieno' }, {}))
      .toContain('Physical stock count recorded (2 lines) by Otieno')
    expect(summarizeAction('inventory.count', { counts: [{}], countedBy: 'Otieno', blind: true }, {}))
      .toContain('(blind)')
    expect(summarizeAction('inventory.count.post', {}, { countId: 'c123', movements: [{ movementId: 'm1' }] }))
      .toContain('Count-linked adjustments posted (1 movements)')
    expect(summarizeAction('inventory.count.schedule', {}, { intervalDays: 7, cleared: false }))
      .toContain('Stock count cadence set: every 7 day(s)')
    expect(summarizeAction('inventory.count.schedule', {}, { intervalDays: null, cleared: true }))
      .toContain('Stock count cadence cleared')
  })
})
