/**
 * Inventory atomicity (DB-2) — src/backend/modules/inventory/service.ts.
 *
 * Closing stock is derived from the append-only StockMovement log, so the
 * service write paths are the invariant's last line of defence:
 *  · over-consumption is rejected BEFORE any movement row is persisted;
 *  · return / damage / adjust report the REAL derived closing (the old code
 *    hardcoded closingQty: 0);
 *  · a transfer's out+in legs are ONE atomic unit — the second write failing
 *    rolls the first one back too.
 *
 * Mirrors tests/unit/ledger.test.ts: @/backend/lib/db is swapped for an
 * in-memory stub whose $transaction snapshots state and restores it on throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of inventoryItem / stockMovement /
// $transaction for the movement core. __state exposes the tables for
// assertions; failOnMovementType injects a write failure for rollback tests.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    items: new Map<string, Record<string, unknown>>(),
    movements: new Map<string, Record<string, unknown>>(),
    // #203: request lines for the consumption-attribution scope guard.
    requests: new Map<string, Record<string, unknown>>(),
    requestLines: new Map<string, Record<string, unknown>>(),
    failOnMovementType: null as string | null,
    reset() {
      state.items.clear()
      state.movements.clear()
      state.requests.clear()
      state.requestLines.clear()
      state.seq = 0
      state.failOnMovementType = null
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const movementsFor = (itemId: string) =>
    [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)

  const inventoryItem = {
    async upsert({ where, update, create }: { where: { projectId_materialName_location: Record<string, string> }; update: Record<string, unknown>; create: Record<string, unknown> }) {
      const key = where.projectId_materialName_location
      const existing = [...state.items.values()].find(
        (i) => i.projectId === key.projectId && i.materialName === key.materialName && i.location === key.location,
      )
      if (existing) {
        // Replace (never mutate in place) so $transaction snapshots restore cleanly.
        const updated = {
          ...existing,
          unit: update.unit,
          ...(update.supplierId !== undefined ? { supplierId: update.supplierId } : {}),
        }
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
  }
  const stockMovement = {
    async create({ data }: { data: Record<string, unknown> }) {
      if (state.failOnMovementType && data.type === state.failOnMovementType) {
        throw new Error(`stub: simulated failure writing ${String(data.type)}`)
      }
      const m: Record<string, unknown> = { id: nid('mv'), createdAt: new Date(), ...data }
      state.movements.set(m.id as string, m)
      return { ...m }
    },
  }
  const materialRequestLine = {
    // #203: the scope guard's read — line by id, request scoped to the
    // caller's project (consumeStock's findItem twin).
    async findFirst({ where }: { where: { id: string; request: { projectId: string } } }) {
      const line = state.requestLines.get(where.id)
      if (!line) return null
      const req = state.requests.get(line.requestId as string)
      return req && req.projectId === where.request.projectId ? { ...line } : null
    },
  }
  const db = {
    inventoryItem,
    stockMovement,
    materialRequestLine,
    async $transaction(fn: (tx: typeof db) => unknown) {
      const items = new Map(state.items)
      const movements = new Map(state.movements)
      const requests = new Map(state.requests)
      const requestLines = new Map(state.requestLines)
      try {
        return await fn(db)
      } catch (err) {
        state.items = items
        state.movements = movements
        state.requests = requests
        state.requestLines = requestLines
        throw err
      }
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { derivedClosingQty } from '@/backend/modules/inventory/repository'
import {
  adjustStock, consumeStock, damageStock, openStock, receiveStock, returnStock, transferStock,
} from '@/backend/modules/inventory/service'

type StubState = {
  items: Map<string, Record<string, unknown>>
  movements: Map<string, Record<string, unknown>>
  requests: Map<string, Record<string, unknown>>
  requestLines: Map<string, Record<string, unknown>>
  failOnMovementType: string | null
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state
const movementsOf = (itemId: string) =>
  [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)

const P = 'proj-1'
async function seedItem(qty = 10): Promise<string> {
  const r = await openStock(P, { materialName: 'Cement', unit: 'bags', qty, location: 'Site Store', unitCost: 750 })
  return r.inventoryItemId
}

/** Seed a request + one line (the #203 attribution target) in the stub. */
function seedRequestLine(projectId: string, qty = 50): string {
  const rid = `mr_${++state.seq}`
  state.requests.set(rid, { id: rid, projectId, requestCode: `MR-${1000 + state.seq}` })
  const lid = `mrl_${++state.seq}`
  state.requestLines.set(lid, { id: lid, requestId: rid, materialName: 'Cement', unit: 'bags', qty })
  return lid
}

