// ACTION SCHEMA REGISTRY (issue #161 / audit API-10) — the machine-readable
// request contract for POST /api/actions, POST /api/sync and POST /api/share.
//
// Before this file, the single largest mutation surface in the system shipped
// `payload?: any` at the route: the 1 MB body cap and the `type` check were
// the only pre-dispatch validation, and the per-action payload shapes lived
// only in applier code and prose. This registry is the one place a payload
// shape is declared, keyed by ActionType, exhaustive BY COMPILATION:
//
//   ACTION_PAYLOAD_SCHEMAS satisfies Record<ActionType, z.ZodType>
//
// — adding an action type without a registry entry fails `tsc` (and the
// runtime matrix test in tests/unit/action-schemas.test.ts fails CI the
// same way, so a stray/renamed key is caught twice).
//
// ENFORCEMENT (one choke point): applyAction (src/backend/lib/mjengo.ts)
// validates the CLEAN payload (after the server-side __actor/__role/
// __supplierId strip, before any DB read or role gate) via parseActionPayload
// below. Every entry path inherits it — /api/actions, /api/sync outbox
// items, /api/share links, the USSD/WhatsApp gateways and /api/ai routes all
// dispatch through applyAction. The /api/actions route additionally renders
// the failure as the house validation 400 ({ error, field? } — the same
// zodIssueResponse contract the v1 family and /api/share already use).
//
// STRICT vs DOCUMENTED — the rollout decision (the issue's own incremental
// scope): the money-relevant families are STRICT zod schemas (unknown fields
// rejected, silently-coerced fields now refused honestly); everything else
// is an explicitly-marked DOCUMENTED entry — a loose object that accepts the
// applier's own validation as the contract, with the payload shape recorded
// here as a comment so the registry is the catalog even where it does not
// yet gate. Growing an entry from documented to strict is a one-line change
// (plus tests) — the seam already exists.
//
//   strict today:  MONEY_ACTIONS (7) + WALLET_ACTIONS (9) = 16 types
//   documented:    the other 109 types (core 30 + trust 4 + evidence 7 +
//                  land 7 + professionals 6 + supply 24 + invoice 6 +
//                  intel 5 + inventory 18 + ai 2)
//
// HONEST BOUNDS POLICY: the strict schemas must never be narrower than what
// the appliers accept (no false rejections — existing flows stay green);
// they MAY refuse what the appliers used to swallow (unknown fields, or
// values silently coerced — e.g. a non-`mpesa|bank|card` escrow method used
// to become 'mpesa' silently; it is a 400 now). Text ceilings are generous
// garbage guards, not policy: the appliers impose none and the 1 MB body cap
// still bounds everything. `amount` reuses parseMoneyCents — the SAME
// validator every applier runs — so schema and applier can never drift.
//
// RESERVED KEYS: __actor / __role / __supplierId are stamped SERVER-side by
// the entry routes and stripped before validation; `confirm: true` is the
// issue #172 / SEC-3r share-link decision flag; `projectId` rides the
// payload when the caller does not put it in the body envelope.

import { z, type ZodIssue } from 'zod'
import type { ActionType } from '@/backend/lib/mjengo'
import { parseMoneyCents, parseSignedMoneyCents } from '@/backend/lib/money'
import { MONEY_AMOUNT_ERROR } from '@/backend/lib/money-bounds'

// ---------------------------------------------------------------- primitives

/**
 * Money in KSh for strict money actions: number OR numeric string
 * ("65000.50" — the appliers accept both), refined by parseMoneyCents —
 * positive, finite, ≤ MAX_MONEY_KES, at most 2 decimal places. Sharing the
 * appliers' own parser is the point: the registry cannot drift from the
 * money stack. The message is the shared MONEY_AMOUNT_ERROR so callers and
 * tests see the one honest refusal either way.
 */
const moneyKes = z
  .union([z.number(), z.string()], { error: MONEY_AMOUNT_ERROR })
  .refine((v) => parseMoneyCents(v) !== null, { message: MONEY_AMOUNT_ERROR })

