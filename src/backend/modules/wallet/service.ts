// Wallet & payment-request service (spec §36-§40, §57) — payment requests,
// wallet deposit/withdraw/transfer, and payment recording through the
// double-entry ledger. F-MONEY hardening:
//   · every multi-write money flow runs in ONE db.$transaction
//   · balance checks happen INSIDE the transaction (no racy check-then-decrement)
//   · decision / payer identity is resolved from the SESSION (wallet/session.ts),
//     never from the payload (F3)
//   · payments route through the PaymentProvider seam (providers.ts, spec §40)
//   · escrow top-ups post CASH → ESCROW ledger rows and keep the
//     EscrowWallet.balance projection in sync inside the same transaction
//
// The escrow wallet is a PROJECTION: ESCROW:<projectId> ledger entries are the
// source of truth (spec §39); the stored balance is a cache that every helper
// here keeps consistent, and the finance slice exposes both so drift is visible.

import { db } from '@/backend/lib/db'
import { parseMoneyAmount, MONEY_AMOUNT_ERROR } from '@/backend/lib/money-bounds'
import { centsToKes, fmtKes, parseMoneyCents, sumCents, assertMoneyCents, type Cents } from '@/backend/lib/money'
import {
  postLedgerTransaction,
  postLedgerTransactionInTx,
  reverseLedgerTransactionInTx,
  ensureAccount,
  ensureAccountTx,
  derivedBalance,
  accountSideSums,
  cashAccountForMethod,
  reversalRefsByTxnId,
  type TxClient,
} from '@/backend/modules/ledger/service'
import { notify } from '@/backend/modules/notify/service'
import { getProvider, type PaymentMethod } from './providers'
import { recordDarajaIntent, recordDarajaUnresolvedInitiation } from './daraja-callback'
import { seedDarajaReconcileSweep } from './daraja-reconcile'
import { currentActor, type DeciderIdentity } from './session'
import { log } from '@/backend/lib/log'

let prCounter = 0
export function nextPaymentRequestCode(): string {
  const now = new Date()
  prCounter = (prCounter + 1) % 100000
  return `PR-${now.getFullYear()}-${String(prCounter).padStart(6, '0')}-${Date.now() % 1000}`
}

// ---------------- money-action session gates (issue #103 / audit BE-2 + BE-7) ----

/**
 * Roles that may operate the money-action family through the action dispatch
 * seams (/api/actions + /api/sync → applyAction → these services). Mirrors
 * guard.ts FINANCE_ROLES — the same allowlist the v1 wallet/journal routes
 * already enforce — so the action surface and the v1 REST surface agree on
 * WHO may move money. Admin is the documented superuser bypass (it can toggle
 * flags and exercise closed surfaces everywhere else too).
 *
 * Kept as a local literal (NOT an import from guard.ts) so this service stays
 * import-cycle-free and mock-friendly — the same discipline
 * src/backend/lib/action-flag-gate.ts documents; guard.test.ts pins the
 * canonical lists and tests/unit/wallet-role-gates.test.ts pins these gates.
 */
export const MONEY_FINANCE_ROLES: readonly string[] = ['finance', 'admin']

/** PAYMENT_ROLES mirror: payment execution is client-initiated too (guard.ts). */
export const MONEY_PAYMENT_ROLES: readonly string[] = ['finance', 'admin', 'client']

/**
 * Session-role gate for a money action (BE-2): resolves the signed-in actor
 * (modules/wallet/session currentActor — the request cookie, NEVER the
 * payload) and REFUSES with an honest single-line error when the role is not
 * in `allowed`. The refusal is a thrown domain error on purpose: /api/actions
 * renders it as the standard { ok:false, error } action refusal and /api/sync
 * as the same PER-ITEM { ok:false, error } — batch semantics, the other
 * outbox items still process — exactly like the flag-family gate messages
 * (lib/action-flag-gate.ts). The gate lives in the service layer so both
 * dispatch routes (and any future caller) inherit it.
 *
 * Sessionless callers (role null) pass with the fallback identity: they are
 * either the share-link path — already restricted to CLIENT_ACTIONS at the
 * route, so client semantics were gated upstream — or trusted server-side
 * flows (the verified Daraja callback, jobs, scripts) that never carry a
 * session cookie. The same doctrine requireDeciderRole and the invoices
 * module's requireClientRole already document.
 */
export async function requireMoneyActor(
  opts: {
    allowed: readonly string[]
    action: string
    payloadBy?: unknown
    fallbackName?: string
    fallbackRole?: string
  },
): Promise<DeciderIdentity> {
  const actor = await currentActor()
  if (actor.role === null) {
    const payloadName = typeof opts.payloadBy === 'string' && opts.payloadBy.trim() ? opts.payloadBy.trim() : ''
    return {
      name: payloadName || opts.fallbackName || 'Finance',
      role: opts.fallbackRole || 'finance',
    }
  }
  if (opts.allowed.includes(actor.role)) {
    return { name: actor.name?.trim() || actor.role, role: actor.role }
  }
  throw new Error(
    `Only ${opts.allowed.join(' or ')} may ${opts.action} — signed in as "${actor.role}"${actor.name ? ` (${actor.name})` : ''}.`,
  )
}

/** Roles that may decide / pay payment requests in-app (client + finance are the real queue). */
const PR_ROLES = ['client', 'finance', 'admin', 'contractor', 'supervisor'] as const

// ---------------- phase cost-code helpers (issue #39) ----------------

/**
 * Structural type both `db` and an in-transaction client satisfy — the phase
 * lookup every money posting seam shares.
 */
type PhaseReader = {
  phase: {
    findFirst(args: { where: { id: string; projectId: string }; select?: { id: true } }): Promise<{ id: string } | null>
  }
}

/**
 * Validate a phase cost-code for a money posting (issue #39). Returns the
 * phase id when the phase belongs to THIS project; null when no phase was
 * referenced (absence of attribution is honest — the report estimates those
 * rows); THROWS fail-closed when the phase exists outside the project — money
 * is never posted with a foreign phase attribution. Money math untouched:
 * this only stamps the attribution dimension on the legacy Transaction row.
 */