beforeEach(() => {
  state.reset()
})

describe('consumeStock — over-consumption never persists (DB-2)', () => {
  it('rejects consuming more than closing stock and writes no movement row', async () => {
    const itemId = await seedItem(10)
    await expect(consumeStock(P, { inventoryItemId: itemId, qty: 15 })).rejects.toThrow(
      'Cannot consume more than closing stock',
    )
    expect(movementsOf(itemId).filter((m) => m.type === 'consumed')).toHaveLength(0)
    expect(state.movements.size).toBe(1) // only the opening row survives
    expect(derivedClosingQty(movementsOf(itemId))).toBe(10)
  })

  it('accepts consumption up to the exact closing stock and reports it', async () => {
    const itemId = await seedItem(10)
    const r = await consumeStock(P, { inventoryItemId: itemId, qty: 10 })
    expect(r.closingQty).toBe(0)
    expect(movementsOf(itemId)).toHaveLength(2)
  })

  it('reports the real projected closing after a partial consumption', async () => {
    const itemId = await seedItem(10)
    const r = await consumeStock(P, { inventoryItemId: itemId, qty: 4 })
    expect(r.closingQty).toBe(6)
  })

  it('unknown item id is rejected', async () => {
    await expect(consumeStock(P, { inventoryItemId: 'nope', qty: 1 })).rejects.toThrow('Inventory item not found')
  })
})

describe('consumeStock — structured consumption attribution (#203)', () => {
  it('stamps the movement with the validated requestLineId', async () => {
    const itemId = await seedItem(10)
    const lineId = seedRequestLine(P, 50)
    const r = await consumeStock(P, { inventoryItemId: itemId, qty: 4, requestLineId: lineId })
    expect(r.closingQty).toBe(6) // the attribution changes nothing about the ledger math
    const consumed = movementsOf(itemId).find((m) => m.type === 'consumed')!
    expect(consumed.requestLineId).toBe(lineId)
  })

  it('refuses an unknown or FOREIGN-PROJECT requestLineId with no movement persisted', async () => {
    const itemId = await seedItem(10)
    const foreignLine = seedRequestLine('proj-2', 50) // another project's line
    await expect(consumeStock(P, { inventoryItemId: itemId, qty: 4, requestLineId: foreignLine })).rejects.toThrow(
      'Request line not found in this project',
    )
    await expect(consumeStock(P, { inventoryItemId: itemId, qty: 4, requestLineId: 'ghost' })).rejects.toThrow(
      'Request line not found in this project',
    )
    expect(movementsOf(itemId).filter((m) => m.type === 'consumed')).toHaveLength(0)
    expect(state.movements.size).toBe(1) // only the opening row
  })

  it('absent / empty / null requestLineId stays UNATTRIBUTED (null) — the pre-#203 shape', async () => {
    const itemId = await seedItem(10)
    await consumeStock(P, { inventoryItemId: itemId, qty: 1 })
    await consumeStock(P, { inventoryItemId: itemId, qty: 1, requestLineId: '' })
    await consumeStock(P, { inventoryItemId: itemId, qty: 1, requestLineId: null })
    const consumed = movementsOf(itemId).filter((m) => m.type === 'consumed')
    expect(consumed).toHaveLength(3)
    for (const m of consumed) expect(m.requestLineId).toBeNull()
  })

  it('every other movement type writes requestLineId null (receipts attribute through the delivery chain)', async () => {
    const lineId = seedRequestLine(P, 50)
    await openStock(P, { materialName: 'Cement', unit: 'bags', qty: 10, location: 'Site Store' })
    const itemId = [...state.items.values()][0]!.id as string
    // receiveStock ignores any requestLineId in the payload — only the
    // consume path accepts attribution.
    await receiveStock(P, { materialName: 'Cement', unit: 'bags', location: 'Site Store', qty: 5, requestLineId: lineId })
    await returnStock(P, { inventoryItemId: itemId, qty: 1 })
    for (const m of movementsOf(itemId)) {
      if (m.type !== 'consumed') expect(m.requestLineId).toBeNull()
    }
  })
})

