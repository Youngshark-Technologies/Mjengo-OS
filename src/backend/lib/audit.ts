import { AsyncLocalStorage } from 'node:async_hooks'
import { db } from '@/backend/lib/db'
import { currentRequestId, log } from '@/backend/lib/log'

export interface AuditActor {
  name: string
  role: string // contractor, foreman, client, system, ai, finance, supervisor
}

/**
 * Request context threaded into audit entries (spec §43): where the action
 * came from and what entity it touched. All fields optional — callers
 * persist what they honestly know.
 */
export interface AuditContext {
  ip?: string
  userAgent?: string
  requestId?: string
  entity?: string
  entityId?: string
  before?: unknown
  after?: unknown
}

// ---------------- request-scoped audit context (F-PLATFORM §43) ----------------

/**
 * AsyncLocalStorage holding the CURRENT request's audit context. The actions
 * route wraps applyAction in withAuditContext(...); applyAction's own
 * logAudit call (lib/mjengo.ts — untouched) then picks the context up here.
 * Correct across concurrent requests — no shared mutable module state.
 */
const auditContextStorage = new AsyncLocalStorage<AuditContext>()

/** Run `fn` with an audit context — every logAudit inside it persists it. */
export async function withAuditContext<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return auditContextStorage.run(ctx, fn)
}

/** The ambient audit context (undefined outside a withAuditContext run). */
export function getAuditContext(): AuditContext | undefined {
  return auditContextStorage.getStore()
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Guarded JSON for the snapshot columns (before/after/meta): BigInt (money
 * cents, #122) serializes as a lossless string, and ANY failure to serialize
 * degrades to "column absent" instead of throwing — DB-4's rule that the
 * audit write must never become the failure surface applies to enriched
 * payloads too (#218: decision actions now put structured facts in
 * meta/before/after, so the stringify is the one place a bad value could
 * previously cost the WHOLE row — e.g. a raw BigInt meta used to throw and
 * silently lose the event).
 */
function asJson(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))
  } catch {
    return undefined
  }
}

/** Deep-copy a value with every BigInt replaced by its string form. */
function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val)
    return out
  }
  return v
}

/** Append-only Bias-Free Ledger entry. Never throws — auditing must not break actions.
 *
 * ctx (optional, last param — backwards compatible): explicit per-call context,
 * merged over the ambient withAuditContext() store. Persists the §43 fields
 * ip/userAgent/requestId/entity/entityId/before/after when present.
 *
 * Issue #204: when NO ctx anywhere supplies a requestId, the ambient LOG
 * context's id is used — route-kit (and the wrapped non-kit routes) run
 * every request inside withRequestLogging, so audit rows and log lines
 * share the ONE request id even where the caller passes no ctx.
 */
export async function logAudit(
  projectId: string,
  kind: string,
  actor: AuditActor,
  summary: string,
  meta?: Record<string, unknown>,
  ctx?: AuditContext,
): Promise<void> {
  try {
    const ambient = auditContextStorage.getStore() ?? {}
    const merged: AuditContext = ctx ? { ...ambient, ...ctx } : ambient
    await db.auditEvent.create({
      data: {
        projectId,
        kind,
        actor: actor.name,
        role: actor.role,
        summary,
        meta: meta ? asJson(meta) : undefined,
        entity: asString(merged.entity),
        entityId: asString(merged.entityId),
        before: asJson(merged.before),
        after: asJson(merged.after),
        ip: asString(merged.ip),
        userAgent: asString(merged.userAgent),
        requestId: asString(merged.requestId) ?? currentRequestId(),
      },
    })
  } catch (e) {
    log.error('audit', 'failed to log', { kind, error: e })
  }
}

