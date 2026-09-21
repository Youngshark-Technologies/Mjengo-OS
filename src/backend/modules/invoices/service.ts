// Invoices module — service layer.
//
// Supplier invoice lifecycle, called from src/backend/actions/invoices.ts:
//   - create/update draft invoices (from a PO or standalone); every total is
//     recomputed server-side — client sums are never trusted
//   - submit to the client decision queue (+ Notification row)
//   - decide (approve/reject) — decisions belong to the CLIENT role; the role
//     is resolved from the signed-in session (modules/invoices/session.ts),
//     never from the payload, so a contractor attempting a decision fails
//     with a clear server-side message
//   - disputes: there is no dispute action in the INVOICE_ACTIONS tuple, so
//     disputes ride `invoice.update` { id, status: 'disputed', note } while
//     SUBMITTED/APPROVED (client-role gated) — documented, UI badge 'DISPUTED'
//   - record payment (method + reference) → exactly ONE Transaction ledger
//     entry, mirroring money.ts conventions: type 'invoice' (peer of
//     'milestone'), method, auto reference (MPESA-XXXXXXXX style), note
//     referencing the invoice code + PO code, date. method 'wallet' debits
//     the escrow wallet exactly like milestone.decide does (balance checked
//     first); external rails never touch the wallet. The wallet is NOT a
//     bank — it records money movement, it never custodies it.
//   - 3-way match (PO vs invoice vs delivery): warn-only — payment still
//     succeeds when the payer explicitly acknowledges the discrepancy
//     (acknowledgeMismatch: true), and that human decision is recorded in
//     the Approval trail + the Bias-Free Ledger (applyAction logs every
//     dispatch). AI/system recommends; an authorized human decides.
//   - A-1-lite ledger consistency: read-only recomputation from the
//     Transaction ledger (three-way.ts) — never mutates wallet values.
//
// Money rules: approvals before payment are enforced server-side (invoice
// must be APPROVED before invoice.pay succeeds); the Transaction ledger is
// append-only thinking — rows are written, never mutated or deleted here.
//
// Every mutation returns a plain object; applyAction() writes the AuditEvent.

import { db } from '@/backend/lib/db'
import { centsToKes, mulQtyCents, parseNonNegativeMoneyCents, parseQtyMilli, sumCents, fmtKes, type Cents } from '@/backend/lib/money'
import { currentActor } from './session'
import { computeLedgerConsistency, matchThreeWay } from './three-way'
import { resolvePostingPhaseId, spendEscrowInTx, spendExternalInTx } from '@/backend/modules/wallet/service'
import { getProvider } from '@/backend/modules/wallet/providers'
import { autoPaymentReference } from '@/shared/ids'
import type { LedgerCheck, ThreeWayReport } from './types'

// ---------------- helpers (money.ts house conventions) ----------------

function kes(nCents: Cents): string {
  return fmtKes(nCents)
}

function posNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** ≥0 money in KSh (zero allowed — tax, zero-priced lines) → cents, or null. */
function money(v: unknown): Cents | null {
  return parseNonNegativeMoneyCents(v)
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Next invoice code: INV-YYYY-000NNN (max NNN on THIS project + 1). */
async function nextInvoiceCode(projectId: string): Promise<string> {
  const year = new Date().getFullYear()
  const existing = await db.invoice.findMany({
    where: { projectId, invoiceCode: { startsWith: `INV-${year}-` } },
    select: { invoiceCode: true },
  })
  let max = 0
  for (const { invoiceCode } of existing) {
    const n = parseInt(invoiceCode.slice(`INV-${year}-`.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `INV-${year}-${String(max + 1).padStart(6, '0')}`
}

/**
 * Server-side payer-role gate: client, finance, or the share-link client path
 * (no session — already client-gated upstream). Aligns with policy.ts
 * DECIDER_ROLES (client + finance + share_client decide and pay).
 */
async function requireClientRole(projectId: string, actionDescription: string): Promise<string> {
  const actor = await currentActor()
  if (actor.role === null || actor.role === 'client' || actor.role === 'finance') {
    return actor.name || actor.role || 'client'
  }
  const project = await db.project.findUnique({ where: { id: projectId } })
  throw new Error(
    `Only the client or finance may ${actionDescription} — signed in as "${actor.role}"${actor.name ? ` (${actor.name})` : ''}. ` +
      `The decision queue is waiting for ${project?.client ?? 'the project client'}.`,
  )
}

interface LineInput {
  name: string
  qty: number
  unitPrice: Cents
  lineTotal: Cents
}

/** Validate + normalize lines and compute totals server-side. */
function normalizeLines(raw: unknown): { lines: LineInput[]; subtotal: Cents } {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('At least one invoice line is required')
  const lines: LineInput[] = []
  let subtotal = 0n
  for (const item of raw) {
    const name = String((item as Record<string, unknown>)?.name ?? '').trim()
    const qtyRaw = (item as Record<string, unknown>)?.qty
    const qtyMilli = parseQtyMilli(qtyRaw)
    const unitPrice = money((item as Record<string, unknown>)?.unitPrice)
    if (!name) throw new Error('Every invoice line needs a name')
    if (qtyMilli === null) throw new Error(`Line "${name}": quantity must be greater than zero (at most 3 decimal places)`)
    if (unitPrice === null) throw new Error(`Line "${name}": unit price must be zero or more`)
    const qty = Number(qtyRaw)
    const lineTotal = mulQtyCents(qty, unitPrice) // exact: qty-thousandths × cents
    lines.push({ name, qty, unitPrice, lineTotal })
    subtotal += lineTotal
  }
  return { lines, subtotal }
}

async function getInvoiceOrThrow(id: unknown, projectId: string) {
  const invoiceId = String(id ?? '')
  if (!invoiceId) throw new Error('Invoice id required')
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, projectId } })
  if (!invoice) throw new Error('Invoice not found in this project')
  return invoice
}

async function notify(projectId: string, kind: string, title: string, body: string, audienceRole: string, recipient: string | null) {
  await db.notification.create({
    data: { projectId, kind, title, body, audienceRole, recipient },
  })
}

// ---------------- lifecycle ----------------

/** `invoice.create` { orderId?, supplierId?, lines, tax?, dueDate?, note? } → DRAFT. */
export async function createInvoice(projectId: string, payload: Record<string, unknown>) {
  const { lines, subtotal } = normalizeLines(payload.lines)
  const tax = payload.tax === undefined || payload.tax === null ? 0n : money(payload.tax)
  if (tax === null) throw new Error('Tax must be zero or more')
  const total = subtotal + tax

  // PO link (optional) — must belong to this project; it also implies the supplier
  let orderId: string | null = null
  let supplierId: string | null = null
  if (payload.orderId) {
    const order = await db.purchaseOrder.findFirst({
      where: { id: String(payload.orderId), projectId },
      include: { supplier: true },
    })
    if (!order) throw new Error('Purchase order not found in this project')
    orderId = order.id
    supplierId = order.supplierId
  }
  if (payload.supplierId) {
    const supplier = await db.supplier.findUnique({ where: { id: String(payload.supplierId) } })
    if (!supplier) throw new Error('Supplier not found')
    supplierId = supplier.id
  }

  const invoiceCode = await nextInvoiceCode(projectId)
  const actor = await currentActor()
  const supplierName = supplierId
    ? (await db.supplier.findUnique({ where: { id: supplierId } }))?.businessName ?? null
    : null
  const invoice = await db.invoice.create({
    data: {
      invoiceCode,
      projectId,
      orderId,
      supplierId,
      status: 'draft',
      subtotal,
      tax,
      total,
      dueDate: parseDate(payload.dueDate),
      issuedAt: new Date(),
      createdBy: actor.name ?? supplierName ?? 'MjengoOS',
      note: typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null,
      lines: { create: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })) },
    },
    include: { lines: true },
  })
  return { id: invoice.id, invoiceCode, total: centsToKes(total) }
}

