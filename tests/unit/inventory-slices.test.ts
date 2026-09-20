/**
 * Inventory slice-loader aggregation (issue #195 / audit TEST-5 residual) —
 * src/backend/modules/inventory/repository.ts `loadInventorySlice`.
 *
 * This is where every stock number the product shows is computed: the
 * per-type sums, the transferred netting (out − in), the closing formula,
 * the last-cost stock value and the newest-first movement flattening. A
 * regression here silently corrupts every Materials tab, CSV export and
 * reconciliation view with no test failing — until now.
 *
 * Pinned here over the stubbed tables (the issue's own idiom, mirroring
 * tests/unit/inventory-atomicity.test.ts):
 *
 *  · per-type sums for ALL eight movement types on one kitchen-sink item,
 *    and the closing = Σ signed-deltas equation read off the row fields;
 *  · transferredQty is the NET out − in, pinned on BOTH sides of a transfer
 *    pair (sender positive, destination negative, round-trip mirrors);
 *  · stockValue multiplies the closing by the LATEST cost-bearing
 *    movement's unitCost (not the first, not the newest row, not 0);
 *  · stockValue is 0 when no movement ever carried a cost;
 *  · the flattened movement list is NEWEST-FIRST across all items (not
 *    grouped per item), with the item's name/unit denormalized onto every
 *    row and cents→KSh on unitCost;
 *  · project scoping: another project's items/movements never leak, and an
 *    empty project yields the empty-slice shape (counts included);
 *  · item rows do NOT double-carry the movement log (the loader strips it
 *    from the items array — movements live in the flat list only).
 *  · #207: lowStock is COMPUTED from the one documented rule (explicit
 *    reorderLevel when set, else closing ≤ 10% of opening+received+
 *    returned, zero-inflow never low) — above/below threshold, the exact
 *    boundary, and the zero-inflow guard are pinned in their own describe.
 *
 * Deliberately NOT duplicated here (already pinned elsewhere — see the PR
 * coverage map): the service write paths + qty validation
 * (inventory-atomicity.test.ts, #119), the same aggregation against the
 * REAL engine incl. the append-only ladder and unique keys
 * (inventory-realdb.test.ts, #184), and the counts/uncounted history half
 * of the slice (inventory-reconciliation*.test.ts, #194).
 *
 * #282 RESOLVED (2026-09-21): unitCost is integer CENTS in the column —
 * the fixtures below seed honest cents (KSh 750 → 75,000n) and the loader
 * converts once at this DTO boundary. The stockValue/unitCost assertions
 * are the CORRECT units (they pinned the ÷100 drift before the fix).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of inventoryItem.findMany (with the
// movements include + orderBy createdAt desc the loader relies on for the
// "latest cost" rule) and stockCount.findMany for loadInventorySlice.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    items: new Map<string, Record<string, unknown>>(),
    movements: new Map<string, Record<string, unknown>>(),
    counts: new Map<string, Record<string, unknown>>(),
    countItems: new Map<string, Record<string, unknown>>(),
    reset() {
      state.items.clear()
      state.movements.clear()
      state.counts.clear()
      state.countItems.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const movementsFor = (itemId: string) =>
    [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)

  const inventoryItem = {
    // The shape loadInventorySlice calls: where.projectId + include
    // movements ordered newest-first (the loader's lastCost rule DEPENDS on
    // this ordering — the stub must reproduce it, not just return rows).
    async findMany({ where }: { where: { projectId: string } }) {
      return [...state.items.values()]
        .filter((i) => i.projectId === where.projectId)
        .map((i) => ({
          ...i,
          movements: movementsFor(i.id as string).sort(
            (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
          ),
        }))
    },
  }
  const stockCount = {
    async findMany({ where, take }: { where: { projectId: string }; take?: number }) {
      const rows = [...state.counts.values()]
        .filter((c) => c.projectId === where.projectId)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .slice(0, take ?? Number.POSITIVE_INFINITY)
      return rows.map((c) => ({
        ...c,
        items: [...state.countItems.values()]
          .filter((line) => line.countId === c.id)
          .map((line) => ({ ...line, inventoryItem: { ...state.items.get(line.inventoryItemId as string)! } })),
      }))
    },
  }
  const db = { inventoryItem, stockCount, __state: state }
  return { db }
})

import { db } from '@/backend/lib/db'
import { loadInventorySlice } from '@/backend/modules/inventory/repository'

type StubState = {
  items: Map<string, Record<string, unknown>>
  movements: Map<string, Record<string, unknown>>
  counts: Map<string, Record<string, unknown>>
  countItems: Map<string, Record<string, unknown>>
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state

const P = 'proj-1'
const OTHER = 'proj-2'

// Fixed, distinct timestamps so newest-first ordering is deterministic.
const T = (h: number) => new Date(`2026-09-01T${String(8 + h).padStart(2, '0')}:00:00.000Z`)

interface SeedMovement {
  type: string
  quantity: number
  unitCost?: bigint | null
  reference?: string | null
  requestLineId?: string | null
  note?: string | null
  recordedBy?: string
  at: Date
}

/** Seed one inventory item with its full movement log (append-only order). */
function seedItem(
  projectId: string,
  spec: { materialName: string; unit?: string; location?: string; supplierId?: string | null; reorderLevel?: number | null },
  movements: SeedMovement[],
): string {
  const id = `item_${++state.seq}`
  state.items.set(id, {
    id,
    projectId,
    materialName: spec.materialName,
    unit: spec.unit ?? 'bag',
    location: spec.location ?? 'Site Store',
    supplierId: spec.supplierId ?? null,
    reorderLevel: spec.reorderLevel ?? null, // #207 column, null = derived default
    updatedAt: T(0),
  })
  movements.forEach((m, i) => {
    const mid = `mv_${++state.seq}_${i}`
    state.movements.set(mid, {
      id: mid,
      inventoryItemId: id,
      type: m.type,
      quantity: m.quantity,
      // Integer CENTS in the column (#282 normalized) — KSh 750 → 75,000n.
      unitCost: m.unitCost === undefined ? null : m.unitCost,
      reference: m.reference ?? null,
      // #203: consumption attribution — null = unattributed/legacy.
      requestLineId: m.requestLineId ?? null,
      note: m.note ?? null,
      recordedBy: m.recordedBy ?? 'Site Manager',
      createdAt: m.at,
    })
  })
  return id
}