/** Human-readable one-liner for any action, for the ledger. */
export function summarizeAction(type: string, payload: any, result: any): string {
  const p = payload ?? {}
  switch (type) {
    case 'task.create': return `Added task "${p.title}"`
    case 'task.update': return `Updated task${p.progress !== undefined ? ` → ${p.progress}%` : ''}${p.status ? ` (${p.status})` : ''}`
    case 'task.delete': return `Deleted task ${p.id?.slice(-6)}`
    case 'phase.update': return `Updated phase progress${p.progressManual !== undefined ? ` → ${p.progressManual}%` : ''}`
    case 'phase.create': return `Added phase "${p.name}" (KSh ${p.budget})`
    case 'delivery.create': return `Logged delivery: ${p.quantity}× ${p.materialId ? 'material ' + p.materialId.slice(-6) : 'material'} from ${p.supplier ?? 'supplier'}`
    case 'consumption.create': return `Recorded consumption: ${p.quantity}× material ${p.materialId?.slice(-6)}`
    case 'attendance.checkin': return `Check-in ${p.toggle === 'out' ? 'out' : 'in'} recorded`
    case 'attendance.setStatus': return `Attendance marked ${p.status}`
    case 'worker.create': return `Added worker "${p.name}" (${p.role ?? 'crew'})`
    case 'worker.update': return `Updated worker ${p.id?.slice(-6)}`
    case 'wages.pay': return `Paid wages${result?.amount ? ` — KSh ${result.amount}` : ''}`
    case 'alert.ack': return `Acknowledged alert ${p.id?.slice(-6)}`
    case 'photo.apply': return `Site photo evidence attached${p.progressPct !== undefined ? ` (${p.progressPct}% phase progress)` : ''}`
    case 'project.update': return `Project details updated`
    case 'project.create': return `Project created`
    case 'expense.create': return `Expense recorded: KSh ${p.amount} (${p.type})`
    case 'transaction.delete': return `Reversed transaction ${p.id?.slice(-6)} — compensating entry posted${result?.ledgerRef ? ` (ledger ${result.ledgerRef})` : ''}`
    case 'material.create': return `Material "${p.name}" added to catalog`
    case 'share.regenerate': return `Share link regenerated`
    // Trust module
    case 'attendance.record': return `Muster roll recorded (${p.records ? JSON.parse(p.records).length : '?'} workers, ${p.verification ?? 'reported'})`
    case 'attendance.exception': return `Attendance exception logged for worker ${p.workerId?.slice(-6)} (${p.reason})`
    case 'attendance.override': return `Attendance OVERRIDE — history preserved`
    case 'payroll.approve': return `Payroll approved${result?.amount ? ` — KSh ${result.amount}` : ''}`
    // Money module
    case 'escrow.topup': return `MjengoPay top-up KSh ${p.amount}`
    case 'milestone.create': return `Milestone "${p.name}" created (KSh ${p.amount})`
    case 'milestone.evidence': return `Proof-of-work evidence attached to milestone ${p.id?.slice(-6)}`
    case 'milestone.requestRelease': return `Milestone release REQUESTED (awaiting client approval)`
    case 'milestone.decide': return `Milestone ${p.decision ?? 'decided'} by client`
    case 'variation.submit': return `Variation submitted: "${p.title}" (${p.budgetImpact >= 0 ? '+' : ''}KSh ${p.budgetImpact})`
    case 'variation.decide': return `Variation ${p.decision} by client`
    // Evidence module
    case 'comment.add': return `Photo comment by ${p.author ?? 'client'}`
    case 'comment.resolve': return `Photo comment resolved`
    case 'notification.read': return `Notification marked read`
    case 'notification.readAll': return `All notifications marked read`
    case 'zone.create': return `Site map zone "${p.name}" added`
    case 'zone.delete': return `Site map zone removed`
    // Inventory module (v3)
    case 'inventory.open': return `Opening stock recorded: ${p.qty}× ${p.materialName}`
    case 'inventory.receive': return `Stock received: ${p.qty}× ${p.materialName ?? 'item'}${p.reference ? ` (ref ${p.reference})` : ''}`
    case 'inventory.consume': return `Stock consumed: ${p.qty}× item ${p.inventoryItemId?.slice(-6)}`
    case 'inventory.transfer': return `Stock transferred: ${p.qty}× → ${p.toLocation}`
    case 'inventory.return': return `Stock returned to supplier: ${p.qty}× item ${p.inventoryItemId?.slice(-6)}`
    case 'inventory.damage': return `Damaged stock recorded: ${p.qty}× — ${p.damageNote ?? 'no note'}`
    case 'inventory.adjust': return `Stock count adjusted ${p.qty > 0 ? '+' : ''}${p.qty} — ${p.reason ?? 'correction'}`
    // Stock reconciliation (issue #194; blind REC-1 #359)
    case 'inventory.count': return `Physical stock count recorded (${p.counts?.length ?? result?.itemCount ?? '?'} lines) by ${p.countedBy ?? 'unknown'}${p.blind === true ? ' (blind)' : ''}${result?.countId ? ` — count ${result.countId.slice(-6)}` : ''}`
    case 'inventory.count.post': return `Count-linked adjustments posted (${result?.movements?.filter((m: { movementId: string | null }) => m.movementId).length ?? '?'} movements)${result?.countId ? ` — count ${result.countId.slice(-6)}` : ''}`
    case 'inventory.count.schedule': return `Stock count cadence ${result?.cleared ? 'cleared' : `set: every ${result?.intervalDays ?? '?'} day(s)`}`
    // BOQ module (v3)
    case 'boq.create': return `BOQ "${p.name}" created (${(p.lines ?? []).length} lines)`
    case 'boq.line.upsert': return `BOQ line ${p.id ? 'updated' : 'added'}: ${p.qty}× ${p.materialName}`
    case 'boq.line.delete': return `BOQ line removed (${p.id?.slice(-6)})`
    case 'boq.approve': return `BOQ approved (${p.id?.slice(-6)})`
    case 'boq.to_request': return `BOQ → material request generated (${result?.requestCode ?? ''})`
    // Supplier shortlist / quotes (v3)
    case 'supplier.save': return `Supplier saved to shortlist (${p.supplierId?.slice(-6)})`
    case 'supplier.unsave': return `Supplier removed from shortlist`
    case 'quote.update': return `Quote detail updated (${p.id?.slice(-6)})`
    // Money core (v3)
    case 'payment.request': return `Payment request created: KSh ${p.amount} to ${p.payee}`
    case 'payment.decide': return `Payment request ${p.decision ?? 'decided'}${p.note ? ` — ${p.note}` : ''}`
    case 'payment.pay': return `Payment recorded${result?.ledgerRef ? ` (ledger ${result.ledgerRef})` : ''}`
    case 'wallet.create': return `Wallet ${result?.code ?? ''} created`
    case 'wallet.deposit': return `Wallet deposit KSh ${p.amount}${result?.ledgerRef ? ` (ledger ${result.ledgerRef})` : ''}`
    case 'wallet.withdraw': return `Wallet withdrawal KSh ${p.amount}`
    case 'wallet.transfer': return `Wallet transfer KSh ${p.amount} ${result?.from ?? ''} → ${result?.to ?? ''}`
    case 'transaction.reverse': return `Transaction REVERSED — ${p.reason ?? 'correction'} (ledger ${result?.ledgerRef ?? ''})`
    case 'ledger.post': return `Manual journal posted (ledger ${result?.ref ?? ''})`
    // Intel module
    case 'risk.recompute': return `Risk score recomputed: ${result?.overallScore ?? '?'}/100 (${result?.findingsCount ?? 0} findings, rules v${String(result?.ruleVersion ?? '1').replace(/^v/, '')})`
    case 'score.recompute': return result?.score === null || result?.score === undefined
      ? `MjengoScore recomputed — no score yet (only ${result?.componentsCount ?? 0} of 6 components have data; describes, humans decide)`
      : `MjengoScore recomputed: ${result.score}/100 (confidence ${result?.confidence ?? 'low'} · ${result?.componentsCount ?? '?'} of 6 components · describes, humans decide)`
    // AI module (W6-1) — advisory only, humans decide
    case 'ai.drawReview': return `AI draw review appended: verdict ${result?.verdict ?? 'advisory'} (confidence ${result?.confidence ?? 'low'} · ${result?.findingsCount ?? 0} finding(s) · advisory only, humans decide)`
    // AI module (W6-2) — deterministic text + TTS voice note, humans decide
    case 'ai.trustDigest': return `Trust digest appended (${result?.lang ?? 'en'}): ${result?.textHash?.slice(0, 12) ?? '?'} (audio ${result?.audioStatus ?? 'unavailable'} · every number is a ledger row · AI reads it aloud, it never decides)`
    default: return `Action: ${type}`
  }
}

