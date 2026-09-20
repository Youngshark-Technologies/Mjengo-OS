/**
 * Double-entry ledger invariants (src/backend/modules/ledger/service.ts).
 *
 * The ledger is "the single way money moves" (spec §39). Its core rules are
 * enforced in pure code paths that only need a Prisma transaction client, so
 * this file swaps @/backend/lib/db for a tiny in-memory stub and tests the
 * REAL posting/reversal logic:
 *  · unbalanced (debits ≠ credits) or malformed lines never post;
 *  · a posted transaction carries balanced legs;
 *  · an idempotency key replays the original transaction — never a double post;
 *  · a reversal is a NEW mirrored transaction linked via reversalOfId — the
 *    original row is never touched (DB-11 / #133: "is reversed?" is derived
 *    from the link, never stamped);
 *  · derived balances follow the account's normal side.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of ledgerAccount / ledgerTransaction /
// $transaction for the posting core. __state exposes the tables for assertions.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    accounts: new Map<string, Record<string, unknown>>(),
    txns: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    reset() {
      state.accounts.clear()
      state.txns.clear()
      state.entries.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const entriesFor = (txnId: string) =>
    [...state.entries.values()]
      .filter((e) => e.transactionId === txnId)
      .map((e) => ({ ...e, account: state.accounts.get(e.accountId as string) ?? null }))

  const entriesForAccount = (accountId: string) =>
    [...state.entries.values()].filter((e) => e.accountId === accountId)
  const ledgerAccount = {
    async findUnique({ where }: { where: { code?: string; id?: string } }) {
      let a: Record<string, unknown> | undefined
      if (where.id) a = state.accounts.get(where.id)
      else if (where.code) a = [...state.accounts.values()].find((x) => x.code === where.code)
      return a ? { ...a, entries: entriesForAccount(a.id as string) } : null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const a: Record<string, unknown> = { id: nid('acct'), ...data }
      state.accounts.set(a.id as string, a)
      return a
    },
  }
  const ledgerTransaction = {
    async findUnique({ where }: { where: { id?: string; idempotencyKey?: string; reversalOfId?: string } }) {
      let t: Record<string, unknown> | undefined
      if (where.id) t = state.txns.get(where.id)
      else if (where.idempotencyKey) {
        t = [...state.txns.values()].find((x) => x.idempotencyKey === where.idempotencyKey)
      } else if (where.reversalOfId) {
        // The #133 derived-reversal lookup: the (unique) row whose
        // reversalOfId points at the queried original.
        t = [...state.txns.values()].find((x) => x.reversalOfId === where.reversalOfId)
      }
      return t ? { ...t, entries: entriesFor(t.id as string) } : null
    },
    async create({ data }: { data: Record<string, unknown> & { entries?: { create: Record<string, unknown>[] } } }) {
      const { entries, ...rest } = data
      const t: Record<string, unknown> = { id: nid('txn'), status: 'posted', reversalRef: null, ...rest }
      const created = (entries?.create ?? []).map((l) => {
        const e: Record<string, unknown> = { id: nid('entry'), transactionId: t.id, ...l }
        state.entries.set(e.id as string, e)
        return { ...e, account: state.accounts.get(e.accountId as string) ?? null }
      })
      state.txns.set(t.id as string, t)
      return { ...t, entries: created }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const t = state.txns.get(where.id)
      if (!t) throw new Error(`stub: txn ${where.id} not found`)
      Object.assign(t, data)
      return { ...t, entries: entriesFor(where.id) }
    },
  }
  const ledgerEntry = {
    // The SQL-SUM balance path (issue #144): derivedBalance aggregates
    // Σdebit/Σcredit via ledgerEntry.groupBy instead of loading rows.
    // Faithful Prisma groupBy twin over the in-memory entries — groups by
    // the requested fields, sums the requested aggregates.
    async groupBy({
      by,
      _sum,
      where,
    }: {
      by: string[]
      _sum?: { amount?: boolean }
      where?: { accountId?: string }
    }) {
      let rows = [...state.entries.values()]
      if (where?.accountId) rows = rows.filter((e) => e.accountId === where.accountId)
      const groups = new Map<string, Record<string, unknown>>()
      for (const e of rows) {
        const key = by.map((f) => (e as Record<string, unknown>)[f]).join('\u0000')
        let g = groups.get(key)
        if (!g) {
          g = Object.fromEntries(by.map((f) => [f, (e as Record<string, unknown>)[f]]))
          if (_sum?.amount) g._sum = { amount: 0n }
          groups.set(key, g)
        }
        if (_sum?.amount) g._sum.amount = (g._sum.amount as bigint) + (e.amount as bigint)
      }
      return [...groups.values()]
    },
  }
  const db = {
    ledgerAccount,
    ledgerEntry,
    ledgerTransaction,
    async $transaction(fn: (tx: typeof db) => unknown) {
      return fn(db)
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import {
  cashAccountForMethod, derivedBalance, ensureAccount, findReversalOf, isReversed,
  postLedgerTransaction, reverseLedgerTransaction,
} from '@/backend/modules/ledger/service'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state

/** The posting core always returns the transaction WITH its entries (include). */
type Posted = {
  id: string
  ref: string
  status: string
  description: string
  reversalOfId: string | null
  entries: { id: string; side: string; amount: bigint; memo: string | null }[]
}
const asPosted = (t: unknown): Posted => t as Posted
function getState() {
  return undefined as unknown as {
    accounts: Map<string, Record<string, unknown>>
    txns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

const BALANCED_LINES = [
  { accountCode: 'CASH_MPESA', side: 'debit' as const, amount: 100000n },
  { accountCode: 'ESCROW:proj-1', side: 'credit' as const, amount: 100000n },
]

const post = (over: Record<string, unknown> = {}) =>
  postLedgerTransaction({
    projectId: 'proj-1',
    description: 'escrow top-up',
    lines: BALANCED_LINES,
    postedBy: 'finance@mjengo.os',
    postedRole: 'finance',
    ...over,
  })

beforeEach(() => {
  state.reset()
})

describe('validateLines — unbalanced or malformed transactions never post', () => {
  it('rejects debits ≠ credits', async () => {
    await expect(
      post({
        lines: [
          { accountCode: 'CASH_MPESA', side: 'debit', amount: 100000n },
          { accountCode: 'ESCROW:proj-1', side: 'credit', amount: 99900n },
        ],
      }),
    ).rejects.toThrow(/Unbalanced ledger transaction: debits 100000 ≠ credits 99900 \(cents\)/)
  })

  it('rejects an empty line set', async () => {
    await expect(post({ lines: [] })).rejects.toThrow('Ledger transaction needs at least one line')
  })

  it('rejects non-positive amounts (zero or negative money is nonsense)', async () => {
    await expect(
      post({ lines: [{ accountCode: 'CASH_MPESA', side: 'debit', amount: 0n }, { accountCode: 'CASH_MPESA', side: 'credit', amount: 0n }] }),
    ).rejects.toThrow('Ledger amounts must be positive')
    await expect(
      post({ lines: [{ accountCode: 'CASH_MPESA', side: 'debit', amount: -500n }, { accountCode: 'CASH_MPESA', side: 'credit', amount: -500n }] }),
    ).rejects.toThrow('Ledger amounts must be positive')
  })

  it('rejects a nonsense side', async () => {
    await expect(
      post({ lines: [{ accountCode: 'CASH_MPESA', side: 'up', amount: 500n } as never] }),
    ).rejects.toThrow('Ledger side must be debit or credit')
  })

  it('nothing was written when validation fails', async () => {
    await expect(post({ lines: [] })).rejects.toThrow()
    expect(state.txns.size).toBe(0)
    expect(state.entries.size).toBe(0)
  })
})

describe('postLedgerTransaction — balanced double entry', () => {
  it('creates one transaction whose debit legs sum to its credit legs', async () => {
    const txn = asPosted(await post())
    const debit = txn.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0n)
    const credit = txn.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0n)
    expect(debit).toBe(100000n)
    expect(credit).toBe(100000n)
    expect(txn.status).toBe('posted')
    expect(txn.reversalOfId).toBeNull()
  })

  it('resolves the platform cash account and the project escrow account', async () => {
    await post()
    const cash = await ensureAccount('CASH_MPESA')
    const escrow = await ensureAccount('ESCROW:proj-1')
    expect(cash.kind).toBe('asset')
    expect(escrow.kind).toBe('liability')
    // ownership lives on the account row (ensureAccount returns only id/kind/name)
    const escrowRow = [...state.accounts.values()].find((a) => a.code === 'ESCROW:proj-1')
    expect(escrowRow!.ownerType).toBe('project')
    expect(escrowRow!.ownerId).toBe('proj-1')
  })

  it('replays the original transaction for a repeated idempotency key (no double post)', async () => {
    const first = asPosted(await post({ idempotencyKey: 'topup-42' }))
    const replay = asPosted(await post({ idempotencyKey: 'topup-42' }))
    expect(replay.id).toBe(first.id)
    expect([...state.txns.values()].filter((t) => t.idempotencyKey === 'topup-42')).toHaveLength(1)
    expect(state.entries.size).toBe(2) // still exactly two legs
  })

  it('persists WHO posted onto the transaction row (BE-7: the wallet/wages seams thread the session actor)', async () => {
    // The actor-attribution contract issue #103 relies on: every posting seam
    // (wallet deposit/withdraw/transfer/reversal, journals, escrow top-ups,
    // wages) passes a real postedBy/postedRole into this engine, and the row
    // keeps it verbatim — the audit trail and the ledger name the same person.
    await post({ postedBy: 'Fatuma Kep', postedRole: 'finance' })
    const row = [...state.txns.values()][0]
    expect(row.postedBy).toBe('Fatuma Kep')
    expect(row.postedRole).toBe('finance')
  })

  it('posts through the pending→posted DB gate (#124 / migration 14): born pending, marked posted last', async () => {
    // The DB-level invariants live in migration 14 (pinned in
    // db-integrity-constraints.test.ts against the real trigger SQL); this
    // test pins the SERVICE-side half of the contract — the write sequence
    // the triggers are designed around: the transaction is created with
    // status 'pending', its legs attach, and the FINAL write marks it
    // 'posted' (LedgerTransaction_posting_gate asserts Σdebits = Σcredits
    // at exactly that UPDATE). A regression to born-'posted' creates would
    // desync the service from the DB guards and fail every real posting.
    const createSpy = vi.spyOn(db.ledgerTransaction, 'create')
    const updateSpy = vi.spyOn(db.ledgerTransaction, 'update')
    const txn = asPosted(await post())

    // born pending …
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect((createSpy.mock.calls[0][0] as { data: { status?: string } }).data.status).toBe('pending')
    // … legs attached inside the same create …
    expect(state.entries.size).toBe(2)
    // … then marked posted as the last write of the flow
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: txn.id }, data: { status: 'posted' } }),
    )
    expect(txn.status).toBe('posted')
    // no transaction is left behind in the intermediate state
    expect([...state.txns.values()].every((t) => t.status === 'posted')).toBe(true)
  })
})