describe('return / damage / adjust — real derived closing, not a hardcoded 0 (DB-2)', () => {
  it('returnStock adds the returned qty to the derived closing', async () => {
    const itemId = await seedItem(10)
    await consumeStock(P, { inventoryItemId: itemId, qty: 4 }) // closing 6
    const r = await returnStock(P, { inventoryItemId: itemId, qty: 3, note: 'unused bags back' })
    expect(r.type).toBe('returned')
    expect(r.closingQty).toBe(9)
  })

  it('damageStock subtracts from the derived closing', async () => {
    const itemId = await seedItem(10)
    const r = await damageStock(P, { inventoryItemId: itemId, qty: 2, damageNote: 'rain damage' })
    expect(r.type).toBe('damaged')
    expect(r.closingQty).toBe(8)
  })

  it('adjustStock applies the signed adjustment to the derived closing', async () => {
    const itemId = await seedItem(10)
    const up = await adjustStock(P, { inventoryItemId: itemId, qty: 5, reason: 'count correction' })
    expect(up.closingQty).toBe(15)
    const down = await adjustStock(P, { inventoryItemId: itemId, qty: -3, reason: 'count correction' })
    expect(down.closingQty).toBe(12)
  })

  it('every result matches the repository movement-sum oracle', async () => {
    const itemId = await seedItem(10)
    await receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 5, location: 'Site Store' })
    await consumeStock(P, { inventoryItemId: itemId, qty: 3 })
    const r = await damageStock(P, { inventoryItemId: itemId, qty: 2 })
    expect(r.closingQty).toBe(derivedClosingQty(movementsOf(itemId)))
    expect(r.closingQty).toBe(10)
  })
})

describe('transferStock — atomic out+in legs (DB-2)', () => {
  it('moves stock between locations as one unit with real closings on both sides', async () => {
    const itemId = await seedItem(10)
    const r = await transferStock(P, { inventoryItemId: itemId, qty: 4, toLocation: 'Workshop' })
    expect(movementsOf(itemId).map((m) => m.type)).toContain('transferred_out')
    const toId = r.to.inventoryItemId as string
    expect(toId).not.toBe(itemId)
    expect(movementsOf(toId).map((m) => m.type)).toEqual(['transferred_in'])
    expect(derivedClosingQty(movementsOf(itemId))).toBe(6)
    expect(derivedClosingQty(movementsOf(toId))).toBe(4)
  })

  it('rejects transferring more than closing stock (nothing persisted)', async () => {
    const itemId = await seedItem(3)
    await expect(transferStock(P, { inventoryItemId: itemId, qty: 5, toLocation: 'Workshop' })).rejects.toThrow(
      'Cannot transfer more than closing stock',
    )
    expect(state.movements.size).toBe(1)
    expect(state.items.size).toBe(1)
  })

  it('rolls the out leg back when the in leg write fails', async () => {
    const itemId = await seedItem(10)
    state.failOnMovementType = 'transferred_in'
    await expect(transferStock(P, { inventoryItemId: itemId, qty: 4, toLocation: 'Workshop' })).rejects.toThrow(
      /simulated failure writing transferred_in/,
    )
    const legs = [...state.movements.values()].filter((m) => m.type === 'transferred_out' || m.type === 'transferred_in')
    expect(legs).toHaveLength(0) // neither leg survived
    expect(state.items.size).toBe(1) // the destination item creation rolled back too
    expect(derivedClosingQty(movementsOf(itemId))).toBe(10)
  })
})