export function kindForAction(type: string): string {
  // W6-2: the trust-digest action lands under its own kind ('ai_digest' —
  // the wave6-plan's audit kind) while the rest of the ai.* family keeps
  // the W6-1 'ai_review' kind (unchanged history semantics).
  if (type === 'ai.trustDigest') return 'ai_digest'
  const prefix = type.split('.')[0]
  const map: Record<string, string> = {
    task: 'task', phase: 'phase', delivery: 'delivery', consumption: 'material',
    attendance: 'attendance', worker: 'worker', wages: 'wage', alert: 'alert',
    photo: 'photo', project: 'project', expense: 'expense', transaction: 'transaction',
    material: 'material', share: 'share', escrow: 'escrow', milestone: 'milestone',
    variation: 'variation', comment: 'comment', notification: 'notification', zone: 'site_map',
    payroll: 'wage',
    inventory: 'inventory', boq: 'boq', payment: 'payment', wallet: 'wallet', ledger: 'ledger',
    score: 'mjengo_score', // MjengoScore recomputes (risk/digest/price/reliability stay 'action' — unchanged history semantics)
    ai: 'ai_review', // W6-1: AI draw review appends (advisory notes — the kind the audit filter list exposes)
  }
  return map[prefix] ?? 'action'
}

// ---------------- decision-action audit enrichment (issue #218) ----------------

