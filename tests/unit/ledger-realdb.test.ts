/**
 * Ledger double-entry engine against a REAL SQLite database (issue #184 /
 * audit TEST-2) — the critical-path companion of tests/unit/ledger.test.ts.
 *
 * The stub suite proves the pure posting logic; this file proves the SAME
 * service code against the real engine — real query planning, real
 * interactive `$transaction`s, real trigger enforcement (migration 14), real
 * unique constraints — on a database whose full migration history was applied
 * by the real `prisma migrate deploy` (see tests/helpers/db.ts). Pinned:
 *
 *  · the harness itself: `_prisma_migrations` is real (20 rows, 00→18 —
 *    the #159/#207 merge race left TWO 18_* folders, both applied; folder
 *    names stay unique so `deploy` order is deterministic) — a migration
 *    that breaks `deploy` cannot reach these tests green;
 *  · double-entry posting through postLedgerTransaction: born pending →
 *    legs → posted (the migration-14 state machine), lazy chart-of-accounts
 *    creation (CASH_MPESA platform + ESCROW:<projectId>), balanced legs;
 *  · the DB posting gate, exercised through the PRISMA writer (bypassing
 *    the service's validateLines): pending→posted with unbalanced legs is
 *    REJECTED and the row stays pending — never half-posted. Through
 *    Prisma, SQLite trigger RAISE(ABORT) errors surface misclassified as
 *    P2003 (verified: the engine maps any SQLITE_CONSTRAINT abort this way)
 *    — so the assertion is rejects + state, and the honest reason text is
 *    probed through the better-sqlite3 handle;
 *  · reversal: mirrored legs post as a NEW transaction linked via
 *    reversalOfId, the original row stays byte-identical (DB-11 / #133 —
 *    "is reversed?" is derived from the link, never stamped), derived
 *    balances are restored to zero; double reversal refuses (derived
 *    guard) and the unique reversalOfId index is the DB backstop;
 *  · the migration-21 tightened update guard: the previously-legal
 *    reversal marking (posted→'reversed' + reversalRef) is now REJECTED —
 *    the only legal UPDATE left is the posting transition;
 *  · idempotency: the same key replays the original transaction — exactly
 *    one set of rows ever lands (real LedgerTransaction.idempotencyKey
 *    unique index under the replay);
 *  · $transaction rollback: a posting that fails mid-flight leaves ZERO
 *    partial rows — the real engine's rollback, not a stub convention;
 *  · derived balance consistency: derivedBalance (SQL SUM through Prisma)
 *    equals an independent raw-SQL SUM via better-sqlite3 for every account
 *    the walk touched, and the global ledger stays Σdebits = Σcredits;
 *  · append-only history through the Prisma writer: entry UPDATE, entry
 *    DELETE and transaction DELETE are all rejected by the DB triggers.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import {
  accountSideSums,
  derivedBalance,
  postLedgerTransaction,
  postLedgerTransactionInTx,
  reverseLedgerTransaction,
} from '@/backend/modules/ledger/service'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

/** Direct row count via the raw handle (bypasses Prisma — independent read). */
const count = (table: string): number => Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n)

describe('the harness (issue #184)', () => {
  it('runs on a database migrated by the real prisma migrate deploy (23 migrations recorded — two 18_* folders)', () => {
    const rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`).get() as { n: bigint }
    // 00→17 is one-per-number (18 migrations); #159 (18_upload_confirm_object_key)
    // and #207 (18_reorder_level) merged 9 minutes apart each carrying an
    // 18-numbered folder — distinct names, so deploy applies both and the
    // count was 20 through wave 19; #129 adds 19_status_ladder_checks → 21;
    // #181 adds 20_token_version (session revocation) → 22; #133 adds
    // 21_ledger_reversals_as_rows (reversals as new rows) → 23.
    // Renaming a folder post-merge would re-apply it on every
    // already-migrated database, so the numbering collision is documented
    // here instead of "fixed".
    expect(Number(rows.n)).toBe(23)
    // The ledger invariant triggers are live in this database.
    const triggers = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'LedgerTransaction%'`).all() as Array<{ name: string }>
    expect(triggers.map((t) => t.name)).toContain('LedgerTransaction_posting_gate')
  })
})