export async function resolvePostingPhaseId(
  reader: PhaseReader,
  projectId: string,
  phaseId: string | null | undefined,
): Promise<string | null> {
  if (!phaseId || typeof phaseId !== 'string') return null
  const phase = await reader.phase.findFirst({ where: { id: phaseId, projectId }, select: { id: true } })
  if (!phase) {
    throw new Error(`Phase ${phaseId} does not belong to this project — refusing to post money with a foreign phase cost-code`)
  }
  return phase.id
}

/**
 * Milestone → phase cost-code for payment requests (issue #39): a request
 * raised against a milestone (`relatedEntityType: 'milestone'`) pays that
 * milestone's phase. Returns null when nothing is derivable (no milestone
 * reference, unknown milestone, or a milestone without a phase) — those rows
 * keep honest null attribution and the report estimates them; money is never
 * blocked on missing attribution. A milestone whose phaseId is FOREIGN to the
 * project fails closed (resolvePostingPhaseId).
 */
export async function phaseIdForMilestonePayment(
  reader: PhaseReader & {
    milestone: {
      findFirst(args: { where: { id: string; projectId: string }; select: { phaseId: true } }): Promise<{ phaseId: string | null } | null>
    }
  },
  projectId: string,
  relatedEntityType: string | null,
  relatedEntityId: string | null,
): Promise<string | null> {
  if (relatedEntityType !== 'milestone' || !relatedEntityId) return null
  const milestone = await reader.milestone.findFirst({ where: { id: relatedEntityId, projectId }, select: { phaseId: true } })
  if (!milestone) return null // honest: unattributable, never a blocked payment
  return resolvePostingPhaseId(reader, projectId, milestone.phaseId)
}

// ---------------- in-tx posting helpers (shared by every money flow) ----------------

/**
 * Debit EXPENSE:<projectId>, credit the cash account for the rail — the
 * standard external-spend posting (expenses, wages, invoice payments on
 * mpesa/bank/card/cash, payment requests). Runs INSIDE the caller's
 * db.$transaction and returns the ledger ids for the legacy Transaction row.
 */
export async function spendExternalInTx(
  tx: TxClient,
  projectId: string,
  input: {
    amount: Cents
    method: string
    description: string
    postedBy: string
    postedRole: string
    idempotencyKey?: string
  },
): Promise<{ ledgerTxnId: string; ledgerRef: string }> {
  const ledgerTxn = await postLedgerTransactionInTx(tx, {
    projectId,
    description: input.description,
    postedBy: input.postedBy,
    postedRole: input.postedRole,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountCode: `EXPENSE:${projectId}`, side: 'debit', amount: input.amount },
      { accountCode: cashAccountForMethod(input.method), side: 'credit', amount: input.amount },
    ],
  })
  return { ledgerTxnId: ledgerTxn.id, ledgerRef: ledgerTxn.ref }
}

/**
 * Debit ESCROW:<projectId>, credit EXPENSE:<projectId> and decrement the
 * wallet projection — escrow money moving into project spend. The balance is
 * re-checked INSIDE the transaction. Returns the new projected balance.
 */
export async function spendEscrowInTx(
  tx: TxClient,
  projectId: string,
  input: {
    amount: Cents
    description: string
    postedBy: string
    postedRole: string
    idempotencyKey?: string
  },
): Promise<{ ledgerTxnId: string; ledgerRef: string; balance: Cents }> {
  const wallet = await tx.escrowWallet.findUnique({ where: { projectId } })
  if (!wallet || wallet.balance < input.amount) {
    throw new Error('Insufficient escrow balance — top up first')
  }
  const escrowAccount = await ensureAccountTx(tx, `ESCROW:${projectId}`)
  const ledgerTxn = await postLedgerTransactionInTx(tx, {
    projectId,
    description: input.description,
    postedBy: input.postedBy,
    postedRole: input.postedRole,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountCode: `ESCROW:${projectId}`, side: 'debit', amount: input.amount },
      { accountCode: `EXPENSE:${projectId}`, side: 'credit', amount: input.amount },
    ],
  })
  const updated = await tx.escrowWallet.update({
    where: { projectId },
    data: { balance: { decrement: input.amount }, ledgerAccountId: escrowAccount.id },
  })
  return { ledgerTxnId: ledgerTxn.id, ledgerRef: ledgerTxn.ref, balance: updated.balance }
}

/**
 * Milestone release (money.ts milestone.decide): milestone state flip +
 * escrow debit + EXPENSE credit + legacy Transaction row — ALL inside one
 * db.$transaction, with the escrow balance checked inside the transaction.
 */
export async function releaseMilestoneAtomic(
  projectId: string,
  input: {
    milestone: { id: string; name: string; amount: Cents; phaseId?: string | null }
    decider: DeciderIdentity
    note: string | null
  },
): Promise<{ balance: Cents; ledgerRef: string; ledgerTxnId: string; transactionId: string }> {
  const { milestone, decider } = input
  return db.$transaction(async (tx) => {
    const now = new Date()
    const released = await tx.milestone.update({
      where: { id: milestone.id },
      data: { status: 'released', decidedAt: now, decidedBy: decider.name, decisionNote: input.note, releasedAt: now },
    })
    void released
    const escrow = await spendEscrowInTx(tx, projectId, {
      amount: milestone.amount,
      description: `Milestone release — ${milestone.name}`,
      postedBy: decider.name,
      postedRole: decider.role,
      idempotencyKey: `milestone.release:${milestone.id}`,
    })
    // Phase cost-code (issue #39): a milestone release is spend ON the
    // milestone's phase — validated in-project INSIDE the transaction
    // (fail-closed on a foreign phase; money math unchanged).
    const phaseId = await resolvePostingPhaseId(tx, projectId, milestone.phaseId)
    // exactly ONE legacy row per release (idempotent on the ledger txn)
    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: escrow.ledgerTxnId } })) ??
      (await tx.transaction.create({
        data: {
          projectId,
          type: 'milestone',
          amount: milestone.amount,
          method: 'escrow',
          reference: `MJP-${milestone.id.slice(-6)}`,
          costCode: 'milestone',
          phaseId,
          ledgerTxnId: escrow.ledgerTxnId,
          note: `${milestone.name} released to contractor — approved by ${decider.name}`,
          date: now,
        },
      }))
    return {
      balance: escrow.balance,
      ledgerRef: escrow.ledgerRef,
      ledgerTxnId: escrow.ledgerTxnId,
      transactionId: txnRow.id,
    }
  })
}

