import { NextResponse } from 'next/server'

/**
 * GET /api/openapi.json — the OpenAPI 3.1 description of the /api/v1 REST
 * surface (Doc A §64 API QUALITY — documentation; B5-APIV1). UNAUTHENTICATED
 * by design: it documents no secrets, only shapes.
 *
 * Hand-written but kept truthful field-for-field against the route code —
 * every documented path, parameter, body field, response field and status
 * code is produced by src/backend/api/v1/** (reorg: src/app/api/v1/** are thin shims; this is the SDK-generation seam
 * listed in ARCHITECTURE.md's roadmap). 27 /api/v1 paths = the 8 v1 wallet/
 * payment route files + the 6 read-only Phase B files (task 10-a: projects
 * list/detail/tasks/deliveries + supply orders list/detail) + the 5 read-only
 * Phase C money-governance files (W3-2: projects milestones/invoices/escrow
 * + milestone/invoice detail) + the 8 read-only Phase D files (task 7-b:
 * workers list/detail, attendance, task detail, suppliers, parcels, intel
 * digest, budget-variance mirror), plus the two wave-3 app-level GETs added by
 * W3-B: /api/audit (admin audit log, spec §44) and /api/reports/
 * budget-variance (QS report), plus the document-intelligence route
 * /api/ai/extract-document added by issue #153 (GET review queue / POST
 * extraction draft / PUT human review gate — the one non-v1 mutation surface
 * in the doc, documented because the review gate is the app's "AI assists,
 * humans decide" control and it now has an operator surface).
 *
 * Honest facts baked into the text: simulated-by-default payment rails (Daraja
 * sandbox when env-configured), KES-only money,
 * ledger as source of truth, idempotent replays that 409 on a payload mismatch,
 * per-host shared rate buckets by default (in-process only when
 * RATE_LIMIT_STORE=memory opts out — see rate-limit.ts), and the one error
 * shape { error, field? }.
 */

const json = (schema: object) => ({ content: { 'application/json': { schema } } })

// ---- shared schema fragments -------------------------------------------------

const errorSchema = {
  type: 'object',
  description: 'The ONE error shape across /api/v1: { error, field? }. The `ok` flag only appears on success bodies.',
  required: ['error'],
  properties: {
    error: { type: 'string', description: 'Human-readable, honest failure reason (never a stack trace).' },
    field: { type: 'string', description: 'Offending request field for validation errors (400) and cursors.' },
  },
  additionalProperties: false,
}

const rateErrorSchema = {
  type: 'object',
  required: ['error', 'retryAfterSec'],
  properties: {
    error: { const: 'Too many requests' },
    retryAfterSec: { type: 'integer', description: 'Seconds until one token refills.' },
  },
}

const okWalletSummaryItem = {
  type: 'object',
  required: ['id', 'code', 'label', 'ownerType', 'currency', 'status', 'balance'],
  properties: {
    id: { type: 'string', description: 'WalletAccount id (cuid).' },
    code: { type: 'string', description: 'Human wallet code, e.g. W-0001.' },
    label: { type: 'string' },
    ownerType: { type: 'string', enum: ['project', 'organization', 'supplier', 'user'] },
    ownerId: { type: ['string', 'null'] },
    currency: { const: 'KES' },
    status: { type: 'string', enum: ['active', 'frozen', 'closed'] },
    ledgerAccountCode: { type: ['string', 'null'], description: 'Backing ledger account code, e.g. WALLET:W-0001.' },
    balance: { type: 'number', description: 'Derived from ledger entries (credits − debits) — never stored.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const ok = (dataSchema: object) => ({
  type: 'object',
  required: ['ok', 'data'],
  properties: {
    ok: { const: true },
    data: dataSchema,
    replayed: { type: 'boolean', description: 'Present (true) when an Idempotency-Key replayed a stored response.' },
    scope: { type: 'string', description: 'Idempotency scope of the replayed request, e.g. "v1.wallet.deposit".' },
  },
})

const ledgerTxnSchema = {
  type: 'object',
  required: ['id', 'ref', 'description', 'occurredAt', 'status', 'postedBy', 'postedRole', 'entries', 'total'],
  properties: {
    id: { type: 'string', description: 'LedgerTransaction id (cuid) — also the pagination cursor value.' },
    ref: { type: 'string', description: 'Ledger ref, e.g. LX-2026-000001.' },
    description: { type: 'string' },
    occurredAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['posted', 'reversed'], description: "Derived (issue #133): 'reversed' iff a reversal transaction links back via reversalOfId — the stored ledger row is append-only 'posted'." },
    postedBy: { type: 'string' },
    postedRole: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['accountCode', 'side', 'amount'],
        properties: {
          accountCode: { type: 'string' },
          side: { type: 'string', enum: ['debit', 'credit'] },
          amount: { type: 'number' },
          memo: { type: ['string', 'null'] },
        },
      },
    },
    total: { type: 'number', description: 'Sum of the debit legs (KES).' },
  },
}

const idempotencyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', maxLength: 200 },
  description:
    'Money-mutation idempotency (spec §57): the FIRST successful run with a key is stored; ' +
    'repeating the key with the SAME payload replays that stored 200 body verbatim (adds ' +
    'top-level replayed: true and scope). Repeating the key with a DIFFERENT payload is ' +
    'refused with 409 — the stored result is never silently replayed for a request it did ' +
    'not produce (issue #75 / BE-9: the payload fingerprint is stored with the record by ' +
    'modules/wallet/http.ts withIdempotency). Failed runs are never recorded, so a retry ' +
    'after a 4xx/5xx is always possible. The keyspace is scoped PER PRINCIPAL (issue #177 / ' +
    'SEC-10): records live in the caller\'s namespace (user + the wallet / payment request ' +
    'this route acts on), so one actor\'s key can never claim or replay another actor\'s ' +
    'record — a different actor\'s identical key is simply a fresh request.',
}

const walletIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$' },
  description: 'Wallet id (cuid) OR human code (e.g. W-0001) — the service resolves both.',
}

const projectIdParam = (where: string) => ({
  name: 'projectId',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: `Scope the lookup to one project (${where}). Absent = unscoped (finance/admin).`,
})

const limitParam = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  description: 'Page size. 1-200, default 50.',
}

const cursorParam = (of: string) => ({
  name: 'cursor',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: `Keyset cursor — the id of the last item of the previous page (${of}). Pages never overlap; a cursor not present in the list → 400.`,
})

const unauthorizedResponse = {
  description: 'No session cookie (guard: src/backend/lib/guard.ts). Body { error: "Sign in required" }.',
  content: { 'application/json': { schema: errorSchema } },
}
const forbiddenResponse = {
  description:
    'Signed in but the role is not permitted (guard): finance+admin own the wallet routes; payments allow finance/admin/client. ' +
    'Body { error: "Not permitted for role \\"<role>\\"" } — or, for a client paying another project\'s request, { error: "Not permitted for this project" } ' +
    '— or, while the `wallet` feature flag is OFF, { error: "Feature disabled by feature flag (wallet)…" } for non-admin sessions ' +
    '(admins bypass so they can toggle and test; spec §81).',
  content: { 'application/json': { schema: errorSchema } },
}
const rateLimitedResponse = {
  description:
    'Per-principal token bucket (session email, else IP): reads 120/min, money mutations 30/min. ' +
    'Retry-After header (seconds). Single-instance, in-process — honest limitation of the current deployment.',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}
