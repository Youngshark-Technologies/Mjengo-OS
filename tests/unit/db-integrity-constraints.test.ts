/**
 * DB integrity constraints (DB-6/DB-7/DB-8) — prisma/migrations/*.
 *
 * The shipped SQLite path enforced almost nothing at the database level:
 * attendance day-rows were unique only by convention (findFirst-then-create
 * in the appliers), supply/invoice business codes not at all, and the
 * hot-path lookups (ledger balance by account, closing stock by item,
 * attendance by project+day) were full table scans.
 *
 * This suite replays the REAL migration SQL — every migration.sql under
 * prisma/migrations, in numeric folder order — against a
 * real better-sqlite3 :memory: database (same runtime the rate-limit store
 * uses in production) and pins migration 10:
 *  · a duplicate Attendance (workerId, date) row is REJECTED by the DB;
 *  · duplicate (projectId, orderCode) PurchaseOrder and (projectId,
 *    invoiceCode) Invoice rows are rejected — while the same code in a
 *    DIFFERENT project stays legal (the generators are per-project);
 *  · every hot-path index exists in sqlite_master.
 *
 * Migration 21 (DB-9, issue #127) — the soft-FK sweep's one CONSTRAIN case,
 * pinned the same way: Transaction.ledgerTxnId is UNIQUE (the schema comment
 * claimed "unique per txn" for years while the DB enforced nothing):
 *  · a second Transaction row with the same ledgerTxnId is REJECTED;
 *  · NULL stays unconstrained (SQLite unique indexes skip NULLs — the legacy
 *    pre-ledger rows are unaffected, any number of NULLs is legal);
 *  · applying the migration over a pre-existing duplicate corpus fails
 *    loudly — the 10_integrity_constraints precedent, that is the point.
 *
 * Migration 14 (DB-3, issue #124) — ledger invariants, pinned the same way
 * (direct SQL, no Prisma in the loop, so the TRIGGERS are what's under
 * test — exactly the writer the issue worried about):
 *  · the posting gate: pending→posted with unbalanced (or zero) legs is
 *    REJECTED; balanced legs post — the SQLite equivalent of the Supabase
 *    deferred balanced-legs constraint (0002_rls.sql L344-366);
 *  · ledger rows are append-only: LedgerEntry UPDATE/DELETE and
 *    LedgerTransaction DELETE are rejected;
 *  · the LedgerTransaction update whitelist: only pending→posted and
 *    posted→reversed (+reversalRef) are legal (0002_rls.sql L309-340);
 *  · legs may only attach to a pending transaction, and transactions are
 *    born pending — the gate cannot be skipped by direct DML;
 *  · CHECK constraints: side ∈ {debit, credit}, amount > 0;
 *  · the LedgerMaintenance flag is the documented maintenance exemption
 *    (SQLite twin of mjengo.allow_maintenance) — and the balance assertion
 *    stays ABSOLUTE even under maintenance.
 */
import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations')

/** Migration folders in numeric prefix order (0_init, 1_…, …, 10_…). */
function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d+_/.test(d))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
}

/** A real SQLite database with the full migration history applied. */
function freshDb() {
  const db = new Database(':memory:')
  for (const dir of migrationDirs()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
  }
  return db
}

let db: ReturnType<typeof freshDb>
beforeEach(() => {
  db = freshDb()
  // Parent rows for the FK graph (better-sqlite3 enforces foreign_keys=ON,
  // which also incidentally pins audit DB-12's pragma posture question).
  db.exec(`
    INSERT INTO Project (id, shareToken, name, client, location, budget, startDate, targetDate, createdAt, updatedAt) VALUES
      ('p-1', 'tok-1', 'Bungalow', 'Client One', 'Nairobi', 2800000, '2026-01-06 08:00:00', '2026-12-18 17:00:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('p-2', 'tok-2', 'Duplex', 'Client Two', 'Kiambu', 5200000, '2026-02-02 08:00:00', '2027-03-19 17:00:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO Worker (id, projectId, name, role, phone, dailyRate, active) VALUES
      ('w-1', 'p-1', 'Wanjala Otieno', 'fundi', '0700000001', 800, 1),
      ('w-2', 'p-1', 'Achieng Milka', 'fundi', '0700000002', 750, 1);
    INSERT INTO Supplier (id, businessName, county, createdAt, updatedAt) VALUES
      ('sup-1', 'Nairobi Cement Works', 'Nairobi', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `)
})