// ---- Payment requests (spec §36/§59) ----

export async function createPaymentRequest(projectId: string, p: any) {
  const amount = parseMoneyCents(p.amount)
  if (amount === null) throw new Error(MONEY_AMOUNT_ERROR)
  // Requester identity from the session when one exists (payload is the fallback)
  const actor = await currentActor()
  const request = await db.paymentRequest.create({
    data: {
      requestCode: nextPaymentRequestCode(),
      projectId,
      requestedByRole: String(p.requestedByRole ?? actor.role ?? 'contractor'),
      requestedByName: String(p.requestedByName ?? actor.name ?? 'Site Manager'),
      description: String(p.description ?? ''),
      amount,
      payee: String(p.payee ?? ''),
      method: String(p.method ?? 'mpesa'),
      relatedEntityType: p.relatedEntityType ?? null,
      relatedEntityId: p.relatedEntityId ?? null,
    },
  })
  await notify(projectId, `Payment request ${request.requestCode} awaiting approval`, `${fmtKes(amount)} to ${request.payee} — ${request.description}`, { kind: 'approval.requested', audienceRole: 'client' })
  return { id: request.id, requestCode: request.requestCode, amount: centsToKes(request.amount) }
}

export async function decidePaymentRequest(projectId: string, p: any) {
  const request = await db.paymentRequest.findFirst({ where: { id: String(p.id), projectId } })
  if (!request) throw new Error('Payment request not found')
  if (request.status !== 'pending') throw new Error(`Payment request already ${request.status}`)
  // F3: decider identity resolved from the session, never from the payload.
  // Share-link callers (no session) fall back to the project client.
  const decider = await requirePrDecider(projectId, 'decide payment requests', p.by)
  const decision = p.decision === 'approve' ? 'approved' : 'rejected'
  const updated = await db.paymentRequest.update({
    where: { id: request.id },
    data: {
      status: decision,
      decidedBy: decider.name,
      decidedAt: new Date(),
      decisionNote: p.note ?? null,
    },
  })
  await notify(
    projectId,
    `Payment request ${request.requestCode} ${decision}`,
    `${fmtKes(request.amount)} to ${request.payee} — decided by ${decider.name} (${decider.role})${p.note ? ` — ${p.note}` : ''}`,
    { kind: decision === 'approved' ? 'payment.approved' : 'payment.rejected' },
  )
  return {
    id: updated.id,
    status: updated.status,
    decidedBy: decider.name,
    // #218 — decision-audit facts (the milestone.decide/variation.decide
    // convention): the pre-read status frozen into before/after + the
    // fields only this handler knows. auditEnrichmentFor (lib/audit.ts)
    // shapes them; applyAction strips the reserved key before the result
    // leaves. This service's ONLY caller is the applyAction dispatcher.
    __audit: {
      entity: 'PaymentRequest',
      entityId: request.id,
      before: { status: request.status },
      after: { status: decision },
      meta: {
        requestCode: request.requestCode,
        amountCents: request.amount, // BigInt — enrichment normalizes to string
        payee: request.payee,
      },
    },
  }
}

/** Session gate for payment-request decisions — client/finance are the real queue. */
async function requirePrDecider(projectId: string, action: string, payloadBy?: unknown): Promise<DeciderIdentity> {
  const actor = await currentActor()
  if (actor.role === null) {
    // Sessionless share-link path: the route already client-gated this call.
    const project = await db.project.findUnique({ where: { id: projectId } })
    const fallback = typeof payloadBy === 'string' && payloadBy.trim() ? payloadBy.trim() : project?.client ?? 'Client'
    return { name: fallback, role: 'client' }
  }
  if ((PR_ROLES as readonly string[]).includes(actor.role)) {
    // Site-team roles may act on the client's behalf in-app (the demo
    // "acting as client" flow); the audit + decision trail record the real
    // signed-in identity and role — never a payload-supplied name.
    return { name: actor.name?.trim() || actor.role, role: actor.role }
  }
  throw new Error(`Only the client or finance may ${action} — signed in as "${actor.role}".`)
}