beforeEach(() => {
  state.reset()
})

describe('loadInventorySlice — per-type sums and the closing formula (stubbed tables)', () => {
  it('sums every movement type and closes over the signed-delta equation', async () => {
    // One kitchen-sink item: all eight types, including a transfer back in.
    seedItem(P, { materialName: 'Cement', unit: 'bag' }, [
      { type: 'opening', quantity: 100, unitCost: 750n, at: T(1) },
      { type: 'received', quantity: 50, unitCost: 760n, at: T(2) },
      { type: 'consumed', quantity: 30, at: T(3) },
      { type: 'transferred_out', quantity: 20, at: T(4) },
      { type: 'transferred_in', quantity: 15, at: T(5) },
      { type: 'returned', quantity: 3, at: T(6) },
      { type: 'damaged', quantity: 5, at: T(7) },
      { type: 'adjusted', quantity: -8, at: T(8) },
    ])

    const slice = await loadInventorySlice(P)
    expect(slice.items).toHaveLength(1)
    const row = slice.items[0]
    expect(row.materialName).toBe('Cement')
    expect(row.unit).toBe('bag')
    expect(row.location).toBe('Site Store')
    expect(row.supplierId).toBeNull()
    expect(row.updatedAt).toBe(T(0).toISOString())

    // Per-type sums — each is the Σ of that type's quantities.
    expect(row.openingQty).toBe(100)
    expect(row.receivedQty).toBe(50)
    expect(row.consumedQty).toBe(30)
    expect(row.transferredQty).toBe(5) // out 20 − in 15 (the NET)
    expect(row.returnedQty).toBe(3)
    expect(row.damagedQty).toBe(5)
    expect(row.adjustedQty).toBe(-8) // signed by design

    // The closing formula: opening + received + returned + adjusted +
    // (transferred_in − transferred_out) − consumed − damaged, read off the
    // row's OWN fields (a self-consistency oracle for the sums above).
    expect(row.closingQty).toBe(100 + 50 + 3 - 8 + (15 - 20) - 30 - 5)
    expect(row.closingQty).toBe(105)

    // #207: lowStock is COMPUTED now — closing 105 vs inflow 153 (100
    // opening + 50 received + 3 returned) × 10% = 15.3 → 105 is comfortably
    // above → false for a REAL reason, not the old hardcoded literal.
    expect(row.lowStock).toBe(false)
    expect(row.reorderLevel).toBeNull()
  })

  it('transferredQty is the NET out − in on BOTH sides of a transfer pair', async () => {
    // Site Store sends 12 bags to the Workshop, gets 7 back.
    const store = seedItem(P, { materialName: 'Cement', location: 'Site Store' }, [
      { type: 'opening', quantity: 40, at: T(1) },
      { type: 'transferred_out', quantity: 12, at: T(2) },
      { type: 'transferred_in', quantity: 7, at: T(3) },
    ])
    const workshop = seedItem(P, { materialName: 'Cement', location: 'Workshop' }, [
      { type: 'transferred_in', quantity: 12, at: T(2) },
      { type: 'transferred_out', quantity: 7, at: T(3) },
    ])

    const slice = await loadInventorySlice(P)
    const from = slice.items.find((i) => i.id === store)!
    const to = slice.items.find((i) => i.id === workshop)!

    // Sender: 12 out, 7 in → net +5. A "sum out only" regression shows 12;
    // a "sum both" regression shows 19; a sign flip shows −5.
    expect(from.transferredQty).toBe(5)
    expect(from.closingQty).toBe(40 - 12 + 7) // 35
    // Destination: 12 in, 7 out → net −12 + 7 = −5 (the mirror image).
    expect(to.transferredQty).toBe(-5)
    expect(to.closingQty).toBe(12 - 7) // 5
  })
})

