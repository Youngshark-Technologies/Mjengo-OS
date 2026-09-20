/**
 * Escrow-spend reversals restore the EscrowWallet projection (issue #213).
 *
 * The money seams under test are pure/shared server modules, so this file
 * swaps @/backend/lib/db for an in-memory stub (the reports-phase-codes /
 * mpesa-daraja pattern — the REAL posting/reversal/ledger core runs) and
 * pins the #213 regression in every escrow-touching shape:
 *  · milestone release → reverse: derived ESCROW == projection again (the
 *    Money-tab chip reads consistent), milestone stays `released` (the
 *    documented terminal state), original row carries `[reversed by LX-…]`;
 *  · the restored money is SPENDABLE again (the pre-#213 bug left it
 *    unspendable): a NEW wallet-method payment request pays from the
 *    restored projection — no double-spend anywhere;
 *  · wallet-method payment request → reverse and wallet-method invoice
 *    payment → reverse: the same derived-vs-projected invariant;
 *  · direction is derived from the legs, never guessed: reversing a
 *    top-up-shaped escrow txn DECREMENTS the projection, and reversing an
 *    external (non-escrow) spend never touches it;
 *  · double-reverse is refused ('already reversed') and moves nothing.
 *
 * The stub's $transaction snapshots + restores state on throw, so rollback
 * is real for the fail-closed assertions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: ledger tables (posting core), project/phase,
// transaction, milestone, paymentRequest, escrowWallet (with upsert — the
// #213 projection restore) + the invoice tables payInvoice touches.
// $transaction snapshots state and restores it when the callback throws.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    projects: new Map<string, Record<string, unknown>>(),
    phases: new Map<string, Record<string, unknown>>(),
    transactions: new Map<string, Record<string, unknown>>(),
    milestones: new Map<string, Record<string, unknown>>(),
    paymentRequests: new Map<string, Record<string, unknown>>(),
    escrowWallets: new Map<string, Record<string, unknown>>(),
    accounts: new Map<string, Record<string, unknown>>(),
    ledgerTxns: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    invoices: new Map<string, Record<string, unknown>>(),
    notifications: new Map<string, Record<string, unknown>>(),
    reset() {
      for (const m of [
        state.projects, state.phases, state.transactions, state.milestones,
        state.paymentRequests, state.escrowWallets, state.accounts,
        state.ledgerTxns, state.entries, state.invoices, state.notifications,
      ]) m.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`

  const pick = (row: Record<string, unknown>, select?: Record<string, true>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row }

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => {
    for (const [key, cond] of Object.entries(where)) {
      if (cond && typeof cond === 'object' && 'not' in (cond as Record<string, unknown>)) {
        if (row[key] === (cond as { not: unknown }).not) return false
      } else if (row[key] !== cond) {
        return false
      }
    }
    return true
  }

  const project = {
    async findUnique({ where }: { where: { id: string } }) {
      const r = state.projects.get(where.id)
      return r ? { ...r } : null
    },
  }

  const phase = {
    async findFirst({ where, select }: { where: Record<string, unknown>; select?: Record<string, true> }) {
      const rows = [...state.phases.values()].filter((p) => matches(p, where))
      return rows.length ? pick(rows[0], select) : null
    },
  }

  const transaction = {
    async findFirst({ where }: { where: Record<string, unknown> }) {
      const row = [...state.transactions.values()].find((t) => matches(t, where))
      return row ? { ...row } : null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const t: Record<string, unknown> = { id: nid('tx'), ...data }
      state.transactions.set(t.id as string, t)
      return { ...t }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const t = state.transactions.get(where.id)
      if (!t) throw new Error(`stub: transaction ${where.id} not found`)
      Object.assign(t, data)
      return { ...t }
    },
  }

  const milestone = {
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const m = state.milestones.get(where.id)
      if (!m) throw new Error(`stub: milestone ${where.id} not found`)
      Object.assign(m, data)
      return { ...m }
    },
  }

  const paymentRequest = {
    async findFirst({ where }: { where: Record<string, unknown> }) {
      const row = [...state.paymentRequests.values()].find((r) => matches(r, where))
      return row ? { ...row } : null
    },
    async findUnique({ where }: { where: { id: string } }) {
      const r = state.paymentRequests.get(where.id)
      return r ? { ...r } : null
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const r = state.paymentRequests.get(where.id)
      if (!r) throw new Error(`stub: paymentRequest ${where.id} not found`)
      Object.assign(r, data)
      return { ...r }
    },
  }

  // Handles the { decrement } / { increment } update operators the wallet
  // projection uses, plus the #213 upsert (projection restore on a missing
  // row is a create-with-delta — crash-safety, mirroring postEscrowTopup).
  const applyWalletData = (w: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'decrement' in (value as Record<string, unknown>)) {
        w[key] = (w[key] as bigint) - (value as { decrement: bigint }).decrement
      } else if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
        w[key] = (w[key] as bigint) + (value as { increment: bigint }).increment
      } else {
        w[key] = value
      }
    }
  }
  const walletOf = (projectId: string) => [...state.escrowWallets.values()].find((x) => x.projectId === projectId)
  const escrowWallet = {
    async findUnique({ where }: { where: { projectId: string } }) {
      const w = walletOf(where.projectId)
      return w ? { ...w } : null
    },
    async update({ where, data }: { where: { projectId: string }; data: Record<string, unknown> }) {
      const w = walletOf(where.projectId)
      if (!w) throw new Error(`stub: escrowWallet ${where.projectId} not found`)
      applyWalletData(w, data)
      return { ...w }
    },
    async upsert({ where, create, update }: { where: { projectId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      let w = walletOf(where.projectId)
      if (!w) {
        w = { id: nid('wallet'), ...create }
        state.escrowWallets.set(w.id as string, w)
      } else {
        applyWalletData(w, update)
      }
      return { ...w }
    },
  }

  const entriesFor = (txnId: string) =>
    [...state.entries.values()]
      .filter((e) => e.transactionId === txnId)
      .map((e) => ({ ...e, account: state.accounts.get(e.accountId as string) ?? null }))
  const ledgerAccount = {
    async findUnique({ where }: { where: { code?: string; id?: string } }) {
      let a: Record<string, unknown> | undefined
      if (where.id) a = state.accounts.get(where.id)
      else if (where.code) a = [...state.accounts.values()].find((x) => x.code === where.code)
      return a ? { ...a } : null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const a: Record<string, unknown> = { id: nid('acct'), ...data }
      state.accounts.set(a.id as string, a)
      return { ...a }
    },
  }
  const ledgerTransaction = {
    async findUnique({ where }: { where: { id?: string; idempotencyKey?: string; reversalOfId?: string } }) {
      let t: Record<string, unknown> | undefined
      if (where.id) t = state.ledgerTxns.get(where.id)
      else if (where.idempotencyKey) {
        t = [...state.ledgerTxns.values()].find((x) => x.idempotencyKey === where.idempotencyKey)
      } else if (where.reversalOfId) {
        // #133 derived-reversal lookup: the row whose reversalOfId points at
        // the queried original.
        t = [...state.ledgerTxns.values()].find((x) => x.reversalOfId === where.reversalOfId)
      }
      return t ? { ...t, entries: entriesFor(t.id as string) } : null
    },
    async create({ data }: { data: Record<string, unknown> & { entries?: { create: Record<string, unknown>[] } } }) {
      const { entries, ...rest } = data
      const t: Record<string, unknown> = { id: nid('ltxn'), status: 'posted', ...rest }
      for (const l of entries?.create ?? []) {
        const e: Record<string, unknown> = { id: nid('entry'), transactionId: t.id, ...l }
        state.entries.set(e.id as string, e)
      }
      state.ledgerTxns.set(t.id as string, t)
      return { ...t, entries: entriesFor(t.id as string) }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const t = state.ledgerTxns.get(where.id)
      if (!t) throw new Error(`stub: ledger txn ${where.id} not found`)
      Object.assign(t, data)
      return { ...t, entries: entriesFor(where.id) }
    },
  }

  const invoice = {
    async findFirst({ where }: { where: Record<string, unknown> }) {
      const row = [...state.invoices.values()].find((i) => matches(i, where))
      return row ? { ...row } : null
    },
    async findUnique({ where }: { where: { id: string } }) {
      const i = state.invoices.get(where.id)
      return i ? { ...i } : null
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const i = state.invoices.get(where.id)
      if (!i) throw new Error(`stub: invoice ${where.id} not found`)
      Object.assign(i, data)
      return { ...i }
    },
  }
  const invoiceLine = {
    // No lines seeded for these fixtures — the 3-way match engine (mocked at
    // the three-way module boundary) sees an empty invoice.
    async findMany() {
      return []
    },
  }
  const orderDeliveryLine = {
    // Unused by these tests (no PO-linked invoices) — present for the shape.
    async findMany() {
      return []
    },
  }
  const notification = {
    async create({ data }: { data: Record<string, unknown> }) {
      const n: Record<string, unknown> = { id: nid('notif'), ...data }
      state.notifications.set(n.id as string, n)
      return { ...n }
    },
  }

  const snapshot = () => {
    const out: [Map<string, Record<string, unknown>>, Map<string, Record<string, unknown>>][] = []
    for (const m of [
      state.projects, state.phases, state.transactions, state.milestones,
      state.paymentRequests, state.escrowWallets, state.accounts, state.ledgerTxns,
      state.entries, state.invoices, state.notifications,
    ]) out.push([m, new Map([...m].map(([k, v]) => [k, { ...v }]))])
    return { seq: state.seq, maps: out }
  }
  const restore = (snap: ReturnType<typeof snapshot>) => {
    state.seq = snap.seq
    for (const [live, saved] of snap.maps) {
      live.clear()
      for (const [k, v] of saved) live.set(k, { ...v })
    }
  }

  const db = {
    project,
    phase,
    transaction,
    milestone,
    paymentRequest,
    escrowWallet,
    ledgerAccount,
    ledgerTransaction,
    invoice,
    invoiceLine,
    orderDeliveryLine,
    notification,
    async $transaction(fn: (tx: typeof db) => unknown) {
      const snap = snapshot()
      try {
        return await fn(db)
      } catch (e) {
        restore(snap) // rollback: a failed reversal leaves NO partial money state
        throw e
      }
    },
    __state: state,
  }
  return { db }
})

vi.mock('@/backend/modules/notify/service', () => ({ notify: vi.fn() }))
// three-way matching is pinned by three-way.test.ts — stub it here so the
// payInvoice test exercises the posting path, not the match engine.
vi.mock('@/backend/modules/invoices/three-way', () => ({
  matchThreeWay: () => ({ mismatches: [] }),
  computeLedgerConsistency: () => ({}),
}))

import { db } from '@/backend/lib/db'
import { payInvoice } from '@/backend/modules/invoices/service'
import {
  payPaymentRequest,
  postEscrowTopup,
  releaseMilestoneAtomic,
  reverseTransaction,
} from '@/backend/modules/wallet/service'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    seq: number
    projects: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    paymentRequests: Map<string, Record<string, unknown>>
    escrowWallets: Map<string, Record<string, unknown>>
    accounts: Map<string, Record<string, unknown>>
    ledgerTxns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    invoices: Map<string, Record<string, unknown>>
    notifications: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

// ---------------------------------------------------------------- fixtures

const P = 'proj-1'

function seedProject() {
  state.projects.set(P, { id: P, name: 'Test Bungalow', client: 'Amina Test' })
}

function seedMilestone(id: string, amount: bigint, status = 'release_requested') {
  state.milestones.set(id, { id, projectId: P, phaseId: null, name: `Milestone ${id}`, amount, status, evidencePhotoIds: '[]' })
}

function seedPaymentRequest(id: string, amount: bigint, method = 'wallet') {
  state.paymentRequests.set(id, {
    id, projectId: P, requestCode: `PR-2026-${id}`, status: 'approved',
    amount, payee: 'Fundi wa Mawe', description: 'work', method,
    relatedEntityType: null, relatedEntityId: null, paidTxnId: null, paidAt: null,
  })
}

function seedInvoice(id: string, total: bigint) {
  state.invoices.set(id, {
    id, invoiceCode: `INV-2026-${id}`, projectId: P, orderId: null, supplierId: null,
    status: 'approved', subtotal: total, tax: 0n, total, paymentMethod: null,
  })
}

/**
 * The Money-tab chip (wallet/repository.ts): derived ESCROW ledger balance vs
 * the stored projection — exactly the two numbers #213 is about.
 */