describe('double-entry posting through the real engine', () => {
  it('posts a balanced transaction born pending → legs → posted, creating the chart of accounts lazily', async () => {
    const project = await seedProject(prisma)
    const AMOUNT = 250_000n // KSh 2,500.00 in cents

    const txn = await postLedgerTransaction({
      projectId: project.id,
      description: 'Escrow top-up — real engine',
      postedBy: 'Test Client',
      postedRole: 'client',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: AMOUNT },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: AMOUNT },
      ],
    })

    // The service returns the POSTED transaction with its legs.
    expect(txn.status).toBe('posted')
    expect(txn.entries).toHaveLength(2)
    expect(txn.entries.map((e) => e.side).sort()).toEqual(['credit', 'debit'])
    expect(txn.entries.every((e) => e.amount === AMOUNT)).toBe(true)

    // The accounts were created by the in-tx resolver — and are queryable.
    const cash = await prisma.ledgerAccount.findUnique({ where: { code: 'CASH_MPESA' } })
    const escrow = await prisma.ledgerAccount.findUnique({ where: { code: `ESCROW:${project.id}` } })
    expect(cash?.kind).toBe('asset')
    expect(escrow?.kind).toBe('liability')

    // The row is durable in the real database — read back through the raw
    // handle, independent of Prisma.
    const row = sqlite.prepare(`SELECT status, postedBy, postedRole FROM LedgerTransaction WHERE id = ?`).get(txn.id) as {
      status: string
      postedBy: string
      postedRole: string
    }
    expect(row).toEqual({ status: 'posted', postedBy: 'Test Client', postedRole: 'client' })
    const legs = sqlite.prepare(`SELECT side, amount FROM LedgerEntry WHERE txnId = ? ORDER BY side`).all(txn.id) as Array<{ side: string; amount: bigint }>
    expect(legs).toEqual([
      { side: 'credit', amount: AMOUNT },
      { side: 'debit', amount: AMOUNT },
    ])

    // Derived balances (asset: debit−credit / liability: credit−debit).
    expect(await derivedBalance('CASH_MPESA')).toBe(AMOUNT)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(AMOUNT)
  })

  it('rejects an unbalanced post at the service seam (fail-fast message)', async () => {
    const project = await seedProject(prisma)
    const beforeTxns = count('LedgerTransaction')
    const beforeEntries = count('LedgerEntry')
    await expect(
      postLedgerTransaction({
        projectId: project.id,
        description: 'unbalanced',
        postedBy: 't',
        postedRole: 'finance',
        lines: [
          { accountCode: 'CASH_MPESA', side: 'debit', amount: 500n },
          { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 499n },
        ],
      }),
    ).rejects.toThrow(/Unbalanced ledger transaction: debits 500 ≠ credits 499/)
    // Fail-fast means fail-clean: nothing was written.
    expect(count('LedgerTransaction')).toBe(beforeTxns)
    expect(count('LedgerEntry')).toBe(beforeEntries)
  })

  it('REJECTS the pending→posted transition with unbalanced legs through the PRISMA writer (migration-14 gate)', async () => {
    const project = await seedProject(prisma)
    // A writer that bypasses the service's validateLines: born pending + legs
    // via Prisma, then the status flip — the exact move the DB trigger guards.
    const pending = await prisma.ledgerTransaction.create({
      data: {
        ref: 'LX-TEST-GATE-1',
        projectId: project.id,
        description: 'direct writer probe',
        occurredAt: new Date(),
        postedBy: 'attacker',
        postedRole: 'finance',
        status: 'pending',
      },
    })
    const account = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'CASH_MPESA' } })
    await prisma.ledgerEntry.create({ data: { txnId: pending.id, accountId: account.id, side: 'debit', amount: 500n } })
    await prisma.ledgerEntry.create({ data: { txnId: pending.id, accountId: account.id, side: 'credit', amount: 300n } })

    // SQLite trigger RAISE(ABORT) → Prisma surfaces the abort (misclassified
    // as P2003 — documented in the suite header); the assertion that matters
    // is REJECTED + no half-posted state.
    await expect(prisma.ledgerTransaction.update({ where: { id: pending.id }, data: { status: 'posted' } })).rejects.toThrow()
    const after = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { id: pending.id } })
    expect(after.status).toBe('pending')

    // The honest reason is visible through the raw handle (better-sqlite3
    // surfaces the trigger's RAISE text; the Prisma engine does not).
    expect(() =>
      sqlite.prepare(`UPDATE LedgerTransaction SET status = 'posted' WHERE id = ?`).run(pending.id),
    ).toThrow(/unbalanced ledger transaction/)

    // A born-posted transaction is equally impossible through Prisma.
    await expect(
      prisma.ledgerTransaction.create({
        data: {
          ref: 'LX-TEST-GATE-2',
          projectId: project.id,
          description: 'born posted probe',
          occurredAt: new Date(),
          postedBy: 'attacker',
          postedRole: 'finance',
          status: 'posted',
        },
      }),
    ).rejects.toThrow()
  })

  it('replays the SAME transaction for a repeated idempotency key — exactly one set of rows', async () => {
    const project = await seedProject(prisma)
    const beforeTxns = count('LedgerTransaction')
    const beforeEntries = count('LedgerEntry')
    const input = {
      projectId: project.id,
      description: 'idempotent post',
      postedBy: 't',
      postedRole: 'finance',
      idempotencyKey: 'ledger-realdb-replay-1',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 100n },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 100n },
      ],
    }
    const first = await postLedgerTransaction(input)
    const replay = await postLedgerTransaction(input)

    expect(replay.id).toBe(first.id)
    expect(replay.ref).toBe(first.ref)
    // Two calls, ONE transaction and ONE pair of legs — the replay returned
    // the original instead of double-posting.
    expect(count('LedgerTransaction')).toBe(beforeTxns + 1)
    expect(count('LedgerEntry')).toBe(beforeEntries + 2)
    // The real unique index is the backstop: a second create with the same
    // key cannot land even if a writer skips the replay check.
    await expect(
      prisma.ledgerTransaction.create({
        data: {
          ref: 'LX-DUP-KEY',
          projectId: project.id,
          description: 'duplicate key probe',
          occurredAt: new Date(),
          postedBy: 't',
          postedRole: 'finance',
          status: 'pending',
          idempotencyKey: 'ledger-realdb-replay-1',
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/)
  })

  it('rolls back a posting that fails mid-flight — zero partial rows (real $transaction semantics)', async () => {
    const project = await seedProject(prisma)
    const beforeTxns = count('LedgerTransaction')
    const beforeEntries = count('LedgerEntry')
    const beforeAccounts = count('LedgerAccount')

    await expect(
      prisma.$transaction(async (tx) => {
        // A real posting happens INSIDE the transaction…
        await postLedgerTransactionInTx(tx, {
          projectId: project.id,
          description: 'doomed posting',
          postedBy: 't',
          postedRole: 'finance',
          lines: [
            { accountCode: 'CASH_BANK', side: 'debit', amount: 750n },
            { accountCode: `EXPENSE:${project.id}`, side: 'credit', amount: 750n },
          ],
        })
        // …and then the caller fails — everything above must vanish.
        throw new Error('injected failure mid-posting')
      }),
    ).rejects.toThrow('injected failure mid-posting')

    expect(count('LedgerTransaction')).toBe(beforeTxns)
    expect(count('LedgerEntry')).toBe(beforeEntries)
    // Even the lazily created EXPENSE account creation rolled back with it.
    expect(count('LedgerAccount')).toBe(beforeAccounts)
    expect(await prisma.ledgerAccount.findUnique({ where: { code: `EXPENSE:${project.id}` } })).toBeNull()
    expect(await derivedBalance('CASH_BANK')).toBe(0n)
  })
})