/** The variation.submit budgetImpact contract: signed, NON-ZERO, ≤ 2 dp. */
const BUDGET_IMPACT_ERROR =
  'Budget impact must be a non-zero amount (positive for extra cost, negative for saving) with at most 2 decimal places'

const signedNonZeroKes = z
  .union([z.number(), z.string()], { error: BUDGET_IMPACT_ERROR })
  .refine((v) => {
    const cents = parseSignedMoneyCents(v)
    return cents !== null && cents !== 0n
  }, { message: BUDGET_IMPACT_ERROR })

/** Row/entity id: an opaque string resolved against the DB by the applier. */
const idRef = z
  .string('must be a string')
  .min(1, 'must not be empty')
  .max(64, 'must be at most 64 characters')

/** Payload-level project scoping (resolveProjectId's third fallback). */
const projectIdRef = z
  .string('projectId must be a string')
  .min(1, 'projectId must not be empty')
  .max(40, 'projectId must be at most 40 characters')

/** The client-decision enum (milestone/variation/payment decisions). */
const decisionEnum = z.enum(['approve', 'reject'], { error: "decision must be 'approve' or 'reject'" })

/** Free-text note (the audit trail truncates at the house 500-char bound). */
const noteText = z.string('note must be a string').max(2000, 'note must be at most 2000 characters')

/** Payment rail. The provider registry + Transaction.method CHECK know these. */
const methodEnum = z.enum(['mpesa', 'bank', 'card', 'cash', 'wallet'], {
  error: 'method must be one of mpesa, bank, card, cash, wallet',
})

/** Sessionless-caller actor fallback (requireMoneyActor's payloadBy path). */
const actorName = z.string('must be a string').min(1, 'must not be empty').max(120, 'must be at most 120 characters')

/** Caller-supplied ledger idempotency key (natural-key replays, BE-3). */
const idemKeyText = z
  .string('idempotencyKey must be a string')
  .min(1, 'idempotencyKey must not be empty')
  .max(200, 'idempotencyKey must be at most 200 characters')

/**
 * The DOCUMENTED (not-yet-strict) entry: a loose object that accepts the
 * applier's own validation as the contract. Every one of these is explicitly
 * marked below with its payload shape; tightening one is a one-line change.
 */
const documentedPayload = z.looseObject({})

// ------------------------------------------------- strict: money + wallet (16)
//
// MONEY_ACTIONS (src/backend/actions/money.ts) + WALLET_ACTIONS
// (src/backend/actions/wallet.ts → modules/wallet/service.ts) — the
// money-relevant families the issue names first.

const escrowTopupPayload = z.strictObject({
  amount: moneyKes,
  // The applier used to silently default any other method to 'mpesa';
  // anything outside the rails it actually posts is a 400 now.
  method: z.enum(['mpesa', 'bank', 'card'], { error: 'method must be one of mpesa, bank, card' }).optional(),
  reference: z.string('reference must be a string').max(200, 'reference must be at most 200 characters').optional(),
  by: actorName.optional(),
  projectId: projectIdRef.optional(),
})

const milestoneCreatePayload = z.strictObject({
  name: z.string('name must be a string').min(1, 'name must not be empty').max(200, 'name must be at most 200 characters'),
  amount: moneyKes,
  phaseId: idRef.optional(),
  projectId: projectIdRef.optional(),
})

const milestoneEvidencePayload = z.strictObject({
  id: idRef,
  photoIds: z.array(idRef, { error: 'photoIds must be an array of photo ids' }).min(1, 'Select at least one photo as evidence'),
  projectId: projectIdRef.optional(),
})

const milestoneRequestReleasePayload = z.strictObject({
  id: idRef,
  projectId: projectIdRef.optional(),
})

/** Shared decide shape: milestone.decide / variation.decide / payment.decide. */
const decidePayload = z.strictObject({
  id: idRef,
  decision: decisionEnum,
  note: noteText.optional(),
  by: actorName.optional(),
  // #172 / SEC-3r: the explicit share-link confirmation flag. Strictly true
  // when present — the share gate demands === true; session paths ignore it.
  confirm: z.literal(true, { error: 'confirm must be true — the explicit decision-dialog confirmation flag' }).optional(),
  projectId: projectIdRef.optional(),
})

