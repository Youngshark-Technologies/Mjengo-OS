/**
 * Transaction phase cost-codes (issue #39) — the posting-seam stamps + the
 * budget-variance report's honest mixed-mode attribution.
 *
 * The money seams under test are pure/shared server modules, so this file
 * swaps @/backend/lib/db for an in-memory stub (the ledger.test.ts /
 * mpesa-daraja.test.ts pattern — the REAL posting/reversal/ledger logic runs)
 * and pins:
 *  · report rollup: a stamped Transaction (phaseId) counts DIRECTLY to its
 *    phase — no estimate; null rows keep the documented budget-share estimate
 *    (numbers identical to the pre-cost-code path); legacy rows derive exactly
 *    through PaymentRequest → milestone → phase; mixed mode keeps the
 *    Σ phases.spent == project.spent invariant;
 *  · honest mode statement: phaseAttribution.mode is 'real' only when every
 *    row is coded, 'mixed' when part-coded, 'estimated' when nothing is coded
 *    ('none' when there is no spend), and codedSpent + milestoneDerivedSpent +
 *    estimatedSpent == spent with the counts == every transaction;
 *  · fail-closed validation: a FOREIGN phaseId is rejected at every stamped
 *    posting seam with an honest error and NO money movement (the stub's
 *    $transaction snapshots + restores state on throw, so rollback is real);
 *  · money math untouched: amounts, balanced ledger legs and wallet balances
 *    are byte-identical to the pre-feature behavior — phaseId is an
 *    attribution dimension only;
 *  · legacy rows unaffected: an uncoded original reverses to an uncoded row;
 *    a stamped original reverses to the SAME phase (net attribution exact).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: ledger tables (posting core), project/phase/task,
// transaction, milestone, paymentRequest, escrowWallet + the invoice tables
// payInvoice touches. __state exposes the tables for assertions.
// $transaction snapshots state and restores it when the callback throws —
// real rollback semantics for the fail-closed money tests.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    projects: new Map<string, Record<string, unknown>>(),
    phases: new Map<string, Record<string, unknown>>(),
    tasks: new Map<string, Record<string, unknown>>(),
    transactions: new Map<string, Record<string, unknown>>(),
    milestones: new Map<string, Record<string, unknown>>(),
    paymentRequests: new Map<string, Record<string, unknown>>(),
    escrowWallets: new Map<string, Record<string, unknown>>(),
    accounts: new Map<string, Record<string, unknown>>(),
    ledgerTxns: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    invoices: new Map<string, Record<string, unknown>>(),
    invoiceLines: new Map<string, Record<string, unknown>>(),
    notifications: new Map<string, Record<string, unknown>>(),
    reset() {
      for (const m of [
        state.projects, state.phases, state.tasks, state.transactions,
        state.milestones, state.paymentRequests, state.escrowWallets,
        state.accounts, state.ledgerTxns, state.entries, state.invoices,
        state.invoiceLines, state.notifications,
      ]) m.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const copy = <T,>(v: T): T => (typeof v === 'object' && v !== null ? { ...(v as object) } as T : v)

  const pick = (row: Record<string, unknown>, select?: Record<string, true>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, copy(row[k])])) : { ...row }

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

  const sortBy = (rows: Record<string, unknown>[], orderBy?: { [k: string]: 'asc' | 'desc' }) => {
    if (!orderBy) return rows
    const [key, dir] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc']
    return [...rows].sort((a, b) => {
      const av = a[key] as number | string
      const bv = b[key] as number | string
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return dir === 'desc' ? -cmp : cmp
    })
  }

  const project = {
    async findUnique({ where }: { where: { id: string } }) {
      const r = state.projects.get(where.id)
      return r ? { ...r } : null
    },
  }

  const tasksOfPhase = (phaseId: string) =>
    [...state.tasks.values()].filter((t) => t.phaseId === phaseId).map((t) => ({ ...t }))

  const phase = {
    async findMany({ where, orderBy, include }: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>; include?: { tasks?: boolean } }) {
      const rows = sortBy([...state.phases.values()].filter((p) => matches(p, where)), orderBy)
      return rows.map((p) => (include?.tasks ? { ...p, tasks: tasksOfPhase(p.id as string) } : { ...p }))
    },
    async findFirst({ where, select }: { where: Record<string, unknown>; select?: Record<string, true> }) {
      const rows = [...state.phases.values()].filter((p) => matches(p, where))
      return rows.length ? pick(rows[0], select) : null
    },
  }

  const transaction = {
    async findMany({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }) {
      return sortBy([...state.transactions.values()].filter((t) => matches(t, where)), orderBy).map((t) => ({ ...t }))
    },
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
    async findMany({ where, select }: { where: Record<string, unknown>; select?: Record<string, true> }) {
      return [...state.milestones.values()].filter((m) => matches(m, where)).map((m) => pick(m, select))
    },
    async findFirst({ where, select }: { where: Record<string, unknown>; select?: Record<string, true> }) {
      const row = [...state.milestones.values()].find((m) => matches(m, where))
      return row ? pick(row, select) : null
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const m = state.milestones.get(where.id)
      if (!m) throw new Error(`stub: milestone ${where.id} not found`)
      Object.assign(m, data)
      return { ...m }
    },
  }

  const paymentRequest = {
    async findMany({ where, select }: { where: Record<string, unknown>; select?: Record<string, true> }) {
      return [...state.paymentRequests.values()].filter((r) => matches(r, where)).map((r) => pick(r, select))
    },
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
  // projection uses (everything else is a plain assign).
  const escrowWallet = {
    async findUnique({ where }: { where: { projectId: string } }) {
      const w = [...state.escrowWallets.values()].find((x) => x.projectId === where.projectId)
      return w ? { ...w } : null
    },
    async update({ where, data }: { where: { projectId: string }; data: Record<string, unknown> }) {
      const w = [...state.escrowWallets.values()].find((x) => x.projectId === where.projectId)
      if (!w) throw new Error(`stub: escrowWallet ${where.projectId} not found`)
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'decrement' in (value as Record<string, unknown>)) {
          w[key] = (w[key] as number) - (value as { decrement: number }).decrement
        } else if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
          w[key] = (w[key] as number) + (value as { increment: number }).increment
        } else {
          w[key] = value
        }
      }
      return { ...w }
    },
  }

  const entriesFor = (txnId: string) => [...state.entries.values()].filter((e) => e.transactionId === txnId)
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
        // #133 derived-reversal lookup (the double-reversal guard's read).
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
    async findMany({ where }: { where: Record<string, unknown> }) {
      return [...state.invoiceLines.values()].filter((l) => matches(l, where)).map((l) => ({ ...l }))
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
      state.projects, state.phases, state.tasks, state.transactions, state.milestones,
      state.paymentRequests, state.escrowWallets, state.accounts, state.ledgerTxns,
      state.entries, state.invoices, state.invoiceLines, state.notifications,
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
        restore(snap) // rollback: a failed posting leaves NO partial money state
        throw e
      }
    },
    __state: state,
  }
  return { db }
})

vi.mock('@/backend/modules/notify/service', () => ({ notify: vi.fn() }))
// three-way matching is pinned by three-way.test.ts — stub it here so the
// payInvoice tests exercise the posting path, not the match engine.
vi.mock('@/backend/modules/invoices/three-way', () => ({
  matchThreeWay: () => ({ mismatches: [] }),
  computeLedgerConsistency: () => ({}),
}))
// The report imports overallProgress from the app monolith; stub it (progress
// is not this feature — attribution is). Everything else runs for real.
vi.mock('@/backend/lib/mjengo', () => ({ overallProgress: () => 0 }))

import { db } from '@/backend/lib/db'
import { buildBudgetVarianceReport } from '@/backend/modules/reports/service'
import { payInvoice } from '@/backend/modules/invoices/service'
import {
  payPaymentRequest,
  releaseMilestoneAtomic,
  resolvePostingPhaseId,
  reverseTransaction,
} from '@/backend/modules/wallet/service'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    seq: number
    projects: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    tasks: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    paymentRequests: Map<string, Record<string, unknown>>
    escrowWallets: Map<string, Record<string, unknown>>
    accounts: Map<string, Record<string, unknown>>
    ledgerTxns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    invoices: Map<string, Record<string, unknown>>
    invoiceLines: Map<string, Record<string, unknown>>
    notifications: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

// ---------------------------------------------------------------- fixtures

const P = 'proj-1'
const d = (n: number) => new Date(`2026-01-${String(n).padStart(2, '0')}T10:00:00.000Z`)

interface SeedPhase { id: string; order: number; budget: bigint; status?: string }
interface SeedTxn { id: string; amount: bigint; day: number; type?: string; phaseId?: string | null }

function seedProject(phases: SeedPhase[], txns: SeedTxn[]) {
  state.projects.set(P, { id: P, name: 'Test Bungalow', client: 'Amina Test' })
  for (const f of phases) {
    state.phases.set(f.id, { id: f.id, projectId: P, name: f.id, order: f.order, budget: f.budget, status: f.status ?? 'in_progress', progressManual: null })
  }
  for (const t of txns) {
    state.transactions.set(t.id, {
      id: t.id, projectId: P, type: t.type ?? 'material', amount: t.amount,
      method: 'mpesa', reference: null, costCode: null, phaseId: t.phaseId ?? null,
      ledgerTxnId: null, note: `note ${t.id}`, date: d(t.day), createdAt: d(t.day),
    })
  }
}

function seedMilestone(id: string, phaseId: string | null, amount = 65_000_000n, status = 'release_requested') {
  state.milestones.set(id, { id, projectId: P, phaseId, name: `Milestone ${id}`, amount, status, evidencePhotoIds: '[]' })
}

function seedEscrow(balance: bigint) {
  state.escrowWallets.set('wallet-1', { id: 'wallet-1', projectId: P, balance, ledgerAccountId: null })
}

const phaseOf = (id: string) => (r: { phases: { id: string }[] }) => r.phases.find((f) => f.id === id)

// ---------------------------------------------------------------- report rollup

describe('budget variance report — phase cost-code attribution', () => {
  beforeEach(() => state.reset())

  it('every row stamped → mode "real": DIRECT attribution, zero estimate', async () => {
    seedProject(
      [
        { id: 'phase-a', order: 1, budget: 10000000n },
        { id: 'phase-b', order: 2, budget: 10000000n },
      ],
      [
        { id: 't1', amount: 4000000n, day: 1, phaseId: 'phase-a' },
        { id: 't2', amount: 6000000n, day: 2, phaseId: 'phase-b' },
        { id: 't3', amount: 1000000n, day: 3, phaseId: 'phase-a' },
      ],
    )
    const r = await buildBudgetVarianceReport(P)
    expect(r).not.toBeNull()
    expect(phaseOf('phase-a')(r!).spent).toBe(50_000) // exact — no estimate share
    expect(phaseOf('phase-b')(r!).spent).toBe(60_000)
    expect(phaseOf('phase-a')(r!).codedSpent).toBe(50_000)
    expect(phaseOf('phase-a')(r!).codedTxnCount).toBe(2)
    expect(phaseOf('phase-b')(r!).codedTxnCount).toBe(1)
    expect(r!.phaseAttribution).toEqual({
      mode: 'real',
      codedSpent: 110_000,
      codedTxnCount: 3,
      milestoneDerivedSpent: 0,
      milestoneDerivedTxnCount: 0,
      estimatedSpent: 0,
      estimatedTxnCount: 0,
    })
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent)
  })

  it('nothing stamped → mode "estimated": the legacy budget-share estimate is byte-identical', async () => {
    // Deterministic greedy allocation pinned by hand: targets 45k/45k over
    // started phases with equal budgets → 30k→A, 30k→B, 30k→A (tie keeps the
    // earliest phase).
    seedProject(
      [
        { id: 'phase-a', order: 1, budget: 10000000n },
        { id: 'phase-b', order: 2, budget: 10000000n },
      ],
      [
        { id: 't1', amount: 3000000n, day: 1 },
        { id: 't2', amount: 3000000n, day: 2 },
        { id: 't3', amount: 3000000n, day: 3 },
      ],
    )
    const r = await buildBudgetVarianceReport(P)
    expect(phaseOf('phase-a')(r!).spent).toBe(60_000)
    expect(phaseOf('phase-b')(r!).spent).toBe(30_000)
    expect(phaseOf('phase-a')(r!).codedSpent).toBe(0)
    expect(r!.phaseAttribution.mode).toBe('estimated')
    expect(r!.phaseAttribution.estimatedSpent).toBe(90_000)
    expect(r!.phaseAttribution.estimatedTxnCount).toBe(3)
    expect(r!.phaseAttribution.codedTxnCount).toBe(0)
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent)
  })

  it('mixed mode: real-coded + estimated remainder, Σ phases == spent', async () => {
    // t1 coded to A (40k); the 60k remainder spreads 30k→B, 30k→B (A's coded
    // spend already covers its 30k target → the estimate fills B).
    seedProject(
      [
        { id: 'phase-a', order: 1, budget: 10000000n },
        { id: 'phase-b', order: 2, budget: 10000000n },
      ],
      [
        { id: 't1', amount: 4000000n, day: 1, phaseId: 'phase-a' },
        { id: 't2', amount: 3000000n, day: 2 },
        { id: 't3', amount: 3000000n, day: 3 },
      ],
    )
    const r = await buildBudgetVarianceReport(P)
    expect(phaseOf('phase-a')(r!).spent).toBe(40_000)
    expect(phaseOf('phase-b')(r!).spent).toBe(60_000)
    expect(r!.phaseAttribution.mode).toBe('mixed')
    expect(r!.phaseAttribution.codedSpent).toBe(40_000)
    expect(r!.phaseAttribution.codedTxnCount).toBe(1)
    expect(r!.phaseAttribution.estimatedSpent).toBe(60_000)
    expect(r!.phaseAttribution.estimatedTxnCount).toBe(2)
    expect(r!.phaseAttribution.codedSpent + r!.phaseAttribution.estimatedSpent).toBe(r!.project.spent)
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent)
  })

  it('legacy milestone linkage (uncoded rows) still derives exactly — tier 2', async () => {
    seedProject(
      [
        { id: 'phase-a', order: 1, budget: 10000000n },
        { id: 'phase-b', order: 2, budget: 10000000n },
      ],
      [
        { id: 't1', amount: 3000000n, day: 1 },
        { id: 't2', amount: 3000000n, day: 2 },
        { id: 't3', amount: 3000000n, day: 3 },
      ],
    )
    seedMilestone('m1', 'phase-b')
    state.paymentRequests.set('pr1', {
      id: 'pr1', projectId: P, requestCode: 'PR-2026-000001', status: 'paid',
      relatedEntityType: 'milestone', relatedEntityId: 'm1', paidTxnId: 't2',
    })
    const r = await buildBudgetVarianceReport(P)
    expect(phaseOf('phase-b')(r!).spent).toBe(30_000) // exact, not estimated
    expect(phaseOf('phase-b')(r!).txCount).toBe(1)
    expect(phaseOf('phase-a')(r!).spent).toBe(60_000) // t1 + t3 estimated
    expect(r!.phaseAttribution.mode).toBe('estimated') // no STORED codes
    expect(r!.phaseAttribution.milestoneDerivedSpent).toBe(30_000)
    expect(r!.phaseAttribution.milestoneDerivedTxnCount).toBe(1)
    expect(r!.phaseAttribution.estimatedSpent).toBe(60_000)
    expect(r!.phaseAttribution.milestoneDerivedSpent + r!.phaseAttribution.estimatedSpent).toBe(r!.project.spent)
  })

  it('a stored code SUPERSEDES the milestone derivation on the same row', async () => {
    seedProject(
      [
        { id: 'phase-a', order: 1, budget: 10000000n },
        { id: 'phase-b', order: 2, budget: 10000000n },
      ],
      [{ id: 't1', amount: 4000000n, day: 1, phaseId: 'phase-a' }],
    )
    seedMilestone('m1', 'phase-b')
    state.paymentRequests.set('pr1', {
      id: 'pr1', projectId: P, requestCode: 'PR-2026-000001', status: 'paid',
      relatedEntityType: 'milestone', relatedEntityId: 'm1', paidTxnId: 't1',
    })
    const r = await buildBudgetVarianceReport(P)
    expect(phaseOf('phase-a')(r!).spent).toBe(40_000) // the code wins
    expect(phaseOf('phase-b')(r!).spent).toBe(0)
    expect(r!.phaseAttribution.codedSpent).toBe(40_000)
    expect(r!.phaseAttribution.milestoneDerivedSpent).toBe(0)
  })

  it('a stamped negative reversal nets its phase down — Σ invariant holds', async () => {
    seedProject(
      [{ id: 'phase-a', order: 1, budget: 10000000n }],
      [
        { id: 't1', amount: 10000000n, day: 1, phaseId: 'phase-a' },
        { id: 't2', amount: -6_000_000n, day: 2, phaseId: 'phase-a', type: 'reversal' },
      ],
    )
    const r = await buildBudgetVarianceReport(P)
    expect(phaseOf('phase-a')(r!).spent).toBe(40_000)
    expect(phaseOf('phase-a')(r!).codedSpent).toBe(40_000)
    expect(r!.phaseAttribution.mode).toBe('real')
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent)
  })

  it('a FOREIGN phaseId (other project) is never counted to a phantom phase — falls back to the estimate, Σ intact', async () => {
    state.projects.set('proj-2', { id: 'proj-2', name: 'Other', client: 'Bob' })
    state.phases.set('phase-x', { id: 'phase-x', projectId: 'proj-2', name: 'x', order: 1, budget: 100n, status: 'in_progress', progressManual: null })
    seedProject(
      [
        { id: 'phase-a', order: 1, budget: 10000000n },
        { id: 'phase-b', order: 2, budget: 10000000n },
      ],
      [
        { id: 't1', amount: 5000000n, day: 1, phaseId: 'phase-x' }, // foreign — cannot occur via the API
        { id: 't2', amount: 5000000n, day: 2 },
      ],
    )
    const r = await buildBudgetVarianceReport(P)
    expect(r!.phases.map((f) => f.id)).toEqual(['phase-a', 'phase-b']) // no phantom phase
    expect(phaseOf('phase-a')(r!).spent).toBe(50_000)
    expect(phaseOf('phase-b')(r!).spent).toBe(50_000)
    expect(r!.phaseAttribution.codedSpent).toBe(0) // the foreign code is not honored
    expect(r!.phaseAttribution.estimatedSpent).toBe(100_000)
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent)
  })

  it('no spend → mode "none"; unknown project → null (route 404)', async () => {
    seedProject([{ id: 'phase-a', order: 1, budget: 10000000n }], [])
    const r = await buildBudgetVarianceReport(P)
    expect(r!.phaseAttribution.mode).toBe('none')
    expect(r!.phaseAttribution.codedSpent).toBe(0)
    expect(await buildBudgetVarianceReport('missing')).toBeNull()
  })

  it('project with no phases: stamped spend reports honestly, no crash', async () => {
    state.projects.set(P, { id: P, name: 'No Phases', client: 'Amina Test' })
    state.transactions.set('t1', {
      id: 't1', projectId: P, type: 'material', amount: 5000000n, method: 'mpesa',
      reference: null, costCode: null, phaseId: 'phase-gone', ledgerTxnId: null,
      note: '', date: d(1), createdAt: d(1),
    })
    const r = await buildBudgetVarianceReport(P)
    expect(r!.phases).toEqual([])
    expect(r!.project.spent).toBe(50_000)
    expect(r!.phaseAttribution.estimatedSpent).toBe(50_000) // nowhere to code against
    expect(r!.phaseAttribution.mode).toBe('estimated')
  })
})

// ---------------------------------------------------------------- posting seams

describe('posting seams — phase cost-code stamps (money math untouched)', () => {
  beforeEach(() => state.reset())

  it('resolvePostingPhaseId: absent → null (honest no-attribution)', async () => {
    state.phases.set('phase-a', { id: 'phase-a', projectId: P, name: 'a', order: 1, budget: 100n, status: 'pending' })
    expect(await resolvePostingPhaseId(db, P, null)).toBeNull()
    expect(await resolvePostingPhaseId(db, P, undefined)).toBeNull()
  })

  it('resolvePostingPhaseId: in-project phase → its id', async () => {
    state.phases.set('phase-a', { id: 'phase-a', projectId: P, name: 'a', order: 1, budget: 100n, status: 'pending' })
    expect(await resolvePostingPhaseId(db, P, 'phase-a')).toBe('phase-a')
  })

  it('resolvePostingPhaseId: FOREIGN phase → fail-closed honest error', async () => {
    state.phases.set('phase-x', { id: 'phase-x', projectId: 'proj-2', name: 'x', order: 1, budget: 100n, status: 'pending' })
    await expect(resolvePostingPhaseId(db, P, 'phase-x')).rejects.toThrow(/does not belong to this project/i)
    await expect(resolvePostingPhaseId(db, P, 'phase-missing')).rejects.toThrow(/foreign phase cost-code/i)
  })

  it('releaseMilestoneAtomic: stamps the milestone phase; escrow/ledger math unchanged', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.phases.set('phase-a', { id: 'phase-a', projectId: P, name: 'a', order: 1, budget: 50000000n, status: 'in_progress' })
    seedMilestone('m1', 'phase-a', 200_000)
    seedEscrow(100000000n)
    const out = await releaseMilestoneAtomic(P, {
      milestone: { id: 'm1', name: 'Milestone m1', amount: 20000000n, phaseId: 'phase-a' },
      decider: { name: 'Amina Test', role: 'client' },
      note: null,
    })
    expect(out.balance).toBe(80_000_000n)
    const row = [...state.transactions.values()].find((t) => t.type === 'milestone')
    expect(row?.phaseId).toBe('phase-a') // THE stamp
    expect(row?.amount).toBe(20_000_000n) // money math untouched (cents)
    expect(row?.ledgerTxnId).toBe(out.ledgerTxnId)
    // balanced double entry: ESCROW debit 200k == EXPENSE credit 200k
    const ledger = state.ledgerTxns.get(out.ledgerTxnId as string)
    expect(ledger).toBeTruthy()
    const legs = [...state.entries.values()].filter((e) => e.transactionId === out.ledgerTxnId)
    expect(legs.filter((e) => e.side === 'debit')[0]?.amount).toBe(20_000_000n)
    expect(legs.filter((e) => e.side === 'credit')[0]?.amount).toBe(20_000_000n)
    expect(state.milestones.get('m1')?.status).toBe('released')
  })

  it('releaseMilestoneAtomic: milestone without a phase → honest null code (legacy rows)', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    seedMilestone('m1', null, 100_000)
    seedEscrow(50000000n)
    await releaseMilestoneAtomic(P, {
      milestone: { id: 'm1', name: 'M', amount: 10000000n, phaseId: null },
      decider: { name: 'Amina Test', role: 'client' },
      note: null,
    })
    const row = [...state.transactions.values()].find((t) => t.type === 'milestone')
    expect(row?.phaseId).toBeNull()
  })

  it('releaseMilestoneAtomic: FOREIGN phase → honest error, NO money moves (rollback)', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.phases.set('phase-x', { id: 'phase-x', projectId: 'proj-2', name: 'x', order: 1, budget: 100n, status: 'pending' })
    seedMilestone('m1', 'phase-x', 200_000)
    seedEscrow(100000000n)
    await expect(
      releaseMilestoneAtomic(P, {
        milestone: { id: 'm1', name: 'M', amount: 20000000n, phaseId: 'phase-x' },
        decider: { name: 'Amina Test', role: 'client' },
        note: null,
      }),
    ).rejects.toThrow(/does not belong to this project/i)
    expect(state.transactions.size).toBe(0) // no legacy row
    expect(state.ledgerTxns.size).toBe(0) // no ledger post
    expect([...state.escrowWallets.values()][0]?.balance).toBe(100000000n) // balance untouched (cents)
    expect(state.milestones.get('m1')?.status).toBe('release_requested') // not released
  })

  it('payPaymentRequest: a milestone-linked request pays the milestone phase — stamp + exact', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.phases.set('phase-a', { id: 'phase-a', projectId: P, name: 'a', order: 1, budget: 50000000n, status: 'in_progress' })
    seedMilestone('m1', 'phase-a', 300_000)
    state.paymentRequests.set('pr1', {
      id: 'pr1', projectId: P, requestCode: 'PR-2026-000001', status: 'approved',
      amount: 30000000n, payee: 'Fundi', description: 'walling', method: 'cash',
      relatedEntityType: 'milestone', relatedEntityId: 'm1', paidTxnId: null,
    })
    const out = await payPaymentRequest(P, { id: 'pr1', method: 'cash' })
    expect(out.status).toBe('paid')
    const row = [...state.transactions.values()].find((t) => t.type === 'payment_request')
    expect(row?.phaseId).toBe('phase-a')
    expect(row?.amount).toBe(30_000_000n)
    expect(state.paymentRequests.get('pr1')?.paidTxnId).toBe(row?.id)
  })

  it('payPaymentRequest: no milestone linkage → null code (the estimate handles it)', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.paymentRequests.set('pr1', {
      id: 'pr1', projectId: P, requestCode: 'PR-2026-000002', status: 'approved',
      amount: 7500000n, payee: 'Supplier', description: 'misc', method: 'cash',
      relatedEntityType: null, relatedEntityId: null, paidTxnId: null,
    })
    await payPaymentRequest(P, { id: 'pr1', method: 'cash' })
    const row = [...state.transactions.values()].find((t) => t.type === 'payment_request')
    expect(row?.phaseId).toBeNull()
  })

  it('payPaymentRequest: milestone WITHOUT a phase, or unknown milestone → null, money still pays', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    seedMilestone('m1', null, 50_000)
    state.paymentRequests.set('pr1', {
      id: 'pr1', projectId: P, requestCode: 'PR-2026-000003', status: 'approved',
      amount: 5000000n, payee: 'Fundi', description: 'x', method: 'cash',
      relatedEntityType: 'milestone', relatedEntityId: 'm1', paidTxnId: null,
    })
    state.paymentRequests.set('pr2', {
      id: 'pr2', projectId: P, requestCode: 'PR-2026-000004', status: 'approved',
      amount: 2500000n, payee: 'Fundi', description: 'y', method: 'cash',
      relatedEntityType: 'milestone', relatedEntityId: 'missing-milestone', paidTxnId: null,
    })
    await payPaymentRequest(P, { id: 'pr1', method: 'cash' })
    await payPaymentRequest(P, { id: 'pr2', method: 'cash' })
    const rows = [...state.transactions.values()].filter((t) => t.type === 'payment_request')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.phaseId === null)).toBe(true) // honest null, never blocked
  })

  it('payInvoice: payload phaseId (valid) → stamped; invoice flips paid; amount unchanged', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.phases.set('phase-a', { id: 'phase-a', projectId: P, name: 'a', order: 1, budget: 50000000n, status: 'in_progress' })
    state.invoices.set('inv1', {
      id: 'inv1', invoiceCode: 'INV-2026-000001', projectId: P, orderId: null, supplierId: null,
      status: 'approved', subtotal: 15000000n, tax: 0, total: 15000000n, paymentMethod: null,
    })
    const out = await payInvoice(P, { id: 'inv1', method: 'cash', phaseId: 'phase-a' })
    expect(out.status).toBe('paid')
    const row = [...state.transactions.values()].find((t) => t.type === 'invoice')
    expect(row?.phaseId).toBe('phase-a')
    expect(row?.amount).toBe(15_000_000n)
    expect(state.invoices.get('inv1')?.status).toBe('paid')
    expect(state.ledgerTxns.size).toBe(1) // posted exactly once
  })

  it('payInvoice: FOREIGN payload phaseId → honest error BEFORE money moves', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.phases.set('phase-x', { id: 'phase-x', projectId: 'proj-2', name: 'x', order: 1, budget: 100n, status: 'pending' })
    state.invoices.set('inv1', {
      id: 'inv1', invoiceCode: 'INV-2026-000002', projectId: P, orderId: null, supplierId: null,
      status: 'approved', subtotal: 15000000n, tax: 0, total: 15000000n, paymentMethod: null,
    })
    await expect(payInvoice(P, { id: 'inv1', method: 'cash', phaseId: 'phase-x' })).rejects.toThrow(
      /does not belong to this project/i,
    )
    expect(state.transactions.size).toBe(0) // nothing posted
    expect(state.ledgerTxns.size).toBe(0)
    expect(state.invoices.get('inv1')?.status).toBe('approved') // still payable after a fix
  })

  it('payInvoice: no payload phaseId → null code (estimate fallback)', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.invoices.set('inv1', {
      id: 'inv1', invoiceCode: 'INV-2026-000003', projectId: P, orderId: null, supplierId: null,
      status: 'approved', subtotal: 2000000n, tax: 0, total: 2000000n, paymentMethod: null,
    })
    await payInvoice(P, { id: 'inv1', method: 'cash' })
    const row = [...state.transactions.values()].find((t) => t.type === 'invoice')
    expect(row?.phaseId).toBeNull()
  })

  it('reverseTransaction: a stamped original reverses to the SAME phase (net attribution exact)', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.transactions.set('t1', {
      id: 't1', projectId: P, type: 'milestone', amount: 10000000n, method: 'mpesa',
      reference: 'MJP-x', costCode: 'milestone', phaseId: 'phase-a', ledgerTxnId: null,
      note: 'orig', date: d(1), createdAt: d(1),
    })
    const out = await reverseTransaction(P, { id: 't1', reason: 'wrong phase', by: 'Finance' })
    const row = state.transactions.get(out.reversalTransactionId as string)
    expect(row?.phaseId).toBe('phase-a') // copied — negates the same phase
    expect(row?.amount).toBe(-10_000_000n)
    expect(row?.type).toBe('reversal')
  })

  it('reverseTransaction: an UNCoded original reverses to null (legacy behavior unchanged)', async () => {
    state.projects.set(P, { id: P, name: 'Test', client: 'Amina Test' })
    state.transactions.set('t1', {
      id: 't1', projectId: P, type: 'material', amount: 4000000n, method: 'cash',
      reference: null, costCode: null, phaseId: null, ledgerTxnId: null,
      note: 'wages-ish', date: d(1), createdAt: d(1),
    })
    const out = await reverseTransaction(P, { id: 't1', reason: 'correction' })
    const row = state.transactions.get(out.reversalTransactionId as string)
    expect(row?.phaseId).toBeNull()
    expect(row?.amount).toBe(-4_000_000n)
  })
})

// ---------------------------------------------------------------- end-to-end honesty

describe('stamped posting → report rollup (the full issue #39 loop)', () => {
  beforeEach(() => state.reset())

  it('a milestone release lands exactly on its phase in the report — no estimate for it', async () => {
    state.projects.set(P, { id: P, name: 'Loop Test', client: 'Amina Test' })
    state.phases.set('phase-a', { id: 'phase-a', projectId: P, name: 'Foundation', order: 1, budget: 80000000n, status: 'in_progress' })
    state.phases.set('phase-b', { id: 'phase-b', projectId: P, name: 'Walling', order: 2, budget: 120000000n, status: 'pending' })
    seedEscrow(200000000n)
    // legacy uncoded spend + one REAL coded release
    state.transactions.set('legacy1', {
      id: 'legacy1', projectId: P, type: 'wage', amount: 3000000n, method: 'mpesa',
      reference: null, costCode: null, phaseId: null, ledgerTxnId: null,
      note: 'wages', date: d(1), createdAt: d(1),
    })
    seedMilestone('m1', 'phase-a', 200_000)
    await releaseMilestoneAtomic(P, {
      milestone: { id: 'm1', name: 'Foundation package', amount: 20000000n, phaseId: 'phase-a' },
      decider: { name: 'Amina Test', role: 'client' },
      note: null,
    })
    const r = await buildBudgetVarianceReport(P)
    // phase-a: 200k REAL (the release) + the 30k estimate share (only phase started → whole pool)
    expect(phaseOf('phase-a')(r!).spent).toBe(230_000)
    expect(phaseOf('phase-a')(r!).codedSpent).toBe(200_000)
    expect(phaseOf('phase-b')(r!).spent).toBe(0)
    expect(r!.phaseAttribution.mode).toBe('mixed')
    expect(r!.phaseAttribution.codedSpent).toBe(200_000)
    expect(r!.phaseAttribution.estimatedSpent).toBe(30_000)
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent) // 230k == 230k
  })
})