const badRequestResponse = {
  description:
    'Validation failure (zod): unknown/missing/ill-typed body field, non-object or unparseable JSON, bad limit/cursor, ' +
    'or an honest business-rule message from the wallet service (e.g. "Insufficient wallet balance: 500 < 1000"). Body { error, field? }.',
  content: { 'application/json': { schema: errorSchema } },
}
const notFoundResponse = {
  description: 'Unknown wallet (or payment request). Body { error: "Wallet not found" | "Wallet belongs to a different project" | "Payment request not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}
const serverErrorResponse = {
  description: 'Unexpected failure — honest generic message; details go to the server logs only (never a stack trace).',
  content: { 'application/json': { schema: errorSchema } },
}

const security = [{ cookieAuth: [] }]

// ---- wave-3 (W3-B) schema fragments: audit log + budget variance report ----

const auditEventSchema = {
  type: 'object',
  description:
    'One append-only audit row (written exclusively by lib/audit logAudit — IMMUTABLE: no update/delete ' +
    'endpoints exist, ever). meta/before/after serialize as parsed JSON when the stored string is valid ' +
    'JSON, else the raw string; null when absent.',
  required: ['id', 'projectId', 'kind', 'actor', 'role', 'summary', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'AuditEvent id (cuid) — the pagination cursor value.' },
    projectId: { type: 'string' },
    kind: {
      type: 'string',
      description: 'e.g. delivery, wage, attendance, milestone, variation, escrow, photo, comment, export, share, auth.',
    },
    actor: { type: 'string', description: 'Who did it (display name).' },
    role: { type: 'string', description: 'contractor, foreman, client, system, ai, finance, supervisor…' },
    summary: { type: 'string', description: 'Human-readable one-liner.' },
    meta: { description: 'JSON extra detail (parsed) or the raw string; null when absent.' },
    entity: { type: ['string', 'null'], description: 'Entity type acted on (Prisma model name for decision actions — Milestone/VariationOrder/PaymentRequest — e.g. StockMovement elsewhere).' },
    entityId: { type: ['string', 'null'] },
    before: { description: 'Snapshot before, mutations only (parsed JSON or raw string; null when absent). Decision actions (#218) freeze the pre-decision state here — e.g. { status: "release_requested", evidencePhotoIds: […] }.' },
    after: { description: 'Snapshot after, mutations only (parsed JSON or raw string; null when absent). Decision actions (#218) freeze the post-decision state here — e.g. { status: "released", evidencePhotoIds: […] }.' },
    ip: { type: ['string', 'null'], description: 'First x-forwarded-for value of the request origin.' },
    userAgent: { type: ['string', 'null'] },
    requestId: { type: ['string', 'null'], description: 'Correlation id (incoming x-request-id or a fresh UUID).' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const budgetVarianceSchema = {
  type: 'object',
  required: ['project', 'phases', 'categories', 'phaseAttribution'],
  properties: {
    project: {
      type: 'object',
      required: ['id', 'name', 'budgetTotal', 'spent', 'remaining', 'spentPct', 'progressPct'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        budgetTotal: { type: 'number', description: 'Σ Phase.budget — the same derivation as the app payload (ProjectSummary.budgetTotal). KES.' },
        spent: { type: 'number', description: 'Σ Transaction.amount — the same derivation as ProjectSummary.budgetSpent (flat, KES).' },
        remaining: { type: 'number', description: 'budgetTotal − spent (plain variance view; the finance slice\'s `committed` dimension is deliberately NOT folded in).' },
        spentPct: { type: 'integer', description: 'round(spent / budgetTotal × 100); 0 when budgetTotal is 0.' },
        progressPct: { type: 'integer', description: 'Budget-weighted phase progress (lib/mjengo overallProgress).' },
      },
    },
    phases: {
      type: 'array',
      description:
        'Three-tier attribution (issue #39): REAL phase cost-codes (Transaction.phaseId) count directly; ' +
        'pre-code rows derive exactly through milestone linkage; the uncoded remainder is the documented ' +
        'budget-share ALLOCATION — Σ phases.spent equals project.spent exactly, and phaseAttribution + ' +
        'per-phase codedSpent state which mode produced each number.',
      items: {
        type: 'object',
        required: ['id', 'name', 'budget', 'spent', 'variance', 'variancePct', 'progressPct', 'txCount', 'codedSpent', 'codedTxnCount', 'topTransactions'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          budget: { type: 'number' },
          spent: { type: 'number' },
          codedSpent: { type: 'number', description: 'Real-code portion of spent (rows carrying this phase\'s Transaction.phaseId cost-code, issue #39); spent − codedSpent is the fallback attribution.' },
          codedTxnCount: { type: 'integer', description: 'Transactions attributed via a real phase cost-code.' },
          variance: { type: 'number', description: 'budget − spent (positive = under budget).' },
          variancePct: { type: 'integer', description: 'round(variance / budget × 100); 0 when budget is 0.' },
          progressPct: { type: 'integer' },
          txCount: { type: 'integer', description: 'Transactions attributed to this phase.' },
          topTransactions: {
            type: 'array',
            description: 'The 5 largest attributed transactions by amount.',
            items: {
              type: 'object',
              required: ['id', 'note', 'amount', 'date'],
              properties: {
                id: { type: 'string' },
                note: { type: 'string' },
                amount: { type: 'number' },
                date: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
    phaseAttribution: {
      type: 'object',
      required: ['mode', 'codedSpent', 'codedTxnCount', 'milestoneDerivedSpent', 'milestoneDerivedTxnCount', 'estimatedSpent', 'estimatedTxnCount'],
      description:
        'Honest mode statement (issue #39): which attribution produced the per-phase numbers. ' +
        'codedSpent + milestoneDerivedSpent + estimatedSpent == project.spent and the three counts == every transaction.',
      properties: {
        mode: { type: 'string', enum: ['none', 'real', 'mixed', 'estimated'], description: "'none' (no spend) · 'real' (every row carries a phase cost-code) · 'mixed' (part coded, part fallback) · 'estimated' (nothing coded — legacy milestone derivation + budget-share estimate)." },
        codedSpent: { type: 'number', description: 'Σ amounts attributed via a stored Transaction.phaseId (real codes).' },
        codedTxnCount: { type: 'integer' },
        milestoneDerivedSpent: { type: 'number', description: 'Σ amounts of uncoded rows attributed exactly via the legacy PaymentRequest→milestone→phase derivation.' },
        milestoneDerivedTxnCount: { type: 'integer' },
        estimatedSpent: { type: 'number', description: 'Σ amounts of uncoded rows spread by the budget-share estimate.' },
        estimatedTxnCount: { type: 'integer' },
      },
    },
    categories: {
      type: 'array',
      description:
        'HONEST: Transaction has no category field — grouping is by Transaction.type (the one real cost ' +
        'dimension the model carries), not QS work-sections. Ordered by spent DESC.',
      items: {
        type: 'object',
        required: ['key', 'label', 'spent', 'txCount', 'share'],
        properties: {
          key: { type: 'string', description: 'Transaction.type, e.g. material, wage, transport, other.' },
          label: { type: 'string', description: 'Friendly label, e.g. Materials, Wages.' },
          spent: { type: 'number' },
          txCount: { type: 'integer' },
          share: { type: 'integer', description: '% of total spent, rounded.' },
        },
      },
    },
  },
}

const auditRateLimitedResponse = {
  description:
    'Per-principal token bucket: 60 reads/min (session email, else IP). Retry-After header (seconds). ' +
    'Single-instance, in-process — honest limitation of the current deployment.',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}

const reportRateLimitedResponse = {
  description:
    'Per-principal token bucket: 30 reads/min (session email, else IP) — the report walks every project ' +
    'transaction, so it is a heavyweight read, not a polling target. Retry-After header (seconds). ' +
    'Single-instance, in-process — honest limitation of the current deployment.',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}

// ---- document intelligence (issue #153) schema fragments ----------------------

const aiRouteRateLimitedResponse = {
  description:
    'Per-principal token bucket (session email, else IP): the shared /api/ai/* gate — 10 model ' +
    'calls/min per route (POST extraction, PUT review); the GET review queue reads at 30/min. ' +
    'Retry-After header (seconds).',
  headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until one token refills.' } },
  content: { 'application/json': { schema: rateErrorSchema } },
}

/** Attachment.extractedJson, parsed by the queue route (normalized shape — never the raw model text). */
const documentExtractionSchema = {
  type: 'object',
  required: ['docType', 'supplier', 'total', 'currency', 'lines', 'notes'],
  properties: {
    docType: { type: 'string', description: 'Best read of what the document is (invoice, quotation, boq, receipt, contract, permit, drawing, delivery note, other).' },
    supplier: { type: ['string', 'null'], description: 'Supplier/vendor name exactly as printed, or null when unreadable.' },
    total: { type: ['number', 'null'], description: 'Grand total as a plain number, or null (never a guess).' },
    currency: { type: ['string', 'null'], description: 'Currency code as printed, e.g. KES.' },
    lines: {
      type: 'array',
      description: 'Priced line items as printed (≤ 200; empty when the document has none).',
      items: {
        type: 'object',
        required: ['description', 'qty', 'unitPrice', 'total'],
        properties: {
          description: { type: 'string' },
          qty: { type: ['number', 'null'] },
          unitPrice: { type: ['number', 'null'] },
          total: { type: ['number', 'null'] },
        },
      },
    },
    notes: { type: ['string', 'null'], description: 'One short note about anything unreadable or uncertain.' },
  },
}

/** One queued document row (GET ?projectId → documents[]). */
const documentReviewItemSchema = {
  type: 'object',
  required: ['id', 'fileName', 'storageKey', 'reviewStatus', 'uploadedBy', 'createdAt', 'extraction'],
  properties: {
    id: { type: 'string', description: 'Attachment id (cuid) — the value POST/PUT take as attachmentId.' },
    fileName: { type: 'string', description: 'Sanitized display name (never a path).', },
    title: { type: ['string', 'null'] },
    category: { type: ['string', 'null'], enum: ['contract', 'drawing', 'permit', 'receipt', 'boq', 'invoice', 'quote', 'other', null], description: '§60 document kind stamped at upload.' },
    mimeType: { type: ['string', 'null'], enum: ['application/pdf', 'image/png', 'image/jpeg', null] },
    sizeBytes: { type: ['integer', 'null'] },
    storageKey: { type: 'string', description: 'The stored file\'s URL/path (local /docs/<name> or the storage driver\'s publicUrl).' },
    projectId: { type: ['string', 'null'] },
    entityType: { type: 'string' },
    entityId: { type: 'string' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    reviewStatus: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
    reviewedBy: { type: ['string', 'null'], description: 'The reviewer identity the PUT stamped (the signed-in session by default).' },
    reviewedAt: { type: ['string', 'null'], format: 'date-time' },
    extractionConfidence: { type: ['number', 'null'], description: 'The model\'s honest 0-1 confidence; null before the first extraction.' },
    extractionModel: { type: ['string', 'null'], description: 'Provenance: glm-5v-turbo (image scans) or zai-chat-llm (PDF text layer).' },
    uploadedBy: { type: 'string', description: 'Uploader email.' },
    createdAt: { type: 'string', format: 'date-time' },
    extraction: {
      oneOf: [{ $ref: '#/components/schemas/DocumentExtraction' }, { type: 'null' }],
      description: 'The parsed draft (extractedJson), or null when no extraction has run. DRAFT-ONLY — approval never copies it into any official record.',
    },
  },
}

// ---- Phase B (task 10-a) schema fragments: projects + supply reads ----

/** Project id path param (cuid). */
const projectIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: 'Project id (cuid).',
}

/** PurchaseOrder id OR orderCode path param. */
const orderIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$' },
  description: 'PurchaseOrder id (cuid) OR human orderCode (e.g. PO-2026-000012) — the route resolves both.',
}

/** Exact status filter (per-resource enum). */
const statusParam = (enumValues: string[], of: string) => ({
  name: 'status',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: enumValues },
  description: `Exact ${of} filter. Applies BEFORE pagination — a cursor that falls out of the filtered list → 400.`,
})

const searchParam = {
  name: 'q',
  in: 'query',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 100 },
  description: 'Free-text search on project name/client (contains, ASCII case-insensitive, evaluated in-memory over the list).',
}

const projectsForbiddenResponse = {
  description:
    'Signed in but not permitted: client-role sessions are pinned to their OWN project — a foreign project → ' +
    '{ error: "Not permitted for this project" } (the same pin /api/v1/payments applies). HONEST SCOPE NOTE: no feature ' +
    'flag gates the projects resource — none of the five flags (ai_progress, ai_voice, wallet, marketplace, ' +
    'land_verification) names the projects surface, so gating it by an unrelated flag would be dishonest.',
  content: { 'application/json': { schema: errorSchema } },
}

const supplyForbiddenResponse = {
  description:
    'Not permitted: (a) a client-role session pinned to a foreign project → { error: "Not permitted for this project" }, ' +
    'or (b) the `marketplace` feature flag is OFF → { error: "Feature disabled by feature flag (marketplace)…" } for ' +
    'non-admin sessions (admins bypass so they can toggle and test; spec §81 — the same uniform gate the wallet flag ' +
    'applies to the v1 wallet family, and the webapp mirrors by hiding the Finder tab for non-admins). Body shape { error }.',
  content: { 'application/json': { schema: errorSchema } },
}

const projectNotFoundResponse = {
  description: 'Unknown project. Body { error: "Project not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const orderNotFoundResponse = {
  description: 'Unknown purchase order. Body { error: "Order not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const projectListItemSchema = {
  type: 'object',
  description:
    'The lightweight roster row — the SAME getProjectsList() derivation the webapp project switcher renders ' +
    '(no new money math in /api/v1).',
  required: [
    'id', 'name', 'client', 'clientType', 'location', 'status', 'startDate', 'targetDate',
    'budgetTotal', 'budgetSpent', 'progressPct', 'dayCount', 'fundisCount', 'unackedAlerts', 'photoCount',
  ],
  properties: {
    id: { type: 'string', description: 'Project id (cuid) — the pagination cursor value.' },
    name: { type: 'string' },
    client: { type: 'string' },
    clientType: { type: 'string', enum: ['diaspora', 'local', 'company'] },
    location: { type: 'string' },
    status: { type: 'string', description: 'active | completed | on_hold (the column is free-form — other values stay visible unfiltered and never match a filter).' },
    startDate: { type: 'string', format: 'date-time' },
    targetDate: { type: 'string', format: 'date-time' },
    budgetTotal: { type: 'number', description: 'Σ Phase.budget — the cost-plan rollup (KES).' },
    budgetSpent: { type: 'number', description: 'Σ Transaction.amount (flat, KES).' },
    progressPct: { type: 'integer', description: 'Budget-weighted phase progress (lib/mjengo overallProgress).' },
    dayCount: { type: 'integer', description: 'Days since startDate (min 1).' },
    fundisCount: { type: 'integer' },
    unackedAlerts: { type: 'integer' },
    photoCount: { type: 'integer' },
  },
}

const taskSummarySchema = {
  type: 'object',
  description: 'One task of the project (Task management v2 fields included — priority, assignment, blockers, verification).',
  required: [
    'id', 'phaseId', 'phaseName', 'title', 'status', 'progress', 'priority', 'dueDate', 'assignedToId',
    'blockedById', 'blockedReason', 'verifiedAt', 'verifiedByName', 'version', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Task id (cuid) — the pagination cursor value.' },
    phaseId: { type: 'string' },
    phaseName: { type: ['string', 'null'] },
    title: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
    progress: { type: 'integer', description: '0-100.' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    dueDate: { type: ['string', 'null'], format: 'date-time' },
    assignedToId: { type: ['string', 'null'], description: 'Worker id when assigned.' },
    blockedById: { type: ['string', 'null'], description: 'Task id of the blocker when blocked.' },
    blockedReason: { type: ['string', 'null'] },
    verifiedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the completed work was verified.' },
    verifiedByName: { type: ['string', 'null'] },
    version: { type: 'integer', description: 'Offline-sync entity version — bumped by every applier that mutates the row.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const projectDetailSchema = {
  type: 'object',
  description:
    'One project + its honest summary. Every number is an EXISTING aggregation: ProjectSummary (getProjectPayload) ' +
    'and procurementTotals (the pure module the Finder dashboard consumes, wired identically) — no new money math. ' +
    'HONEST OMISSION: project.shareToken is deliberately NOT exposed (a bearer capability for share links, not a data field).',
  required: ['project', 'progressPct', 'dayCount', 'daysRemaining', 'budget', 'procurement', 'tasks', 'phases'],
  properties: {
    project: {
      type: 'object',
      required: ['id', 'name', 'client', 'clientType', 'location', 'status', 'budget', 'startDate', 'targetDate', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        client: { type: 'string' },
        clientType: { type: 'string', enum: ['diaspora', 'local', 'company'] },
        location: { type: 'string' },
        status: { type: 'string', description: 'active | completed | on_hold (free-form column).' },
        budget: { type: 'number', description: 'The contract budget field (Project.budget); the cost-plan rollup is budget.total below.' },
        startDate: { type: 'string', format: 'date-time' },
        targetDate: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    progressPct: { type: 'integer', description: 'Budget-weighted phase progress.' },
    dayCount: { type: 'integer' },
    daysRemaining: { type: 'integer' },
    budget: {
      type: 'object',
      required: ['total', 'spent', 'spentPct', 'plannedSpendPct', 'spendVsPlanDeltaPct'],
      properties: {
        total: { type: 'number', description: 'Σ Phase.budget (KES).' },
        spent: { type: 'number', description: 'Σ Transaction.amount (KES, flat).' },
        spentPct: { type: 'integer' },
        plannedSpendPct: { type: 'integer', description: 'Linear plan by elapsed days.' },
        spendVsPlanDeltaPct: { type: 'integer', description: 'spend minus plan as % of budget (positive = over plan).' },
      },
    },
    procurement: {
      type: 'object',
      description: 'The Finder §20 dashboard tile math over the project supply slice (same numbers as the webapp tiles).',
      required: ['required', 'purchased', 'committed', 'remaining', 'pendingRequests', 'pendingApprovals', 'ordersInTransit', 'discrepancies'],
      properties: {
        required: { type: 'number', description: 'Σ estimates of submitted/approved/converted requests (KES).' },
        purchased: { type: 'number', description: 'Σ totals of delivered/closed orders (KES).' },
        committed: { type: 'number', description: 'Σ totals of sent/confirmed/delivering orders (KES) — the budget-vs-committed dimension.' },
        remaining: { type: 'number', description: 'required − purchased, floored at 0.' },
        pendingRequests: { type: 'integer' },
        pendingApprovals: { type: 'integer' },
        ordersInTransit: { type: 'integer' },
        discrepancies: { type: 'integer', description: 'Deliveries whose status is "discrepancy".' },
      },
    },
    tasks: {
      type: 'object',
      required: ['total', 'pending', 'inProgress', 'done', 'blocked'],
      properties: {
        total: { type: 'integer' },
        pending: { type: 'integer' },
        inProgress: { type: 'integer' },
        done: { type: 'integer' },
        blocked: { type: 'integer' },
      },
    },
    phases: { type: 'integer', description: 'Phase count.' },
  },
}

const deliveryVerificationSchema = {
  type: 'object',
  description:
    'One delivery-verification record (OrderDelivery) against a purchase order. HONEST SCOPE: evidence photos are ' +
    'referenced by ATTACHMENT ID ONLY — /api/v1 serves no photo bytes and no storage URLs; fetch the bytes through ' +
    'the app\'s own storage seam, not this API.',
  required: [
    'id', 'orderId', 'orderCode', 'status', 'dispatchedAt', 'receivedAt', 'receivedBy', 'note',
    'driverName', 'driverPhone', 'vehicleReg', 'etaAt', 'departedAt', 'arrivedAt', 'gpsLat', 'gpsLng',
    'photoCount', 'photos', 'lines', 'shortLines', 'createdAt',
  ],
  properties: {
    id: { type: 'string', description: 'OrderDelivery id (cuid) — the pagination cursor value.' },
    orderId: { type: 'string' },
    orderCode: { type: 'string', description: 'The owning purchase order code, e.g. PO-2026-000012.' },
    status: { type: 'string', enum: ['dispatched', 'in_transit', 'arrived', 'received', 'discrepancy', 'cancelled'], description: 'cancelled = voided dispatch (issue #206: order.cancel from delivering, or delivery.void) — never receivable, no stock posted.' },
    dispatchedAt: { type: ['string', 'null'], format: 'date-time' },
    receivedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the site team confirmed receipt (ground truth).' },
    receivedBy: { type: ['string', 'null'] },
    note: { type: ['string', 'null'], description: 'Receive-time note; receiveDelivery writes an honest auto-summary when lines come up short.' },
    driverName: { type: ['string', 'null'] },
    driverPhone: { type: ['string', 'null'] },
    vehicleReg: { type: ['string', 'null'] },
    etaAt: { type: ['string', 'null'], format: 'date-time' },
    departedAt: { type: ['string', 'null'], format: 'date-time' },
    arrivedAt: { type: ['string', 'null'], format: 'date-time' },
    gpsLat: { type: ['number', 'null'] },
    gpsLng: { type: ['number', 'null'] },
    photoCount: { type: 'integer', description: 'Denormalized mirror of the linked DeliveryPhoto rows — recomputed by receiveDelivery, never client-supplied.' },
    photos: {
      type: 'array',
      description: 'Evidence-photo refs — attachment IDS ONLY (no bytes/URLs in v1).',
      items: {
        type: 'object',
        required: ['attachmentId', 'deliveryLineId', 'attachedBy', 'createdAt'],
        properties: {
          attachmentId: { type: 'string', description: '/api/upload Attachment id — the id IS the reference; v1 does not serve the photo.' },
          deliveryLineId: { type: ['string', 'null'], description: 'Line-scoped evidence (the discrepancy record) or null = whole-delivery evidence.' },
          attachedBy: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    lines: {
      type: 'array',
      description: 'Per-line physical counts: ordered vs received vs rejected (spec §34).',
      items: {
        type: 'object',
        required: ['id', 'orderLineId', 'name', 'unit', 'qtyOrdered', 'qtyReceived', 'qtyRejected', 'condition', 'damageNote', 'short'],
        properties: {
          id: { type: 'string' },
          orderLineId: { type: 'string' },
          name: { type: ['string', 'null'], description: 'PO line material name (joined in-memory).' },
          unit: { type: ['string', 'null'] },
          qtyOrdered: { type: 'number' },
          qtyReceived: { type: 'number' },
          qtyRejected: { type: 'number', description: 'Explicitly rejected on inspection.' },
          condition: { type: 'string', enum: ['ok', 'damaged', 'partial'] },
          damageNote: { type: ['string', 'null'] },
          short: { type: 'boolean', description: 'qtyReceived < qtyOrdered — receiveDelivery\'s exact short-line predicate (the same check that sets the delivery status to "discrepancy").' },
        },
      },
    },
    shortLines: { type: 'integer', description: 'Count of lines received short of the ordered quantity.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const supplyOrderSummarySchema = {
  type: 'object',
  description: 'One purchase order summary (the list item; the detail head adds lines + delivery records).',
  required: [
    'id', 'orderCode', 'status', 'supplierId', 'supplierName', 'requestCode', 'subtotal', 'deliveryFee', 'total',
    'paymentSource', 'createdByRole', 'note', 'deliveryCount', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'PurchaseOrder id (cuid) — the pagination cursor value.' },
    orderCode: { type: 'string', description: 'Human order code, e.g. PO-2026-000012.' },
    status: { type: 'string', enum: ['draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed', 'cancelled'] },
    supplierId: { type: 'string' },
    supplierName: { type: 'string', description: 'Supplier.businessName (joined).' },
    requestCode: { type: ['string', 'null'], description: 'The originating material request code, when the order came from one.' },
    subtotal: { type: 'number', description: 'KES.' },
    deliveryFee: { type: 'number', description: 'KES.' },
    total: { type: 'number', description: 'Landed total, KES.' },
    paymentSource: { type: 'string', enum: ['client', 'contractor', 'project_wallet', 'finance'] },
    createdByRole: { type: 'string', description: 'Role that placed the order.' },
    note: { type: ['string', 'null'] },
    deliveryCount: { type: 'integer', description: 'OrderDelivery records against this order.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const supplyOrderDetailSchema = {
  type: 'object',
  description:
    'One purchase order with its lines and delivery-verification records. Read via a route-layer include ' +
    '(the supply module\'s public read is the whole-project slice — there is no single-order service read; the ' +
    'wallet-transactions precedent).',
  required: [
    'id', 'orderCode', 'status', 'supplierId', 'supplierName', 'requestCode', 'subtotal', 'deliveryFee', 'total',
    'paymentSource', 'createdByRole', 'note', 'deliveryCount', 'createdAt', 'updatedAt', 'lines', 'deliveries',
  ],
  properties: {
    ...supplyOrderSummarySchema.properties,
    lines: {
      type: 'array',
      description: 'The ordered lines (paperwork side of the 3-way match).',
      items: {
        type: 'object',
        required: ['id', 'name', 'unit', 'qty', 'unitPrice', 'lineTotal'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          unit: { type: 'string' },
          qty: { type: 'number' },
          unitPrice: { type: 'number', description: 'KES.' },
          lineTotal: { type: 'number', description: 'KES.' },
        },
      },
    },
    deliveries: {
      type: 'array',
      description: 'Delivery-verification records (physical ground truth), newest first.',
      items: { $ref: '#/components/schemas/DeliveryVerification' },
    },
  },
}

/** 200 shape of every Phase B list endpoint (the /api/audit page style). */
const listOkResponse = (items: object, cursorOf: string) => ({
  description: `ok: true. data = the current page; nextCursor is null on the last page, else the ${cursorOf} to pass as ?cursor. hasMore mirrors nextCursor.`,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['ok', 'data', 'nextCursor', 'hasMore'],
        properties: {
          ok: { const: true },
          data: { type: 'array', items },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
      },
    },
  },
})

/** 400 for the Phase B GET family (query validation, not body). */
const readBadRequestResponse = {
  description:
    'Validation failure (zod strictObject on the QUERY): unknown key (listed by name — typo protection), ' +
    'bad limit/cursor, ill-typed status/q, or a missing required param (projectId on /api/v1/supply/orders). ' +
    'Body { error, field? }.',
  content: { 'application/json': { schema: errorSchema } },
}

// ---- Phase C (W3-2) schema fragments: money governance reads ----

/** Milestone id path param (cuid — milestones carry no human code). */
const milestoneIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: 'Milestone id (cuid) — milestones have no human code, unlike wallets/POs/invoices.',
}

/** Invoice id OR invoiceCode path param. */
const invoiceIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$' },
  description: 'Invoice id (cuid) OR human invoiceCode (e.g. INV-2026-000031) — the route resolves both.',
}

/**
 * 403 for the Phase C family: client pin + the honest NO-FLAG note (the
 * release ladder and invoices deliberately survive the wallet flag).
 */
const moneyGovernanceForbiddenResponse = {
  description:
    'Signed in but not permitted: a client-role session pinned to a foreign project → ' +
    '{ error: "Not permitted for this project" } (the same pin /api/v1/payments applies). HONEST FLAG NOTE: no ' +
    'feature flag gates these resources — the wallet flag\'s documented boundary (flags.ts) keeps the escrow/' +
    'milestone release ladder alive while it is off, and invoices were never gated by marketplace or wallet. ' +
    'Body shape { error }.',
  content: { 'application/json': { schema: errorSchema } },
}

const milestoneNotFoundResponse = {
  description: 'Unknown milestone. Body { error: "Milestone not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const invoiceNotFoundResponse = {
  description: 'Unknown invoice. Body { error: "Invoice not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const milestoneSummarySchema = {
  type: 'object',
  description:
    'One rung of the escrow/milestone release ladder (MjengoPay, spec §28-29). The list item; the detail adds ' +
    'projectId, the parsed evidencePhotoIds, the decision fields and the release-ledger tie.',
  required: [
    'id', 'phaseId', 'phaseName', 'name', 'amount', 'status', 'evidencePhotoCount',
    'requestedAt', 'decidedAt', 'releasedAt', 'createdAt',
  ],
  properties: {
    id: { type: 'string', description: 'Milestone id (cuid) — the pagination cursor value.' },
    phaseId: { type: ['string', 'null'], description: 'The phase this milestone pays progress on, when linked.' },
    phaseName: { type: ['string', 'null'], description: 'Phase name joined from the project\'s phases (null when phaseId is null).' },
    name: { type: 'string' },
    amount: { type: 'number', description: 'KES released when the milestone completes.' },
    status: {
      type: 'string',
      enum: ['locked', 'evidence_submitted', 'release_requested', 'approved', 'released', 'rejected'],
      description:
        'The ladder. The runtime writes locked → evidence_submitted → release_requested → released | rejected; ' +
        "'approved' is a documented column value the current release path does not write (approve jumps straight to " +
        "'released', atomically with the escrow ledger debit).",
    },
    evidencePhotoCount: { type: 'integer', description: 'Parsed length of the JSON evidencePhotoIds array (proof-of-work).' },
    requestedAt: { type: ['string', 'null'], format: 'date-time', description: 'Set when the ladder reaches release_requested.' },
    decidedAt: { type: ['string', 'null'], format: 'date-time', description: 'Set when the client decides (approve → released, or reject).' },
    releasedAt: { type: ['string', 'null'], format: 'date-time', description: 'Set when the money moves (only released milestones carry it).' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const milestoneDetailSchema = {
  type: 'object',
  description:
    'One milestone with its full ladder: status timestamps, evidence photo IDS (no bytes, no storage URLs — the ' +
    'same honesty rule as the v1 supply photos), the decision history, and the release-ledger tie. HONEST: the ' +
    'model carries no updatedAt and no offline-sync version — those fields are absent, never fabricated. releaseLedger ' +
    'is the Transaction row the runtime release posts (type milestone, reference MJP-<id tail> — the A-1-lite ' +
    'convention); null for not-released milestones and for pre-ledger seeded history.',
  required: [
    'id', 'phaseId', 'phaseName', 'name', 'amount', 'status', 'evidencePhotoCount',
    'requestedAt', 'decidedAt', 'releasedAt', 'createdAt', 'projectId', 'evidencePhotoIds',
    'decidedBy', 'decisionNote', 'releaseLedger',
  ],
  properties: {
    ...milestoneSummarySchema.properties,
    projectId: { type: 'string' },
    evidencePhotoIds: {
      type: 'array',
      description: 'SitePhoto IDS ONLY (the parsed Milestone.evidencePhotoIds JSON array) — v1 serves no photo bytes or storage URLs.',
      items: { type: 'string' },
    },
    decidedBy: { type: ['string', 'null'], description: 'The client name who approved/rejected (decision history).' },
    decisionNote: { type: ['string', 'null'], description: 'The client\'s note recorded with the decision.' },
    releaseLedger: {
      type: ['object', 'null'],
      description:
        'The money proof of a release — the Transaction row releaseMilestoneAtomic posts. Null when the milestone ' +
        'is not released or predates the ledger convention (seeded history).',
      required: ['transactionId', 'reference', 'amount', 'method', 'ledgerTxnId', 'costCode', 'date', 'note'],
      properties: {
        transactionId: { type: 'string' },
        reference: { type: 'string', description: 'MJP-<milestone id tail> — the convention the A-1-lite ledger check matches on.' },
        amount: { type: 'number', description: 'KES — equals the milestone amount.' },
        method: { type: 'string', description: 'Escrow releases post method "escrow".' },
        ledgerTxnId: { type: ['string', 'null'], description: 'The double-entry LedgerTransaction id backing the row.' },
        costCode: { type: ['string', 'null'] },
        date: { type: 'string', format: 'date-time' },
        note: { type: ['string', 'null'] },
      },
    },
  },
}

const threeWayMatchSchema = {
  type: 'object',
  description:
    'The 3-way-match verdict (PO ↔ invoice ↔ delivery) — recomputed per request by modules/invoices/three-way.ts ' +
    '(the same pure matchThreeWay the pay gate and the Finder matrix run; never stored, never stale). WARN-ONLY by ' +
    'design: every discrepancy is "review required" language, never an accusation — the human decides (a payment ' +
    'with open items carries the payer\'s acknowledgeMismatch decision in the Approval trail).',
  required: ['mode', 'hasOrder', 'hasDelivery', 'lines', 'mismatches', 'note', 'invoiceCode'],
  properties: {
    mode: { type: 'string', enum: ['three-way', 'two-way'], description: 'two-way when the invoice carries no purchase order (invoice vs project delivery records by name).' },
    hasOrder: { type: 'boolean' },
    hasDelivery: { type: 'boolean', description: 'False when no delivery is recorded yet — counts not verifiable (honest, not zero).' },
    invoiceCode: { type: 'string' },
    lines: {
      type: 'array',
      description: 'The per-line matrix: PO qty | invoice qty | delivered qty.',
      items: {
        type: 'object',
        required: ['name', 'poQty', 'invQty', 'deliveredQty', 'feeLine'],
        properties: {
          name: { type: 'string' },
          poQty: { type: ['number', 'null'], description: 'Null = not on the PO / fee line.' },
          invQty: { type: 'number' },
          deliveredQty: { type: ['number', 'null'], description: 'Null = no delivery record to compare against (unknown, not zero).' },
          feeLine: { type: 'boolean', description: 'Delivery/transport fee lines reconcile against the PO delivery fee by amount.' },
        },
      },
    },
    mismatches: {
      type: 'array',
      description: 'Open review items (short deliveries, over-deliveries, PO/invoice qty differences, unverifiable counts) — honest language, never an accusation.',
      items: {
        type: 'object',
        required: ['name', 'po', 'inv', 'delivered', 'issue'],
        properties: {
          name: { type: 'string' },
          po: { type: ['number', 'null'] },
          inv: { type: 'number' },
          delivered: { type: ['number', 'null'] },
          issue: { type: 'string' },
        },
      },
    },
    note: { type: 'string', description: 'One-line honest summary (mode, order code, open-item count or the no-delivery caveat).' },
  },
}

const invoiceSummarySchema = {
  type: 'object',
  description:
    'One supplier invoice summary (the list item; the detail adds lines, note and the 3-way verdict). Disputed and ' +
    'paid states are represented exactly as stored — nothing invented, nothing hidden.',
  required: [
    'id', 'invoiceCode', 'status', 'supplierId', 'supplierName', 'orderId', 'orderCode', 'subtotal', 'tax',
    'total', 'lineCount', 'dueDate', 'issuedAt', 'submittedAt', 'decidedAt', 'decidedBy', 'paidAt',
    'paidByRole', 'paymentMethod', 'paymentReference', 'createdBy', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Invoice id (cuid) — the pagination cursor value.' },
    invoiceCode: { type: 'string', description: 'Human invoice code, e.g. INV-2026-000031.' },
    status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'rejected', 'paid', 'disputed'], description: 'Disputes ride invoice.update { status: "disputed" } while SUBMITTED/APPROVED (documented path — there is no dispute action).' },
    supplierId: { type: ['string', 'null'] },
    supplierName: { type: ['string', 'null'], description: 'Supplier.businessName (joined).' },
    orderId: { type: ['string', 'null'], description: 'The linked purchase order, when the invoice came from one.' },
    orderCode: { type: ['string', 'null'] },
    subtotal: { type: 'number', description: 'KES — recomputed server-side, never client sums.' },
    tax: { type: 'number', description: 'KES.' },
    total: { type: 'number', description: 'KES.' },
    lineCount: { type: 'integer' },
    dueDate: { type: ['string', 'null'], format: 'date-time' },
    issuedAt: { type: ['string', 'null'], format: 'date-time' },
    submittedAt: { type: ['string', 'null'], format: 'date-time' },
    decidedAt: { type: ['string', 'null'], format: 'date-time' },
    decidedBy: { type: ['string', 'null'], description: 'Who approved/rejected/disputed.' },
    paidAt: { type: ['string', 'null'], format: 'date-time' },
    paidByRole: { type: ['string', 'null'], description: 'client | contractor | finance.' },
    paymentMethod: { type: ['string', 'null'], description: 'mpesa | bank | card | wallet | cash.' },
    paymentReference: { type: ['string', 'null'], description: 'e.g. MPESA-8HKT4Q2A.' },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const invoiceDetailSchema = {
  type: 'object',
  description:
    'One supplier invoice with its full lifecycle, lines, totals, payment references and the 3-way-match verdict ' +
    'computed by the invoices module\'s own read-only threeWayCheck (one algorithm, one source of truth — the exact ' +
    'function /api/actions invoice.threeWayCheck runs, so the detail and the pay gate can never disagree).',
  required: [
    'id', 'invoiceCode', 'projectId', 'status', 'supplierId', 'supplierName', 'orderId', 'orderCode',
    'subtotal', 'tax', 'total', 'lines', 'dueDate', 'issuedAt', 'submittedAt', 'decidedAt', 'decidedBy',
    'paidAt', 'paidByRole', 'paymentMethod', 'paymentReference', 'createdBy', 'note', 'threeWayMatch',
    'createdAt', 'updatedAt',
  ],
  properties: {
    ...invoiceSummarySchema.properties,
    projectId: { type: 'string' },
    note: { type: ['string', 'null'] },
    lines: {
      type: 'array',
      description: 'The invoiced lines (the paperwork side of the 3-way match).',
      items: {
        type: 'object',
        required: ['id', 'name', 'qty', 'unitPrice', 'lineTotal'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          qty: { type: 'number' },
          unitPrice: { type: 'number', description: 'KES.' },
          lineTotal: { type: 'number', description: 'KES.' },
        },
      },
    },
    threeWayMatch: threeWayMatchSchema,
  },
}

const projectEscrowSchema = {
  type: 'object',
  description:
    'The project\'s escrow position. HONEST DERIVATION (the note the spec demands): balance is derived from the ' +
    'ESCROW:<projectId> ledger account entries (credits − debits on the liability account) — never the stored ' +
    'EscrowWallet.balance projection. A project with no escrow account yet (created lazily by the first top-up) ' +
    'derives an honest 0; this route never writes anything.',
  required: ['projectId', 'currency', 'balance', 'ledgerAccountCode', 'derivation'],
  properties: {
    projectId: { type: 'string' },
    currency: { const: 'KES', description: 'MjengoOS money is KES-only today.' },
    balance: { type: 'number', description: 'KES — ledger-derived (credits − debits), never the stored projection.' },
    ledgerAccountCode: { type: 'string', description: 'e.g. ESCROW:<projectId> — the double-entry backing account (liability).' },
    derivation: { type: 'string', description: 'The honest note stating how the number was produced.' },
  },
}

// ---- Phase D (task 7-b) schema fragments: workforce / suppliers / parcels / intel reads ----

/** Worker id path param (cuid — workers carry no human code). */
const workerIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: 'Worker id (cuid) — workers have no human code, and the kiosk PIN is never served.',
}

/** Task id path param (cuid — tasks carry no human code). */
const taskIdPathParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 40 },
  description: 'Task id (cuid) — tasks have no human code.',
}

/**
 * 403 for the workforce family (workers/attendance): client pin + the W5-3
 * supplier uniform-403 note + the honest NO-FLAG note.
 */
const workforceForbiddenResponse = {
  description:
    'Signed in but not permitted: a client-role session pinned to a foreign project → ' +
    '{ error: "Not permitted for this project" } (the same pin /api/v1/payments applies); a supplier-role session → ' +
    'uniform 403 (W5-3: suppliers are not project readers — their surface is the supplier-owned rows). HONEST FLAG ' +
    'NOTE: no feature flag gates these resources — none of the five flags (ai_progress, ai_voice, wallet, ' +
    'marketplace, land_verification) names the workforce/attendance surface, so gating it by an unrelated flag ' +
    'would be dishonest (the projects-resource precedent, flags.ts). Body shape { error }.',
  content: { 'application/json': { schema: errorSchema } },
}

const workerNotFoundResponse = {
  description: 'Unknown worker. Body { error: "Worker not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

const taskNotFoundResponse = {
  description: 'Unknown task. Body { error: "Task not found" }.',
  content: { 'application/json': { schema: errorSchema } },
}

/** 403 for the parcels family: client pin + supplier 403 + the land_verification gate. */
const landForbiddenResponse = {
  description:
    'Signed in but not permitted: a client-role session pinned to a foreign project → { error: "Not permitted for ' +
    'this project" }; a supplier-role session → uniform 403 (W5-3); or the `land_verification` feature flag is OFF → ' +
    '{ error: "Feature disabled by feature flag (land_verification)…" } for non-admin sessions (admins bypass so ' +
    'they can toggle and test; spec §81 — mirrors the webapp hiding the parcels section while the flag is off). ' +
    'Body shape { error }.',
  content: { 'application/json': { schema: errorSchema } },
}

/** 403 for the intel digest: client pin + supplier 403 + the honest NO-FLAG note. */
const intelForbiddenResponse = {
  description:
    'Signed in but not permitted: a client-role session pinned to a foreign project → ' +
    '{ error: "Not permitted for this project" }; a supplier-role session → uniform 403 (W5-3). HONEST FLAG NOTE: ' +
    'no feature flag gates this read — ai_progress/ai_voice gate the AI routes (Copilot photo analysis / voice ' +
    'logging), not the intel module\'s deterministic reads; the webapp Intel tab renders while flags are off, and ' +
    'v1 mirrors that. Body shape { error }.',
  content: { 'application/json': { schema: errorSchema } },
}

const workerTodayStatusSchema = {
  type: 'object',
  description:
    'The EAT-today attendance row state — the payload\'s OWN derivation (a null status means no row for today yet).',
  required: ['status', 'checkIn', 'checkOut', 'method', 'wage', 'paid', 'verification', 'exceptionReason'],
  properties: {
    status: { type: ['string', 'null'], enum: ['present', 'absent', 'half_day', 'excused', null] },
    checkIn: { type: ['string', 'null'], format: 'date-time' },
    checkOut: { type: ['string', 'null'], format: 'date-time' },
    method: { type: ['string', 'null'], description: 'geofence, ussd, app, kiosk_pin, qr_card, manager, whatsapp.' },
    wage: { type: 'number', description: 'KES for today (0 when no row yet).' },
    paid: { type: 'boolean' },
    verification: { type: ['string', 'null'], description: 'verified (worker/kiosk evidence), reported (manager says), exception (needs review).' },
    exceptionReason: { type: ['string', 'null'] },
  },
}

const workerSummarySchema = {
  type: 'object',
  description:
    'One worker of the roster (Doc A §14) — the same rows the webapp Team tab renders (a direct db.worker.findMany ' +
    'since issue #154); todayStatus/weekEarnings re-derive with the payload\'s exact logic (EAT "today" and ' +
    'trailing 7 calendar days) over ONE bounded attendance read of the page\'s workers, so the list can never ' +
    'disagree with the webapp read. HONEST ' +
    'OMISSIONS: Worker.pin (the kiosk PIN — a bearer credential) is never served; Worker has no createdAt/updatedAt ' +
    'columns, so those fields are absent, never fabricated; the LIST carries no total attendance count (the ' +
    'true counts are on GET /api/v1/workers/{id}).',
  required: [
    'id', 'projectId', 'name', 'role', 'phone', 'dailyRate', 'active', 'employmentType', 'skills',
    'todayStatus', 'weekEarnings',
  ],
  properties: {
    id: { type: 'string', description: 'Worker id (cuid) — the pagination cursor value.' },
    projectId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', description: 'Trade, e.g. Fundi wa Mawe (Mason), Foreman.' },
    phone: { type: 'string' },
    dailyRate: { type: 'number', description: 'KES.' },
    active: { type: 'boolean', description: 'The roster\'s live/inactive split (the ?active= filter).' },
    employmentType: { type: ['string', 'null'], enum: ['casual', 'contract', 'full_time', null] },
    skills: { type: 'array', description: 'Parsed from the stored JSON array (malformed stored JSON → [], never a 500).', items: { type: 'string' } },
    todayStatus: workerTodayStatusSchema,
    weekEarnings: { type: 'number', description: 'KES — Σ wages of the trailing 7 calendar days (the payload\'s exact derivation).' },
  },
}

const workerDetailSchema = {
  type: 'object',
  description:
    'One worker with the FULL attendance summary (true counts over the worker\'s whole history — by status, by ' +
    'verification, paid/unpaid wage totals) and the recent day rows. Read via a route-layer include (the workforce ' +
    'module has no public single-worker read — the wallet-transactions precedent); todayStatus/weekEarnings ' +
    're-derive with the payload\'s exact logic so the two reads can never disagree.',
  required: [
    'id', 'projectId', 'name', 'role', 'phone', 'dailyRate', 'active', 'employmentType', 'skills',
    'todayStatus', 'weekEarnings', 'idNumber', 'emergencyContactName', 'emergencyContactPhone',
    'attendanceSummary', 'recentAttendance',
  ],
  properties: {
    ...workerSummarySchema.properties,
    idNumber: {
      type: ['string', 'null'],
      description:
        'National ID as given — no verification claim. SEC-6 (#174): served only to membership-holders of the worker\'s project, contractor/admin and the project\'s own client — null for every other reader (byte-identical to a worker with no ID on file).',
    },
    emergencyContactName: {
      type: ['string', 'null'],
      description: 'SEC-6 (#174): membership/portfolio/client-gated like idNumber — null for non-members.',
    },
    emergencyContactPhone: {
      type: ['string', 'null'],
      description: 'SEC-6 (#174): membership/portfolio/client-gated like idNumber — null for non-members.',
    },
    attendanceSummary: {
      type: 'object',
      description: 'True totals over the worker\'s WHOLE attendance history (the list honestly cannot carry these).',
      required: [
        'records', 'present', 'absent', 'halfDay', 'excused', 'verified', 'reported', 'exception',
        'paidWages', 'unpaidWages', 'unpaidRecords', 'firstDate', 'lastDate',
      ],
      properties: {
        records: { type: 'integer' },
        present: { type: 'integer' },
        absent: { type: 'integer' },
        halfDay: { type: 'integer' },
        excused: { type: 'integer' },
        verified: { type: 'integer', description: 'Rows with worker/kiosk evidence (Workforce Trust).' },
        reported: { type: 'integer', description: 'Rows a manager reported without worker evidence.' },
        exception: { type: 'integer', description: 'Rows flagged for review.' },
        paidWages: { type: 'number', description: 'KES — wages of PAID rows.' },
        unpaidWages: { type: 'number', description: 'KES — wages still unpaid (the payroll gate\'s exposure).' },
        unpaidRecords: { type: 'integer' },
        firstDate: { type: ['string', 'null'], description: 'Oldest attendance day (YYYY-MM-DD); null when no rows.' },
        lastDate: { type: ['string', 'null'], description: 'Newest attendance day (YYYY-MM-DD); null when no rows.' },
      },
    },
    recentAttendance: {
      type: 'array',
      description: 'The 14 most recent day rows (newest first — the payload\'s own window).',
      items: {
        type: 'object',
        required: ['id', 'date', 'status', 'checkIn', 'checkOut', 'method', 'wage', 'paid', 'verification', 'exceptionReason', 'version', 'createdAt'],
        properties: {
          id: { type: 'string' },
          date: { type: 'string', description: 'EAT calendar day, YYYY-MM-DD (the column is a date string).' },
          status: { type: 'string', enum: ['present', 'absent', 'half_day', 'excused'] },
          checkIn: { type: ['string', 'null'], format: 'date-time' },
          checkOut: { type: ['string', 'null'], format: 'date-time' },
          method: { type: 'string' },
          wage: { type: 'number', description: 'KES.' },
          paid: { type: 'boolean' },
          verification: { type: 'string' },
          exceptionReason: { type: ['string', 'null'] },
          version: { type: 'integer', description: 'Offline-sync entity version — bumped by every applier that mutates the day-row.' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
}

const attendanceRecordSchema = {
  type: 'object',
  description:
    'One attendance day-row (Doc A §15-16) — the Workforce Trust surface. Evidence and the append-only override log ' +
    'are JSON arrays in storage; they surface as COUNTS ONLY, never raw payloads. Read via a route-layer include ' +
    '(the wallet-transactions precedent — the webapp reads attendance inside the payload\'s worker include).',
  required: [
    'id', 'projectId', 'workerId', 'workerName', 'workerRole', 'date', 'status', 'checkIn', 'checkOut', 'method',
    'wage', 'paid', 'verification', 'evidenceCount', 'overrideCount', 'exceptionReason', 'exceptionNote',
    'recordedBy', 'version', 'createdAt',
  ],
  properties: {
    id: { type: 'string', description: 'Attendance id (cuid) — the pagination cursor value.' },
    projectId: { type: 'string' },
    workerId: { type: 'string' },
    workerName: { type: ['string', 'null'], description: 'Joined from Worker (null only for a vanished worker row).' },
    workerRole: { type: ['string', 'null'] },
    date: { type: 'string', description: 'EAT calendar day, YYYY-MM-DD (the column IS a date string).' },
    status: { type: 'string', enum: ['present', 'absent', 'half_day', 'excused'] },
    checkIn: { type: ['string', 'null'], format: 'date-time' },
    checkOut: { type: ['string', 'null'], format: 'date-time' },
    method: { type: 'string', description: 'geofence, ussd, app, kiosk_pin, qr_card, manager, whatsapp.' },
    wage: { type: 'number', description: 'KES.' },
    paid: { type: 'boolean' },
    verification: { type: 'string', enum: ['verified', 'reported', 'exception'] },
    evidenceCount: { type: 'integer', description: 'Parsed length of the evidence JSON array (gps, pin, qr, photo, supervisor, whatsapp…).' },
    overrideCount: { type: 'integer', description: 'Parsed length of the append-only override log (edits after the fact — Doc A §16 pattern to verify, never an accusation).' },
    exceptionReason: { type: ['string', 'null'] },
    exceptionNote: { type: ['string', 'null'] },
    recordedBy: { type: ['string', 'null'], description: 'Who created the row (name/role).' },
    version: { type: 'integer', description: 'Offline-sync entity version — bumped by every applier that mutates the day-row.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const taskDetailSchema = {
  type: 'object',
  description:
    'One task of the v2 model (Doc A §11) — every TaskSummary field plus the detail-only joins (assignedToName, ' +
    'blockedByTitle). Read-only: task mutations stay on POST /api/actions (Phase D is the read surface). Read via a ' +
    'route-layer include (phase + assigned worker + blocker task — the wallet-transactions precedent).',
  required: [
    'id', 'projectId', 'phaseId', 'phaseName', 'title', 'status', 'progress', 'priority', 'dueDate', 'assignedToId',
    'assignedToName', 'blockedById', 'blockedByTitle', 'blockedReason', 'verifiedAt', 'verifiedByName', 'version',
    'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Task id (cuid).' },
    projectId: { type: 'string' },
    phaseId: { type: 'string' },
    phaseName: { type: ['string', 'null'] },
    title: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
    progress: { type: 'integer', description: '0-100.' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    dueDate: { type: ['string', 'null'], format: 'date-time' },
    assignedToId: { type: ['string', 'null'], description: 'Worker id when assigned.' },
    assignedToName: { type: ['string', 'null'], description: 'Worker name joined (null when unassigned).' },
    blockedById: { type: ['string', 'null'], description: 'Task id of the blocker when blocked.' },
    blockedByTitle: { type: ['string', 'null'], description: 'The blocker task\'s title joined (null when not blocked).' },
    blockedReason: { type: ['string', 'null'] },
    verifiedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the completed work was verified.' },
    verifiedByName: { type: ['string', 'null'] },
    version: { type: 'integer', description: 'Offline-sync entity version — bumped by every applier that mutates the row.' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const supplierCatalogSummarySchema = {
  type: 'object',
  description:
    'One supplier of the marketplace directory with its catalog summary and THIS project\'s relationship marks. ' +
    'HONEST SCOPE: Supplier rows are a GLOBAL directory (loadSupplySlice loads the whole marketplace table — the ' +
    'same rows the webapp Finder renders for the project); the project relationship is carried per row ' +
    '(savedByProject, orderCount, orderTotal computed from this project\'s purchase orders), never by silently ' +
    'filtering the directory. Gated by the `marketplace` flag like the rest of the v1 supply family.',
  required: [
    'id', 'businessName', 'county', 'town', 'phone', 'email', 'verificationState', 'reliabilityScore',
    'responseHours', 'deliveryFeeBase', 'minimumOrder', 'freeDeliveryOver', 'deliveryZones', 'operatingHours',
    'savedByProject', 'orderCount', 'orderTotal', 'catalogCount', 'catalog', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Supplier id (cuid) — the pagination cursor value.' },
    businessName: { type: 'string' },
    county: { type: 'string' },
    town: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    verificationState: { type: 'integer', description: '0-5 platform ladder (unverified → trusted) — based on platform activity, never a government certification claim.' },
    reliabilityScore: { type: 'integer', description: '0-100 from ACTUAL platform transaction history — never anonymous ratings.' },
    responseHours: { type: 'integer', description: 'Average quote response time (hours).' },
    deliveryFeeBase: { type: 'number', description: 'KES base delivery fee.' },
    minimumOrder: { type: 'number', description: 'KES minimum order value.' },
    freeDeliveryOver: { type: ['number', 'null'], description: 'KES order value above which delivery is free.' },
    deliveryZones: { type: 'string', description: 'CSV of zones/counties served.' },
    operatingHours: { type: ['string', 'null'], description: 'e.g. "Mon-Sat 07:00-18:00" (spec §31).' },
    savedByProject: { type: 'boolean', description: 'The project\'s saved-supplier mark (spec §30 — the directory sorts saved first).' },
    orderCount: { type: 'integer', description: 'THIS project\'s purchase orders placed with the supplier.' },
    orderTotal: { type: 'number', description: 'KES — Σ totals of those orders (landed).' },
    catalogCount: { type: 'integer' },
    catalog: {
      type: 'array',
      description: 'The supplier\'s catalog items (name/unit/price/stock/min order — spec §29).',
      items: {
        type: 'object',
        required: ['id', 'name', 'category', 'brand', 'specification', 'unit', 'unitPrice', 'stockQty', 'minOrderQty', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          category: { type: ['string', 'null'], description: 'cement, steel, timber, roofing, plumbing, electrical, paint, tiles, sand, ballast, blocks, tools, equipment, finishes.' },
          brand: { type: ['string', 'null'], description: 'e.g. Simba, Devki, Bamburi.' },
          specification: { type: ['string', 'null'], description: 'e.g. "42.5N 50kg bag".' },
          unit: { type: 'string' },
          unitPrice: { type: 'number', description: 'KES.' },
          stockQty: { type: 'number', description: 'Stock as of updatedAt (spec §31).' },
          minOrderQty: { type: 'number' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const parcelSummarySchema = {
  type: 'object',
  description:
    'One land parcel with the verification ladder\'s summary. HONEST LANGUAGE (land/policy.ts): "verified" is a ' +
    'record state produced by the ladder (document + registry search reviewed), NEVER a government certification ' +
    'claim; "flagged" is an anomaly state for human review, never an accusation. Data comes from the payload\'s ' +
    'land slice — loadLandSlice(projectId), the land module\'s public read. Gated by the `land_verification` flag ' +
    'exactly as the webapp parcels section is.',
  required: [
    'id', 'projectId', 'plotNumber', 'county', 'town', 'lat', 'lng', 'approxArea', 'tenureType', 'status',
    'documentCount', 'searchCount', 'assignmentCount', 'latestSearch', 'assignments', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', description: 'LandParcel id (cuid) — the pagination cursor value.' },
    projectId: { type: 'string' },
    plotNumber: { type: 'string', description: 'e.g. "LR No. 2090/1234".' },
    county: { type: 'string' },
    town: { type: ['string', 'null'] },
    lat: { type: ['number', 'null'] },
    lng: { type: ['number', 'null'] },
    approxArea: { type: ['string', 'null'], description: 'e.g. "0.25 ha", "50x100 ft".' },
    tenureType: { type: ['string', 'null'], description: 'freehold / leasehold.' },
    status: { type: 'string', enum: ['searching', 'verified', 'flagged'], description: 'The documented column values (free-form column — other stored values stay visible unfiltered and never match a filter).' },
    documentCount: { type: 'integer', description: 'Attached documents (title deed, search cert, survey map…).' },
    searchCount: { type: 'integer', description: 'Registry title searches recorded.' },
    assignmentCount: { type: 'integer', description: 'Professionals assigned (surveyor, advocate, engineer…).' },
    latestSearch: {
      type: ['object', 'null'],
      description: 'The newest registry search (null when none requested yet).',
      required: ['id', 'searchRef', 'status', 'transcriptionMatch', 'requestedAt', 'receivedAt', 'reviewedAt'],
      properties: {
        id: { type: 'string' },
        searchRef: { type: 'string', description: 'Registry search reference.' },
        status: { type: 'string', enum: ['requested', 'received', 'reviewed'] },
        transcriptionMatch: { type: 'string', enum: ['pending', 'consistent', 'mismatch'], description: 'mismatch = an anomaly flag for human review, not an accusation.' },
        requestedAt: { type: 'string', format: 'date-time' },
        receivedAt: { type: ['string', 'null'], format: 'date-time' },
        reviewedAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    assignments: {
      type: 'array',
      description: 'Assigned professionals with their role on the parcel.',
      items: {
        type: 'object',
        required: ['id', 'professionalName', 'professionalCategory', 'roleOnParcel', 'status', 'createdAt'],
        properties: {
          id: { type: 'string' },
          professionalName: { type: 'string' },
          professionalCategory: { type: 'string', description: 'surveyor, advocate, engineer, qty_surveyor, architect.' },
          roleOnParcel: { type: 'string' },
          status: { type: 'string', enum: ['active', 'completed', 'withdrawn'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const intelDigestSchema = {
  type: 'object',
  description:
    'The project\'s INTEL DIGEST — flags state, the latest MjengoScore, the latest risk assessment, the §48 health ' +
    'snapshot, the latest weekly digest row, and the anomalies summary (the Alert ledger the anomaly scan writes). ' +
    'HONESTY RULES (the intel module\'s own): the score gates nothing and approves nothing — it describes, humans ' +
    'decide; score is NULL (never a fake 0 or 100) when the project has too little history; every number is ' +
    'deterministic and traceable to real rows — no anonymous ratings, no opaque "AI scores"; risk findings and ' +
    'anomalies are "review required" language, never accusations.',
  required: ['projectId', 'flags', 'score', 'risk', 'health', 'digest', 'anomalies'],
  properties: {
    projectId: { type: 'string' },
    flags: {
      type: 'object',
      description: 'The §81 feature-flag state as of this read (global, 30s cache — see flags.ts).',
      required: ['ai_progress', 'ai_voice', 'wallet', 'marketplace', 'land_verification'],
      properties: {
        ai_progress: { type: 'boolean' },
        ai_voice: { type: 'boolean' },
        wallet: { type: 'boolean' },
        marketplace: { type: 'boolean' },
        land_verification: { type: 'boolean' },
      },
    },
    score: {
      type: ['object', 'null'],
      description:
        'The LATEST MjengoScore row (append-only history; latest wins). Null when never computed. The score is a ' +
        'PROJECTION recomputed only on the explicit score.recompute action — never from a job, webhook or page load.',
      required: ['score', 'confidence', 'ruleVersion', 'computedAt', 'componentsCount', 'components', 'notes'],
      properties: {
        score: { type: ['integer', 'null'], description: '0-100; null = honest low-confidence state (too few components have data — see notes).' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How many components carry data.' },
        ruleVersion: { type: 'string' },
        computedAt: { type: 'string', format: 'date-time' },
        componentsCount: { type: 'integer' },
        components: {
          type: 'array',
          description: 'Parsed components (malformed stored JSON → [], never a 500).',
          items: {
            type: 'object',
            required: ['key', 'label', 'weight', 'value', 'deduction', 'evidence'],
            properties: {
              key: { type: 'string', enum: ['evidence_backed_releases', 'attendance_verification', 'budget_discipline', 'variation_discipline', 'delivery_discrepancy', 'invoice_disputes'] },
              label: { type: 'string' },
              weight: { type: 'integer' },
              value: { type: ['integer', 'null'] },
              deduction: { type: ['number', 'null'] },
              evidence: { type: 'string', description: 'The rows behind the number.' },
            },
          },
        },
        notes: { type: ['string', 'null'], description: 'The explanation when score is null.' },
      },
    },
    risk: {
      type: ['object', 'null'],
      description: 'The LATEST RiskAssessment (recomputed only on the explicit risk.recompute action). Null when never computed.',
      required: ['overallScore', 'ruleVersion', 'computedAt', 'findings'],
      properties: {
        overallScore: { type: 'integer', description: '0-100 (higher = more attention needed).' },
        ruleVersion: { type: 'string' },
        computedAt: { type: 'string', format: 'date-time' },
        findings: {
          type: 'array',
          description: 'Parsed rule hits (malformed stored JSON → [], never a 500).',
          items: {
            type: 'object',
            required: ['rule', 'severity', 'title', 'message', 'evidence'],
            properties: {
              rule: { type: 'string' },
              severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
              title: { type: 'string' },
              message: { type: 'string' },
              evidence: { type: 'string', description: 'The rows behind the number.' },
              score: { type: 'integer', description: 'Severity weight contributed (info 5 · warning 15 · critical 30).' },
            },
          },
        },
      },
    },
    health: {
      type: ['object', 'null'],
      description: 'The §48 project-health snapshot (recomputed on every payload load). Null when the project row is missing.',
      required: ['overall', 'computedAt', 'dimensions'],
      properties: {
        overall: { type: 'integer', description: '0-100, mean of the 6 dimension scores.' },
        computedAt: { type: 'string', format: 'date-time' },
        dimensions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'label', 'score', 'grade', 'summary'],
            properties: {
              key: { type: 'string', enum: ['progress', 'budget', 'schedule', 'procurement', 'issues', 'evidence'] },
              label: { type: 'string' },
              score: { type: 'integer' },
              grade: { type: 'string', enum: ['good', 'attention', 'poor'] },
              summary: { type: 'string', description: 'One line citing the real numbers.' },
            },
          },
        },
      },
    },
    digest: {
      type: ['object', 'null'],
      description: 'The LATEST weekly digest row (digest.weekly writes one per week, updating the same week). Null when none generated yet.',
      required: ['id', 'weekStart', 'summary', 'items', 'createdAt'],
      properties: {
        id: { type: 'string' },
        weekStart: { type: 'string', description: 'ISO date (Monday) of the digest week.' },
        summary: { type: 'string' },
        items: {
          type: 'array',
          description: 'Parsed digest items (malformed stored JSON → [], never a 500).',
          items: {
            type: 'object',
            required: ['kind', 'title', 'detail'],
            properties: {
              kind: { type: 'string', description: 'price_trend, risk, pending_approval, discrepancy, procurement, milestone…' },
              title: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    anomalies: {
      type: 'object',
      description:
        'The project\'s Alert ledger summary — the rows the anomaly scan writes (deterministic §16/§29 rules + the LLM pass). ' +
        'Alerts NEVER auto-change money or records — humans decide; counts are honest row counts, latest carries the 5 newest.',
      required: ['total', 'unacknowledged', 'critical', 'warning', 'info', 'byType', 'latest'],
      properties: {
        total: { type: 'integer' },
        unacknowledged: { type: 'integer' },
        critical: { type: 'integer' },
        warning: { type: 'integer' },
        info: { type: 'integer' },
        byType: {
          type: 'object',
          description: 'Counts per Alert.type bucket (the documented set).',
          required: ['anomaly', 'budget', 'attendance', 'safety', 'progress', 'info'],
          properties: {
            anomaly: { type: 'integer' },
            budget: { type: 'integer' },
            attendance: { type: 'integer' },
            safety: { type: 'integer' },
            progress: { type: 'integer' },
            info: { type: 'integer' },
          },
        },
        latest: {
          type: 'array',
          description: 'The 5 newest alerts (newest first).',
          items: {
            type: 'object',
            required: ['id', 'type', 'severity', 'title', 'message', 'acknowledged', 'createdAt'],
            properties: {
              id: { type: 'string' },
              type: { type: 'string', description: 'anomaly, budget, safety, attendance, progress, info.' },
              severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
              title: { type: 'string' },
              message: { type: 'string', description: 'Carries the evidence and the rule key for deterministic findings.' },
              acknowledged: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
}

// ---- the document ------------------------------------------------------------

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'MjengoOS API v1',
    version: '1.0.0',
    description:
      'REST v1 surface of MjengoOS: wallet accounts, derived balances, double-entry ledger reads, money movement ' +
      'and payment execution (spec §38 wallets / §57 payments), the Phase B READ-ONLY projects + supply ' +
      'resources (project roster, honest summaries, task lists, purchase orders and delivery verification), the ' +
      'Phase C READ-ONLY money-governance resources (milestone release ladder, escrow balance, invoice lifecycle ' +
      'with 3-way-match verdicts), and the Phase D READ-ONLY site + market + intel resources (workers, attendance ' +
      'day-rows, task detail, supplier catalog, land parcels, intel digest, and the v1 mirror of the ' +
      'budget-variance report).\n\n' +
      '**Honest scope notes** — money is KES-only; the payment provider rails are SIMULATED (each response ' +
      'carries an honest integrationNote; a real Daraja/bank provider plugs into the same seam); balances are ' +
      'always derived from ledger entries, never stored; every v1 mutation lives in the wallet/payment family — ' +
      'milestones, escrow, invoices, workers, attendance, tasks, suppliers, parcels and intel are READ-ONLY here ' +
      '(their mutations stay on POST /api/actions).\n\n' +
      '**Auth** — NextAuth credentials session (HttpOnly, signed JWT cookie `next-auth.session-token`). ' +
      'Wallet routes: finance+admin. Payments: finance, admin, or the project-pinned client. ' +
      'No API keys, no OAuth — cookie session only, same-origin.\n\n' +
      '**Errors** — one shape everywhere: { error: string, field? } (400/401/403/404/409/422/429/500). ' +
      'The success shape is { ok: true, data, ... }; the `ok` flag never appears on errors.\n\n' +
      '**Idempotency** — send Idempotency-Key on every money mutation; a key repeated with the ' +
      'same payload returns the stored body (replayed: true); a key repeated with a DIFFERENT ' +
      'payload is refused with 409 (the stored result is never replayed for a request it did ' +
      'not produce).\n\n' +
      '**Pagination** — limit (1-200, default 50) + id cursor; responses carry nextCursor/hasMore.\n\n' +
      'This document is served unauthenticated at /api/openapi.json and is the SDK-generation seam ' +
      '(ARCHITECTURE.md roadmap). It covers exactly the 27 /api/v1 route paths — the wallet + payment surface, ' +
      'the Phase B READ-ONLY projects + supply resources (projects list/detail/tasks/deliveries, supply orders ' +
      'list/detail), the Phase C READ-ONLY money-governance resources (milestones list/detail, escrow, ' +
      'invoices list/detail — no mutations outside the money family), and the Phase D READ-ONLY site + market + ' +
      'intel resources (workers list/detail, attendance, task detail, suppliers, parcels, intel digest, ' +
      'budget-variance mirror — no mutations at all) — plus the three enumerated app reads: ' +
      '/api/audit (admin audit log, spec §44), /api/reports/budget-variance (QS report), and the ' +
      'document-intelligence route /api/ai/extract-document (GET review queue / POST extraction draft / PUT ' +
      'human review gate; issue #153 — the one non-v1 mutation surface documented here, because its review ' +
      'gate is the app\'s "AI assists, humans decide" control and it now has an operator surface in the ' +
      'Copilot tab). The other 30 route paths are deliberately OUT of this document — the app mutation surface ' +
      '(/api/actions with its 124 action types, /api/sync), the webapp-private reads and upload/push families, ' +
      'the remaining /api/ai/* routes (analyze-photo, voice-log, parse-text, anomaly-scan, recap, ' +
      'authenticity-screen), and the external-by-design USSD/WhatsApp/Daraja gateway contracts: their ' +
      'contracts are documented at their seams (runtime GET contracts on the gateway routes, the ActionType ' +
      'registry + route zod schemas, the API baseline inventory). That scope decision — the full pointer ' +
      'table and the revisit triggers (API-10 registry, mobile client, integrator program) — is recorded in ' +
      'ADR 0008 (docs/adr/0008-openapi-scope.md).',
  },
  servers: [{ url: '/', description: 'Same-origin (the app that rendered this document).' }],
  tags: [
    { name: 'wallets', description: 'Wallet accounts, balances and ledger transactions (finance/admin).' },
    { name: 'payments', description: 'Payment execution for approved payment requests (finance/admin/client).' },
    { name: 'projects', description: 'Read-only project roster, honest summaries and task lists (any signed-in role; client-role sessions pinned to their own project).' },
    { name: 'supply', description: 'Read-only procurement reads: purchase orders and delivery verification (any signed-in role, client pinned; gated by the marketplace flag for non-admins).' },
    { name: 'milestones', description: 'Read-only escrow & milestone release ladder (any signed-in role, client pinned; deliberately NOT gated by the wallet flag — the client release flow must survive it, per the flag\'s documented boundary).' },
    { name: 'invoices', description: 'Read-only supplier invoice lifecycle with 3-way-match verdicts (any signed-in role, client pinned; not gated by the marketplace flag — invoices are their own module sharing the Finder tab).' },
    { name: 'workers', description: 'Read-only workforce roster + attendance day-rows with the Workforce Trust verification states (any signed-in role, client pinned; no flag gates the workforce surface).' },
    { name: 'land', description: 'Read-only land parcels with the verification ladder summary (any signed-in role, client pinned; gated by the land_verification flag for non-admins, mirroring the webapp parcels section).' },
    { name: 'intel', description: 'Read-only intel digest: flags state, latest MjengoScore, risk, health, weekly digest and the anomalies summary (any signed-in role, client pinned; no flag gates the intel reads).' },
    { name: 'audit', description: 'Admin audit-log reads — the append-only event ledger (admin only, spec §44).' },
    { name: 'reports', description: 'QS / cost-plan reports: budget variance per phase and category (contractor, admin, supervisor, qs).' },
    { name: 'documents', description: 'Document intelligence: extraction drafts (AI) + the human review gate (contractor, admin, supervisor — issue #153).' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'next-auth.session-token',
        description:
          'NextAuth v4 credentials session cookie (HttpOnly, signed with NEXTAUTH_SECRET). Obtain it by signing in ' +
          'through the app login (/api/auth/callback/credentials — CSRF dance required, so scripted clients should ' +
          'drive a browser session). Absent/expired → 401; wrong role → 403.',
      },
    },
    schemas: {
      Error: errorSchema,
      RateError: rateErrorSchema,
      WalletSummary: okWalletSummaryItem,
      WalletDetail: {
        type: 'object',
        required: ['id', 'code', 'label', 'ownerType', 'currency', 'status', 'balance'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          label: { type: 'string' },
          ownerType: { type: 'string', enum: ['project', 'organization', 'supplier', 'user'] },
          ownerId: { type: ['string', 'null'] },
          currency: { const: 'KES' },
          status: { type: 'string', enum: ['active', 'frozen', 'closed'] },
          ledgerAccountId: { type: ['string', 'null'] },
          balance: { type: 'number', description: 'Derived from ledger entries — never a stored field.' },
        },
      },
      WalletBalance: {
        type: 'object',
        required: ['wallet', 'currency', 'balance', 'derivation'],
        properties: {
          wallet: { type: 'string', description: 'Wallet code.' },
          currency: { const: 'KES' },
          balance: { type: 'number' },
          derivation: { const: 'ledger entries (debits − credits on the backing liability account)' },
        },
      },
      ProviderRail: {
        type: 'object',
        required: ['method', 'provider', 'label', 'integrationNote'],
        properties: {
          method: { type: 'string', description: 'Payment method key, e.g. mpesa.' },
          provider: { type: 'string' },
          label: { type: 'string' },
          integrationNote: { type: 'string', description: 'Honest per-rail integration state (simulated by default; Daraja sandbox when env-configured).' },
        },
      },
      WalletTransactionsPage: {
        type: 'object',
        required: ['wallet', 'balance', 'transactions', 'nextCursor', 'hasMore'],
        properties: {
          wallet: {
            type: 'object',
            required: ['code', 'label'],
            properties: {
              code: { type: 'string' },
              label: { type: 'string' },
              ledgerAccount: { type: 'string', description: 'Absent when the wallet has no backing ledger account (empty ledger).' },
            },
          },
          balance: { type: 'number' },
          transactions: { type: 'array', items: ledgerTxnSchema },
          nextCursor: { type: ['string', 'null'], description: 'LedgerTransaction id to pass as ?cursor; null on the last page.' },
          hasMore: { type: 'boolean' },
        },
      },
      WalletCreateResult: {
        type: 'object',
        required: ['id', 'code', 'ledgerAccount', 'balance'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string' },
          ledgerAccount: { type: 'string', description: 'e.g. WALLET:W-0003.' },
          balance: { type: 'number', description: '0 for a fresh wallet.' },
        },
      },
      DepositWithdrawResult: {
        type: 'object',
        required: ['walletCode', 'ledgerRef', 'balance'],
        properties: {
          walletCode: { type: 'string' },
          ledgerRef: { type: 'string', description: 'Ledger transaction ref, e.g. LX-2026-000004.' },
          balance: { type: 'number', description: 'Wallet balance AFTER the move, derived inside the same db transaction.' },
        },
      },
      TransferResult: {
        type: 'object',
        required: ['from', 'to', 'ledgerRef'],
        properties: {
          from: { type: 'string', description: 'Source wallet code.' },
          to: { type: 'string', description: 'Destination wallet code.' },
          ledgerRef: { type: 'string' },
        },
      },
      PaymentResult: {
        type: 'object',
        required: ['id', 'status', 'transactionId', 'ledgerRef', 'providerNote'],
        properties: {
          id: { type: 'string', description: 'PaymentRequest id.' },
          status: { const: 'paid' },
          transactionId: { type: 'string', description: 'Legacy Transaction row id (carries ledgerTxnId + costCode).' },
          ledgerRef: { type: 'string' },
          balance: { type: 'number', description: 'Present for wallet (escrow) payments — escrow balance after spend.' },
          providerNote: { type: 'string', description: 'Honest rail note (simulated by default; Daraja sandbox when env-configured).' },
        },
      },
      AuditEvent: auditEventSchema,
      BudgetVarianceReport: budgetVarianceSchema,
      ProjectListItem: projectListItemSchema,
      ProjectDetail: projectDetailSchema,
      TaskSummary: taskSummarySchema,
      DeliveryVerification: deliveryVerificationSchema,
      SupplyOrderSummary: supplyOrderSummarySchema,
      SupplyOrderDetail: supplyOrderDetailSchema,
      MilestoneSummary: milestoneSummarySchema,
      MilestoneDetail: milestoneDetailSchema,
      InvoiceSummary: invoiceSummarySchema,
      InvoiceDetail: invoiceDetailSchema,
      ThreeWayMatch: threeWayMatchSchema,
      ProjectEscrow: projectEscrowSchema,
      WorkerSummary: workerSummarySchema,
      WorkerDetail: workerDetailSchema,
      AttendanceRecord: attendanceRecordSchema,
      TaskDetail: taskDetailSchema,
      SupplierCatalogSummary: supplierCatalogSummarySchema,
      ParcelSummary: parcelSummarySchema,
      IntelDigest: intelDigestSchema,
      DocumentExtraction: documentExtractionSchema,
      DocumentReviewItem: documentReviewItemSchema,
    },
  },
  paths: {
    '/api/v1/wallets': {
      get: {
        tags: ['wallets'],
        operationId: 'listWallets',
        summary: 'List wallets (paginated) or the provider-rail surface',
        description:
          'Every wallet with its ledger-derived balance, ordered by code. With ?providers=1 returns the payment-rail ' +
          'introspection instead (bounded static list — pagination does not apply there). ' +
          'Backward compatible: `data` stays the array; pagination metadata (nextCursor, hasMore) rides top-level. ' +
          'Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdParam('filters to that project\'s wallets plus platform wallets'),
          {
            name: 'providers',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['1'] },
            description: 'Set to "1" to list the payment provider rails instead of wallets.',
          },
          limitParam,
          cursorParam('a WalletAccount id'),
        ],
        responses: {
          200: {
            description: 'ok: true. data = wallet page (or provider rails with ?providers=1).',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    ok({ type: 'array', items: { $ref: '#/components/schemas/WalletSummary' } }),
                    ok({ type: 'array', items: { $ref: '#/components/schemas/ProviderRail' } }),
                  ],
                },
              },
            },
          },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
      post: {
        tags: ['wallets'],
        operationId: 'createWallet',
        summary: 'Create a wallet',
        description:
          'Creates a WalletAccount + its backing liability ledger account (code WALLET:W-nnnn). Project wallets need ' +
          'projectId (body or a project-bound session). Idempotency-Key honored. Rate limit: 30/min per principal.',
        security,
        parameters: [idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 120 },
                  ownerType: { type: 'string', enum: ['project', 'organization', 'supplier', 'user'], default: 'project' },
                  ownerId: { type: 'string', minLength: 1, maxLength: 40, description: 'Explicit owner (organization/supplier/user).' },
                  projectId: { type: 'string', minLength: 1, maxLength: 40, description: 'Required for project wallets.' },
                  currency: { type: 'string', enum: ['KES'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = WalletCreateResult.', ...json(ok({ $ref: '#/components/schemas/WalletCreateResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}': {
      get: {
        tags: ['wallets'],
        operationId: 'getWallet',
        summary: 'Get one wallet (id or code)',
        description: 'Wallet with its ledger-derived balance. Rate limit: 120/min per principal.',
        security,
        parameters: [walletIdParam, projectIdParam('cross-project wallets resolve to 404')],
        responses: {
          200: { description: 'ok: true, data = WalletDetail.', ...json(ok({ $ref: '#/components/schemas/WalletDetail' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/balance': {
      get: {
        tags: ['wallets'],
        operationId: 'getWalletBalance',
        summary: 'Derived balance of a wallet',
        description: 'The balance computed from the backing account\'s debit/credit entries (never stored). Rate limit: 120/min.',
        security,
        parameters: [walletIdParam, projectIdParam('cross-project wallets resolve to 404')],
        responses: {
          200: { description: 'ok: true, data = WalletBalance.', ...json(ok({ $ref: '#/components/schemas/WalletBalance' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/transactions': {
      get: {
        tags: ['wallets'],
        operationId: 'listWalletTransactions',
        summary: 'Ledger transactions of a wallet (cursor-paginated)',
        description:
          'Double-entry transactions touching the wallet\'s backing account, newest first (occurredAt DESC, id DESC ' +
          'tiebreak), with per-leg entries and debit totals. True keyset pagination: limit (1-200, default 50) + ' +
          'cursor (LedgerTransaction id) — pages never overlap. Default page is 50 (was a hard 100 before v1.1). ' +
          'Rate limit: 120/min per principal.',
        security,
        parameters: [walletIdParam, projectIdParam('cross-project wallets resolve to 404'), limitParam, cursorParam('a LedgerTransaction id of this wallet')],
        responses: {
          200: { description: 'ok: true, data = WalletTransactionsPage.', ...json(ok({ $ref: '#/components/schemas/WalletTransactionsPage' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/deposit': {
      post: {
        tags: ['wallets'],
        operationId: 'depositWallet',
        summary: 'Deposit cash into a wallet',
        description:
          'Debits the cash rail (CASH_MPESA/CASH_BANK), credits WALLET:<code> — one db transaction; the returned balance ' +
          'reflects the deposit. Idempotency-Key honored (failures never recorded). Rate limit: 30/min per principal.',
        security,
        parameters: [walletIdParam, idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: {
                  amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000, description: 'KES; at most 2 decimal places.' },
                  source: { type: 'string', enum: ['mpesa', 'bank'], default: 'mpesa' },
                  reference: { type: 'string', maxLength: 200, description: 'Unique reference = natural ledger idempotency.' },
                  currency: { type: 'string', enum: ['KES'] },
                  projectId: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = DepositWithdrawResult.', ...json(ok({ $ref: '#/components/schemas/DepositWithdrawResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/transfer': {
      post: {
        tags: ['wallets'],
        operationId: 'transferWallet',
        summary: 'Transfer between wallets',
        description:
          'Debits the source WALLET account, credits the destination, balance re-checked INSIDE the transaction ' +
          '(overdraft → 400 "Insufficient wallet balance…"). Transferring to the same wallet → 422 (nothing recorded). ' +
          'Idempotency-Key honored. Rate limit: 30/min per principal.',
        security,
        parameters: [walletIdParam, idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['toWalletId', 'amount'],
                additionalProperties: false,
                properties: {
                  toWalletId: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9_-]{2,40}$', description: 'Destination wallet id or code.' },
                  amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000, description: 'KES; at most 2 decimal places.' },
                  note: { type: 'string', maxLength: 500 },
                  currency: { type: 'string', enum: ['KES'] },
                  projectId: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = TransferResult.', ...json(ok({ $ref: '#/components/schemas/TransferResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          422: {
            description: 'Structurally valid but nonsensical: source and destination are the same wallet. Body { error, field: "toWalletId" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/wallets/{id}/withdraw': {
      post: {
        tags: ['wallets'],
        operationId: 'withdrawWallet',
        summary: 'Withdraw from a wallet to a cash rail',
        description:
          'Debits WALLET:<code>, credits the cash rail; balance re-checked INSIDE the transaction (overdraft → 400). ' +
          'Idempotency-Key honored. Rate limit: 30/min per principal.',
        security,
        parameters: [walletIdParam, idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: {
                  amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000, description: 'KES; at most 2 decimal places.' },
                  destination: { type: 'string', enum: ['mpesa', 'bank'], default: 'mpesa' },
                  note: { type: 'string', maxLength: 500 },
                  currency: { type: 'string', enum: ['KES'] },
                  projectId: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = DepositWithdrawResult.', ...json(ok({ $ref: '#/components/schemas/DepositWithdrawResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/payments': {
      post: {
        tags: ['payments'],
        operationId: 'payPaymentRequest',
        summary: 'Pay an approved payment request',
        description:
          'Pays an APPROVED PaymentRequest through the provider seam (simulated rails) and posts a balanced double-entry ' +
          'ledger transaction (escrow spend for method=wallet). Client-role sessions are pinned to their own project (403). ' +
          'There is no list endpoint on /api/v1/payments — pagination does not apply. Idempotency-Key honored. ' +
          'Rate limit: 30/min per principal.',
        security,
        parameters: [idempotencyParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'paymentRequestId or the legacy id alias (both accept cuid or requestCode like PR-2026-000001).',
                additionalProperties: false,
                properties: {
                  paymentRequestId: { type: 'string', minLength: 1, maxLength: 40 },
                  id: { type: 'string', minLength: 1, maxLength: 40 },
                  method: { type: 'string', enum: ['mpesa', 'bank', 'card', 'wallet', 'cash'] },
                  reference: { type: 'string', maxLength: 200 },
                  costCode: { type: 'string', maxLength: 120 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'ok: true, data = PaymentResult.', ...json(ok({ $ref: '#/components/schemas/PaymentResult' })) },
          400: badRequestResponse,
          401: unauthorizedResponse,
          403: forbiddenResponse,
          404: notFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects': {
      get: {
        tags: ['projects'],
        operationId: 'listProjects',
        summary: 'List projects (role-scoped, cursor-paginated)',
        description:
          'The lightweight project roster — the same getProjectsList() rows the webapp project switcher renders ' +
          '(budgetTotal = Σ Phase.budget, budgetSpent = Σ Transaction.amount, progressPct = budget-weighted phase ' +
          'progress; no new money math in /api/v1). GUARD: any signed-in session; a CLIENT-role session sees exactly ' +
          'its own project (a client with no pinned project sees an empty list — never the portfolio), every other ' +
          'role sees the whole portfolio — the webapp /api/projects guard, mirrored. No feature flag gates this ' +
          'resource (none of the five flags names it). ?q= searches name/client (contains, ASCII case-insensitive, ' +
          'in-memory); ?status= filters to one of the documented values (the column is free-form — undocumented ' +
          'values stay visible unfiltered). Filters apply BEFORE pagination — a cursor that falls out of the filtered ' +
          'list → 400. Ordered createdAt ASC (the service order). Rate limit: 120/min per principal.',
        security,
        parameters: [
          searchParam,
          statusParam(['active', 'completed', 'on_hold'], 'project status'),
          limitParam,
          cursorParam('a project id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/ProjectListItem' }, 'project id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}': {
      get: {
        tags: ['projects'],
        operationId: 'getProject',
        summary: 'One project with its honest summary',
        description:
          'Project core + honest summary: progressPct, dayCount/daysRemaining, the budget view (total = Σ Phase.budget, ' +
          'spent = Σ Transaction.amount, plan deltas), the procurement view (committed = Σ totals of ' +
          'sent/confirmed/delivering orders — the budget-vs-committed dimension) and task counts by status. Every ' +
          'figure is an EXISTING aggregation: ProjectSummary from getProjectPayload (the webapp main read) plus the ' +
          'pure procurementTotals module wired exactly like the Finder dashboard tiles — zero new money math. HONEST ' +
          'OMISSION: shareToken is never exposed (it is a bearer capability for share links, not a data field). ' +
          'GUARD: any signed-in role; client-role sessions pinned to their own project (resolve-first, pin-second — ' +
          'a foreign id → 403); unknown id → 404. Heavyweight read (the full payload aggregation). No feature flag ' +
          'gates this resource. Rate limit: 120/min per principal.',
        security,
        parameters: [projectIdPathParam],
        responses: {
          200: { description: 'ok: true, data = ProjectDetail.', ...json(ok({ $ref: '#/components/schemas/ProjectDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/tasks': {
      get: {
        tags: ['projects'],
        operationId: 'listProjectTasks',
        summary: 'Task list of a project (cursor-paginated)',
        description:
          'Every task of the project with its phase, priority, assignment, blocker and verification fields. Data comes ' +
          'from a DIRECT db.task.findMany scoped to the project\'s phases (issue #154 — the page never materializes the ' +
          'webapp payload): ?status=, the keyset boundary and take = limit+1 all ride the single query, ordered ' +
          '(createdAt ASC, id ASC) for a deterministic keyset — the same total order the old in-memory sort produced. ' +
          'A cursor that falls out of the filtered ' +
          'list → 400. GUARD: any signed-in role; client-role sessions pinned to their own project (foreign → 403); ' +
          'unknown project → 404. No feature flag gates this resource. Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(['pending', 'in_progress', 'done', 'blocked'], 'task status'),
          limitParam,
          cursorParam('a task id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/TaskSummary' }, 'task id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/deliveries': {
      get: {
        tags: ['supply'],
        operationId: 'listProjectDeliveries',
        summary: 'Delivery verification records of a project (cursor-paginated)',
        description:
          'Every OrderDelivery against every purchase order of the project — the supply loop\'s physical ground ' +
          'truth: status (dispatched → in_transit → arrived → received | discrepancy, or cancelled — a voided ' +
          'dispatch, issue #206), the §26 driver leg, per-line ' +
          'ordered vs received vs rejected counts with inspection condition, and discrepancy flags (shortLines = ' +
          'receiveDelivery\'s exact short-line predicate). EVIDENCE PHOTOS are referenced by ATTACHMENT ID ONLY — ' +
          'no photo bytes and no storage URLs are served by /api/v1; fetch them through the app\'s own storage seam. ' +
          'Issue #155 (API-4): the deliveries ride loadSupplyOrdersBounded — the supply module\'s bounded orders ' +
          'read (take-capped at 200; the full network stays on detail surfaces), so a page beyond that window of ' +
          'newest orders reports hasMore: false. FEATURE FLAG (spec §81): gated by `marketplace` — OFF → 403 for non-admin sessions (admins bypass), the ' +
          'same uniform gate the v1 wallet family applies for `wallet`. GUARD: any signed-in role; client-role ' +
          'sessions pinned to their own project (foreign → 403); unknown project → 404. ?status= filters BEFORE ' +
          'pagination (a cursor that falls out → 400). Ordered (createdAt DESC, id DESC). Rate limit: 120/min per ' +
          'principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(['dispatched', 'in_transit', 'arrived', 'received', 'discrepancy', 'cancelled'], 'delivery status'),
          limitParam,
          cursorParam('a delivery id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/DeliveryVerification' }, 'delivery id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/supply/orders': {
      get: {
        tags: ['supply'],
        operationId: 'listSupplyOrders',
        summary: 'Purchase orders of one project (cursor-paginated)',
        description:
          'The purchase orders of ONE project — loadSupplyOrdersBounded(projectId), the supply module\'s bounded ' +
          'list read (issue #155 / API-4: the orders network alone, take-capped at 200 at the DB — the full ' +
          'loadSupplySlice network stays on the detail surfaces), projected to order summaries with supplier name, ' +
          'landed totals and delivery counts. A page beyond the 200-order window reports hasMore: false (the ' +
          'documented bound, the search-route MAX_SCAN honesty convention). FEATURE FLAG (spec §81): gated by ' +
          '`marketplace` — OFF → 403 for ' +
          'non-admin sessions (admins bypass). GUARD: any signed-in role; client-role sessions pinned to their own ' +
          'project (a foreign projectId → 403, the v1 payments precedent). projectId is REQUIRED — the Finder surface ' +
          'is project-scoped (absent → 400; unknown → 404 — no default-project guessing, mirroring the ' +
          'budget-variance report). ?status= filters to one of the nine PurchaseOrder statuses BEFORE pagination (a ' +
          'cursor that falls out → 400). Ordered (createdAt DESC, id DESC). Rate limit: 120/min per principal.',
        security,
        parameters: [
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 40 },
            description: 'The project whose orders to list. Required — absent → 400; unknown → 404.',
          },
          statusParam(
            ['draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed', 'cancelled'],
            'purchase-order status',
          ),
          limitParam,
          cursorParam('a purchase-order id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/SupplyOrderSummary' }, 'purchase-order id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/supply/orders/{id}': {
      get: {
        tags: ['supply'],
        operationId: 'getSupplyOrder',
        summary: 'One purchase order with lines and delivery records',
        description:
          'One purchase order (id OR orderCode) with its ordered lines (the paperwork side of the 3-way match) and its ' +
          'delivery-verification records (per-line counts, inspection condition, photo refs as attachment ids only). ' +
          'Read via a route-layer include — the supply module\'s public read is the whole-project slice and no ' +
          'single-order service read exists (the wallet-transactions precedent; the module stays untouched). ' +
          'FEATURE FLAG (spec §81): gated by `marketplace` — OFF → 403 for non-admin sessions (admins bypass). ' +
          'GUARD: resolve-first, pin-second (the v1 payments precedent) — the order resolves by id or orderCode, then ' +
          'a client-role session must be pinned to the order\'s own project (else 403). Unknown order → 404. ' +
          'Pagination does not apply (one object). Rate limit: 120/min per principal.',
        security,
        parameters: [orderIdPathParam],
        responses: {
          200: { description: 'ok: true, data = SupplyOrderDetail.', ...json(ok({ $ref: '#/components/schemas/SupplyOrderDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: orderNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/milestones': {
      get: {
        tags: ['milestones'],
        operationId: 'listProjectMilestones',
        summary: 'Milestone release ladder of a project (cursor-paginated)',
        description:
          'The escrow/milestone release ladder (MjengoPay, spec §28-29): locked → evidence_submitted → ' +
          'release_requested → released | rejected, every rung money-proven by the double-entry ledger. Data comes ' +
          'from a DIRECT db.milestone.findMany scoped to the project (issue #154 — the same rows the webapp payload\'s ' +
          'milestones read returns, without materializing the payload), plus the one related read the summaries need ' +
          '(the project\'s phase id→name pairs); ?status=, the keyset boundary and take = limit+1 all ride the single ' +
          'query, ordered (createdAt ASC, id ASC). READ-ONLY: ' +
          'every mutation (milestone.create / evidence / requestRelease / decide) stays on POST /api/actions — v1 ' +
          'never moves escrow. NO FEATURE FLAG (honest boundary, flags.ts): the `wallet` flag gates the user-facing ' +
          'wallet & payment-request surface but deliberately NOT the escrow/milestone governance ladder — "the ' +
          'client\'s release flow must survive" while it is off. GUARD: any signed-in role; client-role sessions ' +
          'pinned to their own project (foreign → 403); unknown project → 404. ?status= filters BEFORE pagination ' +
          '(a cursor that falls out → 400). Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(
            ['locked', 'evidence_submitted', 'release_requested', 'approved', 'released', 'rejected'],
            'milestone status',
          ),
          limitParam,
          cursorParam('a milestone id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/MilestoneSummary' }, 'milestone id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: moneyGovernanceForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/milestones/{id}': {
      get: {
        tags: ['milestones'],
        operationId: 'getMilestone',
        summary: 'One milestone: ladder timestamps, evidence photo ids, decision history, release ledger',
        description:
          'One milestone with its full ladder — requestedAt/decidedAt/releasedAt (null until each rung is reached), ' +
          'the parsed evidencePhotoIds (SitePhoto IDS ONLY — no bytes, no storage URLs in /api/v1), the decision ' +
          'history (decidedAt/decidedBy/decisionNote, kept forever on rejected milestones too) and the release\'s ' +
          'ledger proof: the Transaction row the runtime release posts (type milestone, reference MJP-<id tail> — ' +
          'the A-1-lite convention). releaseLedger is honestly null for not-released milestones and pre-ledger ' +
          'seeded history. READ-ONLY — mutations stay on POST /api/actions (milestone.decide is CLIENT-only there). ' +
          'NO FEATURE FLAG (the wallet flag\'s documented boundary keeps the release ladder alive while it is off). ' +
          'GUARD: resolve-first, pin-second (the v1 payments precedent) — a client-role session must be pinned to ' +
          'the milestone\'s own project (else 403). Unknown milestone → 404. Read via a route-layer findFirst (the ' +
          'money module has no public single-milestone read — the wallet-transactions precedent). Pagination does ' +
          'not apply (one object). Rate limit: 120/min per principal.',
        security,
        parameters: [milestoneIdPathParam],
        responses: {
          200: { description: 'ok: true, data = MilestoneDetail.', ...json(ok({ $ref: '#/components/schemas/MilestoneDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: moneyGovernanceForbiddenResponse,
          404: milestoneNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/invoices': {
      get: {
        tags: ['invoices'],
        operationId: 'listProjectInvoices',
        summary: 'Supplier invoices of a project (cursor-paginated)',
        description:
          'The supplier-invoice lifecycle (Finder §13-15): draft → submitted → approved | rejected | disputed → ' +
          'paid, with totals and payment references — disputed and paid states represented exactly as stored. Data ' +
          'comes from a DIRECT db.invoice.findMany scoped to the project (issue #154 — the same rows the invoices ' +
          'module\'s loadInvoicesSlice returns, with only the line-count/supplier-name/order-code joins the summary ' +
          'needs; the slice\'s ledgerCheck reads are not paid here); the supplier row pin, ?status=, the keyset ' +
          'boundary and take = limit+1 all ride the single query, ordered (createdAt DESC, id DESC). READ-ONLY: every mutation (invoice.create / update / submit / decide / pay; ' +
          'disputes ride invoice.update { status: "disputed" }) stays on POST /api/actions — v1 never records ' +
          'payments. NO FEATURE FLAG (honest boundary, flags.ts): the `marketplace` flag gates the supply loop but ' +
          'explicitly NOT invoice.* (its own module sharing the Finder tab), and the wallet flag never applied to ' +
          'it either. GUARD: any signed-in role; client-role sessions pinned to their own project (foreign → 403); ' +
          'unknown project → 404. ?status= (the six InvoiceStatus values) filters BEFORE pagination (a cursor that ' +
          'falls out → 400). Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(['draft', 'submitted', 'approved', 'rejected', 'paid', 'disputed'], 'invoice status'),
          limitParam,
          cursorParam('an invoice id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/InvoiceSummary' }, 'invoice id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: moneyGovernanceForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/invoices/{id}': {
      get: {
        tags: ['invoices'],
        operationId: 'getInvoice',
        summary: 'One invoice: lifecycle, lines, totals, payment refs + the 3-way-match verdict',
        description:
          'One supplier invoice (id OR invoiceCode) with its full lifecycle, lines, totals, payment references and ' +
          'the 3-WAY-MATCH VERDICT (PO ↔ invoice ↔ delivery) — recomputed per request by modules/invoices/' +
          'three-way.ts through the module\'s own read-only threeWayCheck: the exact function /api/actions ' +
          'invoice.threeWayCheck runs, so this detail and the invoice.pay gate can never disagree. The verdict is ' +
          'WARN-ONLY by design (the module\'s honesty rules): discrepancies are "review required" language, never ' +
          'accusations — an authorized payment with open items carries the payer\'s acknowledgeMismatch decision in ' +
          'the Approval trail. Read via a route-layer include (lines + supplier + order — the loadInvoicesSlice ' +
          'columns; the wallet-transactions precedent). READ-ONLY — mutations stay on POST /api/actions. NO FEATURE ' +
          'FLAG (invoices are not gated by marketplace or wallet — see flags.ts). GUARD: resolve-first, pin-second ' +
          '(the v1 payments precedent) — a client-role session must be pinned to the invoice\'s own project (else ' +
          '403). Unknown invoice → 404. Pagination does not apply (one object). Rate limit: 120/min per principal.',
        security,
        parameters: [invoiceIdPathParam],
        responses: {
          200: { description: 'ok: true, data = InvoiceDetail (carries threeWayMatch).', ...json(ok({ $ref: '#/components/schemas/InvoiceDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: moneyGovernanceForbiddenResponse,
          404: invoiceNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/escrow': {
      get: {
        tags: ['milestones'],
        operationId: 'getProjectEscrow',
        summary: 'The project escrow position (ledger-derived balance)',
        description:
          'The project\'s escrow position. THE LEDGER NEVER LIES (spec §39 / roadmap §8): balance is DERIVED from ' +
          'the ESCROW:<projectId> ledger account\'s entries (credits − debits on the liability account) via the ' +
          'ledger module\'s derivedBalance() — the ONLY way a balance is known, the same derivation the v1 wallet ' +
          'family uses. It is NEVER the stored EscrowWallet.balance projection (F-MONEY keeps that projection in ' +
          'sync inside the posting transaction; this route simply does not read it, so any drift surfaces here ' +
          'honestly instead of being copied). A project with no escrow account yet (created lazily by the first ' +
          'top-up) derives an honest 0 — this route never creates the account and never writes anything. READ-ONLY: ' +
          'escrow.topup and milestone releases stay on POST /api/actions. NO FEATURE FLAG (the wallet flag\'s ' +
          'documented boundary keeps the escrow governance ladder alive while it is off). GUARD: any signed-in role; ' +
          'client-role sessions pinned to their own project (foreign → 403); unknown project → 404. Pagination does ' +
          'not apply (one object). Rate limit: 120/min per principal.',
        security,
        parameters: [projectIdPathParam],
        responses: {
          200: { description: 'ok: true, data = ProjectEscrow (balance + ledgerAccountCode + the honest derivation note).', ...json(ok({ $ref: '#/components/schemas/ProjectEscrow' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: moneyGovernanceForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/workers': {
      get: {
        tags: ['workers'],
        operationId: 'listProjectWorkers',
        summary: 'Workforce roster of a project with the attendance rollup (cursor-paginated)',
        description:
          'The project\'s workforce roster (Doc A §14) — identity, trade, terms, and the SAME todayStatus/' +
          'weekEarnings derivation the webapp Team tab renders (a DIRECT db.worker.findMany since issue #154; the ' +
          'rollup re-derives with the payload\'s exact logic — EAT "today" and trailing 7 calendar days — over ONE ' +
          'bounded attendance read of the page\'s workers inside an 8-day window, never the project\'s whole ' +
          'attendance history). HONEST: the LIST carries no total attendance count (the true counts are on GET ' +
          '/api/v1/workers/{id}), and ' +
          'Worker has no createdAt column, so the deterministic keyset order is the payload\'s own (name ASC, id ASC) ' +
          '— pushed into the findMany with take = limit+1. ' +
          'READ-ONLY — worker mutations stay on POST /api/actions (team.* / attendance.*). NO FEATURE FLAG (none of ' +
          'the five flags names the workforce surface — gating it by an unrelated flag would be dishonest, the ' +
          'projects-resource precedent). GUARD: any signed-in role; client-role sessions pinned to their own project ' +
          '(foreign → 403); supplier-role sessions → uniform 403 (W5-3 — suppliers are not project readers); ' +
          'unknown project → 404. ?active= (true|false — the one Worker boolean column) filters BEFORE pagination ' +
          '(a cursor that falls out → 400). Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          {
            name: 'active',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false'] },
            description: 'The roster\'s live/inactive split (the Worker.active boolean). Applies BEFORE pagination.',
          },
          limitParam,
          cursorParam('a worker id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/WorkerSummary' }, 'worker id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: workforceForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/workers/{id}': {
      get: {
        tags: ['workers'],
        operationId: 'getWorker',
        summary: 'One worker: identity, terms, the FULL attendance summary + recent day rows',
        description:
          'One worker with the attendance summary the list honestly cannot carry: true counts over the worker\'s ' +
          'WHOLE history (by status, by verification — the Workforce Trust states), paid/unpaid wage totals, and ' +
          'the 14 most recent day rows. Read via a route-layer include (the workforce module has no public ' +
          'single-worker read — the wallet-transactions precedent); todayStatus/weekEarnings re-derive with the ' +
          'payload\'s exact logic so the two reads can never disagree. HONEST OMISSION: Worker.pin (the 4-digit ' +
          'kiosk PIN — a bearer credential for the shared site device) is never served, the same rule that keeps ' +
          'project.shareToken out of v1. READ-ONLY — mutations stay on POST /api/actions (team.* / attendance.*). ' +
          'NO FEATURE FLAG (the workforce-family precedent). GUARD: resolve-first, pin-second (the v1 payments ' +
          'precedent) — a client-role session must be pinned to the worker\'s own project (else 403); a supplier ' +
          'session → uniform 403. Unknown worker → 404. Pagination does not apply (one object). Rate limit: ' +
          '120/min per principal.',
        security,
        parameters: [workerIdPathParam],
        responses: {
          200: { description: 'ok: true, data = WorkerDetail.', ...json(ok({ $ref: '#/components/schemas/WorkerDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: workforceForbiddenResponse,
          404: workerNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/attendance': {
      get: {
        tags: ['workers'],
        operationId: 'listProjectAttendance',
        summary: 'Attendance day-rows of a project (cursor-paginated, filterable by worker/status/day)',
        description:
          'The project\'s attendance day-rows (Doc A §15-16) — the Workforce Trust surface: reported vs verified ' +
          'presence, exceptions and their reasons, and the paid state the payroll gate consumes. Evidence and the ' +
          'append-only override log surface as COUNTS ONLY (evidenceCount/overrideCount), never raw payloads. Read ' +
          'via a route-layer include (worker name/role join — the wallet-transactions precedent). READ-ONLY — ' +
          'attendance mutations stay on POST /api/actions (attendance.checkin / record / override / payroll.*). NO ' +
          'FEATURE FLAG (the workforce-family precedent). GUARD: any signed-in role; client-role sessions pinned to ' +
          'their own project (foreign → 403); supplier-role sessions → uniform 403 (W5-3); unknown project → 404. ' +
          'The page is ordered (createdAt DESC, id DESC) — newest day-rows first, the invoices-list precedent — ' +
          'and since issue #155 (API-4) the filters, the keyset boundary and take = limit + 1 are pushed INTO the ' +
          'findMany (DB-level keyset: page 2 never re-reads page 1 rows; the scan is bounded by the page, not the ' +
          'table). ' +
          'FILTERS (all BEFORE pagination): ?workerId= (a worker of this project — a foreign or unknown id matches ' +
          'no rows and answers an honest empty page, the never-written-status precedent), ?status= (present, absent, ' +
          'half_day, excused), ?date= (an exact YYYY-MM-DD calendar day — the column IS a date string). Rate limit: ' +
          '120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          {
            name: 'workerId',
            in: 'query',
            required: false,
            schema: { type: 'string', minLength: 1, maxLength: 40 },
            description: 'Only this worker\'s rows. A foreign/unknown worker id matches no rows (honest empty page).',
          },
          statusParam(['present', 'absent', 'half_day', 'excused'], 'attendance status'),
          {
            name: 'date',
            in: 'query',
            required: false,
            schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            description: 'One exact calendar day (YYYY-MM-DD — the EAT day-sheet).',
          },
          limitParam,
          cursorParam('an attendance record id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/AttendanceRecord' }, 'attendance record id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: workforceForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/tasks/{id}': {
      get: {
        tags: ['projects'],
        operationId: 'getTask',
        summary: 'One task: v2 fields, assignment and blocker joins, verification trail',
        description:
          'One task of the v2 task model (Doc A §11) — every field GET /api/v1/projects/{id}/tasks lists, plus the ' +
          'detail-only joins: assignedToName (the worker) and blockedByTitle (the blocker task). READ-ONLY — task ' +
          'mutations (task.create/update/assign/block/verify …) stay on POST /api/actions; Phase D deliberately ' +
          'exposes no task mutations (the actions layer owns them). NO FEATURE FLAG (the projects/tasks family ' +
          'precedent — no flag names the task surface). GUARD: resolve-first, pin-second — a client-role session ' +
          'must be pinned to the task\'s own project (else 403); a supplier session → uniform 403 (W5-3). Unknown ' +
          'task → 404. Read via a route-layer include (phase + assigned worker + blocker task — the ' +
          'wallet-transactions precedent). Pagination does not apply (one object). Rate limit: 120/min per principal.',
        security,
        parameters: [taskIdPathParam],
        responses: {
          200: { description: 'ok: true, data = TaskDetail.', ...json(ok({ $ref: '#/components/schemas/TaskDetail' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: projectsForbiddenResponse,
          404: taskNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/suppliers': {
      get: {
        tags: ['supply'],
        operationId: 'listProjectSuppliers',
        summary: 'Supplier catalog summary for a project (cursor-paginated)',
        description:
          'The supplier catalog summary the project\'s procurement sees (Finder §30): the marketplace directory ' +
          'rows with their catalogs plus THIS project\'s relationship marks (savedByProject, orderCount, ' +
          'orderTotal). HONEST SCOPE: Supplier rows are a GLOBAL directory (loadSupplierDirectoryBounded — the ' +
          'supply module\'s bounded directory read, issue #154: take-capped at 200 with the two small ' +
          'project-scoped reads the relationship marks need — the same rows the webapp Finder renders for the ' +
          'project, without the request/quote/order network); the project relationship ' +
          'is carried per row, never by silently filtering the directory. FEATURE FLAG: gated by `marketplace` like ' +
          'the rest of the v1 supply family — OFF → 403 for non-admins (admins bypass). GUARD: any signed-in role; ' +
          'client-role sessions pinned to their own project (foreign → 403); supplier-role sessions → uniform 403 ' +
          '(W5-3 — their OWN catalog is the /api/supplier portal surface, never this buyer directory); unknown ' +
          'project → 404. The page is ordered (createdAt ASC, id ASC) — the deterministic keyset (the webapp ' +
          'directory re-sorts by verification state for display). ?q= free-text search on businessName/county/town ' +
          '(contains, ASCII case-insensitive) filters BEFORE pagination over the bounded window (a page beyond the ' +
          '200-supplier window reports hasMore: false — the documented bound). READ-ONLY — catalog mutations stay on ' +
          'POST /api/actions (catalog.upsert / supplier.*). Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          searchParam,
          limitParam,
          cursorParam('a supplier id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/SupplierCatalogSummary' }, 'supplier id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: supplyForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/parcels': {
      get: {
        tags: ['land'],
        operationId: 'listProjectParcels',
        summary: 'Land parcels of a project with the verification ladder summary (cursor-paginated)',
        description:
          'The project\'s land parcels (Doc A §3-8): identity (plot/county/area), tenure, status, document and ' +
          'title-search counts, the latest registry search\'s state, and the assigned professionals. HONEST ' +
          'LANGUAGE (land/policy.ts): "verified" is a record state produced by the ladder, NEVER a government ' +
          'certification claim; "flagged" is an anomaly state for human review, never an accusation. FEATURE FLAG: ' +
          'gated by `land_verification` exactly as the webapp is — the flag\'s enforcement map closes "the parcels ' +
          'section of the Land tab", so OFF → 403 for non-admins (admins bypass). GUARD: any signed-in role; ' +
          'client-role sessions pinned to their own project (foreign → 403); supplier-role sessions → uniform 403 ' +
          '(W5-3); unknown project → 404. Data comes from a DIRECT db.landParcel.findMany scoped to the project ' +
          '(issue #154 — the same rows the land module\'s loadLandSlice returns, with only the summary joins: ' +
          'document ids for the count, the searches newest-first so [0] is the latest, and the assignments with ' +
          'their professional join). The page is ordered (createdAt ASC, id ASC). ?status= ' +
          '(searching|verified|flagged) filters BEFORE pagination (a cursor that falls out → 400). READ-ONLY — ' +
          'parcel mutations stay on POST /api/actions (parcel.* / search.*). Rate limit: 120/min per principal.',
        security,
        parameters: [
          projectIdPathParam,
          statusParam(['searching', 'verified', 'flagged'], 'parcel status'),
          limitParam,
          cursorParam('a parcel id'),
        ],
        responses: {
          200: listOkResponse({ $ref: '#/components/schemas/ParcelSummary' }, 'parcel id'),
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: landForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/intel': {
      get: {
        tags: ['intel'],
        operationId: 'getProjectIntelDigest',
        summary: 'The project\'s intel digest: flags, latest score, risk, health, weekly digest, anomalies summary',
        description:
          'The project\'s INTEL DIGEST in one object: the flags state, the latest MjengoScore trust score, the ' +
          'latest risk assessment, the §48 health snapshot, the latest weekly digest row, and the anomalies ' +
          'summary (the project\'s Alert ledger — the rows the anomaly scan writes, with the severity mix and ' +
          'acknowledgement state). HONESTY RULES (the intel module\'s own): the score gates nothing and approves ' +
          'nothing — it describes, humans decide; score is NULL (never a fake 0 or 100) when the project has too ' +
          'little history; every number is deterministic and traceable to real rows. Data comes from ' +
          'loadIntelSlice(projectId) directly — the intel ' +
          'module\'s public read (latest-wins rows + the module\'s own ' +
          'safe JSON parsers, re-used, never re-implemented) plus a route-layer Alert read (the ' +
          'wallet-transactions precedent) — issue #154: the digest pays only its own module\'s reads, never the ' +
          'webapp payload\'s other ~19. NO FEATURE FLAG gates this READ (ai_progress/ai_voice gate the AI ' +
          'routes, not the intel reads — the webapp Intel tab renders while flags are off, and v1 mirrors that). ' +
          'GUARD: any signed-in role; client-role sessions pinned to their own project (foreign → 403); ' +
          'supplier-role sessions → uniform 403 (W5-3); unknown project → 404. Recomputations stay on POST ' +
          '/api/actions (risk.recompute / score.recompute / digest.generate). Pagination does not apply (one ' +
          'digest object). Rate limit: 120/min per principal.',
        security,
        parameters: [projectIdPathParam],
        responses: {
          200: { description: 'ok: true, data = IntelDigest.', ...json(ok({ $ref: '#/components/schemas/IntelDigest' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: intelForbiddenResponse,
          404: projectNotFoundResponse,
          429: rateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/v1/projects/{id}/budget-variance': {
      get: {
        tags: ['reports'],
        operationId: 'getProjectBudgetVariance',
        summary: 'Budget variance report for the project (the v1 mirror of /api/reports/budget-variance)',
        description:
          'The QS budget-variance report (W3-B) on the v1 surface — the SAME service call, report contract and ' +
          'role gate as /api/reports/budget-variance; only the request moved to the path param and the errors adopt ' +
          'the v1 { error, field? } contract. project rollup: budgetTotal = Σ Phase.budget and spent = Σ ' +
          'Transaction.amount — the exact ProjectSummary derivations, so the report can never disagree with the ' +
          'dashboard. HONEST per-phase derivation: three-tier attribution (real phase cost-codes / milestone ' +
          'linkage / documented budget-share estimate — phaseAttribution states which mode produced the numbers). ' +
          'GUARD: contractor / admin / supervisor / qs only (client, finance, procurement and supplier sessions are ' +
          'not on this surface → 403 — the guard\'s role gate, fail closed). RATE LIMIT: 30/min per principal (NOT ' +
          'the 120/min v1 read convention — a deliberate deviation mirroring the app route: the derivation walks ' +
          'every transaction of the project, so it is a heavyweight read, not a polling target). Unknown project → ' +
          '404 { error: "Project not found" } (never an empty report). Pagination does not apply (one object).',
        security,
        parameters: [projectIdPathParam],
        responses: {
          200: { description: 'ok: true, data = BudgetVarianceReport (the same component /api/reports/budget-variance serves).', ...json(ok({ $ref: '#/components/schemas/BudgetVarianceReport' })) },
          400: readBadRequestResponse,
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but the role is not on the QS surface (allowed: contractor, admin, supervisor, qs). Body { error: "Not permitted for role \\"<role>\\"" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          404: projectNotFoundResponse,
          429: reportRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/audit': {
      get: {
        tags: ['audit'],
        operationId: 'listAuditEvents',
        summary: 'Audit log with filters (admin-only, cursor-paginated)',
        description:
          'Admin → Audit Logs (spec §44): the read side of the append-only Bias-Free Ledger — every dispatched ' +
          'action writes exactly one AuditEvent (actor, role, summary, entity, ip, userAgent, requestId). ' +
          'Guard: admin ONLY (any other signed-in role → 403; anonymous → 401). IMMUTABLE BY DESIGN — no ' +
          'POST/PUT/PATCH/DELETE handlers exist or may ever be added (users must not be able to erase audit ' +
          'records; lib/audit logAudit is the single append-only writer). ' +
          'Filters: actor (contains), role / projectId / entity / kind (exact), from / to (inclusive ISO range ' +
          'on createdAt; a date-only `to` like 2026-02-14 expands to end-of-day UTC), q (free-text contains on ' +
          'summary). actor/q match ASCII case-insensitively (SQLite LIKE; non-ASCII case folding unsupported). ' +
          'Keyset pagination like /api/v1/wallets: limit (1-200, default 50) + cursor (the AuditEvent id of the ' +
          'last row of the previous page; unknown id → 400), ordered createdAt DESC then id DESC. ' +
          'Rate limit: 60/min per principal.',
        security,
        parameters: [
          { name: 'actor', in: 'query', required: false, schema: { type: 'string', maxLength: 120 }, description: 'Actor name contains (ASCII case-insensitive).' },
          { name: 'role', in: 'query', required: false, schema: { type: 'string', maxLength: 40 }, description: 'Exact role: contractor, client, system, ai, finance, supervisor, foreman…' },
          { name: 'projectId', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 40 }, description: 'Exact project scope.' },
          { name: 'entity', in: 'query', required: false, schema: { type: 'string', maxLength: 60 }, description: 'Exact entity type acted on, e.g. StockMovement.' },
          { name: 'kind', in: 'query', required: false, schema: { type: 'string', maxLength: 40 }, description: 'Exact event kind: delivery, wage, milestone, escrow, share, auth…' },
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Inclusive createdAt lower bound (ISO 8601; date-only = midnight UTC).' },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Inclusive createdAt upper bound (ISO 8601; date-only expands to end-of-day UTC).' },
          { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Free-text search in the summary (contains, ASCII case-insensitive).' },
          limitParam,
          cursorParam('an AuditEvent id'),
        ],
        responses: {
          200: {
            description:
              'ok: true. data = AuditEvent page (createdAt DESC, id DESC); nextCursor is null on the last page, ' +
              'else the id to pass as ?cursor. hasMore mirrors nextCursor.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'data', 'nextCursor', 'hasMore'],
                  properties: {
                    ok: { const: true },
                    data: { type: 'array', items: { $ref: '#/components/schemas/AuditEvent' } },
                    nextCursor: { type: ['string', 'null'], description: 'AuditEvent id for the next page; null on the last page.' },
                    hasMore: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Bad limit (must be an integer 1-200), unknown cursor, or unparseable from/to. Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but not admin — audit logs are admin-only (spec §44). Body { error: "Not permitted for role \\"<role>\\"" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: auditRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/reports/budget-variance': {
      get: {
        tags: ['reports'],
        operationId: 'getBudgetVarianceReport',
        summary: 'Budget variance report (QS surface: cost plan vs actuals per phase/category)',
        description:
          'QS surface — "BOQ / Cost Plan / Variations / Actual Cost / Forecast / Budget Variance". ' +
          'Guard: contractor / admin / supervisor / qs (client, finance and procurement are not on this ' +
          'surface → 403; anonymous → 401). projectId query param REQUIRED (no default-project guessing on a ' +
          'report) → 400 when absent; unknown project → 404. ' +
          'project rollup: budgetTotal = Σ Phase.budget and spent = Σ Transaction.amount — the exact ' +
          'derivations the app payload uses (ProjectSummary), so the report can never disagree with the ' +
          'dashboard; remaining = budgetTotal − spent. HONEST per-phase derivation: Transaction has no ' +
          'phaseId — milestone-linked payments are exact, the rest is a budget-share allocation across ' +
          'started phases that preserves Σ phases.spent == project.spent (see the schema notes). ' +
          'categories group by Transaction.type (the model has no category field). ' +
          'Rate limit: 30/min per principal.',
        security,
        parameters: [
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 40 },
            description: 'The project to report on. Required — absent → 400; unknown → 404.',
          },
        ],
        responses: {
          200: {
            description: 'ok: true, data = BudgetVarianceReport.',
            content: {
              'application/json': {
                schema: ok({ $ref: '#/components/schemas/BudgetVarianceReport' }),
              },
            },
          },
          400: {
            description: 'projectId missing. Body { error: "projectId required" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but the role is not on the QS surface (allowed: contractor, admin, supervisor, qs). Body { error: "Not permitted for role \\"<role>\\"" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          404: {
            description: 'Unknown projectId. Body { error: "Project not found" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: reportRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
    '/api/ai/extract-document': {
      get: {
        tags: ['documents'],
        operationId: 'listDocumentReviewQueue',
        summary: 'Document review queue (extraction drafts + human review state)',
        description:
          'Document intelligence (issue #153): the review queue the app\'s Copilot "Documents" panel renders — ' +
          'document-mode Attachments (entityType "document") for one project, newest first, capped at 100, each ' +
          'with its parsed extraction draft and review state. Guard: contractor / admin / supervisor ONLY (the ' +
          'shared /api/ai/* gate; any other signed-in role → 403, anonymous → 401). projectId is REQUIRED — ' +
          'no default-project guessing on a queue a human decides from (absent → 400; unknown → 404). ' +
          'reviewStatus is optional (pending | approved | rejected; other values → 400); absent = all statuses. ' +
          'The response never carries ocrText (the raw text layer can be 200 KB and the queue does not render it) — ' +
          'only the parsed extractedJson draft, or null when no extraction has run. ' +
          'Rate limit: 30 reads/min per principal (one queue read per review round-trip — not a model call).',
        security,
        parameters: [
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 40 },
            description: 'The project whose documents are queued. Required — absent → 400; unknown → 404.',
          },
          {
            name: 'reviewStatus',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
            description: 'Filter by review state. Absent = all statuses (the panel asks for pending).',
          },
        ],
        responses: {
          200: {
            description:
              'ok: true. documents = the queue rows (createdAt DESC, take 100), each with the parsed `extraction` draft or null.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'documents'],
                  properties: {
                    ok: { const: true },
                    documents: { type: 'array', items: { $ref: '#/components/schemas/DocumentReviewItem' } },
                  },
                },
              },
            },
          },
          400: {
            description: 'projectId missing, or reviewStatus outside pending|approved|rejected. Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description:
              'Signed in but not on the site-team allowlist (contractor, admin, supervisor) — the shared /api/ai/* gate. ' +
              'Body { error: "AI tools are limited to site-team roles…" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          404: {
            description: 'Unknown projectId. Body { error: "Project not found" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: aiRouteRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
      post: {
        tags: ['documents'],
        operationId: 'extractDocumentDraft',
        summary: 'Run extraction on a stored document (DRAFT-ONLY — no official record is ever written)',
        description:
          'Runs the extraction on a stored document Attachment and persists the draft: image scans → the VLM seam ' +
          '(model glm-5v-turbo); PDFs → the server-side text-layer extraction (lib/pdf-text.ts, issue #42) fed ' +
          'through the same parse path — a PDF with NO usable text layer (a scan) or an encrypted PDF fails ' +
          'HONESTLY with 400 and the reason (never a faked extraction). An ocrTextHint (≤ 100,000 chars) always ' +
          'WINS over the server-side extraction. The write touches ONLY the Attachment row\'s own extraction fields ' +
          '(ocrText, extractedJson, extractionConfidence, extractionModel) — no BOQ, material request, invoice or ' +
          'ledger row is ever created or mutated — and reviewStatus resets to "pending" because the content changed. ' +
          'Guard: the shared /api/ai/* gate (contractor / admin / supervisor; strict body shape — unknown fields → 400; ' +
          'body capped at 128 KB). Rate limit: 10 calls/min per principal.',
        security,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['attachmentId'],
                properties: {
                  attachmentId: { type: 'string', description: 'The Attachment id (from the review queue row or the /api/upload document-mode response).' },
                  ocrTextHint: { type: 'string', maxLength: 100000, description: 'Optional text extracted ELSEWHERE (client-side lib, upstream OCR). When present it wins over the server-side extraction.' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description:
              'ok: true, simulated: false (honest label — a real model call, no fixture). reviewStatus is "pending" — re-extraction always re-opens review.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'simulated', 'model', 'confidence', 'extraction', 'attachmentId', 'reviewStatus'],
                  properties: {
                    ok: { const: true },
                    simulated: { const: false },
                    model: { type: 'string', description: 'glm-5v-turbo (image scan) or zai-chat-llm (PDF text layer — a pipeline label, the chat seam does not return a model id).' },
                    confidence: { type: ['number', 'null'], description: 'The model\'s honest 0-1 confidence.' },
                    extraction: { $ref: '#/components/schemas/DocumentExtraction' },
                    attachmentId: { type: 'string' },
                    reviewStatus: { const: 'pending' },
                  },
                },
              },
            },
          },
          400: {
            description:
              'Missing attachmentId; ocrTextHint over 100,000 chars; the stored file is missing/unreadable, not a ' +
              'PDF/PNG/JPEG, or its bytes do not match the recorded mime; a scanned PDF with no text layer and no hint ' +
              '(the honest failure — never a faked extraction). Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but not on the site-team allowlist (contractor, admin, supervisor). Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          404: {
            description: 'Unknown attachmentId. Body { error: "Attachment not found" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: aiRouteRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
      put: {
        tags: ['documents'],
        operationId: 'reviewDocumentDraft',
        summary: 'The human review gate — approve or reject a document draft',
        description:
          'The "AI assists, humans decide" control (spec §60): sets reviewStatus to approved|rejected, stamps ' +
          'reviewedBy/reviewedAt, and writes an AuditEvent (kind "document") on the linked project (an unlinked ' +
          'document\'s verdict is carried by the Attachment row alone — AuditEvent.projectId is non-nullable). ' +
          'The default reviewer identity is the signed-in session (auditable) — the optional `reviewer` field only ' +
          'overrides the display name (≤ 120 chars), never the audit actor. Approving does NOT copy the draft into ' +
          'any official record; consuming flows must gate on reviewStatus === "approved" themselves. ' +
          'Guard: the shared /api/ai/* gate (contractor / admin / supervisor; strict body shape). ' +
          'Rate limit: 10 calls/min per principal.',
        security,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['attachmentId', 'decision'],
                properties: {
                  attachmentId: { type: 'string' },
                  decision: { type: 'string', enum: ['approved', 'rejected'] },
                  reviewer: { type: 'string', maxLength: 120, description: 'Optional display-name override; the audit actor is always the signed-in session.' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'ok: true — the stamped verdict (reviewStatus, reviewedBy, reviewedAt).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'attachmentId', 'reviewStatus', 'reviewedBy', 'reviewedAt'],
                  properties: {
                    ok: { const: true },
                    attachmentId: { type: 'string' },
                    reviewStatus: { type: 'string', enum: ['approved', 'rejected'] },
                    reviewedBy: { type: 'string' },
                    reviewedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Missing attachmentId, decision outside approved|rejected, or reviewer over 120 chars. Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: unauthorizedResponse,
          403: {
            description: 'Signed in but not on the site-team allowlist (contractor, admin, supervisor). Body { error }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          404: {
            description: 'Unknown attachmentId. Body { error: "Attachment not found" }.',
            content: { 'application/json': { schema: errorSchema } },
          },
          429: aiRouteRateLimitedResponse,
          500: serverErrorResponse,
        },
      },
    },
  },
}

export async function GET() {
  return NextResponse.json(spec, { headers: { 'Cache-Control': 'public, max-age=60' } })
}