const variationSubmitPayload = z.strictObject({
  title: z.string('title must be a string').min(1, 'title must not be empty').max(200, 'title must be at most 200 characters'),
  description: z
    .string('description must be a string')
    .min(1, 'description must not be empty')
    .max(2000, 'description must be at most 2000 characters'),
  budgetImpact: signedNonZeroKes,
  phaseId: idRef.optional(),
  submittedBy: actorName.optional(),
  projectId: projectIdRef.optional(),
})

const paymentRequestPayload = z.strictObject({
  description: z
    .string('description must be a string')
    .min(1, 'description must not be empty')
    .max(500, 'description must be at most 500 characters'),
  amount: moneyKes,
  payee: z.string('payee must be a string').min(1, 'payee must not be empty').max(120, 'payee must be at most 120 characters'),
  method: methodEnum.optional(),
  relatedEntityType: z
    .string('relatedEntityType must be a string')
    .max(40, 'relatedEntityType must be at most 40 characters')
    .optional(),
  relatedEntityId: idRef.optional(),
  requestedByName: actorName.optional(),
  requestedByRole: z
    .string('requestedByRole must be a string')
    .max(40, 'requestedByRole must be at most 40 characters')
    .optional(),
  projectId: projectIdRef.optional(),
})

const paymentPayPayload = z.strictObject({
  id: idRef,
  method: methodEnum.optional(),
  reference: z.string('reference must be a string').max(200, 'reference must be at most 200 characters').optional(),
  costCode: z.string('costCode must be a string').max(60, 'costCode must be at most 60 characters').optional(),
  paidBy: actorName.optional(),
  paidByRole: z.string('paidByRole must be a string').max(40, 'paidByRole must be at most 40 characters').optional(),
  projectId: projectIdRef.optional(),
})

const walletCreatePayload = z.strictObject({
  label: z.string('label must be a string').max(120, 'label must be at most 120 characters').optional(),
  ownerType: z.enum(['project', 'organization', 'supplier', 'user'], {
    error: 'ownerType must be one of project, organization, supplier, user',
  }).optional(),
  ownerId: idRef.optional(),
  projectId: projectIdRef.optional(),
})

const walletDepositPayload = z.strictObject({
  walletId: idRef.optional(),
  code: idRef.optional(),
  amount: moneyKes,
  reference: z.string('reference must be a string').max(200, 'reference must be at most 200 characters').optional(),
  source: methodEnum.optional(),
  by: actorName.optional(),
  idempotencyKey: idemKeyText.optional(),
  projectId: projectIdRef.optional(),
})

const walletWithdrawPayload = z.strictObject({
  walletId: idRef,
  amount: moneyKes,
  note: noteText.optional(),
  destination: methodEnum.optional(),
  by: actorName.optional(),
  idempotencyKey: idemKeyText.optional(),
  projectId: projectIdRef.optional(),
})

const walletTransferPayload = z.strictObject({
  fromWalletId: idRef,
  toWalletId: idRef,
  amount: moneyKes,
  note: noteText.optional(),
  by: actorName.optional(),
  idempotencyKey: idemKeyText.optional(),
  projectId: projectIdRef.optional(),
})

const transactionReversePayload = z.strictObject({
  id: idRef,
  reason: noteText.optional(),
  method: methodEnum.optional(),
  by: actorName.optional(),
  projectId: projectIdRef.optional(),
})

const ledgerPostPayload = z.strictObject({
  description: z
    .string('description must be a string')
    .max(2000, 'description must be at most 2000 characters')
    .optional(),
  lines: z
    .array(
      z.strictObject({
        accountCode: z
          .string('lines.accountCode must be a string')
          .min(1, 'lines.accountCode must not be empty')
          .max(60, 'lines.accountCode must be at most 60 characters'),
        side: z.enum(['debit', 'credit'], { error: "lines.side must be 'debit' or 'credit'" }),
        amount: moneyKes,
        memo: z.string('lines.memo must be a string').max(500, 'lines.memo must be at most 500 characters').optional(),
      }),
      { error: 'lines must be an array of { accountCode, side, amount }' },
    )
    .min(1, 'Ledger transaction needs at least one line'),
  by: actorName.optional(),
  role: z.string('role must be a string').max(40, 'role must be at most 40 characters').optional(),
  idempotencyKey: idemKeyText.optional(),
  projectId: projectIdRef.optional(),
})

