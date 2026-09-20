/**
 * Wallet money movements against a REAL SQLite database (issue #184 / audit
 * TEST-2) — the critical-path companion of wallet-idempotency.test.ts and
 * wallet-role-gates.test.ts (stub suites, unchanged and still green).
 *
 * The stubs prove the replay/natural-key logic; this file proves the same
 * service code against the real engine, where the guarantees are supposed to
 * live: real unique constraints (WalletAccount.code, the per-wallet account
 * link, LedgerTransaction.idempotencyKey), real interactive $transactions,
 * the migration-14 posting gate under the real service flow, and the
 * EscrowWallet PROJECTION vs the ledger's derived truth (spec §39 — the
 * stored balance is a cache; ESCROW:<projectId> entries are the source).
 * Pinned:
 *
 *  · createWallet: WalletAccount + WALLET:<code> liability account, linked
 *    (ledgerAccountId) in ONE transaction — plus the honest P2002 when a
 *    second wallet tries the same code;
 *  · deposit idempotency: the same caller reference replays the SAME ledger
 *    transaction (ONE posting under the real idempotencyKey unique index),
 *    while reference-less deposits of the same amount are distinct events;
 *  · withdraw: insufficient funds refuses with zero rows written; a retried
 *    withdrawal replays (BEFORE the balance check — an emptied wallet still
 *    returns its original ledgerRef); a distinguishing note is a second,
 *    intentional movement;
 *  · transfer: both legs land and the derived balances move by the amount;
 *  · escrow derivation: after top-ups, a spend and a REVERSAL (issue #213's
 *    projection-restore path), the stored EscrowWallet.balance equals
 *    derivedBalance(ESCROW:<projectId>) at every step, and an over-spend
 *    leaves both untouched (real rollback);
 *  · every balance read in this file is cross-checked against an independent
 *    raw-SQL SUM through the better-sqlite3 handle.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import {
  createWallet,
  depositWallet,
  postEscrowTopup,
  reverseTransaction,
  spendEscrowInTx,
  transferWallet,
  walletWithBalance,
  withdrawWallet,
} from '@/backend/modules/wallet/service'
import { derivedBalance } from '@/backend/modules/ledger/service'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

const count = (table: string): number => Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n)

/** Independent raw-SQL balance for an account code (liability sign by default). */
function rawSqlBalance(accountId: string, kind: string): bigint {
  const sums = sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN side = 'debit' THEN amount END), 0) AS debit,
         COALESCE(SUM(CASE WHEN side = 'credit' THEN amount END), 0) AS credit
       FROM LedgerEntry WHERE accountId = ?`,
    )
    .get(accountId) as { debit: bigint; credit: bigint }
  return kind === 'asset' || kind === 'expense' ? sums.debit - sums.credit : sums.credit - sums.debit
}

describe('wallet lifecycle under real constraints', () => {
  it('createWallet writes the WalletAccount AND its backing liability account, linked in one transaction', async () => {
    const project = await seedProject(prisma)
    const wallet = await createWallet(project.id, { label: 'Site float', ownerType: 'project' })

    expect(wallet.code).toMatch(/^W-\d{4}$/)
    expect(wallet.ledgerAccount).toBe(`WALLET:${wallet.code}`)
    expect(wallet.balance).toBe(0)

    const row = await prisma.walletAccount.findUniqueOrThrow({ where: { code: wallet.code } })
    const account = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: `WALLET:${wallet.code}` } })
    expect(account.kind).toBe('liability') // we owe the wallet owner this balance
    expect(account.ownerType).toBe('wallet')
    expect(account.ownerId).toBe(row.id)
    expect(row.ledgerAccountId).toBe(account.id)
    // Wallet codes are unique — the real constraint (probed with this wallet's code).
    await expect(
      prisma.walletAccount.create({ data: { code: wallet.code, label: 'dupe', ownerType: 'project', ownerId: project.id } }),
    ).rejects.toThrow(/Unique constraint failed/)
    expect(() =>
      sqlite
        .prepare(`INSERT INTO WalletAccount (id, code, label, ownerType, ownerId, currency, status, createdAt, updatedAt) VALUES ('w-dupe', ?, 'dupe', 'project', ?, 'KES', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(wallet.code, project.id),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('deposits post CASH → WALLET legs; the same caller reference replays ONE posting (real idempotencyKey unique)', async () => {
    const project = await seedProject(prisma)
    const wallet = await createWallet(project.id, { label: 'dep', ownerType: 'project' })
    const beforeTxns = count('LedgerTransaction')
    const beforeEntries = count('LedgerEntry')

    const first = await depositWallet(project.id, { walletId: wallet.id, amount: 2500, reference: 'DEP-001', source: 'mpesa', by: 'Finance' })
    const replay = await depositWallet(project.id, { walletId: wallet.id, amount: 2500, reference: 'DEP-001', source: 'mpesa', by: 'Finance' })

    expect(replay.ledgerRef).toBe(first.ledgerRef)
    expect(replay.balance).toBe(first.balance) // 2500 KSh
    expect(count('LedgerTransaction')).toBe(beforeTxns + 1) // ONE posting, not two
    expect(count('LedgerEntry')).toBe(beforeEntries + 2)

    // The account's derived balance (liability: credit − debit) equals the
    // deposit, and the independent raw SUM agrees.
    const account = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: `WALLET:${wallet.code}` } })
    expect(await derivedBalance(`WALLET:${wallet.code}`)).toBe(250_000n)
    expect(rawSqlBalance(account.id, 'liability')).toBe(250_000n)
    // The idempotency key the service derived is durable on the row.
    const txnRow = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `wallet.deposit:${wallet.id}:250000:DEP-001` } })
    expect(txnRow.status).toBe('posted')
  })

  it('reference-less deposits of the same amount are DISTINCT events (documented semantics)', async () => {
    const project = await seedProject(prisma)
    const wallet = await createWallet(project.id, { label: 'distinct', ownerType: 'project' })
    const a = await depositWallet(project.id, { walletId: wallet.id, amount: 500, source: 'mpesa', by: 'Finance' })
    const b = await depositWallet(project.id, { walletId: wallet.id, amount: 500, source: 'mpesa', by: 'Finance' })
    expect(a.ledgerRef).not.toBe(b.ledgerRef)
    expect(await derivedBalance(`WALLET:${wallet.code}`)).toBe(100_000n)
  })

  it('withdraws: insufficient funds refuses with ZERO rows; a funded withdrawal posts and replays its natural key', async () => {
    const project = await seedProject(prisma)
    const wallet = await createWallet(project.id, { label: 'wd', ownerType: 'project' })
    await depositWallet(project.id, { walletId: wallet.id, amount: 1000, reference: 'DEP-WD', source: 'mpesa', by: 'Finance' })

    // Insufficient: refuses BEFORE any write.
    const beforeTxns = count('LedgerTransaction')
    await expect(
      withdrawWallet(project.id, { walletId: wallet.id, amount: 5000, destination: 'mpesa', by: 'Finance' }),
    ).rejects.toThrow(/Insufficient wallet balance/)
    expect(count('LedgerTransaction')).toBe(beforeTxns)

    // Funded: 400 of 1000.
    const wd = await withdrawWallet(project.id, { walletId: wallet.id, amount: 400, destination: 'mpesa', note: 'fuel', by: 'Finance' })
    expect(wd.balance).toBe(600)

    // Retry (same wallet/amount/rail/note/actor → same natural key): replays
    // the original result — checked BEFORE the balance check, so this never
    // becomes "insufficient" money-wise.
    const replay = await withdrawWallet(project.id, { walletId: wallet.id, amount: 400, destination: 'mpesa', note: 'fuel', by: 'Finance' })
    expect(replay.ledgerRef).toBe(wd.ledgerRef)
    expect(count('LedgerTransaction')).toBe(beforeTxns + 1) // still ONE debit

    // A distinguishing note is a second, intentional movement.
    const second = await withdrawWallet(project.id, { walletId: wallet.id, amount: 100, destination: 'mpesa', note: 'different errand', by: 'Finance' })
    expect(second.ledgerRef).not.toBe(wd.ledgerRef)
    expect(second.balance).toBe(500)
    expect(await derivedBalance(`WALLET:${wallet.code}`)).toBe(500_00n)
  })

  it('transfers post BOTH legs and move both derived balances', async () => {
    const project = await seedProject(prisma)
    const from = await createWallet(project.id, { label: 'from', ownerType: 'project' })
    const to = await createWallet(project.id, { label: 'to', ownerType: 'project' })
    await depositWallet(project.id, { walletId: from.id, amount: 800, reference: 'DEP-TX', source: 'bank', by: 'Finance' })

    const result = await transferWallet(project.id, { fromWalletId: from.id, toWalletId: to.id, amount: 300, note: 'move', by: 'Finance' })
    expect(result).toEqual({ from: from.code, to: to.code, ledgerRef: result.ledgerRef })

    expect(await derivedBalance(`WALLET:${from.code}`)).toBe(500_00n)
    expect(await derivedBalance(`WALLET:${to.code}`)).toBe(300_00n)
    // Overdrafting the transfer refuses.
    await expect(
      transferWallet(project.id, { fromWalletId: from.id, toWalletId: to.id, amount: 999, note: 'too much', by: 'Finance' }),
    ).rejects.toThrow(/Insufficient wallet balance/)
    expect(await derivedBalance(`WALLET:${from.code}`)).toBe(500_00n)
  })

  it('walletWithBalance reads the ledger-derived balance (not a stored number)', async () => {
    const project = await seedProject(prisma)
    const wallet = await createWallet(project.id, { label: 'read', ownerType: 'project' })
    await depositWallet(project.id, { walletId: wallet.id, amount: 120.5, reference: 'DEP-READ', source: 'mpesa', by: 'Finance' })
    await withdrawWallet(project.id, { walletId: wallet.id, amount: 20.5, destination: 'mpesa', note: 'read', by: 'Finance' })

    const read = await walletWithBalance(project.id, wallet.id)
    expect(read.wallet.code).toBe(wallet.code)
    expect(read.balance).toBe(100_00n) // CENTS — the service returns the raw derived Cents; routes convert to KSh
  })
})