describe('loadInventorySlice — stockValue from the latest cost-bearing movement', () => {
  it('multiplies the closing by the LATEST movement that carries a unitCost', async () => {
    // Mixed-cost history: opened @ KSh 750 (75,000 cents), topped up @
    // KSh 760 (76,000 cents), then three cost-less movements AFTER the last
    // cost (the hard case — the latest ROW is not the latest COST).
    seedItem(P, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 100, unitCost: 75_000n, at: T(1) },
      { type: 'received', quantity: 50, unitCost: 76_000n, at: T(2) },
      { type: 'consumed', quantity: 30, at: T(3) },
      { type: 'damaged', quantity: 5, at: T(4) },
      { type: 'adjusted', quantity: -10, at: T(5) },
    ])

    const slice = await loadInventorySlice(P)
    const row = slice.items[0]
    expect(row.closingQty).toBe(105)

    // #282 normalized — the units are honest now: stockValue = closing ×
    // the LATEST cost in CENTS (mulQtyCents), converted to KSh once at this
    // DTO boundary: 105 × 76,000 cents = 7,980,000 cents → KSh 79,800.
    // The value being pinned is the ARITHMETIC: closing × the LATEST cost
    // (KSh 760), not the FIRST (KSh 750 → 78,750), not the newest row
    // (null → 0), i.e. exactly 79,800.
    expect(row.stockValue).toBe(79_800)
  })

  it('falls back to 0 when no movement ever carried a cost', async () => {
    seedItem(P, { materialName: 'Ballast' }, [
      { type: 'opening', quantity: 10, at: T(1) },
      { type: 'consumed', quantity: 4, at: T(2) },
    ])
    const slice = await loadInventorySlice(P)
    expect(slice.items[0].closingQty).toBe(6)
    expect(slice.items[0].stockValue).toBe(0) // lastCost ?? 0n
  })
})

describe('loadInventorySlice — newest-first movement flattening', () => {
  it('flattens movements across ALL items newest-first, denormalizing name/unit onto every row', async () => {
    const ballast = seedItem(P, { materialName: 'Ballast', unit: 'tonne' }, [
      { type: 'opening', quantity: 10, unitCost: 90_000n, at: T(1), reference: 'GRN-1', note: 'initial', recordedBy: 'Otieno' },
      { type: 'consumed', quantity: 2, at: T(3) },
    ])
    const nails = seedItem(P, { materialName: 'Nails', unit: 'kg', location: 'Workshop' }, [
      { type: 'opening', quantity: 8, at: T(2) },
      { type: 'damaged', quantity: 1, at: T(4) },
    ])

    const slice = await loadInventorySlice(P)
    expect(slice.movements).toHaveLength(4)

    // Interleaved timestamps ACROSS items → the flat list is globally
    // newest-first (T4, T3, T2, T1), not grouped per item.
    expect(slice.movements.map((m) => m.createdAt)).toEqual([
      T(4).toISOString(),
      T(3).toISOString(),
      T(2).toISOString(),
      T(1).toISOString(),
    ])

    // Row field mapping: the item's materialName/unit are denormalized onto
    // every movement; id/inventoryItemId/reference/note/recordedBy pass
    // through; createdAt is an ISO string.
    const newest = slice.movements[0]
    expect(newest.inventoryItemId).toBe(nails)
    expect(newest.materialName).toBe('Nails')
    expect(newest.unit).toBe('kg')
    expect(newest.type).toBe('damaged')
    expect(newest.quantity).toBe(1)
    expect(newest.unitCost).toBeNull()
    const oldest = slice.movements[3]
    expect(oldest.inventoryItemId).toBe(ballast)
    expect(oldest.materialName).toBe('Ballast')
    expect(oldest.unit).toBe('tonne')
    expect(oldest.type).toBe('opening')
    expect(oldest.quantity).toBe(10)
    // #282 normalized: 90,000 cents in the column → KSh 900 at this DTO
    // boundary (the drifted fixture showed 9).
    expect(oldest.unitCost).toBe(900)
    expect(oldest.reference).toBe('GRN-1')
    expect(oldest.note).toBe('initial')
    expect(oldest.recordedBy).toBe('Otieno')
    expect(new Date(oldest.createdAt).toISOString()).toBe(oldest.createdAt) // ISO round-trips
  })

  it('#203: serves the structured consumption attribution (requestLineId) on the movement DTO', async () => {
    seedItem(P, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 30, at: T(2), requestLineId: 'mrl_cement' },
      { type: 'consumed', quantity: 10, at: T(3) }, // unattributed — the legacy shape
      { type: 'received', quantity: 5, at: T(4), requestLineId: 'mrl_cement' }, // non-consume types carry it through unmapped
    ])
    const slice = await loadInventorySlice(P)
    // The DTO is the BOQ-vs-actual view's contract: the consumed column
    // joins on requestLineId, so the field must ride the payload exactly as
    // stored (attributed row keeps it; legacy row reads null — never
    // undefined, which would break { requestLineId: null } consumers).
    const attributed = slice.movements.find((m) => m.type === 'consumed' && m.quantity === 30)!
    expect(attributed.requestLineId).toBe('mrl_cement')
    const legacy = slice.movements.find((m) => m.type === 'consumed' && m.quantity === 10)!
    expect(legacy.requestLineId).toBeNull()
    const passthrough = slice.movements.find((m) => m.type === 'received')!
    expect(passthrough.requestLineId).toBe('mrl_cement')
  })
})

