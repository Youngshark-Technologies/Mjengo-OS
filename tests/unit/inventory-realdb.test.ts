/**
 * Site Store movements against a REAL SQLite database (issue #184 / audit
 * TEST-2) — the critical-path companion of inventory-atomicity.test.ts
 * (stub suite, unchanged and still green).
 *
 * Stock is NEVER stored: closing quantities are derived from the append-only
 * StockMovement log (spec §33/§35), so the derivation is only ever as honest
 * as the engine that appends and reads the rows. Pinned here against the
 * real tables:
 *
 *  · every movement type posts a real StockMovement row and reports the REAL
 *    derived closing (opening/receive/consume/transfer/return/damage/adjust);
 *  · the inventory equation holds over the real log — closing = opening +
 *    received + returned + transferred_in + adjusted − consumed − damaged −
 *    transferred_out — cross-checked with an independent raw-SQL SUM;
 *  · over-consumption and over-transfers throw BEFORE any row is written
 *    (DB-2: the projection happens inside the transaction, so a refused
 *    movement leaves the log untouched — real rollback, not stub courtesy);
 *  · transfers write their out+in legs as ONE atomic unit keyed to two
 *    InventoryItems (the unique (projectId, materialName, location) key is
 *    real — same material at a second location is a distinct item);
 *  · the InventoryItem unique constraint is enforced by the database
 *    (P2002 through Prisma, UNIQUE through the raw handle);
 *  · loadInventorySlice (the project payload's read side) agrees with the
 *    service-reported closing quantities and per-type sums, and derives
 *    stock value from the last known unit cost;
 *  · unitCost is integer CENTS end-to-end (issue #282, normalized 2026-09-21):
 *    the action payload carries KSh (the frontend "Unit cost (KSh)" contract
 *    and the offline outbox replay), the service converts at parseUnitCost,
 *    the column stores cents, and loadInventorySlice converts back — write
 *    KSh at the boundary → stored cents → read back KSh, asserted against a
 *    raw-SQL oracle on the column itself.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import {
  adjustStock,
  consumeStock,
  damageStock,
  openStock,
  receiveStock,
  returnStock,
  transferStock,
} from '@/backend/modules/inventory/service'
import { loadInventorySlice } from '@/backend/modules/inventory/repository'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

const count = (table: string, where = ''): number =>
  Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: bigint }).n)

/** Independent raw-SQL closing stock for one item (the movement equation). */
function rawClosing(inventoryItemId: string): number {
  const row = sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type IN ('consumed', 'damaged', 'transferred_out') THEN -quantity ELSE quantity END), 0) AS closing
       FROM StockMovement WHERE inventoryItemId = ?`,
    )
    .get(inventoryItemId) as { closing: number }
  return row.closing
}

describe('movement posting + derived closing stock (real tables)', () => {
  it('walks the full movement ladder: opening → receive → consume → transfer → return → damage → adjust', async () => {
    const project = await seedProject(prisma)

    const opened = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 100, unitCost: 750, location: 'Site Store' })
    expect(opened.type).toBe('opening')
    expect(opened.closingQty).toBe(100)

    const received = await receiveStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 50, unitCost: 760, reference: 'PO-2026-000042' })
    expect(received.closingQty).toBe(150)
    expect(received.inventoryItemId).toBe(opened.inventoryItemId) // same item — same (project, material, location)

    // #282 — the units oracle on the REAL column: the payload said KSh (the
    // "Unit cost (KSh)" contract), the column holds integer CENTS. The
    // pre-normalization drift stored the raw KSh number here (750/760) and
    // every read side then divided by 100 again.
    const storedCost = (type: string) =>
      (sqlite.prepare(`SELECT unitCost FROM StockMovement WHERE inventoryItemId = ? AND type = ?`).get(opened.inventoryItemId, type) as { unitCost: bigint }).unitCost
    expect(storedCost('opening')).toBe(75_000n)
    expect(storedCost('received')).toBe(76_000n)

    const consumed = await consumeStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 30, reference: 'foundation pour' })
    expect(consumed.closingQty).toBe(120)

    const transfer = await transferStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 20, toLocation: 'Laying Area' })
    expect(transfer.from.movementId).toBeTruthy()
    expect(transfer.to.movementId).toBeTruthy()
    // Two REAL items now — the transfer legs point at different rows.
    expect(transfer.from.inventoryItemId).not.toBe(transfer.to.inventoryItemId)

    const returned = await returnStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 3, note: 'unused bags back' })
    expect(returned.closingQty).toBe(120 - 20 + 3) // 103

    const damaged = await damageStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 5, damageNote: 'rain damage' })
    expect(damaged.closingQty).toBe(98)

    const adjusted = await adjustStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: -8, reason: 'count correction' })
    expect(adjusted.closingQty).toBe(90)

    // ------------------------------------------------ the inventory equation, twice
    // (a) from the real movement log via an independent raw-SQL SUM…
    expect(rawClosing(opened.inventoryItemId)).toBe(90)
    const destItem = await prisma.inventoryItem.findFirstOrThrow({
      where: { projectId: project.id, materialName: 'Cement', location: 'Laying Area' },
    })
    expect(rawClosing(destItem.id)).toBe(20)
    // (b) …and (b) from the payload read side: loadInventorySlice agrees with
    // the service-reported numbers and the per-type sums.
    const slice = await loadInventorySlice(project.id)
    expect(slice.items).toHaveLength(2)
    const store = slice.items.find((i) => i.location === 'Site Store')!
    const laying = slice.items.find((i) => i.location === 'Laying Area')!
    expect(store.openingQty).toBe(100)
    expect(store.receivedQty).toBe(50)
    expect(store.consumedQty).toBe(30)
    expect(store.transferredQty).toBe(20) // out of this location
    expect(store.returnedQty).toBe(3)
    expect(store.damagedQty).toBe(5)
    expect(store.adjustedQty).toBe(-8)
    expect(store.closingQty).toBe(90)
    expect(laying.closingQty).toBe(20)
    // #282 normalized: unitCost is integer CENTS in the column, so stockValue
    // = closing × LATEST cost, computed in cents then converted once —
    // 90 bags × 76,000 cents = 6,840,000 cents → KSh 68,400 (the drifted
    // writer era showed 684 — ÷100 — pinned then, fixed now).
    expect(store.stockValue).toBe(68_400)
    // The append-only log is intact: opening + received + consumed +
    // transferred_out + transferred_in + returned + damaged + adjusted = 8.
    expect(slice.movements).toHaveLength(8)
    // The DTO is the KSh read boundary: movement rows carry KSh numbers.
    const receiveRow = slice.movements.find((m) => m.type === 'received')!
    expect(receiveRow.unitCost).toBe(760)
  })

  it('normalizes unitCost to integer cents end-to-end: KSh in at the action boundary → cents stored → KSh out (issue #282)', async () => {
    const project = await seedProject(prisma, { name: 'Cents Walk' })

    // KSh 798 typed into the "Unit cost (KSh)" field → 79,800 cents in the
    // column; a sub-KSh cost (KSh 12.50) exercises the 2-dp money contract.
    const opened = await openStock(project.id, { materialName: 'Deformed bar', unit: 'length', qty: 3, unitCost: 798, location: 'Site Store' })
    await receiveStock(project.id, { materialName: 'Deformed bar', unit: 'length', qty: 2, unitCost: 12.5 })

    // STORED — raw SQL on the column: integer cents, never a KSh number.
    const storedCost = (type: string) =>
      (sqlite.prepare(`SELECT unitCost FROM StockMovement WHERE inventoryItemId = ? AND type = ?`).get(opened.inventoryItemId, type) as { unitCost: bigint }).unitCost
    expect(storedCost('opening')).toBe(79_800n)
    expect(storedCost('received')).toBe(1_250n)

    // READ BACK — the payload DTO is the KSh boundary: movements carry KSh
    // numbers, and stockValue is computed in cents (closing × LATEST cost)
    // and converted once: 5 × 1,250 cents = 6,250 cents → KSh 62.50.
    const slice = await loadInventorySlice(project.id)
    expect(slice.movements.find((m) => m.type === 'opening')?.unitCost).toBe(798)
    expect(slice.movements.find((m) => m.type === 'received')?.unitCost).toBe(12.5)
    expect(slice.items[0].closingQty).toBe(5)
    expect(slice.items[0].stockValue).toBe(62.5)

    // The boundary also validates like money (#122): a >2-dp KSh cost is
    // refused BEFORE any row is written.
    const before = count('StockMovement')
    await expect(
      receiveStock(project.id, { materialName: 'Deformed bar', unit: 'length', qty: 1, unitCost: 760.555 }),
    ).rejects.toThrow(/no more than 2 decimal places/)
    expect(count('StockMovement')).toBe(before)
  })

  it('refuses over-consumption and over-transfers WITHOUT writing a movement row (DB-2 rollback)', async () => {
    const project = await seedProject(prisma)
    const opened = await openStock(project.id, { materialName: 'Ballast', unit: 'tonne', qty: 10 })
    const before = count('StockMovement')

    await expect(consumeStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 11 })).rejects.toThrow(
      /Cannot consume more than closing stock/,
    )
    expect(count('StockMovement')).toBe(before) // nothing persisted

    await expect(
      transferStock(project.id, { inventoryItemId: opened.inventoryItemId, qty: 10.5, toLocation: 'Far Corner' }),
    ).rejects.toThrow(/Cannot transfer more than closing stock/)
    expect(count('StockMovement')).toBe(before)

    // The item's derived closing is untouched by the refusals.
    expect(rawClosing(opened.inventoryItemId)).toBe(10)
  })

  it('enforces the InventoryItem unique key (projectId, materialName, location) at the DB level', async () => {
    const project = await seedProject(prisma)
    const a = await openStock(project.id, { materialName: 'Sand', unit: 'tonne', qty: 5 })
    // The service upserts the SAME (project, material, location) → one item.
    const b = await receiveStock(project.id, { materialName: 'Sand', unit: 'tonne', qty: 2 })
    expect(b.inventoryItemId).toBe(a.inventoryItemId)
    expect(await prisma.inventoryItem.count({ where: { projectId: project.id } })).toBe(1)

    // The database constraint is real — a second row for the same key is
    // rejected through Prisma (P2002) and through the raw handle.
    await expect(
      prisma.inventoryItem.create({
        data: { projectId: project.id, materialName: 'Sand', unit: 'tonne', location: 'Site Store' },
      }),
    ).rejects.toThrow(/Unique constraint failed/)
    expect(() =>
      sqlite
        .prepare(`INSERT INTO InventoryItem (id, projectId, materialName, unit, location, createdAt, updatedAt) VALUES ('item-dupe', ?, 'Sand', 'tonne', 'Site Store', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(project.id),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('keeps movements append-only per project scope — another project cannot see or spend them', async () => {
    const projectA = await seedProject(prisma, { name: 'Store A' })
    const projectB = await seedProject(prisma, { name: 'Store B' })
    await openStock(projectA.id, { materialName: 'Nails', unit: 'kg', qty: 8 })

    // Different project → a DIFFERENT item row (its own Site Store), and the
    // consume from B cannot touch A's stock (the id is scoped by findFirst).
    const itemB = await openStock(projectB.id, { materialName: 'Nails', unit: 'kg', qty: 4 })
    expect(itemB.inventoryItemId).not.toEqual((await prisma.inventoryItem.findFirstOrThrow({ where: { projectId: projectA.id } })).id)
    await expect(consumeStock(projectB.id, { inventoryItemId: itemB.inventoryItemId, qty: 5 })).rejects.toThrow(
      /Cannot consume more than closing stock/,
    )
    // A's stock is untouched: still 8, one item per project.
    const sliceA = await loadInventorySlice(projectA.id)
    expect(sliceA.items).toHaveLength(1)
    expect(sliceA.items[0].closingQty).toBe(8)
  })
})