/** `invoice.update` — edit while DRAFT, or file a DISPUTE while SUBMITTED/APPROVED. */
export async function updateInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)

  // ---- dispute transition (no dispute action in the tuple — documented path) ----
  if (payload.status === 'disputed') {
    const decidedBy = await requireClientRole(projectId, 'dispute an invoice')
    if (!['submitted', 'approved'].includes(invoice.status)) {
      throw new Error(`Cannot dispute an invoice that is ${invoice.status.toUpperCase()} — disputes are filed while the invoice is SUBMITTED or APPROVED`)
    }
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'disputed', decidedAt: new Date(), decidedBy, note: note ?? invoice.note },
    })
    await notify(
      projectId,
      'invoice.disputed',
      `Invoice disputed: ${invoice.invoiceCode}`,
      `${kes(invoice.total)} from the supplier is disputed${note ? ` — “${note}”` : ''}. The site team should reconcile with the supplier before re-approval.`,
      'contractor',
      null,
    )
    return { id: invoice.id, status: 'disputed' }
  }

  // ---- draft edits ----
  if (invoice.status !== 'draft') {
    throw new Error(`Only DRAFT invoices can be edited — this one is ${invoice.status.toUpperCase()}`)
  }
  if (payload.status !== undefined && payload.status !== 'draft') {
    throw new Error("Status changes go through invoice.submit / invoice.decide / invoice.pay — updates can only file a dispute")
  }

  const data: Record<string, unknown> = {}
  if (payload.lines !== undefined) {
    const { lines, subtotal } = normalizeLines(payload.lines)
    const tax = payload.tax === undefined ? invoice.tax : money(payload.tax)
    if (tax === null) throw new Error('Tax must be zero or more')
    data.subtotal = subtotal
    data.tax = tax
    data.total = subtotal + tax
    await db.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
    await db.invoiceLine.createMany({
      data: lines.map((l) => ({ invoiceId: invoice.id, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    })
  } else if (payload.tax !== undefined) {
    const tax = money(payload.tax)
    if (tax === null) throw new Error('Tax must be zero or more')
    data.tax = tax
    data.total = invoice.subtotal + tax
  }
  if (payload.dueDate !== undefined) data.dueDate = parseDate(payload.dueDate)
  if (typeof payload.note === 'string') data.note = payload.note.trim() || null

  await db.invoice.update({ where: { id: invoice.id }, data })
  return { id: invoice.id }
}

/** `invoice.submit` { id } → SUBMITTED (+ notification to the client). */
export async function submitInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  if (invoice.status !== 'draft') {
    throw new Error(`Only DRAFT invoices can be submitted — this one is ${invoice.status.toUpperCase()}`)
  }
  await db.invoice.update({ where: { id: invoice.id }, data: { status: 'submitted', submittedAt: new Date() } })
  const project = await db.project.findUnique({ where: { id: projectId } })
  await notify(
    projectId,
    'invoice.submitted',
    `Invoice ${invoice.invoiceCode} submitted`,
    `${kes(invoice.total)}${invoice.orderId ? ' against a purchase order' : ''} from the supplier — awaiting your decision.`,
    'client',
    project?.client ?? null,
  )
  return { id: invoice.id, status: 'submitted' }
}

/** `invoice.decide` { id, decision: approve|reject, by?, note? } — CLIENT only. */
export async function decideInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  const decision = payload.decision
  if (decision !== 'approve' && decision !== 'reject') {
    // disputes are filed via invoice.update { status: 'disputed' } — see the module docs
    throw new Error("decision must be 'approve' or 'reject' (file disputes with invoice.update { status: 'disputed' })")
  }
  if (!['submitted', 'disputed'].includes(invoice.status)) {
    throw new Error(`Invoice is not awaiting a client decision — it is ${invoice.status.toUpperCase()}`)
  }

  const sessionName = await requireClientRole(projectId, decision === 'approve' ? 'approve invoices' : 'reject invoices')
  const project = await db.project.findUnique({ where: { id: projectId } })
  const by = typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : sessionName !== 'client' ? sessionName : project?.client ?? 'Client'
  const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null
  const now = new Date()

  const status = decision === 'approve' ? 'approved' : 'rejected'
  await db.invoice.update({
    where: { id: invoice.id },
    data: { status, decidedAt: now, decidedBy: by },
  })

  // Approval trail (plain entityType/entityId — audited via the ledger, same as the seed)
  const pending = await db.approval.findFirst({
    where: { entityType: 'invoice', entityId: invoice.id, decision: 'pending' },
  })
  if (pending) {
    await db.approval.update({
      where: { id: pending.id },
      data: { decision: status === 'approved' ? 'approved' : 'rejected', approverRole: 'client', approverName: by, decidedAt: now, note },
    })
  } else {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'invoice',
        entityId: invoice.id,
        approverRole: 'client',
        approverName: by,
        decision: status === 'approved' ? 'approved' : 'rejected',
        note,
        decidedAt: now,
      },
    })
  }

  await notify(
    projectId,
    'invoice.decided',
    `Invoice ${status}: ${invoice.invoiceCode}`,
    `${kes(invoice.total)} ${status} by ${by}${note ? ` — “${note}”` : ''}.`,
    'contractor',
    null,
  )
  return { id: invoice.id, status }
}