export async function payPaymentRequest(projectId: string, p: any) {
  // BE-2 (issue #103): payment execution is a PAYMENT_ROLES action — finance,
  // admin, or the client paying their own approved request. Site-team roles
  // (supervisor/qs/procurement/contractor) are refused here, at the service
  // seam both /api/actions and /api/sync route through, mirroring the v1
  // payments route's role allowlist. Sessionless share-link callers keep the
  // client-payer semantics the route already gated upstream.
  const payer = await requireMoneyActor({
    allowed: MONEY_PAYMENT_ROLES,
    action: 'execute payment requests',
    payloadBy: p.paidBy,
    fallbackRole: typeof p.paidByRole === 'string' && p.paidByRole.trim() ? p.paidByRole : 'finance',
  })
  const paidBy = payer.name
  const paidByRole = payer.role

  const request = await db.paymentRequest.findFirst({ where: { id: String(p.id), projectId } })
  if (!request) throw new Error('Payment request not found')
  if (request.status === 'paid') throw new Error('Payment request already paid')
  if (request.status !== 'approved') throw new Error('Payment request must be approved before payment')

  const method = String(p.method ?? request.method) as PaymentMethod

  // Provider seam (spec §40) — the simulated rail records an honest result;
  // a real provider (Daraja, bank API…) plugs in here without touching the ledger.
  const provider = getProvider(method)
  const reference = String(p.reference ?? '').trim() || `${request.requestCode}`
  const initiation = await provider.initiatePayment({
    amount: centsToKes(request.amount),
    currency: 'KES',
    method,
    payee: request.payee,
    reference,
    description: request.description,
  })
  if (initiation.status === 'pending') {
    // A REAL rail is async (M-Pesa STK: the customer must confirm on their
    // handset). Record the PENDING intent — NO money has moved yet — and
    // fail honestly: the verified provider callback (webhooks/daraja) posts
    // the balanced entry and flips this request to paid when Safaricom
    // confirms settlement. Failures here never record money.
    try {
      await recordDarajaIntent({
        kind: 'payment.request',
        paymentRequestId: request.id,
        requestCode: request.requestCode,
        projectId,
        amount: centsToKes(request.amount),
        payee: request.payee,
        method,
        reference,
        providerRef: initiation.providerRef,
        initiatedBy: paidBy,
        initiatedByRole: paidByRole,
      })
      // Issue #34: seed the jobs-module reconciliation sweep for this
      // intent (runAt = now + DARAJA_RECONCILE_AFTER_MIN). If Safaricom's
      // callback is missed, the sweep re-drives the same callback processor
      // (query-API-verified) instead of leaving the intent pending forever.
      // Best-effort — see daraja-reconcile.ts.
      await seedDarajaReconcileSweep()
    } catch (e) {
      // Best-effort row — the callback completes the payment only when the
      // intent exists; a missing row means an honest operator fix-up, never
      // invented money.
      log.error('wallet', 'failed to record pending provider intent', { error: e })
    }
    throw new Error(
      `${provider.label} accepted the request but it is PENDING customer confirmation — no money has moved yet. ${initiation.detail}. The payment records automatically once the provider's VERIFIED callback confirms settlement (ref ${initiation.providerRef}).`,
    )
  }
  if (initiation.status !== 'succeeded') {
    // Issue #211 — outcome-UNKNOWN initiation (the push fetch itself
    // timed out / the 2xx body was unreadable): Safaricom may STILL have
    // accepted the push and the customer may still confirm it, but the
    // CheckoutRequestID — the only key the callback and the reconcile sweep
    // can ever match — was never learned. Persist what IS known right here,
    // AT initiation time (the durable-intent pattern applied to the
    // outcome-unknown class): an unresolved-initiation row keyed
    // daraja.unresolved:<attempt>:<request> carrying the request, amount,
    // payee and the honest failure line. A later verified-success callback
    // for that checkout still cannot be auto-matched (fail-closed: nothing
    // posts without an intent row) but is now ALERTED against these rows
    // (payment.orphaned notification + console.warn) instead of being
    // silently ignored; finance reconciles against the M-Pesa portal.
    // Definitive failures (a real HTTP answer, a readable rejection) never
    // write a row — no push went out, no money can move.
    if (initiation.outcomeUnknown === true) {
      try {
        await recordDarajaUnresolvedInitiation({
          kind: 'payment.unresolved',
          paymentRequestId: request.id,
          requestCode: request.requestCode,
          projectId,
          amount: centsToKes(request.amount),
          payee: request.payee,
          method,
          reference,
          providerRef: initiation.providerRef,
          initiatedBy: paidBy,
          initiatedByRole: paidByRole,
          failureDetail: initiation.detail,
        })
      } catch (e) {
        // Best-effort row — a failed write never masks the honest failure
        // (the orphan-callback alert then degrades to console.warn only).
        log.error('wallet', 'failed to record the unresolved provider initiation', { error: e })
      }
    }
    throw new Error(`Provider did not accept the payment: ${initiation.detail}`)
  }

  const costCode = String(p.costCode ?? request.relatedEntityType ?? 'payment_request')

  const result = await db.$transaction(async (tx) => {
    // Status re-checked INSIDE the transaction — no double-pay race.
    const fresh = await tx.paymentRequest.findUnique({ where: { id: request.id } })
    if (!fresh || fresh.status === 'paid') throw new Error('Payment request already paid')
    if (fresh.status !== 'approved') throw new Error('Payment request must be approved before payment')

    const spend =
      method === 'wallet'
        ? await spendEscrowInTx(tx, projectId, {
            amount: fresh.amount,
            description: `Payment ${fresh.requestCode} — ${fresh.payee} (escrow)`,
            postedBy: paidBy,
            postedRole: paidByRole,
            idempotencyKey: `payment.request:${fresh.id}`,
          })
        : await spendExternalInTx(tx, projectId, {
            amount: fresh.amount,
            method,
            description: `Payment ${fresh.requestCode} — ${fresh.payee}`,
            postedBy: paidBy,
            postedRole: paidByRole,
            idempotencyKey: `payment.request:${fresh.id}`,
          })

    // Phase cost-code (issue #39): a request raised against a milestone pays
    // that milestone's phase — derived + validated INSIDE the transaction
    // (fail-closed on a foreign phase). No milestone linkage → null (the
    // report's documented estimate handles those rows honestly).
    const phaseId = await phaseIdForMilestonePayment(tx, projectId, fresh.relatedEntityType, fresh.relatedEntityId)

    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: spend.ledgerTxnId } })) ??
      (await tx.transaction.create({
        data: {
          projectId,
          type: 'payment_request',
          amount: fresh.amount,
          method,
          reference: p.reference ?? spend.ledgerRef,
          costCode,
          phaseId,
          ledgerTxnId: spend.ledgerTxnId,
          note: `${fresh.requestCode} — ${fresh.description}`,
          date: new Date(),
        },
      }))

    await tx.paymentRequest.update({
      where: { id: fresh.id },
      data: { status: 'paid', paidAt: new Date(), paidTxnId: txnRow.id },
    })

    return { transactionId: txnRow.id, ledgerRef: spend.ledgerRef, balance: 'balance' in spend ? spend.balance : undefined }
  })

  await notify(
    projectId,
    `Payment ${request.requestCode} recorded`,
    `${fmtKes(request.amount)} to ${request.payee} via ${method} — ledger ${result.ledgerRef} (${provider.integrationNote})`,
    { kind: 'payment.paid' },
  )
  return { id: request.id, status: 'paid', transactionId: result.transactionId, ledgerRef: result.ledgerRef, balance: result.balance, providerNote: provider.integrationNote }
}

// ---- Wallets (spec §37/§38) ----