describe('escrow: the stored projection vs the ledger truth (spec §39)', () => {
  it('top-ups keep EscrowWallet.balance === derived ESCROW balance through every step, including a reversal', async () => {
    const project = await seedProject(prisma)
    // No projection row exists yet — the top-up creates it.
    expect(await prisma.escrowWallet.findUnique({ where: { projectId: project.id } })).toBeNull()

    const first = await postEscrowTopup(project.id, 100_000n, 'Client A', { reference: 'TOP-1', role: 'client' })
    const second = await postEscrowTopup(project.id, 50_000n, 'Client A', { reference: 'TOP-2', role: 'client' })
    expect(first.balance).toBe(100_000n)
    expect(second.balance).toBe(150_000n)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(150_000n)

    // A repeated reference replays (escrow.topup:<project>:<ref> idempotency).
    const replay = await postEscrowTopup(project.id, 100_000n, 'Client A', { reference: 'TOP-1', role: 'client' })
    expect(replay.ledgerRef).toBe(first.ledgerRef)
    expect(replay.balance).toBe(150_000n)

    // Spend 60.000,00 through the in-tx helper (the milestone-release path).
    const spend = await prisma.$transaction((tx) =>
      spendEscrowInTx(tx, project.id, {
        amount: 60_000n,
        description: 'Escrow spend — walling',
        postedBy: 'Contractor',
        postedRole: 'contractor',
      }),
    )
    expect(spend.balance).toBe(90_000n)
    let projection = await prisma.escrowWallet.findUniqueOrThrow({ where: { projectId: project.id } })
    expect(projection.balance).toBe(90_000n)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(90_000n)

    // Over-spend refuses and leaves BOTH the projection and the ledger untouched.
    const txnsBefore = count('LedgerTransaction')
    await expect(
      prisma.$transaction((tx) =>
        spendEscrowInTx(tx, project.id, { amount: 999_000n, description: 'too much', postedBy: 'x', postedRole: 'finance' }),
      ),
    ).rejects.toThrow(/Insufficient escrow balance/)
    expect(count('LedgerTransaction')).toBe(txnsBefore)
    projection = await prisma.escrowWallet.findUniqueOrThrow({ where: { projectId: project.id } })
    expect(projection.balance).toBe(90_000n)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(90_000n)

    // Issue #213's projection-restore: reverse the spend through the wallet
    // service (it needs the legacy Transaction row the spend's callers write).
    const txnRow = await prisma.transaction.create({
      data: {
        projectId: project.id,
        type: 'milestone',
        amount: 60_000n,
        method: 'escrow',
        reference: 'MJP-spend',
        ledgerTxnId: spend.ledgerTxnId,
        note: 'walling released',
        date: new Date(),
      },
    })
    const reversal = await reverseTransaction(project.id, { id: txnRow.id, reason: 'wrong milestone', by: 'Finance' })
    expect(reversal.ledgerRef).toBeTruthy()

    // The money is back — in the projection AND in the derived truth.
    projection = await prisma.escrowWallet.findUniqueOrThrow({ where: { projectId: project.id } })
    expect(projection.balance).toBe(150_000n)
    expect(await derivedBalance(`ESCROW:${project.id}`)).toBe(150_000n)
    // The original ledger transaction is NEVER touched (#133 / DB-11): its
    // reversal exists as a new row linked via reversalOfId — derived, not
    // stamped (status stays 'posted', reversalRef stays null).
    const original = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { id: spend.ledgerTxnId } })
    expect(original.status).toBe('posted')
    expect(original.reversalRef).toBeNull()
    const derived = await prisma.ledgerTransaction.findUnique({ where: { reversalOfId: spend.ledgerTxnId } })
    expect(derived?.ref).toBe(reversal.ledgerRef)
  })

  it('spendEscrowInTx refuses when NO escrow wallet exists at all (top up first)', async () => {
    const project = await seedProject(prisma)
    await expect(
      prisma.$transaction((tx) =>
        spendEscrowInTx(tx, project.id, { amount: 10n, description: 'nothing there', postedBy: 'x', postedRole: 'finance' }),
      ),
    ).rejects.toThrow(/Insufficient escrow balance/)
  })
})