/**
 * House bound for a free-text note riding an audit row — the v1 `noteText`
 * contract (api/v1/schemas.ts, ≤ 500). The decision actions accept an
 * unbounded `note` payload field, so the enrichment truncates defensively:
 * ids and refs only is the size policy, and a note is the one human text
 * that can be arbitrarily long.
 */
const AUDIT_NOTE_MAX = 500

/**
 * The reserved `__audit` result key a decision-action handler may return:
 * the raw facts ONLY (pre-read state, entity ids, handler-known fields) —
 * applyAction's logAudit call is the single writer and auditEnrichmentFor
 * (below) is the single shaper. The `__` prefix mirrors the __actor/__role
 * payload convention: applyAction STRIPS the key before the result leaves,
 * so no route response, outbox row or idempotency record ever sees it.
 *
 * entity is the Prisma MODEL name, PascalCase — the DrawPack/v1-payments
 * convention (entity: 'DrawPack' / 'PaymentRequest' / 'WalletAccount'), not
 * the lowercase audit kind.
 */
export interface ActionAuditFacts {
  entity: string
  entityId: string
  /** State as it stood when the decision was made (frozen into the row). */
  before?: Record<string, unknown>
  /** The post-decision projection (status transition). */
  after?: Record<string, unknown>
  /** Handler-known fields the dispatcher cannot derive from payload/result. */
  meta?: Record<string, unknown>
}

/** What auditEnrichmentFor hands applyAction: the merged meta + the ctx. */
export interface ActionAuditEnrichment {
  meta: Record<string, unknown>
  ctx: AuditContext
}

/**
 * Build the decision-scoped audit enrichment for an action result (issue
 * #218). Reads the handler's `__audit` facts off the result, merges the
 * payload's decision/note and (for milestone approve) the money refs that
 * already ride the result, and returns the meta + ctx logAudit needs.
 * Returns null for every action that did not carry facts — the historic
 * `{ type }`-only meta and the ambient request ctx stay exactly as they
 * were for all of them.
 *
 * Money values are normalized to STRINGS of integer cents (BigInt →
 * "80000000"): lossless, unambiguous, and safe for JSON persistence. The
 * note is truncated to AUDIT_NOTE_MAX. Evidence refs are ids ONLY — never
 * binaries or URLs (PII/size policy).
 */
export function auditEnrichmentFor(
  type: string,
  payload: any,
  result: any,
): ActionAuditEnrichment | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const raw = (result as { __audit?: unknown }).__audit
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const facts = raw as Partial<ActionAuditFacts>
  if (typeof facts.entity !== 'string' || !facts.entity || typeof facts.entityId !== 'string' || !facts.entityId) {
    return null
  }
  const p = payload ?? {}
  // The decision appliers have already validated decision ∈ approve/reject
  // by the time the audit line runs (they throw otherwise); the typeof
  // guards here keep the helper total for any future caller.
  const decision = typeof p.decision === 'string' ? p.decision : undefined
  const trimmedNote = typeof p.note === 'string' ? p.note.trim() : ''
  const note = trimmedNote
    ? trimmedNote.length > AUDIT_NOTE_MAX
      ? `${trimmedNote.slice(0, AUDIT_NOTE_MAX)}…`
      : trimmedNote
    : undefined
  const base: Record<string, unknown> = { type }
  if (decision) base.decision = decision
  if (note) base.note = note
  const extra = facts.meta && typeof facts.meta === 'object' ? facts.meta : {}

  let meta: Record<string, unknown>
  switch (type) {
    case 'milestone.decide': {
      meta = { ...base, milestoneId: facts.entityId, ...extra }
      if (decision === 'approve') {
        // The money refs ride the approve result already; reject moves none
        // (drawPackId null = the pack write failed, audited separately as
        // draw_pack.create_failed — honest, never fabricated).
        const r = result as { ledgerRef?: unknown; drawPackId?: unknown }
        meta.ledgerRef = r.ledgerRef
        meta.drawPackId = r.drawPackId ?? null
      }
      break
    }
    case 'variation.decide':
      meta = { ...base, variationId: facts.entityId, ...extra }
      break
    case 'payment.decide':
      meta = { ...base, paymentRequestId: facts.entityId, ...extra }
      break
    default:
      return null
  }
  return {
    meta: jsonSafe(meta) as Record<string, unknown>,
    ctx: {
      entity: facts.entity,
      entityId: facts.entityId,
      ...(facts.before ? { before: jsonSafe(facts.before) } : {}),
      ...(facts.after ? { after: jsonSafe(facts.after) } : {}),
    },
  }
}