export async function createWallet(projectId: string, p: any) {
  const ownerType = String(p.ownerType ?? 'project')
  const ownerId = p.ownerId ?? projectId
  const wallet = await db.$transaction(async (tx) => {
    const count = await tx.walletAccount.count()
    const code = `W-${String(count + 1).padStart(4, '0')}`
    const created = await tx.walletAccount.create({
      data: { code, label: String(p.label ?? code), ownerType, ownerId, status: 'active' },
    })
    const account = await tx.ledgerAccount.create({
      data: {
        code: `WALLET:${created.code}`,
        name: `Wallet ${created.code} — ${created.label}`,
        kind: 'liability', // we owe the wallet owner this balance
        normalSide: 'credit',
        projectId: ownerType === 'project' ? projectId : null,
        ownerType: 'wallet',
        ownerId: created.id,
      },
    })
    return tx.walletAccount.update({ where: { id: created.id }, data: { ledgerAccountId: account.id } })
  })
  const accountCode = `WALLET:${wallet.code}`
  const balance = await derivedBalance(accountCode)
  return { id: wallet.id, code: wallet.code, ledgerAccount: accountCode, balance: centsToKes(balance) }
}

async function resolveWallet(projectId: string | null | undefined, idOrCode: any) {
  const wallet = await db.walletAccount.findFirst({
    where: { OR: [{ id: String(idOrCode) }, { code: String(idOrCode) }] },
  })
  if (!wallet) throw new Error('Wallet not found')
  // Empty/absent projectId = unscoped lookup (finance/admin v1 routes); a
  // NON-empty projectId scopes to that project's wallets only.
  if (wallet.ownerType === 'project' && projectId && wallet.ownerId !== projectId) {
    throw new Error('Wallet belongs to a different project')
  }
  return wallet
}

/** Wallet + derived balance (spec §39: the ledger is the source of truth). */
export async function walletWithBalance(projectId: string, idOrCode: any) {
  const wallet = await resolveWallet(projectId, idOrCode)
  const balance = await derivedBalance(`WALLET:${wallet.code}`)
  return { wallet, balance }
}

export async function depositWallet(projectId: string, p: any) {
  const amount = parseMoneyCents(p.amount)
  if (amount === null) throw new Error(MONEY_AMOUNT_ERROR)
  // BE-2 (issue #103): wallet money movements are finance/admin actions —
  // gated at the service seam BEFORE any wallet/ledger read, so a refused
  // dispatch touches nothing.
  const actor = await requireMoneyActor({
    allowed: MONEY_FINANCE_ROLES,
    action: 'deposit into wallets',
    payloadBy: p.by,
  })
  const wallet = await resolveWallet(projectId, p.walletId ?? p.code)
  const cashCode = cashAccountForMethod(String(p.source ?? 'mpesa'))
  const ledgerProjectId = wallet.ownerType === 'project' ? projectId : null
  const { ledgerRef, balance } = await db.$transaction(async (tx) => {
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: ledgerProjectId,
      description: `Wallet ${wallet.code} deposit`,
      // BE-7 (issue #103): the REAL session actor (payload `by` only on the
      // sessionless/internal fallback path) — was hardcoded 'finance'.
      postedBy: actor.name,
      postedRole: actor.role,
      // Natural idempotency ONLY when the caller supplied a unique reference —
      // repeated same-amount deposits without a reference are distinct events.
      idempotencyKey:
        p.idempotencyKey ??
        (typeof p.reference === 'string' && p.reference.trim() ? `wallet.deposit:${wallet.id}:${amount}:${p.reference.trim()}` : undefined),
      lines: [
        { accountCode: cashCode, side: 'debit', amount },
        { accountCode: `WALLET:${wallet.code}`, side: 'credit', amount },
      ],
    })
    // Derived on the SAME tx client — uncommitted entries are visible here,
    // so the returned balance reflects this deposit (liability: credits − debits).
    // SQL SUM aggregation (issue #144): one grouped Σdebit/Σcredit over the
    // LedgerEntry(accountId) index instead of loading the full entry history
    // into JS — constant memory, still inside the transaction.
    const account = await ensureAccountTx(tx, `WALLET:${wallet.code}`)
    const { debit, credit } = await accountSideSums(tx, account.id)
    return { ledgerRef: ledgerTxn.ref, balance: credit - debit }
  })
  return { walletCode: wallet.code, ledgerRef, balance: centsToKes(balance) }
}

/**
 * Deterministic natural idempotency key for wallet money mutations
 * (issue #75 / BE-3): derived ONLY from immutable request content — the
 * wallets/amounts involved, the wallet currency, the payment rail, the note
 * and the actor — NEVER a timestamp. A client retry after a lost response
 * re-derives the SAME key and replays the original ledger transaction
 * instead of double-posting a second debit.
 *
 * Honest trade-off: two byte-identical but DISTINCT withdrawals (same
 * wallet, amount, rail, note AND actor) are indistinguishable from a retry
 * by construction — they replay the first result instead of paying twice.
 * The money-safe direction: never double-pay. Clients that intend a second
 * distinct movement send an Idempotency-Key header (the v1 routes dedupe
 * on it) or a distinguishing note.
 */
function withdrawNaturalKey(
  wallet: { id: string; currency: string },
  amount: Cents,
  p: any,
  actorName: string,
): string {
  return `wallet.withdraw:${JSON.stringify([
    wallet.id,
    amount.toString(), // cents — key format changed with #122
    wallet.currency,
    String(p.destination ?? 'mpesa'),
    String(p.note ?? ''),
    actorName,
  ])}`
}