describe('loadInventorySlice — project scoping + slice shape', () => {
  it("never leaks another project's items or movements; an empty project yields the empty slice", async () => {
    seedItem(P, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 30, at: T(2) },
    ])
    seedItem(OTHER, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 5, at: T(1) },
    ])

    const mine = await loadInventorySlice(P)
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0].closingQty).toBe(70)
    expect(mine.movements).toHaveLength(2)

    const theirs = await loadInventorySlice(OTHER)
    expect(theirs.items).toHaveLength(1)
    expect(theirs.items[0].closingQty).toBe(5)
    expect(theirs.movements).toHaveLength(1)

    // A project with nothing at all: the full empty-slice shape, counts
    // slot included (the #194 half is pinned in the reconciliation suites).
    const empty = await loadInventorySlice('proj-empty')
    expect(empty).toEqual({ items: [], movements: [], counts: [] })
  })

  it('item rows do NOT double-carry the movement log (movements live in the flat list only)', async () => {
    seedItem(P, { materialName: 'Cement' }, [{ type: 'opening', quantity: 10, at: T(1) }])
    const slice = await loadInventorySlice(P)
    expect(slice.items).toHaveLength(1)
    expect('movements' in slice.items[0]).toBe(false)
    expect(slice.movements).toHaveLength(1) // …but the log is served once, flat
  })
})