describe('input validation — every movement action refuses a bad qty before any write (#210)', () => {
  // Bad inputs the /api/actions surface (and the offline outbox) can hand the
  // service: negative, zero, NaN, Infinity, non-numeric strings, absurd sizes.
  const BAD = [
    ['negative', -50],
    ['zero', 0],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['non-numeric string', 'abc'],
    ['empty string', ''],
    ['null', null],
    ['absurd (over the 1e9 cap)', 2e9],
  ] as const

  // One seed so item-scoped actions have a real target; the new-line actions
  // (open/receive) upsert by name and need no seed.
  async function target(): Promise<string> {
    return seedItem(10)
  }

  const CALLERS = {
    'inventory.open': async (qty: unknown) => openStock(P, { materialName: 'Cement', unit: 'bags', qty, location: 'Site Store' }),
    'inventory.receive': async (qty: unknown) => receiveStock(P, { materialName: 'Cement', unit: 'bags', qty, location: 'Site Store' }),
    'inventory.consume': async (qty: unknown) => consumeStock(P, { inventoryItemId: await target(), qty }),
    'inventory.transfer': async (qty: unknown) => transferStock(P, { inventoryItemId: await target(), qty, toLocation: 'Workshop' }),
    'inventory.return': async (qty: unknown) => returnStock(P, { inventoryItemId: await target(), qty }),
    'inventory.damage': async (qty: unknown) => damageStock(P, { inventoryItemId: await target(), qty }),
    // adjust is signed by design — negative is VALID, so its bad list drops it.
    'inventory.adjust': async (qty: unknown) => adjustStock(P, { inventoryItemId: await target(), qty }),
  } as const

  for (const [action, call] of Object.entries(CALLERS)) {
    describe(`${action} refuses a bad qty before any write`, () => {
      const cases = action === 'inventory.adjust' ? BAD.filter(([, v]) => v !== -50) : BAD
      it.each(cases)('%s', async (_label, qty) => {
        await expect(call(qty)).rejects.toThrow(`${action}: qty`)
        // The refusal is BEFORE any write: no movement row survived (only the
        // seed's opening row exists where one was seeded), and no NEW item was
        // created (open/receive upserts never happened).
        const movementRows = [...state.movements.values()].filter((m) => m.type !== 'opening')
        expect(movementRows).toHaveLength(0)
        const seededOrNone = action === 'inventory.open' || action === 'inventory.receive' ? 0 : 1
        expect(state.items.size).toBe(seededOrNone)
      })
    })
  }

  it('adjust stays signed by design: negative adjusts down, positive up, zero is a no-op refused', async () => {
    const itemId = await seedItem(10)
    const down = await adjustStock(P, { inventoryItemId: itemId, qty: -3, reason: 'count correction' })
    expect(down.closingQty).toBe(7)
    const up = await adjustStock(P, { inventoryItemId: itemId, qty: 2, reason: 'count correction' })
    expect(up.closingQty).toBe(9)
    await expect(adjustStock(P, { inventoryItemId: itemId, qty: 0 })).rejects.toThrow(
      'inventory.adjust: qty cannot be zero',
    )
  })

  it('numeric strings coerce (outbox replay semantics) — the honest legacy behavior stays', async () => {
    const r = await receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: '5', location: 'Site Store' })
    expect(r.quantity).toBe(5)
    expect(r.closingQty).toBe(5)
  })

  it('unitCost is validated where accepted: negative / NaN / >2-dp refused, zero and absent pass (#282 boundary)', async () => {
    await expect(
      openStock(P, { materialName: 'Cement', unit: 'bags', qty: 10, location: 'Site Store', unitCost: -1 }),
    ).rejects.toThrow('inventory.open: unitCost must be a non-negative KSh amount')
    await expect(
      receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 10, location: 'Site Store', unitCost: 'free' }),
    ).rejects.toThrow('inventory.receive: unitCost must be a non-negative KSh amount')
    // #282: the boundary parses like money (#122) — sub-KSh precision is 2 dp.
    await expect(
      receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 10, location: 'Site Store', unitCost: 750.555 }),
    ).rejects.toThrow(/no more than 2 decimal places/)
    const zero = await openStock(P, { materialName: 'Cement', unit: 'bags', qty: 10, location: 'Site Store', unitCost: 0 })
    expect(zero.closingQty).toBe(10)
    const none = await receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 5, location: 'Site Store' })
    expect(none.closingQty).toBe(15)
  })

  it('unitCost crosses the boundary as KSh and is STORED as integer cents (#282)', async () => {
    // The payload is the frontend "Unit cost (KSh)" contract; the BigInt
    // column holds cents. parseUnitCost is the one conversion point.
    await openStock(P, { materialName: 'Cement', unit: 'bags', qty: 10, location: 'Site Store', unitCost: 750 })
    await receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 5, location: 'Site Store', unitCost: 12.5 })
    const rows = [...state.movements.values()]
    expect(rows.find((m) => m.type === 'opening')?.unitCost).toBe(75_000n)
    expect(rows.find((m) => m.type === 'received')?.unitCost).toBe(1_250n) // KSh 12.50
    // Absent → null (no cost recorded); zero → 0n (a real zero-cost row).
    await receiveStock(P, { materialName: 'Ballast', unit: 'tonne', qty: 2, location: 'Site Store' })
    await openStock(P, { materialName: 'Sand', unit: 'tonne', qty: 1, location: 'Site Store', unitCost: 0 })
    const all = [...state.movements.values()]
    const ballastItem = [...state.items.values()].find((i) => i.materialName === 'Ballast')!
    expect(all.find((m) => m.inventoryItemId === ballastItem.id)?.unitCost).toBeNull()
    expect(all.find((m) => m.unitCost === 0n)?.type).toBe('opening') // the Sand row
  })

  it('the absurd-qty cap speaks honestly (unit mistakes, not digits)', async () => {
    await expect(
      receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 1e12, location: 'Site Store' }),
    ).rejects.toThrow(/per-movement cap of 1,000,000,000/)
  })
})