// ---------------------------------------------------------------- the registry
//
// EVERY ActionType has an entry (satisfies Record<ActionType, z.ZodType> —
// a new type without a row fails compilation). Documented entries carry
// their payload shape as the comment; strict entries reference the schemas
// above. Family groupings mirror the dispatcher's own.

export const ACTION_PAYLOAD_SCHEMAS = {
  // ---- core (applyCoreAction, src/backend/lib/mjengo.ts) — documented ----
  'task.create': documentedPayload, // { phaseId, title, priority?, assignedToId?, dueDate?, blockedById? }
  'task.update': documentedPayload, // { id, title?, status?, progress?, priority?, dueDate?, assignedToId?, blockedById?, baseVersion? }
  'task.delete': documentedPayload, // { id }
  'task.assign': documentedPayload, // { id, assignedToId | null }
  'task.block': documentedPayload, // { id, reason?, blockedById? }
  'task.unblock': documentedPayload, // { id }
  'task.complete': documentedPayload, // { id }
  'task.verify': documentedPayload, // { id }
  'phase.update': documentedPayload, // { id, status?, progressManual? }
  'phase.create': documentedPayload, // { name, budget (number ≥ 0, KSh), order? }
  'delivery.create': documentedPayload, // { materialId, quantity, unitCost?, supplier?, source?, rawTranscript?, date? }
  'delivery.assign': documentedPayload, // { deliveryId, driverName?, driverPhone?, vehicleReg? } — §26 driver leg
  'delivery.transit': documentedPayload, // { deliveryId, etaAt } — §26 driver leg
  'delivery.arrive': documentedPayload, // { deliveryId, gpsLat?, gpsLng? } — §26 driver leg
  'team.add': documentedPayload, // { name, role, phone?, email?, note? } — §33 roster
  'team.update': documentedPayload, // { id, name?, role?, phone?, email?, note? }
  'team.remove': documentedPayload, // { id }
  'consumption.create': documentedPayload, // { materialId, quantity, phaseName?, note? }
  'attendance.checkin': documentedPayload, // { workerId, toggle: 'in'|'out', baseVersion? } — method stamped 'ussd' by the gateway
  'attendance.setStatus': documentedPayload, // { workerId, status: present|absent|half_day, baseVersion? }
  'worker.create': documentedPayload, // { name, role?, phone?, dailyRate?, pin?, idNumber?, employmentType?, skills?, emergencyContactName?, emergencyContactPhone? }
  'worker.update': documentedPayload, // { id, name?, role?, phone?, dailyRate?, active?, pin?, … §14 optional fields }
  'wages.pay': documentedPayload, // { date, workerIds?, force? } — payroll gate refuses unreviewed exceptions unless forced
  'expense.create': documentedPayload, // { type: material|wage|other|transport, amount, method?, note?, reference?, date?, costCode? }
  'transaction.delete': documentedPayload, // { id } — name kept for UI compat; ALWAYS a compensating reversal (history immutable)
  'material.create': documentedPayload, // { name, unit, unitPrice, reorderLevel? }
  'project.update': documentedPayload, // { id, name?, client?, clientType?, location?, budget?, startDate?, targetDate?, status? }
  'share.regenerate': documentedPayload, // {} — rotates the client share link + expiry
  'alert.ack': documentedPayload, // { id }
  'photo.apply': documentedPayload, // { photoId, phaseId?, caption? } — AI-analysis write-back

  // ---- trust (actions/trust.ts) — documented ----
  'attendance.record': documentedPayload, // { records: [{workerId,status,baseVersion?}] | JSON string, verification?, recordedBy? }
  'attendance.exception': documentedPayload, // { workerId, date?, reason, note?, evidence?, baseVersion? }
  'attendance.override': documentedPayload, // { id, to, reason, by, baseVersion? } — append-only overrideLog
  'payroll.approve': documentedPayload, // { date, force? } — gated like wages.pay

  // ---- money (actions/money.ts) — STRICT ----
  'escrow.topup': escrowTopupPayload, // { amount, method?, reference?, by?, projectId? }
  'milestone.create': milestoneCreatePayload, // { name, amount, phaseId?, projectId? }
  'milestone.evidence': milestoneEvidencePayload, // { id, photoIds: string[], projectId? }
  'milestone.requestRelease': milestoneRequestReleasePayload, // { id, projectId? }
  'milestone.decide': decidePayload, // { id, decision, note?, by?, confirm?, projectId? } — CLIENT-only
  'variation.submit': variationSubmitPayload, // { title, description, budgetImpact, phaseId?, submittedBy?, projectId? }
  'variation.decide': decidePayload, // { id, decision, note?, by?, confirm?, projectId? } — CLIENT-only

  // ---- evidence (actions/evidence.ts) — documented ----
  'comment.add': documentedPayload, // { photoId, author, role: client|contractor|foreman, message }
  'comment.resolve': documentedPayload, // { id }
  'zone.create': documentedPayload, // { name, x, y, w?, h? } — percent coords 0-100
  'zone.delete': documentedPayload, // { id }
  'notification.read': documentedPayload, // { id }
  'notification.readAll': documentedPayload, // {}
  'photo.zone': documentedPayload, // { id, zoneId | null }

  // ---- land (actions/land.ts) — documented ----
  'parcel.create': documentedPayload, // { plotNumber, county, town?, lat?, lng?, approxArea?, tenureType? }
  'parcel.update': documentedPayload, // { id, town?, approxArea?, tenureType?, notes?… }
  'parcel.setStatus': documentedPayload, // { id, status: searching|verified|flagged, note? }
  'parcelDoc.attach': documentedPayload, // { parcelId, kind: title_deed|search_cert|survey_map|other, fileName, storageKey, extractedText?, issuedOn? }
  'search.request': documentedPayload, // { parcelId, searchRef? }
  'search.receive': documentedPayload, // { id, resultSummary }
  'search.review': documentedPayload, // { id, decision: accept|flag, note? }

  // ---- professionals (actions/professionals.ts) — documented ----
  'professional.upsert': documentedPayload, // { id?, name, category, organisation?, phone?, email?, county?, licenceNumber?, licenceBody?, notes? }
  'professional.update': documentedPayload, // { id, …fields, verificationState? }
  'credential.record': documentedPayload, // { professionalId, method: document_review|reference_call|registry_lookup, finding, checkedBy? }
  'assignment.create': documentedPayload, // { parcelId, professionalId, role: surveyor|advocate|engineer|qty_surveyor, note? }
  'assignment.update': documentedPayload, // { id, status: invited|active|done }
  'assignment.remove': documentedPayload, // { id }

  // ---- supply (actions/supply.ts) — documented ----
  'supplier.upsert': documentedPayload, // { id?, businessName, county, town?, phone?, email?, deliveryFeeBase?, … }
  'catalog.upsert': documentedPayload, // { supplierId, id?, name, unit, unitPrice, stockQty?, minOrderQty? }
  'request.create': documentedPayload, // { lines: [{ materialName, unit, qty }], notes? }
  'request.update': documentedPayload, // { id, lines?, notes? } — edit while DRAFT
  'request.submit': documentedPayload, // { id }
  'request.decide': documentedPayload, // { id, decision: approve|reject, note? } — band-checked approval engine
  'request.cancel': documentedPayload, // { id, reason } — PENDING approvals settle withdrawn (#206)
  'quote.request': documentedPayload, // { requestId, supplierIds: string[] }
  'quote.receive': documentedPayload, // { id, unitPrice, deliveryFee?, transportFee?, fees?, deliveryEta?, stockOk?, validUntil?, terms?, lines?: [{ unitPrice }] }
  'quote.decline': documentedPayload, // { id, reason? }
  'order.create': documentedPayload, // { requestId, supplierId, quoteId?, paymentSource?, note? }
  'order.update': documentedPayload, // { id, note? }
  'order.approve': documentedPayload, // { id, note? }
  'order.send': documentedPayload, // { id }
  'order.confirm': documentedPayload, // { id, note? }
  'order.dispatch': documentedPayload, // { orderId }
  'order.cancel': documentedPayload, // { id, reason } — in-flight dispatch voided in-tx (#206)
  'order.close': documentedPayload, // { id, note? }
  'delivery.receive': documentedPayload, // { deliveryId, lines: [{ orderLineId, qtyReceived, qtyRejected?, damageNote?, condition?, photoIds? }], note?, photoIds?, gpsLat?, gpsLng? }
  'delivery.dispatch': documentedPayload, // { deliveryId, note? }
  'delivery.void': documentedPayload, // { deliveryId, reason }
  'rule.upsert': documentedPayload, // { id?, minAmount, maxAmount?, approverRole, priority?, active? }
  'rule.delete': documentedPayload, // { id }
  'supply.compare': documentedPayload, // { materialName, qty, radiusKm?, deliveryDay? } — read-side ranking

  // ---- invoices (actions/invoices.ts) — documented ----
  'invoice.create': documentedPayload, // { orderId?, supplierId?, lines: [{ name, qty, unitPrice }], tax?, dueDate?, note? }
  'invoice.update': documentedPayload, // { id, lines?, tax?, dueDate?, note? } · { id, status: 'disputed', note }
  'invoice.submit': documentedPayload, // { id }
  'invoice.decide': documentedPayload, // { id, decision: approve|reject, by?, note? }
  'invoice.pay': documentedPayload, // { id, method?, reference?, costCode?, phaseId?, acknowledgeMismatch?, by? }
  'invoice.threeWayCheck': documentedPayload, // { id }

  // ---- intel (actions/intel.ts) — documented ----
  'risk.recompute': documentedPayload, // {}
  'score.recompute': documentedPayload, // {}
  'digest.generate': documentedPayload, // { weekStart? }
  'price.record': documentedPayload, // { materialName, region, unitPrice }
  'reliability.recompute': documentedPayload, // { supplierId? } — omit = all

  // ---- inventory (actions/inventory.ts) — documented ----
  'inventory.open': documentedPayload, // { materialName, unit, qty, unitCost?, location?, supplierId?, reorderLevel? }
  'inventory.receive': documentedPayload, // { inventoryItemId | materialName+unit+location, qty, unitCost?, reference?, note?, reorderLevel? }
  'inventory.consume': documentedPayload, // { inventoryItemId, qty, reference?, note?, requestLineId? } — requestLineId (#203): optional structured consumption attribution (source request line)
  'inventory.transfer': documentedPayload, // { inventoryItemId, qty, toLocation, note? }
  'inventory.return': documentedPayload, // { inventoryItemId, qty, note? }
  'inventory.damage': documentedPayload, // { inventoryItemId, qty, damageNote }
  'inventory.adjust': documentedPayload, // { inventoryItemId, qty, reason } — ± count correction
  'inventory.count': documentedPayload, // { countedBy, countedAt?, note?, blind?, counts: [{ inventoryItemId, countedQty }] } (#194; blind REC-1 #359)
  'inventory.count.post': documentedPayload, // { countId, postedBy? }
  'inventory.count.schedule': documentedPayload, // { intervalDays: number | null } — set/clear the recurring count cadence (REC-1 #359)
  'boq.create': documentedPayload, // { name, lines?: [{ materialName, unit?, qty?, estUnitPrice?, category?, note? }] }
  'boq.line.upsert': documentedPayload, // { boqId, id?, materialName, unit, qty, estUnitPrice?, category?, note? }
  'boq.line.delete': documentedPayload, // { id }
  'boq.approve': documentedPayload, // { id }
  'boq.to_request': documentedPayload, // { id, lineIds? }
  'supplier.save': documentedPayload, // { supplierId, note? }
  'supplier.unsave': documentedPayload, // { supplierId }
  'quote.update': documentedPayload, // { id, validUntil?, terms?, lines? }

  // ---- wallet (actions/wallet.ts) — STRICT ----
  'payment.request': paymentRequestPayload, // { description, amount, payee, method?, relatedEntityType?, relatedEntityId?, requestedByName?, requestedByRole?, projectId? }
  'payment.decide': decidePayload, // { id, decision, note?, by?, projectId? } — client/finance queue
  'payment.pay': paymentPayPayload, // { id, method?, reference?, costCode?, paidBy?, paidByRole?, projectId? }
  'wallet.create': walletCreatePayload, // { label?, ownerType?, ownerId?, projectId? }
  'wallet.deposit': walletDepositPayload, // { walletId | code, amount, reference?, source?, by?, idempotencyKey?, projectId? }
  'wallet.withdraw': walletWithdrawPayload, // { walletId, amount, note?, destination?, by?, idempotencyKey?, projectId? }
  'wallet.transfer': walletTransferPayload, // { fromWalletId, toWalletId, amount, note?, by?, idempotencyKey?, projectId? }
  'transaction.reverse': transactionReversePayload, // { id, reason?, method?, by?, projectId? }
  'ledger.post': ledgerPostPayload, // { description?, lines: [{ accountCode, side, amount, memo? }], by?, role?, idempotencyKey?, projectId? }

  // ---- ai (actions/ai.ts) — documented ----
  'ai.drawReview': documentedPayload, // { drawPackId?, milestoneId? } — advisory only
  'ai.trustDigest': documentedPayload, // { lang: 'en'|'sw', sinceDays? }
} as const satisfies Record<ActionType, z.ZodType>