describe('migration replay', () => {
  it('every migration folder parses and applies in folder order', () => {
    expect(() => freshDb()).not.toThrow()
    expect(migrationDirs().length).toBeGreaterThanOrEqual(11)
  })

  it('migration 10_integrity_constraints is part of the chain', () => {
    expect(migrationDirs()).toContain('10_integrity_constraints')
  })

  it('migration 14_ledger_invariants is part of the chain', () => {
    expect(migrationDirs()).toContain('14_ledger_invariants')
  })

  it('migration 18_reorder_level is part of the chain (#207 low-stock threshold)', () => {
    expect(migrationDirs()).toContain('18_reorder_level')
    // And it is a pure additive ALTER: the column exists, nullable, no default.
    const cols = db.prepare(`PRAGMA table_info(InventoryItem)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
    const col = cols.find((c) => c.name === 'reorderLevel')
    expect(col).toBeDefined()
    expect(col!.notnull).toBe(0)
    expect(col!.dflt_value).toBeNull()
  })
})

describe('Attendance day-row uniqueness (DB-7)', () => {
  const insert = () =>
    db.prepare(
      `INSERT INTO Attendance (id, workerId, projectId, date, wage) VALUES (?, ?, ?, ?, 100)`,
    )

  it('rejects a second (workerId, date) row', () => {
    insert().run('att-1', 'w-1', 'p-1', '2026-09-16')
    expect(() => insert().run('att-2', 'w-1', 'p-1', '2026-09-16')).toThrow(/UNIQUE constraint failed/)
  })

  it('still allows the same worker on a different day, and a different worker the same day', () => {
    insert().run('att-1', 'w-1', 'p-1', '2026-09-16')
    expect(() => insert().run('att-2', 'w-1', 'p-1', '2026-09-15')).not.toThrow()
    expect(() => insert().run('att-3', 'w-2', 'p-1', '2026-09-16')).not.toThrow()
  })
})

describe('business-code uniqueness (DB-8)', () => {
  const insertOrder = () =>
    db.prepare(
      `INSERT INTO PurchaseOrder (id, orderCode, projectId, supplierId, subtotal, total, createdByRole, createdAt, updatedAt)
       VALUES (?, ?, ?, 'sup-1', 100, 100, 'contractor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
  const insertInvoice = () =>
    db.prepare(
      `INSERT INTO Invoice (id, invoiceCode, projectId, createdAt, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )

  it('rejects a duplicate (projectId, orderCode) PurchaseOrder', () => {
    insertOrder().run('po-1', 'PO-2026-000010', 'p-1')
    expect(() => insertOrder().run('po-2', 'PO-2026-000010', 'p-1')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows the same orderCode in a different project (per-project generator)', () => {
    insertOrder().run('po-1', 'PO-2026-000010', 'p-1')
    expect(() => insertOrder().run('po-2', 'PO-2026-000010', 'p-2')).not.toThrow()
  })

  it('rejects a duplicate (projectId, invoiceCode) Invoice', () => {
    insertInvoice().run('inv-1', 'INV-2026-000031', 'p-1')
    expect(() => insertInvoice().run('inv-2', 'INV-2026-000031', 'p-1')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows the same invoiceCode in a different project (per-project generator)', () => {
    insertInvoice().run('inv-1', 'INV-2026-000031', 'p-1')
    expect(() => insertInvoice().run('inv-2', 'INV-2026-000031', 'p-2')).not.toThrow()
  })
})

describe('Transaction.ledgerTxnId uniqueness (DB-9, migration 21)', () => {
  const insertTxn = (id: string, ledgerTxnId: string | null) =>
    db
      .prepare(
        `INSERT INTO "Transaction" (id, projectId, type, amount, method, ledgerTxnId, date)
         VALUES (?, 'p-1', 'material', 100, 'mpesa', ?, '2026-09-16 10:00:00')`,
      )
      .run(id, ledgerTxnId)

  it('migration 21_transaction_ledger_txn_unique is part of the chain', () => {
    expect(migrationDirs()).toContain('21_transaction_ledger_txn_unique')
  })

  it('the unique index exists in sqlite_master', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get('Transaction_ledgerTxnId_key')
    expect(row).toEqual({ name: 'Transaction_ledgerTxnId_key' })
  })

  it('rejects a second Transaction row with the same ledgerTxnId', () => {
    insertTxn('t-1', 'lt-uniq-1')
    expect(() => insertTxn('t-2', 'lt-uniq-1')).toThrow(/UNIQUE constraint failed: Transaction.ledgerTxnId/)
  })

  it('different ledgerTxnIds stay legal (one money event each)', () => {
    insertTxn('t-3', 'lt-uniq-2')
    expect(() => insertTxn('t-4', 'lt-uniq-3')).not.toThrow()
  })

  it('NULL stays unconstrained — any number of legacy pre-ledger rows is legal', () => {
    // SQLite unique indexes treat NULLs as distinct: the rows written before
    // the double-entry ledger (and the delivery/payroll legacy rows that
    // never carried a link) are untouched by the constraint.
    insertTxn('t-legacy-1', null)
    insertTxn('t-legacy-2', null)
    insertTxn('t-legacy-3', null)
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM "Transaction" WHERE ledgerTxnId IS NULL`).get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(3)
  })

  it('fails loudly on pre-existing duplicates — applying 21 over a dup corpus throws (the point)', () => {
    // The 10_integrity_constraints precedent: the constraint creation is the
    // tripwire. The findFirst-??-create writers cannot produce dupes except
    // through a race; a race survivor set must be reconciled by hand.
    const old = new Database(':memory:')
    for (const dir of migrationDirs()) {
      if (parseInt(dir, 10) > 20) break
      old.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
    }
    old.exec(`
      INSERT INTO Project (id, shareToken, name, client, location, budget, startDate, targetDate, createdAt, updatedAt)
        VALUES ('p-dup', 'tok-dup', 'Dupes', 'C', 'N', 100, '2026-01-01', '2026-12-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Transaction" (id, projectId, type, amount, method, ledgerTxnId, date) VALUES
        ('t-dup-1', 'p-dup', 'material', 100, 'mpesa', 'lt-race', '2026-09-16 10:00:00'),
        ('t-dup-2', 'p-dup', 'material', 100, 'mpesa', 'lt-race', '2026-09-16 10:00:00');
    `)
    expect(() =>
      old.exec(readFileSync(join(MIGRATIONS_DIR, '21_transaction_ledger_txn_unique', 'migration.sql'), 'utf8')),
    ).toThrow(/UNIQUE constraint failed/)
    old.close()
  })
})

describe('hot-path indexes exist (DB-6)', () => {
  const EXPECTED_INDEXES = [
    'Attendance_workerId_date_key',
    'Attendance_projectId_date_idx',
    'PurchaseOrder_projectId_orderCode_key',
    'Invoice_projectId_invoiceCode_key',
    'LedgerEntry_accountId_idx',
    'StockMovement_inventoryItemId_idx',
    // Migration 15 (issue #144) — the audit's remaining hot paths.
    'JobRecord_status_runAt_idx',
    'Notification_projectId_read_idx',
    'Notification_projectId_createdAt_idx',
    'AuditEvent_projectId_createdAt_idx',
  ]

  it.each(EXPECTED_INDEXES)('%s exists in sqlite_master', (name) => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)
    expect(row).toEqual({ name })
  })
})