export async function withdrawWallet(projectId: string, p: any) {
  const amount = parseMoneyCents(p.amount)
  if (amount === null) throw new Error(MONEY_AMOUNT_ERROR)
  // BE-2 (issue #103): finance/admin only, BEFORE any wallet/ledger read.
  const actor = await requireMoneyActor({
    allowed: MONEY_FINANCE_ROLES,
    action: 'withdraw from wallets',
    payloadBy: p.by,
  })
  const wallet = await resolveWallet(projectId, p.walletId)
  const cashCode = cashAccountForMethod(String(p.destination ?? 'mpesa'))
  const ledgerProjectId = wallet.ownerType === 'project' ? projectId : null
  // BE-7: the natural key carries the REAL actor (payload `by` only on the
  // sessionless fallback, which resolves to the same string as before) — two
  // distinct finance users never collide into one replay.
  const idempotencyKey = p.idempotencyKey ?? withdrawNaturalKey(wallet, amount, p, actor.name)
  const { ledgerRef, balance } = await db.$transaction(async (tx) => {
    // Balance re-checked INSIDE the transaction — no overdraft race. The
    // re-check is a SQL SUM aggregate on the SAME tx client (issue #144):
    // uncommitted rows stay visible (identical read set, constant memory).
    const account = await ensureAccountTx(tx, `WALLET:${wallet.code}`)
    const { debit, credit } = await accountSideSums(tx, account.id)
    const current = credit - debit // liability account
    // Replay check BEFORE the balance check: a retried withdrawal that
    // (nearly) emptied the wallet must return the ORIGINAL result, not
    // "Insufficient wallet balance" — the money already moved once.
    const prior = idempotencyKey
      ? await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } })
      : null
    if (prior) return { ledgerRef: prior.ref, balance: current }
    if (current < amount) throw new Error(`Insufficient wallet balance: ${fmtKes(current)} < ${fmtKes(amount)}`)
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: ledgerProjectId,
      description: `Wallet ${wallet.code} withdrawal${p.note ? ` — ${p.note}` : ''}`,
      // BE-7 (issue #103): the REAL session actor — was hardcoded 'finance'.
      postedBy: actor.name,
      postedRole: actor.role,
      idempotencyKey,
      lines: [
        { accountCode: `WALLET:${wallet.code}`, side: 'debit', amount },
        { accountCode: cashCode, side: 'credit', amount },
      ],
    })
    return { ledgerRef: ledgerTxn.ref, balance: current - amount }
  })
  return { walletCode: wallet.code, ledgerRef, balance: centsToKes(balance) }
}

/** Transfer-key twin of withdrawNaturalKey — from/to wallets + amount + content. */
function transferNaturalKey(
  from: { id: string; currency: string },
  to: { id: string },
  amount: Cents,
  p: any,
  actorName: string,
): string {
  return `wallet.transfer:${JSON.stringify([
    from.id,
    to.id,
    amount.toString(), // cents — key format changed with #122
    from.currency,
    String(p.note ?? ''),
    actorName,
  ])}`
}

export async function transferWallet(projectId: string, p: any) {
  const amount = parseMoneyCents(p.amount)
  if (amount === null) throw new Error(MONEY_AMOUNT_ERROR)
  // BE-2 (issue #103): finance/admin only, BEFORE any wallet/ledger read.
  const actor = await requireMoneyActor({
    allowed: MONEY_FINANCE_ROLES,
    action: 'transfer between wallets',
    payloadBy: p.by,
  })
  const from = await resolveWallet(projectId, p.fromWalletId)
  const to = await resolveWallet(projectId, p.toWalletId)
  const ledgerProjectId = from.ownerType === 'project' ? projectId : null
  const idempotencyKey = p.idempotencyKey ?? transferNaturalKey(from, to, amount, p, actor.name)
  const { ledgerRef } = await db.$transaction(async (tx) => {
    // Same in-tx SQL SUM re-check as withdraw (issue #144) — race safety
    // unchanged: the aggregate runs on the tx client, inside the transaction.
    const account = await ensureAccountTx(tx, `WALLET:${from.code}`)
    const { debit, credit } = await accountSideSums(tx, account.id)
    const current = credit - debit
    // Replay check BEFORE the balance check (same rule as withdraw).
    const prior = idempotencyKey
      ? await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } })
      : null
    if (prior) return { ledgerRef: prior.ref }
    if (current < amount) throw new Error(`Insufficient wallet balance: ${fmtKes(current)} < ${fmtKes(amount)}`)
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: ledgerProjectId,
      description: `Wallet transfer ${from.code} → ${to.code}`,
      // BE-7 (issue #103): the REAL session actor — was hardcoded 'finance'.
      postedBy: actor.name,
      postedRole: actor.role,
      idempotencyKey,
      lines: [
        { accountCode: `WALLET:${from.code}`, side: 'debit', amount },
        { accountCode: `WALLET:${to.code}`, side: 'credit', amount },
      ],
    })
    return { ledgerRef: ledgerTxn.ref }
  })
  return { from: from.code, to: to.code, ledgerRef }
}

// ---- Reversals & manual journals (spec §39) ----

/**
 * Reverse a posted transaction (issue #213 hardening).
 *
 * LEDGER-BACKED ROWS: the mirrored reversal post, the EscrowWallet.balance
 * projection restore and the `[reversed by LX-…]` marker on the original row
 * ALL run in ONE db.$transaction — the same pattern the deposit/release
 * paths use for their projection writes. Before #213 the reversal mirrored
 * the ledger entries (restoring the DERIVED escrow balance) but never
 * touched the projection, so every escrow-spend reversal permanently broke
 * derived-vs-projected consistency (the Money-tab chip read "Drift —
 * investigate" forever) and the restored money was UNSPENDABLE — every
 * future spendEscrowInTx checks the projection, which still carried the
 * decrement. The restore is derived, not hardcoded: the projection moves by
 * the NEGATED escrow effect of the ORIGINAL txn's ESCROW:<projectId> legs
 * (debits − credits), so spend reversals increment (escrow money comes
 * back) and top-up reversals decrement (escrow money leaves) — direction
 * falls out of the ledger, never out of a guess.
 *
 * POST-REVERSAL ENTITY STATES (documented terminal state — issue #213): a
 * reversal restores the MONEY, not the decision. The milestone stays
 * `released`, the invoice stays `paid`, the payment request stays `paid` —
 * each is a historical decision with its audit trail, and money history is
 * append-only (spec §39). The operator route for "the client approved the
 * wrong milestone": reverse the release here (the money returns to escrow,
 * spendable again — the re-release regression test pins this), then re-issue
 * the spend as a NEW payment request / variation order / new milestone; the
 * original decision history stays intact. Re-opening the ladder from
 * `released` is deliberately NOT offered (that would rewrite decision
 * history, which is immutable by doctrine).
 *
 * M-PESA RAIL REVERSALS (known limitation, deliberately unwired): the books
 * are corrected here only — the customer's M-Pesa is never asked to return
 * the money. The provider seam's refund() (daraja.ts, reversal request)
 * exists and is tested but has ZERO callers by design: firing it needs the
 * separate reversal credentials (#43) AND the reversal ResultURL callback
 * is still unprocessed, so wiring it now would be a promise the rail cannot
 * keep. An operator reconciles the rail side via the M-Pesa portal.
 *
 * LEGACY (pre-ledger) ROWS: the compensating CASH/EXPENSE post is
 * projection-neutral by design — those rows predate the escrow projection
 * discipline and never carried one.
 */