describe('ensureAccountTx — chart of accounts resolution', () => {
  it('is idempotent per code (one account row, ever)', async () => {
    const a = await ensureAccount('CASH_BANK')
    const b = await ensureAccount('CASH_BANK')
    expect(a.id).toBe(b.id)
    expect([...state.accounts.values()].filter((x) => x.code === 'CASH_BANK')).toHaveLength(1)
  })

  it('ESCROW:<projectId> is a liability with a credit normal side', async () => {
    const acct = await ensureAccount('ESCROW:proj-2')
    expect(acct.kind).toBe('liability')
  })

  it('EXPENSE:<projectId> is an expense with a debit normal side', async () => {
    const acct = await ensureAccount('EXPENSE:proj-2')
    expect(acct.kind).toBe('expense')
  })

  it('unknown codes are refused — no silent implicit accounts', async () => {
    await expect(ensureAccount('MISC_WHATEVER')).rejects.toThrow(/Unknown ledger account code/)
  })
})

describe('reverseLedgerTransaction — corrections are new rows, never edits (DB-11 / #133)', () => {
  it('creates a mirrored transaction and leaves the original row untouched', async () => {
    const original = asPosted(await post())
    const originalEntryIds = [...state.entries.values()].filter((e) => e.transactionId === original.id).map((e) => e.id)
    const originalRowBefore = { ...state.txns.get(original.id) as Record<string, unknown> }

    const reversal = asPosted(await reverseLedgerTransaction(original.id, 'wrong amount', 'finance@mjengo.os', 'finance'))

    // the original's history is untouched (append-only): same entries…
    expect([...state.entries.values()].filter((e) => e.transactionId === original.id).map((e) => e.id)).toEqual(originalEntryIds)
    // …and the SAME ROW — byte-identical, no status/reversalRef stamp (#133:
    // the pre-#133 model flipped the original to 'reversed' here)
    expect(state.txns.get(original.id)).toEqual(originalRowBefore)
    expect((state.txns.get(original.id) as Record<string, unknown>).status).toBe('posted')

    // the reversal points back at the original and mirrors every leg
    expect(reversal.reversalOfId).toBe(original.id)
    expect(reversal.description).toContain('REVERSAL of')
    expect(reversal.entries.map((e) => e.side).sort()).toEqual(['credit', 'debit'])
    const bySide = (side: string) => reversal.entries.find((e) => e.side === side)
    expect(bySide('debit')!.amount).toBe(100000n) // escrow leg flipped to debit
    expect(bySide('credit')!.amount).toBe(100000n) // cash leg flipped to credit
  })

  it('a reversal nets every touched account back to zero', async () => {
    const original = asPosted(await post())
    await reverseLedgerTransaction(original.id, 'test reversal', 'finance@mjengo.os', 'finance')
    expect(await derivedBalance('CASH_MPESA')).toBe(0n)
    expect(await derivedBalance('ESCROW:proj-1')).toBe(0n)
  })

  it('derived state: findReversalOf/isReversed read the link, not a stamp', async () => {
    const original = asPosted(await post())
    // not reversed yet — no row points at it
    expect(await isReversed(original.id)).toBe(false)
    expect(await findReversalOf(db, original.id)).toBeNull()

    const reversal = asPosted(await reverseLedgerTransaction(original.id, 'derived probe', 'finance@mjengo.os', 'finance'))

    // reversed now — DERIVED from the reversalOfId link (the original row
    // still says 'posted'; nothing was stamped)
    expect(await isReversed(original.id)).toBe(true)
    const found = await findReversalOf(db, original.id)
    expect(found?.id).toBe(reversal.id)
    expect(found?.ref).toBe(reversal.ref)
    // the reversal itself is NOT reversed (no link points at it)
    expect(await isReversed(reversal.id)).toBe(false)
    // unknown ids are honestly not-reversed (no throw)
    expect(await isReversed('nope')).toBe(false)
  })

  it('refuses to reverse an already-reversed transaction (derived guard)', async () => {
    const original = asPosted(await post())
    await reverseLedgerTransaction(original.id, 'first', 'finance@mjengo.os', 'finance')
    await expect(reverseLedgerTransaction(original.id, 'second', 'finance@mjengo.os', 'finance')).rejects.toThrow(
      'Transaction already reversed',
    )
    // exactly ONE reversal row points at the original — the guard read the
    // link, and a second reversal never landed
    expect([...state.txns.values()].filter((t) => t.reversalOfId === original.id)).toHaveLength(1)
  })

  it('refuses to reverse an unknown transaction id', async () => {
    await expect(reverseLedgerTransaction('nope', 'x', 'finance@mjengo.os', 'finance')).rejects.toThrow(
      'Ledger transaction not found',
    )
  })
})