/** `invoice.threeWayCheck` { id } → read-only PO ↔ invoice ↔ delivery report. */
export async function threeWayCheck(projectId: string, payload: Record<string, unknown>): Promise<ThreeWayReport & { invoiceCode: string }> {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  // NOTE: InvoiceLine/PurchaseOrderLine carry no timestamp column, so lines
  // load in default (insertion) order — the match is name-first and only falls
  // back to positional matching, so order sensitivity is minimal.
  const invoiceLines = await db.invoiceLine.findMany({ where: { invoiceId: invoice.id } })

  let order: Awaited<ReturnType<typeof loadOrderForMatch>> = null
  if (invoice.orderId) order = await loadOrderForMatch(invoice.orderId)

  // 2-way fallback: project-wide delivery records grouped by material name
  const projectDeliveries: { name: string; qtyReceived: number }[] = []
  if (!order) {
    const rows = await db.orderDeliveryLine.findMany({
      where: { delivery: { order: { projectId } } },
      include: { orderLine: { select: { name: true } } },
    })
    for (const r of rows) {
      const found = projectDeliveries.find((d) => d.name === r.orderLine.name)
      if (found) found.qtyReceived += r.qtyReceived
      else projectDeliveries.push({ name: r.orderLine.name, qtyReceived: r.qtyReceived })
    }
  }

  const report = matchThreeWay({
    invoiceLines: invoiceLines.map((l) => ({
      name: l.name,
      qty: l.qty,
      unitPrice: centsToKes(l.unitPrice),
      lineTotal: centsToKes(l.lineTotal),
    })),
    order,
    projectDeliveries,
  })
  return { ...report, invoiceCode: invoice.invoiceCode }
}

async function loadOrderForMatch(orderId: string) {
  const order = await db.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      lines: true, // default (insertion) order — see the note in threeWayCheck
      deliveries: { orderBy: { createdAt: 'desc' }, include: { lines: true } },
    },
  })
  if (!order) return null
  return {
    orderCode: order.orderCode,
    deliveryFee: centsToKes(order.deliveryFee),
    lines: order.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty })),
    deliveries: order.deliveries.map((d) => ({
      createdAt: d.createdAt,
      lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
    })),
  }
}

/**
 * `invoice.pay` { id, method, reference?, costCode?, phaseId?, acknowledgeMismatch?, by? } — CLIENT/FINANCE only,
 * APPROVED only. Writes exactly ONE Transaction ledger row (costCode + ledgerTxnId);
 * the posting goes through the PaymentProvider seam (spec §40 — simulated rail,
 * clearly labelled) and the double-entry ledger inside ONE db.$transaction with
 * the escrow balance re-checked inside it (F2). The 3-way check runs internally
 * and mismatched payments need the payer's explicit acknowledgeMismatch — the
 * human decision, recorded in the trail.
 *
 * Phase cost-code (issue #39): an OPTIONAL payload phaseId attributes the
 * payment to one of the project's phases — the payer's real attribution at
 * pay time, validated in-project BEFORE the provider is touched (foreign
 * phase → honest 400-style error, money never moves). Absent → null: the
 * reports module's documented estimate keeps handling the row.
 */