export async function reverseTransaction(projectId: string, p: any) {
  // BE-2 (issue #103): reversals rewrite money history — finance/admin only,
  // gated BEFORE any transaction lookup.
  const actor = await requireMoneyActor({
    allowed: MONEY_FINANCE_ROLES,
    action: 'reverse transactions',
    payloadBy: p.by,
  })
  const txn = await db.transaction.findFirst({ where: { id: String(p.id), projectId } })
  if (!txn) throw new Error('Transaction not found')
  if (!txn.ledgerTxnId) {
    // Legacy single-entry row (pre-ledger): post a compensating entry now.
    const by = actor.name
    const { reversalLedger, compensating } = await db.$transaction(async (tx) => {
      const reversalLedger = await postLedgerTransactionInTx(tx, {
        projectId,
        description: `REVERSAL of legacy transaction ${txn.id.slice(-6)} — ${p.reason ?? 'correction'}`,
        postedBy: by,
        postedRole: actor.role,
        lines: [
          { accountCode: cashAccountForMethod(String(p.method ?? txn.method)), side: 'debit', amount: txn.amount },
          { accountCode: `EXPENSE:${projectId}`, side: 'credit', amount: txn.amount },
        ],
      })
      const compensating =
        (await tx.transaction.findFirst({ where: { ledgerTxnId: reversalLedger.id } })) ??
        (await tx.transaction.create({
          data: {
            projectId,
            type: 'reversal',
            amount: -txn.amount,
            method: txn.method,
            reference: reversalLedger.ref,
            // Phase cost-code (issue #39): a reversal negates the SAME phase
            // spend — the original row's code is copied so net attribution
            // stays exact (money math untouched).
            phaseId: txn.phaseId,
            ledgerTxnId: reversalLedger.id,
            note: `Reversal of ${txn.id.slice(-6)}: ${p.reason ?? 'correction'}`,
            date: new Date(),
          },
        }))
      await tx.transaction.update({ where: { id: txn.id }, data: { note: `${txn.note ?? ''} [reversed by ${reversalLedger.ref}]`.trim() } })
      return { reversalLedger, compensating }
    })
    return { reversalTransactionId: compensating.id, ledgerRef: reversalLedger.ref }
  }

  const ledgerTxn = await db.ledgerTransaction.findUnique({
    where: { id: txn.ledgerTxnId },
    include: { entries: { include: { account: true } } },
  })
  if (!ledgerTxn) throw new Error('Backing ledger transaction not found')
  // BE-7 (issue #103): the REAL session actor on the mirrored reversal too.
  // Issue #213: the mirrored post, the escrow projection restore and the
  // original-row marker commit as ONE unit — a failure anywhere (e.g. the
  // 'already reversed' guard racing a concurrent reversal) rolls back all of
  // it, so the projection can never drift from the ledger again.
  const { reversal, compensating } = await db.$transaction(async (tx) => {
    const reversal = await reverseLedgerTransactionInTx(
      tx,
      ledgerTxn,
      String(p.reason ?? 'correction'),
      actor.name,
      actor.role,
    )
    // Escrow projection restore (issue #213): when the ORIGINAL txn touched
    // ESCROW:<projectId>, its posting kept the projection in sync (decrement
    // on spend, increment on top-up) — the reversal must apply the NEGATED
    // effect. Delta = original debits − credits on the escrow account:
    //   · spend reversal (original leg: debit)  → +amount (money back)
    //   · top-up reversal (original leg: credit) → −amount (money out)
    // Derived from the mirrored legs' source of truth, never hardcoded.
    const escrowCode = `ESCROW:${projectId}`
    const escrowLegs = ledgerTxn.entries.filter((e) => e.account.code === escrowCode)
    if (escrowLegs.length > 0) {
      const delta = escrowLegs.reduce((sum, e) => sum + (e.side === 'debit' ? e.amount : -e.amount), 0n)
      if (delta !== 0n) {
        const escrowAccount = await ensureAccountTx(tx, escrowCode)
        await tx.escrowWallet.upsert({
          where: { projectId },
          create: { projectId, balance: delta, ledgerAccountId: escrowAccount.id },
          update: { balance: { increment: delta }, ledgerAccountId: escrowAccount.id },
        })
      }
    }
    const compensating =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: reversal.id } })) ??
      (await tx.transaction.create({
        data: {
          projectId,
          type: 'reversal',
          amount: -txn.amount,
          method: txn.method,
          reference: reversal.ref,
          // Phase cost-code (issue #39): same as the legacy branch — the
          // reversal negates the original row's phase spend, so its code is
          // copied (net attribution exact; null originals stay null).
          phaseId: txn.phaseId,
          ledgerTxnId: reversal.id,
          note: `Reversal of ${txn.id.slice(-6)}: ${p.reason ?? 'correction'}`,
          date: new Date(),
        },
      }))
    // Marker on the original legacy row — parity with the legacy branch
    // (issue #213 AC): the ledger-backed branch used to skip this, so the
    // original row never said it had been reversed.
    await tx.transaction.update({
      where: { id: txn.id },
      data: { note: `${txn.note ?? ''} [reversed by ${reversal.ref}]`.trim() },
    })
    return { reversal, compensating }
  })
  return { reversalTransactionId: compensating.id, ledgerRef: reversal.ref }
}

export async function postJournal(projectId: string, p: any) {
  // BE-2 (issue #103): manual journals are the rawest money write — finance/
  // admin only. (Sessionless/internal fallback keeps the legacy payload role.)
  const actor = await requireMoneyActor({
    allowed: MONEY_FINANCE_ROLES,
    action: 'post manual journal entries',
    payloadBy: p.by,
    fallbackRole: typeof p.role === 'string' && p.role.trim() ? p.role : 'finance',
  })
  const lines = (p.lines ?? []).map((l: any) => ({
    accountCode: String(l.accountCode),
    side: String(l.side) as 'debit' | 'credit',
    amount: assertMoneyCents(l.amount, 'lines.amount'),
    memo: l.memo,
  }))
  const txn = await postLedgerTransaction({
    projectId,
    description: String(p.description ?? 'Manual journal entry'),
    // BE-7 (issue #103): the REAL session actor — payload `by`/`role` only
    // survive on the sessionless fallback path.
    postedBy: actor.name,
    postedRole: actor.role,
    idempotencyKey: p.idempotencyKey,
    lines,
  })
  return { ref: txn.ref }
}