describe('InventoryItem.supplierId write-time validation (DB-9, issue #127)', () => {
  // supplierId is a soft FK → Supplier. The registry decision (ADR 0010):
  // validated at the ONE write seam (upsertItem — open/receive/transfer all
  // flow through it), so a dangling id can never be stored going forward.
  // Pre-existing rows are unswept (additive house rule — documented choice).

  it('accepts a known supplier and stores the link', async () => {
    const project = await seedProject(prisma)
    const supplier = await prisma.supplier.create({ data: { businessName: 'Kamulu Builders', county: 'Nairobi' } })

    const opened = await openStock(project.id, { materialName: 'Ballast', unit: 'tonne', qty: 10, unitCost: 1200, supplierId: supplier.id })
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: opened.inventoryItemId } })
    expect(item.supplierId).toBe(supplier.id)
  })

  it('rejects a dangling supplierId — nothing written (real rollback, movement log untouched)', async () => {
    const project = await seedProject(prisma)
    await expect(
      openStock(project.id, { materialName: 'Sand', unit: 'tonne', qty: 5, unitCost: 900, supplierId: 'supplier-that-never-was' }),
    ).rejects.toThrow('Supplier not found: supplier-that-never-was')
    // The whole movement transaction rolled back — no item, no movement row.
    expect(await prisma.inventoryItem.count({ where: { projectId: project.id } })).toBe(0)
    expect(await prisma.stockMovement.count({ where: { projectId: project.id } })).toBe(0)
  })

  it('rejects a dangling supplierId on the receive path too (the same upsertItem seam)', async () => {
    const project = await seedProject(prisma)
    await expect(
      receiveStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 5, unitCost: 750, supplierId: 'ghost-supplier' }),
    ).rejects.toThrow('Supplier not found: ghost-supplier')
    expect(await prisma.inventoryItem.count({ where: { projectId: project.id } })).toBe(0)
  })

  it('an empty-string supplierId normalizes to no link (not a dangling empty id)', async () => {
    const project = await seedProject(prisma)
    const opened = await openStock(project.id, { materialName: 'Nails', unit: 'kg', qty: 2, unitCost: 200, supplierId: '' })
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: opened.inventoryItemId } })
    expect(item.supplierId).toBeNull()
  })

  it('omitting supplierId entirely stays legal (the optional-link contract)', async () => {
    const project = await seedProject(prisma)
    const opened = await openStock(project.id, { materialName: 'Timber', unit: 'm', qty: 3, unitCost: 500 })
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: opened.inventoryItemId } })
    expect(item.supplierId).toBeNull()
  })
})
