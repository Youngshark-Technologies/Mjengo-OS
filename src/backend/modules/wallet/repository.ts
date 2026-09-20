// Finance slice loader for the project payload (spec §36-§40).
// F-MONEY full slice: ledger transactions, accounts with derived balances,
// escrow projection vs ledger consistency, payment requests with their ledger
// refs, and the budget → committed → spent → remaining rollup.

import { db } from '@/backend/lib/db'
import { centsToKes, sumCents, type Cents } from '@/backend/lib/money'
import { reversalRefsByTxnId } from '@/backend/modules/ledger/service'
import type { FinanceSlice, LedgerTxnRow, LedgerAccountRow } from './types'

export async function loadFinanceSlice(projectId: string): Promise<FinanceSlice> {
  const [project, paymentRequests, txns, accounts, phases, transactions] = await Promise.all([
    db.project.findUnique({ where: { id: projectId } }),
    db.paymentRequest.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    db.ledgerTransaction.findMany({
      where: { projectId },
      include: { entries: { include: { account: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 60,
    }),
    db.ledgerAccount.findMany({ where: { projectId }, select: { id: true, code: true, name: true, kind: true, normalSide: true } }),
    db.phase.findMany({ where: { projectId }, select: { budget: true } }),
    db.transaction.findMany({ where: { projectId } }),
  ])

  // Budget rollup: phase budgets are the source of truth (matches
  // ProjectSummary.budgetTotal); project.budget is the fallback. All in
  // CENTS (issue #122) — exact bigint sums, KSh only at the return.
  const budget = phases.length ? sumCents(phases.map((p) => p.budget)) : project?.budget ?? 0n
  const spent = sumCents(transactions.map((t) => t.amount))

  const openPos = project ? await db.purchaseOrder.findMany({ where: { projectId } }) : []
  const openInvoices = project
    ? await db.invoice.findMany({ where: { projectId, status: 'approved' } })
    : []
  const pendingVariations = project
    ? await db.variationOrder.findMany({ where: { projectId, status: 'submitted' } })
    : []
  const committed =
    sumCents(openPos.filter((p) => !['closed', 'cancelled'].includes(p.status)).map((p) => p.total)) +
    sumCents(openInvoices.map((i) => i.total)) +
    sumCents(pendingVariations.filter((v) => v.budgetImpact > 0n).map((v) => v.budgetImpact))

  // DB-11 (#133): reversal state is DERIVED — the reversal rows linked via
  // reversalOfId, looked up in ONE indexed query for the whole page. The
  // original rows are never stamped (status stays 'posted'; reversalRef is a
  // legacy column nothing writes anymore).
  const reversalRefs = await reversalRefsByTxnId(txns.map((t) => t.id))
  const txnRows: LedgerTxnRow[] = txns.map((t) => ({
    id: t.id,
    ref: t.ref,
    description: t.description,
    occurredAt: t.occurredAt.toISOString(),
    status: reversalRefs.has(t.id) ? 'reversed' : t.status,
    reversalOfRef: reversalRefs.get(t.id) ?? null,
    postedBy: t.postedBy,
    postedRole: t.postedRole,
    entries: t.entries.map((e) => ({
      accountCode: e.account.code,
      accountName: e.account.name,
      side: e.side,
      amount: centsToKes(e.amount),
    })),
    total: centsToKes(sumCents(t.entries.filter((e) => e.side === 'debit').map((e) => e.amount))),
  }))

  // Ledger refs for paid payment requests (paidTxnId → Transaction.ledgerTxnId → ref)
  const ledgerRefByTxnId = new Map(txns.map((t) => [t.id, t.ref]))
  const prLedgerRef = new Map<string, string | null>()
  for (const pr of paymentRequests) {
    if (!pr.paidTxnId) continue
    const legacy = transactions.find((t) => t.id === pr.paidTxnId)
    const ref = legacy?.ledgerTxnId ? ledgerRefByTxnId.get(legacy.ledgerTxnId) ?? null : null
    prLedgerRef.set(pr.id, ref ?? legacy?.reference ?? null)
  }

  // Exact cents balances per account; KSh only for the row display. The
  // escrow consistency check below reuses the CENTS form (exact compare).
  // SQL SUM aggregation (issue #144): ONE grouped Σdebit/Σcredit per
  // (account, side) — the pre-#144 shape loaded every account with its
  // ENTIRE entry history (`include: { entries: true }`) and reduced in JS,
  // so the finance slice degraded with the project's ledger age. Sign
  // convention identical to the old reduce (kind-keyed).
  const sums = accounts.length
    ? await db.ledgerEntry.groupBy({
        by: ['accountId', 'side'],
        _sum: { amount: true },
        where: { accountId: { in: accounts.map((a) => a.id) } },
      })
    : []
  const sumsByAccount = new Map<string, { debit: Cents; credit: Cents }>()
  for (const g of sums) {
    const s = sumsByAccount.get(g.accountId) ?? { debit: 0n, credit: 0n }
    if (g.side === 'debit') s.debit = g._sum.amount ?? 0n
    else if (g.side === 'credit') s.credit = g._sum.amount ?? 0n
    sumsByAccount.set(g.accountId, s)
  }
  const accountBalances = new Map<string, Cents>()
  const accountRows: LedgerAccountRow[] = accounts.map((a) => {
    const s = sumsByAccount.get(a.id) ?? { debit: 0n, credit: 0n }
    const balance = a.kind === 'asset' || a.kind === 'expense' ? s.debit - s.credit : s.credit - s.debit
    accountBalances.set(a.code, balance)
    return { code: a.code, name: a.name, kind: a.kind, normalSide: a.normalSide, balance: centsToKes(balance) }
  })

  // Escrow projection vs derived ledger balance (spec §39 — the ledger wins).
  // EXACT cents comparison (issue #122): the old < 1 KSh float tolerance is
  // gone — a one-cent drift is a drift.
  const escrow = await db.escrowWallet.findUnique({ where: { projectId } })
  const derivedEscrowCents = accountBalances.get(`ESCROW:${projectId}`) ?? 0n
  const escrowSlice = escrow
    ? {
        projected: centsToKes(escrow.balance),
        derived: centsToKes(derivedEscrowCents),
        consistent: derivedEscrowCents === escrow.balance,
        drift: centsToKes(derivedEscrowCents - escrow.balance),
        ledgerAccountId: escrow.ledgerAccountId,
      }
    : null

  return {
    paymentRequests: paymentRequests.map((p) => ({
      id: p.id,
      requestCode: p.requestCode,
      description: p.description,
      amount: centsToKes(p.amount),
      payee: p.payee,
      method: p.method,
      status: p.status,
      relatedEntityType: p.relatedEntityType,
      relatedEntityId: p.relatedEntityId,
      requestedByRole: p.requestedByRole,
      requestedByName: p.requestedByName,
      decidedBy: p.decidedBy,
      decidedAt: p.decidedAt?.toISOString() ?? null,
      decisionNote: p.decisionNote,
      paidAt: p.paidAt?.toISOString() ?? null,
      ledgerRef: prLedgerRef.get(p.id) ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    ledger: { transactions: txnRows, accounts: accountRows },
    wallet: null,
    escrowLedgered: txns.some((t) => t.description.startsWith('Escrow top-up')),
    escrow: escrowSlice,
    committed: centsToKes(committed),
    remaining: centsToKes(budget - committed - spent),
    budget: centsToKes(budget),
    spent: centsToKes(spent),
  }
}