/**
 * The action types with STRICT schemas (unknown fields rejected). Today:
 * the money-relevant families — MONEY_ACTIONS ∪ WALLET_ACTIONS. Pinned to
 * exactly that set by tests/unit/action-schemas.test.ts, so widening the
 * strict set is a conscious, tested change.
 */
export const STRICT_ACTION_TYPES = [
  'escrow.topup',
  'milestone.create',
  'milestone.evidence',
  'milestone.requestRelease',
  'milestone.decide',
  'variation.submit',
  'variation.decide',
  'payment.request',
  'payment.decide',
  'payment.pay',
  'wallet.create',
  'wallet.deposit',
  'wallet.withdraw',
  'wallet.transfer',
  'transaction.reverse',
  'ledger.post',
] as const satisfies readonly (keyof typeof ACTION_PAYLOAD_SCHEMAS)[]

/** Type-level view of the strict set (for generated client types later). */
export type StrictActionType = (typeof STRICT_ACTION_TYPES)[number]

// ---------------------------------------------------------------- enforcement

/**
 * Thrown by parseActionPayload when a payload violates its registry schema.
 * Carries the zod issues so /api/actions can render the house
 * `{ error, field? }` 400 (zodIssueResponse); the message itself is the
 * sync/share/ussd contract (`Invalid <type> payload — …`), readable on its
 * own wherever an Error message is all a caller gets.
 */