describe('loadInventorySlice — #207 honest lowStock (ONE rule: reorderLevel, else 10% of inflow)', () => {
  it('derived default: closing at or below 10% of inflow is LOW, above is not', async () => {
    // Healthy: 100 in, 80 consumed → closing 20 > 10 (10% of 100) → not low.
    seedItem(P, { materialName: 'Healthy cement' }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 80, at: T(2) },
    ])
    // Low: 100 in, 95 consumed → closing 5 ≤ 10 → LOW.
    seedItem(P, { materialName: 'Drained cement' }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 95, at: T(2) },
    ])
    // The exact boundary: closing == 10% of inflow → LOW (the rule is ≤).
    seedItem(P, { materialName: 'Boundary cement' }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 90, at: T(2) },
    ])

    const slice = await loadInventorySlice(P)
    const byName = (n: string) => slice.items.find((i) => i.materialName === n)!
    expect(byName('Healthy cement').closingQty).toBe(20)
    expect(byName('Healthy cement').lowStock).toBe(false)
    expect(byName('Drained cement').closingQty).toBe(5)
    expect(byName('Drained cement').lowStock).toBe(true)
    expect(byName('Boundary cement').closingQty).toBe(10)
    expect(byName('Boundary cement').lowStock).toBe(true)
  })

  it('the derived denominator counts opening + received + returned — NOT transfers or adjustments', async () => {
    // Transfers move stock between the project's own locations: they are not
    // inflow on either side. 40 in, 30 transferred out → closing 10, inflow
    // 40 → 10 > 4 → NOT low (counting transfers as inflow would still say
    // not-low here; the pin is the denominator's shape).
    seedItem(P, { materialName: 'Transfer-only source' }, [
      { type: 'opening', quantity: 40, at: T(1) },
      { type: 'transferred_out', quantity: 30, at: T(2) },
    ])
    // A destination that only ever received stock BY TRANSFER: closing 10,
    // inflow 0 → never low (zero-inflow guard — the v1 client heuristic's
    // own no-inflow protection, now server-owned).
    seedItem(P, { materialName: 'Transfer-only destination', location: 'Workshop' }, [
      { type: 'transferred_in', quantity: 10, at: T(2) },
    ])
    // Returns count as inflow: 5 opening + 5 returned, 9 consumed →
    // closing 1, inflow 10 → 1 ≤ 1 → LOW.
    seedItem(P, { materialName: 'Returned stock' }, [
      { type: 'opening', quantity: 5, at: T(1) },
      { type: 'returned', quantity: 5, at: T(2) },
      { type: 'consumed', quantity: 9, at: T(3) },
    ])

    const slice = await loadInventorySlice(P)
    const byName = (n: string) => slice.items.find((i) => i.materialName === n)!
    expect(byName('Transfer-only source').lowStock).toBe(false)
    expect(byName('Transfer-only destination').lowStock).toBe(false)
    expect(byName('Returned stock').lowStock).toBe(true)
  })

  it('a zero-inflow item is NEVER low under the derived default (no basis for a percentage)', async () => {
    // The classic false-positive the guard kills: a fresh line with a single
    // consumed movement... cannot exist (guards refuse over-consumption), but
    // an adjusted-to-zero line with no inflow can: closing 0, inflow 0 →
    // 0 ≤ 0 × 0.1 would be TRUE without the guard. Never low.
    seedItem(P, { materialName: 'Adjusted to nothing' }, [
      { type: 'adjusted', quantity: -4, at: T(1) },
    ])
    const slice = await loadInventorySlice(P)
    expect(slice.items[0].closingQty).toBe(-4)
    expect(slice.items[0].lowStock).toBe(false)
  })

  it('an explicit reorderLevel governs outright — including where the derived default would disagree', async () => {
    // Derived would say NOT low (50 > 100×10%); the operator's reorder point
    // of 60 says the pile is already too small → LOW. The threshold wins.
    seedItem(P, { materialName: 'Threshold makes it low', reorderLevel: 60 }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 50, at: T(2) },
    ])
    // Derived would say LOW (8 ≤ 100×10%); reorderLevel 5 says reordering
    // only matters below 5 → NOT low. The threshold wins in BOTH directions.
    seedItem(P, { materialName: 'Threshold spares it', reorderLevel: 5 }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 92, at: T(2) },
    ])
    // The boundary: closing == reorderLevel → LOW (≤, mirroring the derived
    // rule's own boundary semantics).
    seedItem(P, { materialName: 'Boundary on the level', reorderLevel: 25 }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 75, at: T(2) },
    ])
    // reorderLevel 0 = "alert only at stockout": closing 3 is fine, 0 is low.
    seedItem(P, { materialName: 'Stockout-only alert', reorderLevel: 0 }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 97, at: T(2) },
    ])
    seedItem(P, { materialName: 'Stockout reached', reorderLevel: 0 }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 100, at: T(2) },
    ])

    const slice = await loadInventorySlice(P)
    const byName = (n: string) => slice.items.find((i) => i.materialName === n)!
    expect(byName('Threshold makes it low').lowStock).toBe(true)
    expect(byName('Threshold spares it').lowStock).toBe(false)
    expect(byName('Boundary on the level').closingQty).toBe(25)
    expect(byName('Boundary on the level').lowStock).toBe(true)
    expect(byName('Stockout-only alert').closingQty).toBe(3)
    expect(byName('Stockout-only alert').lowStock).toBe(false)
    expect(byName('Stockout reached').closingQty).toBe(0)
    expect(byName('Stockout reached').lowStock).toBe(true)
  })

  it('surfaces the reorderLevel itself on the row (null when unset, the number when set)', async () => {
    seedItem(P, { materialName: 'No level' }, [{ type: 'opening', quantity: 10, at: T(1) }])
    seedItem(P, { materialName: 'With level', reorderLevel: 7 }, [{ type: 'opening', quantity: 10, at: T(1) }])
    const slice = await loadInventorySlice(P)
    const byName = (n: string) => slice.items.find((i) => i.materialName === n)!
    expect(byName('No level').reorderLevel).toBeNull()
    expect(byName('With level').reorderLevel).toBe(7)
  })
})