describe('migration 15 — the hot-path indexes serve the REAL query shapes (issue #144)', () => {
  /** The planner's chosen access path for a query, as one detail string. */
  const plan = (sql: string): string => {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
    return rows.map((r) => r.detail).join(' | ')
  }

  it('the job drain (status IN (queued,retrying) + runAt <= now, ORDER BY runAt) is index-backed', () => {
    // runDueJobs' exact WHERE/ORDER — the pg_cron 5-min drainer's read.
    const p = plan(
      `SELECT * FROM JobRecord WHERE status IN ('queued', 'retrying') AND runAt <= '2026-09-18T00:00:00Z' ORDER BY runAt ASC LIMIT 10`,
    )
    expect(p).toContain('JobRecord_status_runAt_idx')
  })

  it('the notifications list (projectId + ORDER BY createdAt DESC, the `before` keyset) is index-backed', () => {
    // /api/notifications project-scoped reads (post-#157 owner roles must
    // NAME the project) + project timeline + mjengo payload reads.
    const p = plan(`SELECT * FROM Notification WHERE "projectId" = 'p-1' AND "createdAt" < '2026-09-18T00:00:00Z' ORDER BY "createdAt" DESC LIMIT 50`)
    expect(p).toContain('Notification_projectId_createdAt_idx')
  })

  it('the unread reads / markRead (projectId + read = false) are index-backed', () => {
    // The unread filter of the same list + markRead's updateMany WHERE.
    const p = plan(`SELECT * FROM Notification WHERE "projectId" = 'p-1' AND "read" = 0`)
    expect(p).toContain('Notification_projectId_read_idx')
  })

  it('the audit timeline (projectId + ORDER BY createdAt DESC, keyset after the boundary row) is index-backed', () => {
    // project.ts timeline take-60 / mjengo.ts take-120 / audit.ts keyset.
    const p = plan(`SELECT * FROM AuditEvent WHERE "projectId" = 'p-1' ORDER BY "createdAt" DESC, "id" DESC LIMIT 60`)
    expect(p).toContain('AuditEvent_projectId_createdAt_idx')
  })
})

describe('migration 14 — ledger balance + append-only invariants (DB-3, issue #124)', () => {
  // Direct-SQL writers, deliberately bypassing the TypeScript service — the
  // exact threat model of the issue. Helpers mirror the service's write
  // sequence: born pending → attach legs → mark posted.
  const insertTxn = (id: string, status: string, ref = `LX-2026-${id}`) =>
    db
      .prepare(
        `INSERT INTO LedgerTransaction (id, ref, projectId, description, occurredAt, postedBy, postedRole, status, createdAt)
         VALUES (?, ?, 'p-1', 'test txn', '2026-09-16 10:00:00', 'tester', 'finance', ?, CURRENT_TIMESTAMP)`,
      )
      .run(id, ref, status)
  const insertLeg = (id: string, txnId: string, side: string, amount: number) =>
    db
      .prepare(
        `INSERT INTO LedgerEntry (id, txnId, accountId, side, amount, createdAt) VALUES (?, ?, 'acct-1', ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(id, txnId, side, amount)
  const markPosted = (id: string) =>
    db.prepare(`UPDATE LedgerTransaction SET status = 'posted' WHERE id = ?`).run(id)
  /** A fully posted balanced transaction (500 debit / 500 credit). */
  const postBalanced = (id: string) => {
    insertTxn(id, 'pending')
    insertLeg(`${id}-d`, id, 'debit', 500)
    insertLeg(`${id}-c`, id, 'credit', 500)
    markPosted(id)
  }

  beforeEach(() => {
    db.prepare(
      `INSERT INTO LedgerAccount (id, code, name, kind, normalSide, ownerType, active, createdAt)
       VALUES ('acct-1', 'TEST:CASH', 'Test cash', 'asset', 'debit', 'platform', 1, CURRENT_TIMESTAMP)`,
    ).run()
  })

  describe('posting gate — Σdebits = Σcredits (0002_rls.sql L344-366 parity)', () => {
    it('rejects marking an unbalanced transaction posted', () => {
      insertTxn('t-1', 'pending')
      insertLeg('e-1', 't-1', 'debit', 500)
      insertLeg('e-2', 't-1', 'credit', 300)
      expect(() => markPosted('t-1')).toThrow(/unbalanced ledger transaction/)
      // the failed transition leaves the row pending — never half-posted
      expect(db.prepare(`SELECT status FROM LedgerTransaction WHERE id = 't-1'`).get()).toEqual({ status: 'pending' })
    })

    it('rejects marking a leg-less transaction posted', () => {
      insertTxn('t-1', 'pending')
      expect(() => markPosted('t-1')).toThrow(/unbalanced ledger transaction/)
    })

    it('accepts a balanced transaction (the service flow, replayed in raw SQL)', () => {
      expect(() => postBalanced('t-1')).not.toThrow()
      expect(db.prepare(`SELECT status FROM LedgerTransaction WHERE id = 't-1'`).get()).toEqual({ status: 'posted' })
    })

    it('rejects a transaction born posted — the gate cannot be skipped by direct DML', () => {
      expect(() => insertTxn('t-1', 'posted')).toThrow(/born pending/)
    })

    it('rejects legs attached to a non-pending (posted) transaction', () => {
      postBalanced('t-1')
      expect(() => insertLeg('e-late', 't-1', 'debit', 100)).toThrow(/may only attach to a pending transaction/)
    })
  })

  describe('append-only rows (0002_rls.sql L281-305 parity)', () => {
    it('rejects LedgerEntry UPDATE', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`UPDATE LedgerEntry SET amount = 1 WHERE id = 't-1-d'`).run()).toThrow(/append-only/)
    })

    it('rejects LedgerEntry DELETE', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`DELETE FROM LedgerEntry WHERE id = 't-1-d'`).run()).toThrow(/append-only/)
    })

    it('rejects LedgerTransaction DELETE', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`DELETE FROM LedgerTransaction WHERE id = 't-1'`).run()).toThrow(/append-only/)
    })

    it('rejects the Project cascade delete into ledger history (documented operational change)', () => {
      postBalanced('t-1')
      // FK-cascade deletes fire the guards (verified: SQLite runs BEFORE
      // DELETE triggers for ON DELETE CASCADE actions) — deleting a project
      // with financial history fails loudly instead of silently cascading
      // the ledger away, mirroring the Supabase design's §5.3/§9 delta.
      expect(() => db.prepare(`DELETE FROM Project WHERE id = 'p-1'`).run()).toThrow(/append-only/)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM LedgerTransaction`).get()).toEqual({ n: 1 })
    })
  })

  describe('LedgerTransaction update whitelist (0002_rls.sql L309-340 parity)', () => {
    it('allows reversal marking: posted → reversed + reversalRef', () => {
      postBalanced('t-1')
      expect(() =>
        db
          .prepare(`UPDATE LedgerTransaction SET status = 'reversed', reversalRef = 'LX-2026-t-2' WHERE id = 't-1'`)
          .run(),
      ).not.toThrow()
      const row = db.prepare(`SELECT status, reversalRef FROM LedgerTransaction WHERE id = 't-1'`).get() as {
        status: string
        reversalRef: string
      }
      expect(row).toEqual({ status: 'reversed', reversalRef: 'LX-2026-t-2' })
    })

    it('rejects editing immutable columns (description, occurredAt, ref, postedBy)', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`UPDATE LedgerTransaction SET description = 'hack' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() =>
        db.prepare(`UPDATE LedgerTransaction SET occurredAt = '2020-01-01 00:00:00' WHERE id = 't-1'`).run(),
      ).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET ref = 'LX-fake' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET postedBy = 'attacker' WHERE id = 't-1'`).run()).toThrow(/immutable/)
    })

    it('rejects status edits outside the two legal transitions', () => {
      postBalanced('t-1')
      // posted → posted (no-op), posted → pending, and reversalRef without
      // the posted → reversed move are all outside the whitelist
      expect(() => db.prepare(`UPDATE LedgerTransaction SET status = 'posted' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET status = 'pending' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET reversalRef = 'X' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      // pending → reversed skips the balance gate — rejected
      insertTxn('t-2', 'pending')
      expect(() => db.prepare(`UPDATE LedgerTransaction SET status = 'reversed' WHERE id = 't-2'`).run()).toThrow(/immutable/)
      // a reversed row is frozen
      postBalanced('t-3')
      db.prepare(`UPDATE LedgerTransaction SET status = 'reversed', reversalRef = 'LX-x' WHERE id = 't-3'`).run()
      expect(() => db.prepare(`UPDATE LedgerTransaction SET reversalRef = 'LX-y' WHERE id = 't-3'`).run()).toThrow(/immutable/)
    })
  })

  describe('CHECK constraints (0001_schema.sql L984-985 parity)', () => {
    it('rejects non-positive amounts', () => {
      insertTxn('t-1', 'pending')
      expect(() => insertLeg('e-1', 't-1', 'debit', 0)).toThrow(/LedgerEntry_amount_check/)
      expect(() => insertLeg('e-2', 't-1', 'debit', -5)).toThrow(/LedgerEntry_amount_check/)
    })

    it('rejects a side outside debit/credit', () => {
      insertTxn('t-1', 'pending')
      expect(() => insertLeg('e-1', 't-1', 'banana', 5)).toThrow(/LedgerEntry_side_check/)
    })

    it('carries both CHECKs in the table DDL (visible to introspection)', () => {
      const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'LedgerEntry'`).get() as {
        sql: string
      }
      expect(sql.sql).toContain('LedgerEntry_side_check')
      expect(sql.sql).toContain('LedgerEntry_amount_check')
    })
  })

  describe('maintenance mode — the LedgerMaintenance exemption (mjengo.allow_maintenance twin)', () => {
    const enable = () => db.prepare(`INSERT INTO LedgerMaintenance (id, allow) VALUES (1, 1)`).run()
    const disable = () => db.prepare(`UPDATE LedgerMaintenance SET allow = 0 WHERE id = 1`).run()

    it('pauses the append-only + birth-state guards while allow = 1', () => {
      postBalanced('t-1')
      enable()
      // archival ops the seeds legitimately need: wipe + born-posted backfill
      expect(() => db.prepare(`DELETE FROM LedgerEntry WHERE txnId = 't-1'`).run()).not.toThrow()
      expect(() => db.prepare(`DELETE FROM LedgerTransaction WHERE id = 't-1'`).run()).not.toThrow()
      expect(() => insertTxn('t-arch', 'posted')).not.toThrow()
      disable()
      // flag off ⇒ guards are live again
      expect(() => insertTxn('t-2', 'posted')).toThrow(/born pending/)
    })

    it('does NOT bypass the balance assertion — the invariant is absolute', () => {
      enable()
      insertTxn('t-1', 'pending')
      insertLeg('e-1', 't-1', 'debit', 500)
      insertLeg('e-2', 't-1', 'credit', 499)
      expect(() => markPosted('t-1')).toThrow(/unbalanced ledger transaction/)
      disable()
    })
  })
})

