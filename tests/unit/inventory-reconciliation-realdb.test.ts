/**
 * Stock reconciliation against a REAL SQLite database (issue #194) — the
 * critical-path companion of inventory-reconciliation.test.ts (stub suite,
 * unchanged and still green).
 *
 * The reconciliation loop only stays honest if the REAL tables enforce it:
 *
 *  · migration 16 is deployed by the real `prisma migrate deploy` (the
 *    harness applies 00→16, so a migration that deploys via `db push` but
 *    not via `deploy` — the #73 bug class — cannot pass here);
 *  · a count session writes real StockCount + StockCountItem rows with the
 *    expectedQty SNAPSHOT (derived closing at countedAt), and the raw tables
 *    agree with the service-reported variance math;
 *  · posting appends real `adjusted` StockMovement rows whose reference is
 *    'count:<countId>' (auditable lineage) and whose qty is counted −
 *    expected — verified with an independent raw-SQL read;
 *  · the movement ledger is NEVER edited: every pre-existing movement row is
 *    byte-identical after posting (raw SELECT before/after), posting only
 *    appends (DB-2 / migration-14 append-only discipline);
 *  · a zero-variance count posts NO movement rows;
 *  · a second post REFUSES (idempotent-by-refusal) with a zero-row proof;
 *  · the unique (countId, inventoryItemId) key is enforced by the database;
 *  · loadInventorySlice serves the reconciliation history — counted lines
 *    with variance, uncounted items listed separately with their derived
 *    closing AS OF countedAt;
 *  · project scoping: another project cannot post or read the count.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import {
  openStock,
  postCountAdjustments,
  receiveStock,
  recordStockCount,
  setCountCadence,
} from '@/backend/modules/inventory/service'
import { loadInventorySlice } from '@/backend/modules/inventory/repository'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

const count = (table: string, where = ''): number =>
  Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: bigint }).n)

interface RawMovement {
  id: string
  type: string
  quantity: number
  reference: string | null
  note: string | null
  recordedBy: string
  createdAt: string
}

/** Full raw movement rows for an item — the never-edited-history oracle. */
function rawMovements(inventoryItemId: string): RawMovement[] {
  return sqlite
    .prepare(
      `SELECT id, type, quantity, reference, note, recordedBy, createdAt
       FROM StockMovement WHERE inventoryItemId = ? ORDER BY createdAt, id`,
    )
    .all(inventoryItemId) as RawMovement[]
}