export async function payInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  const method = String(payload.method ?? '').toLowerCase()
  if (!['mpesa', 'bank', 'card', 'wallet', 'cash'].includes(method)) {
    throw new Error("method must be one of mpesa, bank, card, wallet, cash")
  }
  if (invoice.status !== 'approved') {
    // approvals-before-payment is a server-side money rule, not a UI nicety
    throw new Error(`Invoice must be APPROVED before payment — ${invoice.invoiceCode} is ${invoice.status.toUpperCase()}`)
  }

  const sessionName = await requireClientRole(projectId, 'release invoice payments')
  const project = await db.project.findUnique({ where: { id: projectId } })
  const actor = await currentActor()
  const by = typeof payload.by === 'string' && payload.by.trim()
    ? payload.by.trim()
    : sessionName !== 'client' ? sessionName : project?.client ?? 'Client'
  const paidByRole = actor.role === 'finance' ? 'finance' : 'client'
  const costCode =
    typeof payload.costCode === 'string' && payload.costCode.trim()
      ? payload.costCode.trim()
      : 'invoice'

  // Phase cost-code (issue #39): the payer may attribute the payment to a
  // phase of THIS project — validated fail-closed before the provider or the
  // ledger is touched (a foreign phase never receives money attribution).
  // Absent → null → the report's documented estimate fallback.
  const phaseIdCandidate =
    typeof payload.phaseId === 'string' && payload.phaseId.trim() ? payload.phaseId.trim() : null
  const phaseId = await resolvePostingPhaseId(db, projectId, phaseIdCandidate)

  // ---- 3-way match gate: warn, human decides ----
  const report = await threeWayCheck(projectId, { id: invoice.id })
  if (report.mismatches.length > 0 && payload.acknowledgeMismatch !== true) {
    throw new Error(
      `3-way match shows ${report.mismatches.length} open item(s) on ${invoice.invoiceCode} (first: ${report.mismatches[0].issue}). ` +
        'Review them with the supplier and confirm with acknowledgeMismatch to record the payment anyway — the human decides.',
    )
  }

  // MD-4 (#350): the auto reference is minted by the shared CSPRNG seam
  // (src/shared/ids.ts) — never Math.random (was predictable).
  const reference =
    typeof payload.reference === 'string' && payload.reference.trim()
      ? payload.reference.trim()
      : autoPaymentReference(method)

  // ---- PaymentProvider seam (spec §40) — the simulated rail records an ----
  // honest result; a real provider plugs in here without touching the ledger.
  const supplierNamePreview = invoice.supplierId
    ? (await db.supplier.findUnique({ where: { id: invoice.supplierId } }))?.businessName ?? 'the supplier'
    : 'the supplier'
  const provider = getProvider(method)
  const initiation = await provider.initiatePayment({
    amount: centsToKes(invoice.total),
    currency: 'KES',
    method: method as 'mpesa' | 'bank' | 'card' | 'wallet' | 'cash',
    payee: supplierNamePreview,
    reference,
    description: invoice.invoiceCode,
  })
  if (initiation.status !== 'succeeded') {
    throw new Error(`Provider did not accept the payment: ${initiation.detail}`)
  }

  const now = new Date()
  const supplierName = supplierNamePreview
  const orderCode = invoice.orderId
    ? (await db.purchaseOrder.findUnique({ where: { id: invoice.orderId } }))?.orderCode ?? null
    : null

  // ---- ONE atomic money movement (F2): escrow debit (wallet) or EXPENSE debit ----
  // ---- + cash credit, Transaction row with ledgerTxnId, invoice flip        ----
  const { ledgerRef, balance } = await db.$transaction(async (tx) => {
    // Status re-checked INSIDE the transaction — no double-payment race.
    const fresh = await tx.invoice.findUnique({ where: { id: invoice.id } })
    if (!fresh || fresh.status !== 'approved') {
      throw new Error(`Invoice must be APPROVED before payment — ${invoice.invoiceCode} is ${(fresh?.status ?? 'missing').toUpperCase()}`)
    }

    const spend: { ledgerTxnId: string; ledgerRef: string; balance?: Cents } =
      method === 'wallet'
        ? await spendEscrowInTx(tx, projectId, {
            amount: fresh.total,
            description: `Invoice payment ${fresh.invoiceCode} — ${supplierName} (escrow)`,
            postedBy: by,
            postedRole: paidByRole,
            idempotencyKey: `invoice.pay:${fresh.id}`,
          })
        : await spendExternalInTx(tx, projectId, {
            amount: fresh.total,
            method,
            description: `Invoice payment ${fresh.invoiceCode} — ${supplierName}`,
            postedBy: by,
            postedRole: paidByRole,
            idempotencyKey: `invoice.pay:${fresh.id}`,
          })

    // exactly ONE ledger row (append-only; never mutated/deleted here) —
    // idempotent on the ledger txn id
    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: spend.ledgerTxnId } })) ??
      (await tx.transaction.create({
        data: {
          projectId,
          type: 'invoice', // peer of money.ts 'milestone' — supplier payments ledgered at source
          amount: fresh.total,
          method,
          reference,
          costCode,
          phaseId,
          ledgerTxnId: spend.ledgerTxnId,
          note: `${fresh.invoiceCode}${orderCode ? ` (${orderCode})` : ''} paid to ${supplierName} — recorded by ${by}`,
          date: now,
        },
      }))

    await tx.invoice.update({
      where: { id: fresh.id },
      data: {
        status: 'paid',
        paidAt: now,
        paidByRole,
        paymentMethod: method,
        paymentReference: reference,
      },
    })

    const spendBalance: Cents | undefined = spend.balance
    return { ledgerRef: spend.ledgerRef, balance: spendBalance }
  })

  // The acknowledged-discrepancy decision is part of the honest trail
  if (report.mismatches.length > 0) {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'invoice',
        entityId: invoice.id,
        approverRole: paidByRole,
        approverName: by,
        decision: 'approved',
        note: `Payment recorded with ${report.mismatches.length} open 3-way item(s) — discrepancy reviewed with the supplier before paying.`,
        decidedAt: now,
      },
    })
  }

  await notify(
    projectId,
    'invoice.paid',
    `Invoice paid: ${invoice.invoiceCode}`,
    `${kes(invoice.total)} paid to ${supplierName} via ${method.toUpperCase()} (${reference}) — ledger ${ledgerRef}, recorded by ${by}.`,
    'contractor',
    null,
  )
  return { id: invoice.id, status: 'paid', reference, ledgerRef, balance: balance === undefined ? undefined : centsToKes(balance) }
}

// ---------------- A-1-lite (read-only) ----------------

/** Recompute the wallet/ledger consistency projection — never mutates values. */
export async function ledgerConsistency(projectId: string): Promise<LedgerCheck & { walletBalance: number }> {
  const [wallet, transactions, milestones, invoices] = await Promise.all([
    db.escrowWallet.findUnique({ where: { projectId } }),
    db.transaction.findMany({ where: { projectId } }),
    db.milestone.findMany({ where: { projectId }, select: { id: true, status: true } }),
    db.invoice.findMany({ where: { projectId, status: 'paid' }, select: { paymentReference: true } }),
  ])
  const check = computeLedgerConsistency({
    walletBalance: centsToKes(wallet?.balance ?? 0n),
    transactions: transactions.map((t) => ({ type: t.type, method: t.method, amount: centsToKes(t.amount), reference: t.reference })),
    releasedMilestoneIds: milestones.filter((m) => m.status === 'released').map((m) => m.id),
    paidInvoiceReferences: invoices.map((i) => i.paymentReference ?? ''),
  })
  return { ...check, walletBalance: centsToKes(wallet?.balance ?? 0n) }
}