// ------------------------------------------------- migration 18 (#159 / API-8)

describe('Attachment.objectKey uniqueness (migration 18 — #159 / audit API-8)', () => {
  const insert = (id: string, objectKey: string | null) =>
    db
      .prepare(
        `INSERT INTO Attachment (id, entityType, entityId, fileName, storageKey, objectKey, kind, uploadedBy, reviewStatus)
         VALUES (?, 'photo', 'unattached', 'upp-1712345678-abcd12.png', '/photos/upp-1712345678-abcd12.png', ?, 'other_photo', 'a@demo.test', 'pending')`,
      )
      .run(id, objectKey)

  it('migration 18_upload_confirm_object_key is part of the chain', () => {
    expect(migrationDirs()).toContain('18_upload_confirm_object_key')
  })

  it('rejects a second row with the same objectKey — the /api/upload/confirm dedupe', () => {
    insert('att-a', 'upp-1712345678-abcd12.png')
    expect(() => insert('att-b', 'upp-1712345678-abcd12.png')).toThrow(
      /UNIQUE constraint failed: Attachment.objectKey/,
    )
  })

  it('NULL objectKey rows never collide — the pre-#159 corpus (document mode, legacy rows) is untouched', () => {
    // Two rows with IDENTICAL fileName and storageKey — the duplicated-
    // evidence shape #159 is about — both land: SQLite unique indexes skip
    // NULLs, so the constraint is additive over the legacy corpus and no
    // dedupe pass exists (documented in the migration header).
    insert('att-legacy-1', null)
    expect(() => insert('att-legacy-2', null)).not.toThrow()
  })

  it('distinct objectKeys coexist — distinct keys keep working exactly as today', () => {
    insert('att-c', 'upp-1712345678-aaaaaa.png')
    expect(() => insert('att-d', 'upp-1712345678-bbbbbb.png')).not.toThrow()
  })

  it('the migration applies over a database seeded with pre-#159 duplicates (no cleanup pass needed)', () => {
    // The issue's "migration test on a DB seeded with a duplicate": replay
    // 00→17 (the pre-#159 world — no objectKey column yet), seed the
    // duplicate rows the old behavior could mint, then apply migration 18's
    // SQL on top: it must succeed, because the new keyspace starts empty
    // (every pre-migration row is NULL) — the documented reason there is no
    // dedupe/delete pass in the migration.
    const old = new Database(':memory:')
    for (const dir of migrationDirs()) {
      if (parseInt(dir, 10) > 17) break
      old.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
    }
    const dup = `INSERT INTO Attachment (id, entityType, entityId, fileName, storageKey, kind, uploadedBy, reviewStatus)
                 VALUES (?, 'photo', 'unattached', 'upp-1712345678-abcd12.png', '/photos/upp-1712345678-abcd12.png', 'other_photo', 'retry@demo.test', 'pending')`
    old.prepare(dup).run('att-dup-1')
    old.prepare(dup).run('att-dup-2') // the duplicated evidence row #159 exists to stop
    expect(() =>
      old.exec(readFileSync(join(MIGRATIONS_DIR, '18_upload_confirm_object_key', 'migration.sql'), 'utf8')),
    ).not.toThrow()
    // And the constraint is live on the migrated duplicate-seeded database:
    // the legacy duplicates survive (NULL objectKey), a fresh keyed pair
    // does not.
    const n = old.prepare(`SELECT COUNT(*) AS n FROM Attachment WHERE fileName = 'upp-1712345678-abcd12.png'`).get() as { n: number }
    expect(Number(n.n)).toBe(2)
    const keyed = `INSERT INTO Attachment (id, entityType, entityId, fileName, storageKey, objectKey, kind, uploadedBy, reviewStatus)
                   VALUES (?, 'photo', 'unattached', 'upp-1712345678-cccccc.png', '/photos/x', ?, 'other_photo', 'a@demo.test', 'pending')`
    old.prepare(keyed).run('att-new-1', 'upp-1712345678-cccccc.png')
    expect(() => old.prepare(keyed).run('att-new-2', 'upp-1712345678-cccccc.png')).toThrow(
      /UNIQUE constraint failed: Attachment.objectKey/,
    )
    old.close()
  })
})