/** Independent raw-SQL derived closing (the movement equation). */
function rawClosing(inventoryItemId: string, asOf?: string): number {
  const row = sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type IN ('consumed', 'damaged', 'transferred_out') THEN -quantity ELSE quantity END), 0) AS closing
       FROM StockMovement WHERE inventoryItemId = ?${asOf ? ' AND createdAt <= ?' : ''}`,
    )
    .get(...(asOf ? [inventoryItemId, asOf] : [inventoryItemId])) as { closing: number }
  return row.closing
}

describe('stock reconciliation — count → variance → count-linked adjustment (real tables)', () => {
  it('walks the loop: record a count, see the variance, post the adjustments, verify the lineage', async () => {
    const project = await seedProject(prisma, { name: 'Reconcile Bungalow' })
    const opened = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 100, unitCost: 750, location: 'Site Store' })
    await receiveStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 50, unitCost: 760, reference: 'PO-2026-000042' })
    const nails = await openStock(project.id, { materialName: 'Nails', unit: 'kg', qty: 8, location: 'Site Store' })

    // (1) RECORD — the count finds 5 bags fewer than the book, nails spot-on.
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno (storekeeper)',
      note: 'end-of-month stocktake',
      counts: [
        { inventoryItemId: opened.inventoryItemId, countedQty: 145 },
        { inventoryItemId: nails.inventoryItemId, countedQty: 8 },
      ],
    })
    expect(recorded.itemCount).toBe(2)
    const cement = recorded.variances.find((v) => v.inventoryItemId === opened.inventoryItemId)!
    expect(cement.expectedQty).toBe(150) // 100 + 50 — the derived closing at count time
    expect(cement.variance).toBe(5) // expected − counted
    const nailLine = recorded.variances.find((v) => v.inventoryItemId === nails.inventoryItemId)!
    expect(nailLine.variance).toBe(0)

    // Real rows: StockCount open + two StockCountItems with pinned snapshots.
    const countRow = sqlite
      .prepare('SELECT id, status, countedBy, note FROM StockCount WHERE id = ?')
      .get(recorded.countId) as { id: string; status: string; countedBy: string; note: string }
    expect(countRow.status).toBe('open')
    expect(countRow.countedBy).toBe('Otieno (storekeeper)')
    expect(countRow.note).toBe('end-of-month stocktake')
    const lineRows = sqlite
      .prepare('SELECT inventoryItemId, countedQty, expectedQty, postedQty FROM StockCountItem WHERE countId = ?')
      .all(recorded.countId) as Array<{ inventoryItemId: string; countedQty: number; expectedQty: number; postedQty: number | null }>
    expect(lineRows).toHaveLength(2)
    expect(lineRows.find((l) => l.inventoryItemId === opened.inventoryItemId)!.expectedQty).toBe(150)
    expect(lineRows.every((l) => l.postedQty === null)).toBe(true)

    // (2) POST — one adjusted movement for the variance, none for the spot-on line.
    const movementsBefore = rawMovements(opened.inventoryItemId)
    expect(movementsBefore).toHaveLength(2)
    const posted = await postCountAdjustments(project.id, { countId: recorded.countId, postedBy: 'Akinyi (QS)' })
    expect(posted.movements.find((m) => m.inventoryItemId === opened.inventoryItemId)!.adjustment).toBe(-5)
    expect(posted.movements.find((m) => m.inventoryItemId === nails.inventoryItemId)!.movementId).toBeNull()

    // LINEAGE on the real tables: the appended movement references the count.
    const after = rawMovements(opened.inventoryItemId)
    expect(after).toHaveLength(3)
    const adjusted = after.find((m) => m.type === 'adjusted')!
    expect(adjusted.reference).toBe(`count:${recorded.countId}`)
    expect(adjusted.quantity).toBe(-5)
    expect(adjusted.note).toContain('expected 150')
    expect(adjusted.note).toContain('counted 145')
    // And the derived closing now matches the count (independent raw SUM).
    expect(rawClosing(opened.inventoryItemId)).toBe(145)
    expect(rawClosing(nails.inventoryItemId)).toBe(8)

    // (3) NEVER EDITS HISTORY — the pre-existing rows are byte-identical.
    for (const before of movementsBefore) {
      const now = after.find((m) => m.id === before.id)!
      expect(now).toEqual(before)
    }

    // The count row flipped posted with the transition record.
    const postedRow = sqlite
      .prepare('SELECT status, postedBy, postedAt FROM StockCount WHERE id = ?')
      .get(recorded.countId) as { status: string; postedBy: string; postedAt: string }
    expect(postedRow.status).toBe('posted')
    expect(postedRow.postedBy).toBe('Akinyi (QS)')
    expect(postedRow.postedAt).toBeTruthy()
    const stamped = sqlite
      .prepare('SELECT postedQty FROM StockCountItem WHERE countId = ? AND inventoryItemId = ?')
      .get(recorded.countId, opened.inventoryItemId) as { postedQty: number }
    expect(stamped.postedQty).toBe(-5)
  })

  it('a zero-variance count posts NO movement rows but still closes the session', async () => {
    const project = await seedProject(prisma, { name: 'Clean Store' })
    const opened = await openStock(project.id, { materialName: 'Ballast', unit: 'tonne', qty: 10 })
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: opened.inventoryItemId, countedQty: 10 }],
    })
    const before = count('StockMovement')
    const posted = await postCountAdjustments(project.id, { countId: recorded.countId })
    expect(count('StockMovement')).toBe(before) // nothing appended
    expect(posted.movements[0].movementId).toBeNull()
    expect(posted.movements[0].adjustment).toBe(0)
    const row = sqlite
      .prepare('SELECT status, postedQty FROM StockCount JOIN StockCountItem ON StockCountItem.countId = StockCount.id WHERE StockCount.id = ?')
      .get(recorded.countId) as { status: string; postedQty: number }
    expect(row.status).toBe('posted')
    expect(row.postedQty).toBe(0)
  })

  it('refuses a double post with a zero-row proof (idempotent-by-refusal)', async () => {
    const project = await seedProject(prisma, { name: 'Once Only' })
    const opened = await openStock(project.id, { materialName: 'Sand', unit: 'tonne', qty: 6 })
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: opened.inventoryItemId, countedQty: 5 }],
    })
    await postCountAdjustments(project.id, { countId: recorded.countId })
    const movementsAfterFirst = rawMovements(opened.inventoryItemId).length
    await expect(postCountAdjustments(project.id, { countId: recorded.countId })).rejects.toThrow(
      /already posted/,
    )
    expect(rawMovements(opened.inventoryItemId)).toHaveLength(movementsAfterFirst) // no double-adjustment
    expect(rawClosing(opened.inventoryItemId)).toBe(5)
  })

  it('#207: posting a shortfall count that crosses an item INTO low writes ONE stock.low notification (real seam, real tables)', async () => {
    const project = await seedProject(prisma, { name: 'Shortfall Store' })
    // 100 in, no reorderLevel → the derived threshold is 10 (10% of inflow).
    const opened = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 100 })
    // The shelf count finds only 4 → adjustment −96 → closing 4 ≤ 10 → LOW.
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: opened.inventoryItemId, countedQty: 4 }],
    })
    const posted = await postCountAdjustments(project.id, { countId: recorded.countId })
    const line = posted.movements.find((m) => m.inventoryItemId === opened.inventoryItemId)!
    expect(line.lowStockCrossing).toBe(true)
    expect(line.closingQty).toBe(4)

    // The notify seam wrote exactly ONE row for the crossing: reordering
    // role, in-app channel, honest 'logged' delivery state, real quantities.
    const notes = sqlite
      .prepare(
        `SELECT kind, audienceRole, channel, deliveryStatus, title, body FROM Notification WHERE projectId = ? AND kind = 'stock.low'`,
      )
      .all(project.id) as Array<{ kind: string; audienceRole: string; channel: string; deliveryStatus: string; title: string; body: string }>
    expect(notes).toHaveLength(1)
    expect(notes[0].audienceRole).toBe('contractor')
    expect(notes[0].channel).toBe('in_app')
    expect(notes[0].deliveryStatus).toBe('logged')
    expect(notes[0].title).toBe('Low stock: Cement')
    expect(notes[0].body).toContain('4 bag')
  })

  it('enforces the StockCountItem unique (countId, inventoryItemId) at the DB level', async () => {
    const project = await seedProject(prisma, { name: 'Unique Lines' })
    const opened = await openStock(project.id, { materialName: 'Gravel', unit: 'tonne', qty: 3 })
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: opened.inventoryItemId, countedQty: 3 }],
    })
    // The service-level dedupe refuses a duplicate line in one session…
    await expect(
      recordStockCount(project.id, {
        countedBy: 'Otieno',
        counts: [
          { inventoryItemId: opened.inventoryItemId, countedQty: 1 },
          { inventoryItemId: opened.inventoryItemId, countedQty: 2 },
        ],
      }),
    ).rejects.toThrow(/counted twice in one session/)
    // …and the database constraint is real — a second row for the same
    // (count, item) pair is rejected through Prisma (P2002) and raw SQL.
    await expect(
      prisma.stockCountItem.create({
        data: { countId: recorded.countId, inventoryItemId: opened.inventoryItemId, countedQty: 1, expectedQty: 3 },
      }),
    ).rejects.toThrow(/Unique constraint failed/)
    expect(() =>
      sqlite
        .prepare(`INSERT INTO StockCountItem (id, countId, inventoryItemId, countedQty, expectedQty) VALUES ('line-dupe', ?, ?, 1, 3)`)
        .run(recorded.countId, opened.inventoryItemId),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('loadInventorySlice serves the history: variance per line, uncounted listed separately (as of countedAt)', async () => {
    const project = await seedProject(prisma, { name: 'History Store' })
    const cement = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 40, location: 'Site Store' })
    await openStock(project.id, { materialName: 'Timber', unit: 'piece', qty: 200, location: 'Lumber Yard' })

    // Count ONLY the cement line (timber stays uncounted); find 36 bags.
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: cement.inventoryItemId, countedQty: 36 }],
    })
    await postCountAdjustments(project.id, { countId: recorded.countId })

    const slice = await loadInventorySlice(project.id)
    expect(slice.counts).toHaveLength(1)
    const c = slice.counts[0]
    expect(c.status).toBe('posted')
    expect(c.countedBy).toBe('Otieno')
    expect(c.itemCount).toBe(1)
    expect(c.items).toHaveLength(1)
    expect(c.items[0].materialName).toBe('Cement')
    expect(c.items[0].expectedQty).toBe(40)
    expect(c.items[0].countedQty).toBe(36)
    expect(c.items[0].variance).toBe(4)
    expect(c.items[0].postedQty).toBe(-4)
    // The uncounted line is listed separately with its expected qty at count time.
    expect(c.uncounted).toHaveLength(1)
    expect(c.uncounted[0].materialName).toBe('Timber')
    expect(c.uncounted[0].location).toBe('Lumber Yard')
    expect(c.uncounted[0].expectedQty).toBe(200)
    // And the movement ledger carries the lineage.
    const adjusted = slice.movements.find((m) => m.type === 'adjusted')!
    expect(adjusted.reference).toBe(`count:${recorded.countId}`)
    expect(adjusted.quantity).toBe(-4)
  })

  it('uncounted expected is AS OF countedAt — movements after the count are excluded from the history view', async () => {
    const project = await seedProject(prisma, { name: 'Backdated Store' })
    const cement = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 20, location: 'Site Store' })
    const timber = await openStock(project.id, { materialName: 'Timber', unit: 'piece', qty: 50, location: 'Lumber Yard' })

    // Prisma writes SQLite DateTime as INTEGER ms since epoch — backdate the
    // timber opening two minutes so it predates the count (the physical
    // count happened a minute ago; only cement was counted).
    const now = Date.now()
    sqlite
      .prepare('UPDATE StockMovement SET createdAt = ? WHERE inventoryItemId = ?')
      .run(now - 120_000, timber.inventoryItemId)
    const countedAtMs = now - 60_000
    const recorded = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      countedAt: new Date(countedAtMs).toISOString(),
      counts: [{ inventoryItemId: cement.inventoryItemId, countedQty: 20 }],
    })
    // Timber receives 30 more pieces AFTER the count.
    await receiveStock(project.id, { materialName: 'Timber', unit: 'piece', qty: 30, location: 'Lumber Yard' })

    const slice = await loadInventorySlice(project.id)
    const c = slice.counts.find((x) => x.id === recorded.countId)!
    expect(c.uncounted).toHaveLength(1)
    // 50 pieces at count time — the 30 received afterwards are excluded.
    expect(c.uncounted[0].expectedQty).toBe(50)
    expect(rawClosing(timber.inventoryItemId, String(countedAtMs))).toBe(50)
  })

  it('keeps counts project-scoped — another project cannot post or read them', async () => {
    const projectA = await seedProject(prisma, { name: 'Scope A' })
    const projectB = await seedProject(prisma, { name: 'Scope B' })
    const opened = await openStock(projectA.id, { materialName: 'Nails', unit: 'kg', qty: 8 })
    const recorded = await recordStockCount(projectA.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: opened.inventoryItemId, countedQty: 7 }],
    })

    // B cannot post A's count…
    await expect(postCountAdjustments(projectB.id, { countId: recorded.countId })).rejects.toThrow('Stock count not found')
    // …and B's payload slice sees none of A's sessions.
    const sliceB = await loadInventorySlice(projectB.id)
    expect(sliceB.counts).toHaveLength(0)
    // A's count is still open (the foreign post attempt wrote nothing).
    const row = sqlite.prepare('SELECT status FROM StockCount WHERE id = ?').get(recorded.countId) as { status: string }
    expect(row.status).toBe('open')
  })

  // ---- REC-1 (issue #359): blind counts + scheduled cadence, real tables ----

  it('blind mode round-trips through migration 24: the row stores it, the slice serves it, the default is honest', async () => {
    const project = await seedProject(prisma, { name: 'Blind Store' })
    const cement = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 100, location: 'Site Store' })

    // A BLIND session (the counter never saw the book while typing).
    const blindCount = await recordStockCount(project.id, {
      countedBy: 'Otieno',
      blind: true,
      counts: [{ inventoryItemId: cement.inventoryItemId, countedQty: 95 }],
    })
    expect(blindCount.blind).toBe(true)
    // The real column (migration 24) — SQLite stores the boolean as 1
    // (better-sqlite3 returns BigInt for INTEGER columns).
    const rawBlind = sqlite.prepare('SELECT blind FROM StockCount WHERE id = ?').get(blindCount.countId) as { blind: bigint }
    expect(Number(rawBlind.blind)).toBe(1)

    // A VISIBLE session (the pre-#359 default).
    const visibleCount = await recordStockCount(project.id, {
      countedBy: 'Akinyi',
      counts: [{ inventoryItemId: cement.inventoryItemId, countedQty: 95 }],
    })
    expect(visibleCount.blind).toBe(false)
    const rawVisible = sqlite.prepare('SELECT blind FROM StockCount WHERE id = ?').get(visibleCount.countId) as { blind: bigint }
    expect(Number(rawVisible.blind)).toBe(0)

    // The slice serves both honestly — the history (and CSV export) can tell
    // them apart.
    const slice = await loadInventorySlice(project.id)
    expect(slice.counts.find((c) => c.id === blindCount.countId)!.blind).toBe(true)
    expect(slice.counts.find((c) => c.id === visibleCount.countId)!.blind).toBe(false)
  })

  it('the count cadence derives on read over real rows: never-counted → due, backdated last count → overdue, fresh count → not due, cleared → off', async () => {
    const project = await seedProject(prisma, { name: 'Cadence Store' })
    const cement = await openStock(project.id, { materialName: 'Cement', unit: 'bag', qty: 100, location: 'Site Store' })

    // (1) No cadence: nothing is due (the pre-#359 contract).
    expect((await loadInventorySlice(project.id)).countCadence).toEqual({
      intervalDays: null, lastCountAt: null, nextDueAt: null, due: false, overdueDays: 0,
    })

    // (2) A weekly cadence is set but the store has never been counted → due now.
    await setCountCadence(project.id, { intervalDays: 7 })
    const rawInterval = sqlite.prepare('SELECT countIntervalDays FROM Project WHERE id = ?').get(project.id) as { countIntervalDays: bigint }
    expect(Number(rawInterval.countIntervalDays)).toBe(7)
    const never = (await loadInventorySlice(project.id)).countCadence
    expect(never.intervalDays).toBe(7)
    expect(never.due).toBe(true)
    expect(never.lastCountAt).toBeNull()

    // (3) A count 8 days ago (backdated countedAt) → overdue by ≥ 1 day.
    await recordStockCount(project.id, {
      countedBy: 'Otieno',
      countedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      counts: [{ inventoryItemId: cement.inventoryItemId, countedQty: 100 }],
    })
    const overdue = (await loadInventorySlice(project.id)).countCadence
    expect(overdue.due).toBe(true)
    expect(overdue.overdueDays).toBeGreaterThanOrEqual(1)
    expect(overdue.lastCountAt).toBeTruthy()

    // (4) A fresh count (countedAt now) resets the clock → not due, next due in ~7 days.
    await recordStockCount(project.id, {
      countedBy: 'Otieno',
      counts: [{ inventoryItemId: cement.inventoryItemId, countedQty: 100 }],
    })
    const fresh = (await loadInventorySlice(project.id)).countCadence
    expect(fresh.due).toBe(false)
    expect(fresh.overdueDays).toBe(0)
    expect(fresh.nextDueAt).toBeTruthy()
    const daysToNext = (new Date(fresh.nextDueAt!).getTime() - Date.now()) / 86_400_000
    expect(daysToNext).toBeGreaterThan(6.9)
    expect(daysToNext).toBeLessThanOrEqual(7)

    // (5) Clearing the cadence turns everything off — no phantom schedule.
    await setCountCadence(project.id, { intervalDays: null })
    const cleared = (await loadInventorySlice(project.id)).countCadence
    expect(cleared.intervalDays).toBeNull()
    expect(cleared.due).toBe(false)
    expect(cleared.nextDueAt).toBeNull()
    // lastCountAt still reports the honest history.
    expect(cleared.lastCountAt).toBeTruthy()
  })
})