// ---- Escrow top-up (money.ts escrow.topup — the ledger is the source of truth) ----

/**
 * Escrow top-up posting: debit the cash pool, credit ESCROW:<projectId>, and
 * keep the EscrowWallet.balance projection + ledgerAccountId in sync — all in
 * ONE db.$transaction (F2). `by`/`role` come from the resolved session actor.
 */
export async function postEscrowTopup(
  projectId: string,
  amount: Cents,
  by: string,
  opts: { reference?: string; method?: string; role?: string } = {},
): Promise<{ ledgerRef: string; balance: Cents }> {
  const method = opts.method ?? 'mpesa'
  const cashCode = cashAccountForMethod(method)
  // Same natural key the ledger post below derives (issue #75/BE-3): a
  // retried top-up with the SAME reference must REPLAY, never double-count.
  // Found by the #184 real-SQLite harness: the projection used to increment
  // unconditionally, so a replay incremented EscrowWallet.balance while the
  // ledger (correctly) posted nothing — the stored balance drifted above the
  // derived truth by exactly the retry amount (the #212 drift-alarm class).
  // The replay check runs BEFORE the upsert, mirroring withdrawWallet's
  // replay-before-balance-check discipline.
  const idempotencyKey = opts.reference ? `escrow.topup:${projectId}:${opts.reference}` : undefined
  return db.$transaction(async (tx) => {
    if (idempotencyKey) {
      const prior = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } })
      if (prior) {
        const wallet = await tx.escrowWallet.findUnique({ where: { projectId } })
        return { ledgerRef: prior.ref, balance: wallet?.balance ?? 0n }
      }
    }
    const escrowAccount = await ensureAccountTx(tx, `ESCROW:${projectId}`)
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId,
      description: `Escrow top-up${opts.reference ? ` (${opts.reference})` : ''} — ${method}`,
      postedBy: by,
      postedRole: opts.role ?? 'client',
      idempotencyKey,
      lines: [
        { accountCode: cashCode, side: 'debit', amount },
        { accountCode: `ESCROW:${projectId}`, side: 'credit', amount },
      ],
    })
    const wallet = await tx.escrowWallet.upsert({
      where: { projectId },
      create: { projectId, balance: amount, ledgerAccountId: escrowAccount.id },
      update: { balance: { increment: amount }, ledgerAccountId: escrowAccount.id },
    })
    return { ledgerRef: ledgerTxn.ref, balance: wallet.balance }
  })
}

export async function escrowDerivedBalance(projectId: string) {
  await ensureAccount(`ESCROW:${projectId}`)
  return derivedBalance(`ESCROW:${projectId}`)
}

// ---- v1 read helpers (spec §38) ----

/** All wallets (optionally project-scoped) with ledger-derived balances. */
export async function listWallets(projectId?: string) {
  const wallets = await db.walletAccount.findMany({
    where: projectId ? { OR: [{ ownerId: projectId, ownerType: 'project' }, { ownerType: { not: 'project' } }] } : undefined,
    orderBy: { code: 'asc' },
  })
  // SQL SUM aggregation (issue #144): account rows (bounded — one per wallet,
  // never per entry) + ONE grouped Σdebit/Σcredit per (account, side) — the
  // pre-#144 shape loaded every wallet-owned account with its ENTIRE entry
  // history (`include: { entries: true }`), so the list view materialized
  // the global entry count in memory on every render.
  const accounts = await db.ledgerAccount.findMany({
    where: { ownerType: 'wallet' },
    select: { id: true, code: true, ownerId: true },
  })
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
  return wallets.map((w) => {
    const account = accounts.find((a) => a.ownerId === w.id)
    const s = account ? sumsByAccount.get(account.id) : undefined
    const debit = s?.debit ?? 0n
    const credit = s?.credit ?? 0n
    return {
      id: w.id,
      code: w.code,
      label: w.label,
      ownerType: w.ownerType,
      ownerId: w.ownerId,
      currency: w.currency,
      status: w.status,
      ledgerAccountCode: account?.code ?? null,
      balance: centsToKes(credit - debit), // liability account: we owe the owner this
      createdAt: w.createdAt.toISOString(),
    }
  })
}

/** Ledger transactions that touch a wallet's backing account. */
export async function walletLedgerTransactions(projectId: string, idOrCode: any) {
  const { wallet, balance } = await walletWithBalance(projectId, idOrCode)
  const account = wallet.ledgerAccountId
    ? await db.ledgerAccount.findUnique({ where: { id: wallet.ledgerAccountId } })
    : null
  if (!account) return { wallet: { code: wallet.code, label: wallet.label }, balance, transactions: [] }
  const txns = await db.ledgerTransaction.findMany({
    where: { entries: { some: { accountId: account.id } } },
    include: { entries: { include: { account: true } } },
    orderBy: { occurredAt: 'desc' },
    take: 100,
  })
  // DB-11 (#133): 'reversed' is DERIVED from the reversalOfId link (one
  // indexed query for the page) — the stored rows are append-only 'posted'.
  const reversalRefs = await reversalRefsByTxnId(txns.map((t) => t.id))
  return {
    wallet: { code: wallet.code, label: wallet.label, ledgerAccount: account.code },
    balance: centsToKes(balance),
    transactions: txns.map((t) => ({
      id: t.id,
      ref: t.ref,
      description: t.description,
      occurredAt: t.occurredAt.toISOString(),
      status: reversalRefs.has(t.id) ? 'reversed' : t.status,
      postedBy: t.postedBy,
      postedRole: t.postedRole,
      entries: t.entries.map((e) => ({
        accountCode: e.account.code,
        side: e.side,
        amount: centsToKes(e.amount),
        memo: e.memo,
      })),
      total: centsToKes(sumCents(t.entries.filter((e) => e.side === 'debit').map((e) => e.amount))),
    })),
  }
}