// ------------------------------------------------- migration 19 (#129 / DB-10)

/**
 * Status-ladder CHECK constraints (migration 19 — issue #129).
 *
 * The schema carried zero enums and zero CHECKs on every status/role/ladder
 * column: a typo like "recieved" or "on-hold" persisted silently. Migration
 * 19 rebuilds the affected tables (the sanctioned data-preserving pattern)
 * carrying the Supabase design's vocabulary CHECKs. Pinned here, per the
 * issue's acceptance criteria:
 *
 *  · a wrong-value INSERT on a constrained ladder is REJECTED by the DB —
 *    the full census of the 75 new CHECKs, every one probed with a legal
 *    value (accepted) and a realistic typo (rejected);
 *  · a wrong-value UPDATE is rejected too, and the row is untouched;
 *  · nullable ladders accept NULL but still refuse typos;
 *  · the migration is data-preserving: legal rows written into the
 *    PRE-migration (00→18) database survive the 19 rebuild verbatim;
 *  · the migration-14 ledger trigger set survives the LedgerTransaction
 *    rebuild (DROP TABLE drops triggers — 19 recreates them verbatim).
 */

/** Every (table, column, legal, typo) probe for migration 19's CHECKs. */
const LADDER_PROBES: ReadonlyArray<[table: string, column: string, legal: string, typo: string]> = [
  // -- core project domain
  ['Project', 'clientType', 'diaspora', 'Diaspora'],
  ['Project', 'status', 'on_hold', 'on-hold'],
  ['Phase', 'status', 'in_progress', 'in-progress'],
  ['Task', 'status', 'blocked', 'block'],
  ['Task', 'priority', 'urgent', 'urgent!!'],
  ['Worker', 'employmentType', 'casual', 'intern'],
  ['Attendance', 'status', 'half_day', 'halfday'],
  ['Attendance', 'method', 'kiosk_pin', 'pin'],
  ['Attendance', 'verification', 'exception', 'except'],
  ['Attendance', 'exceptionReason', 'battery_dead', 'battery'],
  ['Delivery', 'source', 'voice', 'whatsapp'],
  ['Alert', 'type', 'safety', ' hazard'],
  ['Alert', 'severity', 'critical', 'crit'],
  // -- trust & money platform
  ['Transaction', 'type', 'payment_request', 'payment'],
  ['Transaction', 'method', 'mpesa', 'M-Pesa'],
  ['AuditEvent', 'role', 'foreman', 'forman'],
  ['Milestone', 'status', 'release_requested', 'release-requested'],
  ['VariationOrder', 'status', 'approved', 'approve'],
  ['PhotoComment', 'role', 'foreman', 'Foreman'],
  // -- platform surface
  ['Notification', 'channel', 'whatsapp', 'WhatsApp'],
  ['Notification', 'deliveryStatus', 'failed', 'failure'],
  ['User', 'role', 'procurement', 'procurment'],
  ['ProjectTeam', 'role', 'client_rep', 'client-rep'],
  // -- land & professionals
  ['LandParcel', 'tenureType', 'leasehold', 'leasehold 99 years'],
  ['LandParcel', 'status', 'searching', 'search'],
  ['ParcelDocument', 'kind', 'search_cert', 'search certificate'],
  ['TitleSearch', 'transcriptionMatch', 'mismatch', 'missmatch'],
  ['TitleSearch', 'status', 'reviewed', 'complete'],
  ['Professional', 'category', 'qty_surveyor', 'qs'],
  ['Professional', 'licenceBody', 'BORAQS', 'boraqs'],
  ['CredentialCheck', 'method', 'registry_lookup', 'registry'],
  ['ParcelAssignment', 'role', 'advocate', 'lawyer'],
  ['ParcelAssignment', 'status', 'invited', 'invite'],
  // -- supply chain
  ['MaterialRequest', 'requestedByRole', 'procurement', 'procure'],
  ['MaterialRequest', 'status', 'cancelled', 'withdrawn'], // withdrawn is the APPROVAL word (#206)
  ['ApprovalRule', 'approverRole', 'finance', 'finace'],
  ['Approval', 'entityType', 'request', 'requests'],
  ['Approval', 'approverRole', 'supervisor', 'superviser'],
  ['Approval', 'decision', 'withdrawn', 'settled'],
  ['Quote', 'status', 'declined', 'decline'],
  ['PurchaseOrder', 'status', 'pending_approval', 'pending-approval'],
  ['PurchaseOrder', 'paymentSource', 'project_wallet', 'wallet'],
  ['OrderDelivery', 'status', 'in_transit', 'transit'],
  ['OrderDeliveryLine', 'condition', 'damaged', 'damage'],
  // -- invoices & money core
  ['Invoice', 'status', 'disputed', 'dispute'],
  ['Invoice', 'paidByRole', 'finance', 'fin'],
  ['Invoice', 'paymentMethod', 'wallet', 'paypal'],
  ['MjengoScore', 'confidence', 'high', 'hi'],
  ['PricePoint', 'source', 'order', 'orders'],
  ['LedgerAccount', 'kind', 'liability', 'liabilities'],
  ['LedgerAccount', 'normalSide', 'credit', 'cred'],
  ['LedgerAccount', 'ownerType', 'escrow', 'team'],
  ['LedgerTransaction', 'postedRole', 'admin', 'manager'],
  ['WalletAccount', 'ownerType', 'organization', 'org'],
  ['WalletAccount', 'status', 'frozen', 'freeze'],
  ['PaymentRequest', 'requestedByRole', 'finance', 'fin'],
  ['PaymentRequest', 'method', 'bank', 'paypal'],
  ['PaymentRequest', 'status', 'paid', 'payed'],
  ['PaymentRequest', 'relatedEntityType', 'wages', 'salary'],
  // -- inventory
  ['StockMovement', 'type', 'transferred_in', 'transfer_in'],
  ['StockCount', 'status', 'posted', 'post'],
  ['Boq', 'status', 'superseded', 'superceded'],
  // -- universal & platform
  ['Attachment', 'category', 'receipt', 'reciept'],
  ['Attachment', 'reviewStatus', 'rejected', 'reject'],
  ['JobRecord', 'status', 'retrying', 'retry'],
  ['AiReviewNote', 'verdict', 'escalate', 'critical'],
  ['AiReviewNote', 'confidence', 'medium', 'med'],
  ['AiInsight', 'targetType', 'draw_pack', 'pack'],
  ['AiInsight', 'kind', 'phase_mismatch', 'mismatch'],
  ['AiInsight', 'source', 'dhash', 'hash'],
  ['AiInsight', 'severity', 'warning', 'warn'],
  ['AiInsight', 'confidence', 'high', 'ultra'],
  ['TrustDigest', 'lang', 'sw', 'fr'],
  ['TrustDigest', 'audioStatus', 'ready', 'available'],
]