export class ActionPayloadError extends Error {
  readonly issues: ZodIssue[]
  constructor(
    readonly actionType: string,
    issues: ZodIssue[],
  ) {
    const first = issues[0]
    const where = first && first.path.length ? `${String(first.path.join('.'))}: ` : ''
    super(`Invalid ${actionType} payload — ${where}${first ? first.message : 'validation failed'}`)
    this.name = 'ActionPayloadError'
    this.issues = issues
  }
}

/**
 * Validate a dispatch payload against the registry — the ONE seam
 * applyAction calls before anything else (no DB read, no role gate runs
 * first). Unknown types get the dispatcher's own honest miss (the same
 * message applyCoreAction's default arm throws) instead of a silent
 * registry miss. Validation-only by design: the parsed VALUE is discarded —
 * appliers keep their exact coercion/trim semantics, so no validated flow
 * changes behavior, only garbage that used to flow through now stops here.
 */
export function parseActionPayload(type: string, payload: unknown): void {
  const schema = (ACTION_PAYLOAD_SCHEMAS as Record<string, z.ZodType | undefined>)[type]
  if (!schema) throw new Error(`Unknown action type: ${type}`)
  const result = schema.safeParse(payload)
  if (!result.success) throw new ActionPayloadError(type, result.error.issues)
}