function escrowChip() {
  const account = [...state.accounts.values()].find((a) => a.code === `ESCROW:${P}`)
  const legs = account ? [...state.entries.values()].filter((e) => e.accountId === account.id) : []
  const debit = legs.filter((e) => e.side === 'debit').reduce((s, e) => s + (e.amount as bigint), 0n)
  const credit = legs.filter((e) => e.side === 'credit').reduce((s, e) => s + (e.amount as bigint), 0n)
  const derived = credit - debit // liability account
  const wallet = [...state.escrowWallets.values()].find((w) => w.projectId === P)
  const projected = wallet ? (wallet.balance as bigint) : 0n
  return { derived, projected, consistent: derived === projected } // cents are exact — no tolerance
}

const fundEscrow = (amount: bigint) => postEscrowTopup(P, amount, 'Amina Test', { reference: `topup-${amount}`, role: 'client' })
const txnRowOf = (ledgerTxnId: string) => [...state.transactions.values()].find((t) => t.ledgerTxnId === ledgerTxnId)

// ---------------------------------------------------------------- the bug

describe('escrow-spend reversals restore the EscrowWallet projection (issue #213)', () => {
  beforeEach(() => state.reset())

  it('milestone release → reverse: derived == projection again, milestone stays released, original row marked', async () => {
    seedProject()
    seedMilestone('m1', 20_000_000n)
    await fundEscrow(100_000_000n)
    const release = await releaseMilestoneAtomic(P, {
      milestone: { id: 'm1', name: 'Milestone m1', amount: 20_000_000n, phaseId: null },
      decider: { name: 'Amina Test', role: 'client' },
      note: null,
    })
    expect(release.balance).toBe(80_000_000n)
    expect(escrowChip()).toEqual({ derived: 80_000_000n, projected: 80_000_000n, consistent: true })

    const out = await reverseTransaction(P, { id: release.transactionId, reason: 'wrong milestone approved', by: 'Finance Fox' })

    // THE #213 invariant: the projection is restored in the same transaction
    expect(escrowChip()).toEqual({ derived: 100_000_000n, projected: 100_000_000n, consistent: true })

    // the mirrored ledger post: ESCROW credit / EXPENSE debit — and the
    // original row is NEVER touched (#133 / DB-11): the reversal exists as a
    // new row linked via reversalOfId, derived not stamped
    const originalLedger = state.ledgerTxns.get(release.ledgerTxnId) as unknown as { status: string; reversalRef: string | null | undefined }
    expect(originalLedger.status).toBe('posted')
    // no stamp was written (stub: never-set key; real DB: NULL)
    expect(originalLedger.reversalRef ?? null).toBeNull()
    const derivedReversal = [...state.ledgerTxns.values()].find((t) => t.reversalOfId === release.ledgerTxnId) as unknown as { ref: string } | undefined
    expect(derivedReversal?.ref).toBe(out.ledgerRef)
    const reversalTxn = [...state.ledgerTxns.values()].find((t) => t.ref === out.ledgerRef) as unknown as { id: string }
    const legs = [...state.entries.values()].filter((e) => e.transactionId === reversalTxn.id)
    expect(legs.filter((e) => e.side === 'credit').map((e) => [e.amount, state.accounts.get(e.accountId as string)?.code])).toContainEqual([20_000_000n, `ESCROW:${P}`])
    expect(legs.filter((e) => e.side === 'debit').map((e) => [e.amount, state.accounts.get(e.accountId as string)?.code])).toContainEqual([20_000_000n, `EXPENSE:${P}`])

    // documented terminal state: the decision history is NOT rewritten
    expect(state.milestones.get('m1')?.status).toBe('released')

    // the compensating legacy row + the marker on the original
    const compensating = state.transactions.get(out.reversalTransactionId as string)
    expect(compensating?.type).toBe('reversal')
    expect(compensating?.amount).toBe(-20_000_000n)
    expect(String(state.transactions.get(release.transactionId)?.note)).toContain('[reversed by LX-')
  })

  it('release → reverse → NEW wallet payment request: the restored money is spendable again (no double-spend)', async () => {
    seedProject()
    seedMilestone('m1', 20_000_000n)
    await fundEscrow(100_000_000n)
    const release = await releaseMilestoneAtomic(P, {
      milestone: { id: 'm1', name: 'Milestone m1', amount: 20_000_000n, phaseId: null },
      decider: { name: 'Amina Test', role: 'client' },
      note: null,
    })
    await reverseTransaction(P, { id: release.transactionId, reason: 'wrong milestone approved', by: 'Finance Fox' })
    expect(escrowChip().projected).toBe(100_000_000n)

    // the documented operator route: re-issue the spend as a NEW request
    seedPaymentRequest('pr1', 20_000_000n, 'wallet')
    const paid = await payPaymentRequest(P, { id: 'pr1', method: 'wallet', paidBy: 'Finance Fox', paidByRole: 'finance' })
    expect(paid.status).toBe('paid')
    expect(paid.balance).toBe(80_000_000n)
    expect(escrowChip()).toEqual({ derived: 80_000_000n, projected: 80_000_000n, consistent: true })

    // no double-spend: top-up + release + reversal + re-issued spend = 4
    // ledger txns; the top-up posts NO legacy row, so 3 Transaction rows
    // (release, reversal, re-issued spend) — the PR paid once
    expect(state.ledgerTxns.size).toBe(4)
    expect(state.transactions.size).toBe(3)
    expect(state.paymentRequests.get('pr1')?.status).toBe('paid')
    expect(state.paymentRequests.get('pr1')?.paidTxnId).toBeTruthy()
  })

  it('wallet-method payment request → reverse: same derived-vs-projected invariant', async () => {
    seedProject()
    await fundEscrow(50_000_000n)
    seedPaymentRequest('pr1', 15_000_000n, 'wallet')
    const paid = await payPaymentRequest(P, { id: 'pr1', method: 'wallet', paidBy: 'Finance Fox', paidByRole: 'finance' })
    expect(escrowChip()).toEqual({ derived: 35_000_000n, projected: 35_000_000n, consistent: true })

    await reverseTransaction(P, { id: paid.transactionId as string, reason: 'duplicate request', by: 'Finance Fox' })

    expect(escrowChip()).toEqual({ derived: 50_000_000n, projected: 50_000_000n, consistent: true })
    expect(String(state.transactions.get(paid.transactionId as string)?.note)).toContain('[reversed by LX-')
  })

  it('wallet-method invoice payment → reverse: same derived-vs-projected invariant', async () => {
    seedProject()
    await fundEscrow(50_000_000n)
    seedInvoice('inv1', 15_000_000n)
    await payInvoice(P, { id: 'inv1', method: 'wallet', by: 'Amina Test' })
    expect(escrowChip()).toEqual({ derived: 35_000_000n, projected: 35_000_000n, consistent: true })

    const invTxn = [...state.transactions.values()].find((t) => t.type === 'invoice')
    await reverseTransaction(P, { id: invTxn?.id as string, reason: 'wrong invoice', by: 'Finance Fox' })

    expect(escrowChip()).toEqual({ derived: 50_000_000n, projected: 50_000_000n, consistent: true })
  })

  it('direction derives from the legs: reversing a top-up-shaped escrow txn DECREMENTS the projection', async () => {
    seedProject()
    await fundEscrow(30_000_000n)
    // a second, manual top-up-shaped ledger txn with its legacy row — the
    // operator-visible handle a reversal needs (escrow.topup posts no legacy
    // row, so simulate the recorded one)
    const { postLedgerTransaction } = await import('@/backend/modules/ledger/service')
    const manual = await postLedgerTransaction({
      projectId: P,
      description: 'Escrow top-up — bank',
      postedBy: 'Amina Test',
      postedRole: 'client',
      lines: [
        { accountCode: 'CASH_BANK', side: 'debit', amount: 10_000_000n },
        { accountCode: `ESCROW:${P}`, side: 'credit', amount: 10_000_000n },
      ],
    })
    state.transactions.set('t-topup', {
      id: 't-topup', projectId: P, type: 'escrow_topup', amount: 10_000_000n, method: 'bank',
      reference: null, costCode: null, phaseId: null, ledgerTxnId: manual.id,
      note: 'manual top-up', date: new Date(), createdAt: new Date(),
    })
    // keep the projection honest with the extra ledger money (what a top-up
    // posting would have done)
    const wallet = [...state.escrowWallets.values()].find((w) => w.projectId === P) as Record<string, unknown>
    wallet.balance = 40_000_000n
    expect(escrowChip()).toEqual({ derived: 40_000_000n, projected: 40_000_000n, consistent: true })

    await reverseTransaction(P, { id: 't-topup', reason: 'reversal of erroneous top-up', by: 'Finance Fox' })

    // the escrow leg was a CREDIT: the reversal takes the money back OUT
    expect(escrowChip()).toEqual({ derived: 30_000_000n, projected: 30_000_000n, consistent: true })
  })

  it('external-spend reversal never touches the escrow projection', async () => {
    seedProject()
    await fundEscrow(50_000_000n)
    seedPaymentRequest('pr1', 12_000_000n, 'cash')
    const paid = await payPaymentRequest(P, { id: 'pr1', method: 'cash', paidBy: 'Finance Fox', paidByRole: 'finance' })
    expect(escrowChip()).toEqual({ derived: 50_000_000n, projected: 50_000_000n, consistent: true })

    await reverseTransaction(P, { id: paid.transactionId as string, reason: 'correction', by: 'Finance Fox' })

    // no ESCROW leg on the original → projection AND derived unchanged
    expect(escrowChip()).toEqual({ derived: 50_000_000n, projected: 50_000_000n, consistent: true })
    expect(state.ledgerTxns.size).toBe(3) // top-up + external spend + mirrored reversal
  })

  it('double-reverse is refused and moves nothing', async () => {
    seedProject()
    seedMilestone('m1', 20_000_000n)
    await fundEscrow(100_000_000n)
    const release = await releaseMilestoneAtomic(P, {
      milestone: { id: 'm1', name: 'Milestone m1', amount: 20_000_000n, phaseId: null },
      decider: { name: 'Amina Test', role: 'client' },
      note: null,
    })
    await reverseTransaction(P, { id: release.transactionId, reason: 'first', by: 'Finance Fox' })
    const chipBefore = escrowChip()
    const ledgersBefore = state.ledgerTxns.size
    const rowsBefore = state.transactions.size

    await expect(reverseTransaction(P, { id: release.transactionId, reason: 'second', by: 'Finance Fox' })).rejects.toThrow(/already reversed/i)

    expect(escrowChip()).toEqual(chipBefore)
    expect(state.ledgerTxns.size).toBe(ledgersBefore)
    expect(state.transactions.size).toBe(rowsBefore)
  })
})