describe('status-ladder CHECK constraints (migration 19 — #129 / DB-10)', () => {
  // Parent rows for the FK graph beyond the shared beforeEach — one row per
  // table whose children need it, minimal legal shapes.
  beforeEach(() => {
    db.exec(`
      INSERT INTO Phase (id, projectId, name, "order", budget, status) VALUES ('ph-1', 'p-1', 'Foundation', 1, 1000, 'pending');
      INSERT INTO Material (id, name, unit, unitPrice) VALUES ('mat-1', 'Cement', 'bag', 65000);
      INSERT INTO InventoryItem (id, projectId, materialName, unit, updatedAt) VALUES ('inv-1', 'p-1', 'Cement', 'bag', CURRENT_TIMESTAMP);
      INSERT INTO SitePhoto (id, projectId, url) VALUES ('sp-1', 'p-1', '/photos/sp-1.jpg');
      INSERT INTO LandParcel (id, projectId, plotNumber, county, updatedAt) VALUES ('lp-1', 'p-1', 'LR 1/1', 'Nairobi', CURRENT_TIMESTAMP);
      INSERT INTO Professional (id, name, category, updatedAt) VALUES ('prof-1', 'Wanjala', 'surveyor', CURRENT_TIMESTAMP);
      INSERT INTO MaterialRequest (id, projectId, requestCode, requestedByRole, requestedByName, updatedAt) VALUES ('mr-1', 'p-1', 'MR-2026-000001', 'contractor', 'C', CURRENT_TIMESTAMP);
      INSERT INTO PurchaseOrder (id, orderCode, projectId, supplierId, subtotal, total, createdByRole, updatedAt) VALUES ('po-1', 'PO-2026-000001', 'p-1', 'sup-1', 1, 1, 'contractor', CURRENT_TIMESTAMP);
      INSERT INTO PurchaseOrderLine (id, orderId, name, unit, qty, unitPrice, lineTotal) VALUES ('pol-1', 'po-1', 'Cement', 'bag', 1, 1, 1);
      INSERT INTO OrderDelivery (id, orderId, status) VALUES ('od-1', 'po-1', 'dispatched');
      INSERT INTO Milestone (id, projectId, name, amount) VALUES ('ms-1', 'p-1', 'Slab', 1000);
      INSERT INTO DrawPack (id, milestoneId, projectId, milestoneName, amount, ledgerRef, ledgerTxnId, attendanceSummary, contentHash) VALUES ('dp-1', 'ms-1', 'p-1', 'Slab', 1000, 'MJL-2026-001', 'lt-seed', '{}', 'h');
    `)
  })

  /**
   * Legal values for EVERY constrained column, so the generic builder can
   * fill non-probed ladder columns without tripping their own CHECKs (the
   * placeholder 'x' is only for unconstrained free text). First value of
   * each ladder — mirrors the migration-19 vocabularies.
   */
  const LEGAL: Record<string, Record<string, string>> = {
    Project: { clientType: 'diaspora', status: 'active' },
    Phase: { status: 'pending' },
    Task: { status: 'pending', priority: 'normal' },
    Worker: { employmentType: 'casual' },
    Attendance: { status: 'present', method: 'geofence', verification: 'reported', exceptionReason: 'network' },
    Delivery: { source: 'manual' },
    Alert: { type: 'budget', severity: 'info' },
    Transaction: { type: 'material', method: 'mpesa' },
    AuditEvent: { role: 'contractor' },
    Milestone: { status: 'locked' },
    VariationOrder: { status: 'submitted' },
    PhotoComment: { role: 'client' },
    Notification: { channel: 'in_app', deliveryStatus: 'logged' },
    User: { role: 'contractor' },
    ProjectTeam: { role: 'contractor' },
    LandParcel: { tenureType: 'freehold', status: 'searching' },
    ParcelDocument: { kind: 'title_deed' },
    TitleSearch: { transcriptionMatch: 'pending', status: 'requested' },
    Professional: { category: 'surveyor', licenceBody: 'LSK' },
    CredentialCheck: { method: 'document_review' },
    ParcelAssignment: { role: 'surveyor', status: 'active' },
    MaterialRequest: { requestedByRole: 'contractor', status: 'draft' },
    ApprovalRule: { approverRole: 'supervisor' },
    Approval: { entityType: 'request', approverRole: 'supervisor', decision: 'pending' },
    Quote: { status: 'requested' },
    PurchaseOrder: { status: 'draft', paymentSource: 'client' },
    OrderDelivery: { status: 'dispatched' },
    OrderDeliveryLine: { condition: 'ok' },
    Invoice: { status: 'draft', paidByRole: 'client', paymentMethod: 'mpesa' },
    MjengoScore: { confidence: 'low' },
    PricePoint: { source: 'seed' },
    LedgerAccount: { kind: 'asset', normalSide: 'debit', ownerType: 'project' },
    LedgerTransaction: { postedRole: 'client', status: 'pending' },
    WalletAccount: { ownerType: 'project', status: 'active' },
    PaymentRequest: { requestedByRole: 'contractor', method: 'mpesa', status: 'pending', relatedEntityType: 'milestone' },
    StockMovement: { type: 'received' },
    StockCount: { status: 'open' },
    Boq: { status: 'draft' },
    Attachment: { category: 'other', reviewStatus: 'pending' },
    JobRecord: { status: 'queued' },
    AiReviewNote: { verdict: 'consistent', confidence: 'low' },
    AiInsight: { targetType: 'site_photo', kind: 'duplicate', source: 'dhash', severity: 'info', confidence: 'low' },
    TrustDigest: { lang: 'en', audioStatus: 'ready' },
  }

  /**
   * Columns whose DB DEFAULT is illegal for a direct INSERT (only one: the
   * migration-14 birth gate demands 'pending' while the column default says
   * 'posted' — the posting transition is the balance gate).
   */
  const FORCED: Record<string, Record<string, string>> = {
    LedgerTransaction: { status: 'pending' },
  }

  /**
   * Generic INSERT builder: fills every required column with a type-correct
   * placeholder, resolves FK columns onto the seeded parents, fills sibling
   * ladder columns with LEGAL values, and lets the caller override exactly
   * the ladder column under test.
   */
  function insertInto(table: string, overrides: Record<string, unknown>): void {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>
    const parents: Record<string, string> = {
      projectId: 'p-1', workerId: 'w-1', supplierId: 'sup-1', phaseId: 'ph-1',
      parcelId: 'lp-1', professionalId: 'prof-1', requestId: 'mr-1', orderId: 'po-1',
      orderLineId: 'pol-1', deliveryId: 'od-1', drawPackId: 'dp-1', photoId: 'sp-1',
      materialId: 'mat-1', inventoryItemId: 'inv-1', milestoneId: 'ms-1', txnId: 'lt-guard',
    }
    const legal = LEGAL[table] ?? {}
    const forced = FORCED[table] ?? {}
    const cols: string[] = []
    const vals: unknown[] = []
    for (const c of info) {
      if (c.name in overrides) { cols.push(`"${c.name}"`); vals.push(overrides[c.name]); continue }
      if (c.name in forced) { cols.push(`"${c.name}"`); vals.push(forced[c.name]); continue }
      if (c.name === 'id') { cols.push('"id"'); vals.push(`${table}-${Math.random().toString(36).slice(2, 10)}`); continue }
      if (c.name in legal) { cols.push(`"${c.name}"`); vals.push(legal[c.name]); continue }
      if (c.dflt_value !== null) continue // column default covers it
      if (c.name in parents) { cols.push(`"${c.name}"`); vals.push(parents[c.name]); continue }
      if (c.notnull === 0) continue // nullable and unset -> NULL
      cols.push(`"${c.name}"`)
      // Unique per call: several free-text columns are UNIQUE (ref, email,
      // code, …) and a shared 'x' would collide across probes.
      vals.push(c.type === 'DATETIME' ? '2026-01-01 08:00:00' : c.type === 'REAL' ? 1.0 : c.type === 'BOOLEAN' ? 1 : `${c.name}-${Math.random().toString(36).slice(2, 10)}`)
    }
    db.prepare(
      `INSERT INTO "${table}" (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...vals)
  }

  it('migration 19_status_ladder_checks is part of the chain', () => {
    expect(migrationDirs()).toContain('19_status_ladder_checks')
  })

  it('the CHECK census: 77 named _check constraints across 44 tables (75 from migration 19 + 2 from migration 14)', () => {
    const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string; sql: string }>
    const perTable = rows.map((r) => ({ t: r.name, n: (r.sql.match(/_check" CHECK/g) ?? []).length })).filter((r) => r.n > 0)
    expect(perTable.reduce((s, r) => s + r.n, 0)).toBe(77)
    expect(perTable.length).toBe(44)
    // migration 14's LedgerEntry pair rides along untouched
    expect(perTable.find((r) => r.t === 'LedgerEntry')?.n).toBe(2)
  })

  it.each(LADDER_PROBES)('%s.%s: "%s" accepted, "%s" rejected at the DB level', (table, column, legal, typo) => {
    // Legal value persists (INSERT path)
    expect(() => insertInto(table, { [column]: legal })).not.toThrow()
    // Typo'd value is rejected by the CHECK (INSERT path)
    expect(() => insertInto(table, { [column]: typo })).toThrow(
      new RegExp(`CHECK constraint failed: ${table}_${column}_check`),
    )
  })

  it('a wrong-value UPDATE is rejected and the row keeps its legal value', () => {
    insertInto('Project', { id: 'upd-1', status: 'active' })
    expect(() => db.prepare(`UPDATE Project SET status = 'completed!' WHERE id = 'upd-1'`).run()).toThrow(
      /CHECK constraint failed: Project_status_check/,
    )
    expect((db.prepare(`SELECT status FROM Project WHERE id = 'upd-1'`).get() as { status: string }).status).toBe('active')
    // A legal UPDATE still works
    expect(() => db.prepare(`UPDATE Project SET status = 'completed' WHERE id = 'upd-1'`).run()).not.toThrow()
    expect((db.prepare(`SELECT status FROM Project WHERE id = 'upd-1'`).get() as { status: string }).status).toBe('completed')
  })

  it('nullable ladders accept NULL but still refuse typos', () => {
    for (const [table, column, typo] of [
      ['Worker', 'employmentType', 'intern'],
      ['Attendance', 'exceptionReason', 'sick'],
      ['Invoice', 'paymentMethod', 'paypal'],
      ['Attachment', 'category', 'photograph'],
      ['LandParcel', 'tenureType', 'leasehold 99 years'],
      ['AiInsight', 'confidence', 'certain'],
      ['LedgerAccount', 'ownerType', 'team'],
      ['Professional', 'licenceBody', 'KRA'],
      ['PaymentRequest', 'relatedEntityType', 'task'],
    ] as const) {
      expect(() => insertInto(table, { [column]: null }), `${table}.${column} NULL`).not.toThrow()
      expect(() => insertInto(table, { [column]: typo }), `${table}.${column} "${typo}"`).toThrow(
        new RegExp(`CHECK constraint failed: ${table}_${column}_check`),
      )
    }
  })

  it('the ledger birth-state gate and the status CHECK coexist (migration 14 + 19)', () => {
    // 'posted' is a legal CHECK value but an illegal BIRTH state — the
    // migration-14 insert gate rejects it (the posting transition is the
    // balance gate), proving the trigger survived the 19 rebuild.
    expect(() => insertInto('LedgerTransaction', { status: 'posted' })).toThrow(/born pending/)
    // 'pending' is the one legal birth state.
    expect(() => insertInto('LedgerTransaction', { status: 'pending' })).not.toThrow()
    // postedRole has its own ladder — a wrong actor role is refused by the
    // CHECK even on a legal pending birth (triggers pass it through).
    expect(() => insertInto('LedgerTransaction', { status: 'pending', postedRole: 'manager' })).toThrow(
      /CHECK constraint failed: LedgerTransaction_postedRole_check/,
    )
    // Under maintenance (the archival exemption) the birth gate is
    // disabled — a born-'posted' backfill row is allowed — but the status
    // CHECK is ABSOLUTE (like the posting-gate balance assertion): a
    // nonsense status still cannot land, maintenance or not.
    db.prepare(`INSERT INTO LedgerMaintenance (id, allow) VALUES (1, 1)`).run()
    expect(() => insertInto('LedgerTransaction', { status: 'posted' })).not.toThrow()
    expect(() => insertInto('LedgerTransaction', { status: 'settled' })).toThrow(
      /CHECK constraint failed: LedgerTransaction_status_check/,
    )
  })

  it('the migration-14 trigger set survived the rebuild (all seven, verbatim semantics)', () => {
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string }>
    expect(triggers.map((t) => t.name).sort()).toEqual([
      'LedgerEntry_delete_guard',
      'LedgerEntry_insert_gate',
      'LedgerEntry_update_guard',
      'LedgerTransaction_delete_guard',
      'LedgerTransaction_insert_gate',
      'LedgerTransaction_posting_gate',
      'LedgerTransaction_update_guard',
    ])
    // And they still bite: LedgerEntry is append-only (a live row first —
    // a no-op UPDATE on an empty table fires nothing).
    insertInto('LedgerAccount', { id: 'la-guard', code: 'GUARD', name: 'Guard', kind: 'asset', normalSide: 'debit' })
    insertInto('LedgerTransaction', { id: 'lt-guard', status: 'pending', postedRole: 'client' })
    db.prepare(
      `INSERT INTO LedgerEntry (id, txnId, accountId, side, amount) VALUES ('le-guard', 'lt-guard', 'la-guard', 'debit', 1)`,
    ).run()
    expect(() => db.prepare(`UPDATE LedgerEntry SET amount = amount + 1 WHERE id = 'le-guard'`).run()).toThrow(/append-only/)
  })

  it('data-preserving: legal rows written into the 00→18 database survive the 19 rebuild verbatim', () => {
    // The #159 pattern: replay the PRE-migration world, write rows, apply
    // migration 19 on top — the rebuild copies every column losslessly.
    const old = new Database(':memory:')
    for (const dir of migrationDirs()) {
      if (parseInt(dir, 10) > 18) break
      old.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
    }
    old.exec(`
      INSERT INTO Project (id, shareToken, name, client, location, budget, startDate, targetDate, status, createdAt, updatedAt)
        VALUES ('keep-p', 'tok-keep', 'Kept', 'C', 'N', 100, '2026-01-01', '2026-12-01', 'on_hold', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO Phase (id, projectId, name, "order", budget, status) VALUES ('keep-ph', 'keep-p', 'Walls', 1, 1, 'done');
      INSERT INTO Task (id, phaseId, title, status, priority, updatedAt) VALUES ('keep-t', 'keep-ph', 'T', 'blocked', 'urgent', CURRENT_TIMESTAMP);
      INSERT INTO Worker (id, projectId, name, role, phone, dailyRate, active) VALUES ('keep-w', 'keep-p', 'W', 'fundi', '0700000000', 1, 1);
      INSERT INTO Attendance (id, workerId, projectId, date, status, method, wage, verification) VALUES ('keep-a', 'keep-w', 'keep-p', '2026-09-01', 'half_day', 'kiosk_pin', 1, 'exception');
      INSERT INTO Milestone (id, projectId, name, amount, status) VALUES ('keep-m', 'keep-p', 'M', 1, 'release_requested');
    `)
    expect(() =>
      old.exec(readFileSync(join(MIGRATIONS_DIR, '19_status_ladder_checks', 'migration.sql'), 'utf8')),
    ).not.toThrow()
    // Every row survived with its ladder value intact.
    expect((old.prepare(`SELECT status FROM Project WHERE id = 'keep-p'`).get() as { status: string }).status).toBe('on_hold')
    expect((old.prepare(`SELECT status, priority FROM Task WHERE id = 'keep-t'`).get() as { status: string; priority: string })).toEqual({ status: 'blocked', priority: 'urgent' })
    expect((old.prepare(`SELECT status, method, verification FROM Attendance WHERE id = 'keep-a'`).get() as Record<string, string>)).toEqual({ status: 'half_day', method: 'kiosk_pin', verification: 'exception' })
    expect((old.prepare(`SELECT status FROM Milestone WHERE id = 'keep-m'`).get() as { status: string }).status).toBe('release_requested')
    // And the CHECKs are live on the migrated database.
    expect(() => old.prepare(`UPDATE Task SET status = 'finished' WHERE id = 'keep-t'`).run()).toThrow(
      /CHECK constraint failed: Task_status_check/,
    )
    old.close()
  })
})