describe('derivedBalance — balances are projections of entries', () => {
  it('asset accounts are debit-minus-credit', async () => {
    await post()
    expect(await derivedBalance('CASH_MPESA')).toBe(100000n)
  })

  it('liability accounts are credit-minus-debit', async () => {
    await post()
    expect(await derivedBalance('ESCROW:proj-1')).toBe(100000n)
  })

  it('an unknown account has balance 0 (no throw)', async () => {
    expect(await derivedBalance('CASH_BANK')).toBe(0n)
  })
})

describe('cashAccountForMethod — payment rail mapping', () => {
  it("M-Pesa settles into the mobile-money pool", () => {
    // The rail enum is the lowercase word 'mpesa' (PaymentMethod); casing is
    // tolerated, but a hyphenated brand spelling is NOT a rail this app emits.
    expect(cashAccountForMethod('mpesa')).toBe('CASH_MPESA')
    expect(cashAccountForMethod('MPESA')).toBe('CASH_MPESA')
    expect(cashAccountForMethod('Mpesa')).toBe('CASH_MPESA')
  })

  it('everything else settles into the bank float', () => {
    for (const m of ['bank', 'card', 'cash', 'cheque', '']) {
      expect(cashAccountForMethod(m)).toBe('CASH_BANK')
    }
  })
})