describe('reversal (append-only corrections — DB-11 / #133)', () => {
  it('posts mirrored legs as a NEW row; the original stays byte-identical; balances restore', async () => {
    const project = await seedProject(prisma)
    const AMOUNT = 125_000n
    const original = await postLedgerTransaction({
      projectId: project.id,
      description: 'to be reversed',
      postedBy: 't',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: AMOUNT },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: AMOUNT },
      ],
    })
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(AMOUNT)

    // The ORIGINAL row, every column, read through the raw handle — the
    // byte-identical snapshot the reversal must not disturb (#133).
    const before = sqlite.prepare(`SELECT * FROM LedgerTransaction WHERE id = ?`).get(original.id)

    const reversal = await reverseLedgerTransaction(original.id, 'wrong amount', 'Finance', 'finance')

    // THE #133 invariant: the original row is byte-identical after the
    // reversal — no status flip, no reversalRef stamp, nothing.
    expect(sqlite.prepare(`SELECT * FROM LedgerTransaction WHERE id = ?`).get(original.id)).toEqual(before)
    const untouched = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { id: original.id } })
    expect(untouched.status).toBe('posted')
    expect(untouched.reversalRef).toBeNull()

    // The reversal row: posted, mirrored, linked back — the link IS the
    // reversal record.
    expect(reversal.status).toBe('posted')
    expect(reversal.reversalOfId).toBe(original.id)
    const legs = await prisma.ledgerEntry.findMany({ where: { txnId: reversal.id } })
    expect(legs).toHaveLength(2)
    const escrowLeg = legs.find((l) => l.side === 'debit')
    expect(escrowLeg?.amount).toBe(AMOUNT) // mirror of the original credit

    // Derived reversal state: the link, not a stamp.
    const derived = await prisma.ledgerTransaction.findUnique({ where: { reversalOfId: original.id } })
    expect(derived?.id).toBe(reversal.id)
    expect(derived?.ref).toBe(reversal.ref)

    // Money moved back: the escrow account's derived balance is restored.
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(0n)
    // History grew — nothing was edited or deleted.
    expect(count('LedgerTransaction')).toBeGreaterThan(0)
  })

  it('refuses to reverse an already-reversed transaction (derived guard)', async () => {
    const project = await seedProject(prisma)
    const txn = await postLedgerTransaction({
      projectId: project.id,
      description: 'reverse twice probe',
      postedBy: 't',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 10n },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 10n },
      ],
    })
    await reverseLedgerTransaction(txn.id, 'first', 'Finance', 'finance')
    await expect(reverseLedgerTransaction(txn.id, 'second', 'Finance', 'finance')).rejects.toThrow('Transaction already reversed')
  })

  it('migration 21: the previously-legal reversal marking UPDATE is now REJECTED by the tightened guard', async () => {
    const project = await seedProject(prisma)
    const txn = await postLedgerTransaction({
      projectId: project.id,
      description: 'guard probe',
      postedBy: 't',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 10n },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 10n },
      ],
    })
    // The pre-#133 service write: posted → 'reversed' + reversalRef. Under
    // migration 14/19's whitelist this was the one legal mutation; migration
    // 21 removed the arm — the original is never UPDATEd again.
    expect(() =>
      sqlite.prepare(`UPDATE LedgerTransaction SET status = 'reversed', reversalRef = 'LX-gone' WHERE id = ?`).run(txn.id),
    ).toThrow(/DB-11 \(#133\)/)
    // Through Prisma too — no writer path is exempt.
    await expect(
      prisma.ledgerTransaction.update({ where: { id: txn.id }, data: { status: 'reversed', reversalRef: 'LX-gone' } }),
    ).rejects.toThrow()
    // The row is untouched by the failed attempts.
    const row = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { id: txn.id } })
    expect(row.status).toBe('posted')
    expect(row.reversalRef).toBeNull()
    // The posting transition (the balance gate's enforcement point) is
    // still the one legal UPDATE — a fresh post exercises it end-to-end.
    const again = await postLedgerTransaction({
      projectId: project.id,
      description: 'posting transition still legal',
      postedBy: 't',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 5n },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 5n },
      ],
    })
    expect(again.status).toBe('posted')
  })

  it('migration 21: one reversal per original — the unique index is the DB-level double-reversal backstop', async () => {
    const project = await seedProject(prisma)
    const txn = await postLedgerTransaction({
      projectId: project.id,
      description: 'unique link probe',
      postedBy: 't',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 10n },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 10n },
      ],
    })
    const first = await reverseLedgerTransaction(txn.id, 'the one reversal', 'Finance', 'finance')
    // A rogue writer that skips the service's derived guard cannot land a
    // SECOND reversal row pointing at the same original — the unique
    // index on reversalOfId fails it closed.
    await expect(
      prisma.ledgerTransaction.create({
        data: {
          ref: 'LX-ROGUE-SECOND-REVERSAL',
          projectId: project.id,
          description: 'rogue second reversal',
          occurredAt: new Date(),
          postedBy: 'attacker',
          postedRole: 'finance',
          status: 'pending',
          reversalOfId: txn.id,
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/)
    // …and the index is live in sqlite_master under Prisma's name.
    const idx = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'LedgerTransaction_reversalOfId_key'`).get()
    expect(idx).toEqual({ name: 'LedgerTransaction_reversalOfId_key' })
    // Ordinary rows (NULL reversalOfId) never collide — many coexist.
    expect(count('LedgerTransaction')).toBeGreaterThan(1)
    expect(first.status).toBe('posted')
  })
})

describe('derived-balance consistency under real transactions', () => {
  it('derivedBalance matches an independent raw-SQL SUM for every account, and the ledger balances globally', async () => {
    const project = await seedProject(prisma)
    // A small workload: three posts + one reversal across four accounts.
    const posts = [
      { d: 'CASH_MPESA', c: `ESCROW:${project.id}`, amount: 400_00n },
      { d: 'CASH_BANK', c: `ESCROW:${project.id}`, amount: 600_00n },
      { d: `ESCROW:${project.id}`, c: `EXPENSE:${project.id}`, amount: 150_00n },
    ]
    const posted = []
    for (const p of posts) {
      posted.push(
        await postLedgerTransaction({
          projectId: project.id,
          description: 'consistency walk',
          postedBy: 't',
          postedRole: 'finance',
          lines: [
            { accountCode: p.d, side: 'debit', amount: p.amount },
            { accountCode: p.c, side: 'credit', amount: p.amount },
          ],
        }),
      )
    }
    await reverseLedgerTransaction(posted[2].id, 'undo spend', 'Finance', 'finance')

    // Every account the walk touched (plus an unknown one): Prisma's SQL SUM
    // (accountSideSums/derivedBalance) vs an independent better-sqlite3 SUM.
    const codes = ['CASH_MPESA', 'CASH_BANK', `ESCROW:${project.id}`, `EXPENSE:${project.id}`]
    for (const code of codes) {
      const row = await prisma.ledgerAccount.findUnique({ where: { code } })
      expect(row, code).not.toBeNull()
      const raw = sqlite
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN side = 'debit' THEN amount END), 0) AS debit,
             COALESCE(SUM(CASE WHEN side = 'credit' THEN amount END), 0) AS credit
           FROM LedgerEntry WHERE accountId = ?`,
        )
        .get(row!.id) as { debit: bigint; credit: bigint }
      const sums = await accountSideSums(prisma, row!.id)
      expect(sums.debit, `${code} Σdebit`).toBe(raw.debit)
      expect(sums.credit, `${code} Σcredit`).toBe(raw.credit)
      // The sign convention, re-derived from the raw numbers.
      const expected = row!.kind === 'asset' || row!.kind === 'expense' ? raw.debit - raw.credit : raw.credit - raw.debit
      expect(await derivedBalance(code)).toBe(expected)
    }

    // Unknown account: honest zero, no throw.
    expect(await derivedBalance('NO:SUCH:ACCOUNT')).toBe(0n)

    // Global double-entry invariant over every transaction that PASSED the
    // posting gate (pending rows under direct-writer probes may legally hold
    // unbalanced legs — the gate exists precisely to stop them posting).
    const global = sqlite
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN side = 'debit' THEN amount END), 0) AS debit,
           COALESCE(SUM(CASE WHEN side = 'credit' THEN amount END), 0) AS credit
         FROM LedgerEntry
         WHERE txnId IN (SELECT id FROM LedgerTransaction WHERE status IN ('posted', 'reversed'))`,
      )
      .get() as { debit: bigint; credit: bigint }
    expect(global.debit).toBe(global.credit)
    // …and no posted/reversed transaction exists with unbalanced legs.
    const unbalanced = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM LedgerTransaction t
         WHERE t.status IN ('posted', 'reversed')
           AND (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount END), 0) FROM LedgerEntry e WHERE e.txnId = t.id)
             != (SELECT COALESCE(SUM(CASE WHEN side = 'credit' THEN amount END), 0) FROM LedgerEntry e WHERE e.txnId = t.id)`,
      )
      .get() as { n: bigint }
    expect(Number(unbalanced.n)).toBe(0)
  })

  it('keeps the history append-only even through the Prisma writer (migration-14 triggers)', async () => {
    const project = await seedProject(prisma)
    const txn = await postLedgerTransaction({
      projectId: project.id,
      description: 'append-only probe',
      postedBy: 't',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 55n },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 55n },
      ],
    })
    const entry = (await prisma.ledgerEntry.findFirstOrThrow({ where: { txnId: txn.id } })).id
    const before = count('LedgerEntry')

    await expect(prisma.ledgerEntry.update({ where: { id: entry }, data: { amount: 1n } })).rejects.toThrow()
    await expect(prisma.ledgerEntry.delete({ where: { id: entry } })).rejects.toThrow()
    await expect(prisma.ledgerTransaction.delete({ where: { id: txn.id } })).rejects.toThrow()

    expect(count('LedgerEntry')).toBe(before)
    expect(await prisma.ledgerTransaction.findUnique({ where: { id: txn.id } })).not.toBeNull()
    // The raw handle names the rule: append-only.
    expect(() => sqlite.prepare(`UPDATE LedgerEntry SET amount = 1 WHERE id = ?`).run(entry)).toThrow(/append-only/)
  })
})
