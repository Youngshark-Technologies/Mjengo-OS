// Supply & procurement (MjengoOS Finder) module — service layer.
//
// The Find → Compare → Request → Approve → Order → Deliver → Verify loop,
// called from src/backend/actions/supply.ts (thin actions, fat services — the
// money.ts/land.ts house pattern):
//
//   - compareSuppliers: landed-cost engine + weighted ranking (pure math in
//     compare.ts — the same function the Finder search section runs
//     client-side; one algorithm, no drift)
//   - requests: create (DRAFT, wallet untouched — Finder §2) → update →
//     submit → the approval-rules engine (§11) → decide
//   - approval engine: est total = best RECEIVED quote total, else Σ(avg
//     catalog unitPrice × qty); active rules whose band [min, max) contains
//     the est chain by priority (>250k = client + finance); when the
//     requester's OWN role is the sole required approver → auto-approve
//     ("Auto-approved within limit"); otherwise PENDING Approval rows
//     (entityType 'request' — seeded rows use 'material_request', both are
//     matched on decide). No matching rule → conservative client default.
//   - quotes: request → receive (DOCUMENTED v1 CHOICE: a quote is per-request
//     — unitPrice applies to the FIRST line's material × its qty, plus
//     delivery + transport + fees = totalLanded; multi-line detail waits for
//     real supplier responses) → decline
//   - orders: create from an APPROVED request only (the request's approval
//     counts — orders are born 'approved'; pending_approval/draft stay
//     available for future flows), lines priced from the supplier's catalog
//     by name match with quote-price fallback, PO-YYYY-000NNN codes, then
//     send → confirm (simulated supplier) → dispatch → receive
//   - cancellation is COMPLETE and SAFE (#206): a cancelled PO can never be
//     stocked (receiveDelivery refuses on the parent order's state),
//     dispatch and cancel are CONDITIONAL single-transaction claims (the
//     cancel+dispatch race can no longer strand a receivable delivery on a
//     cancelled order), a DELIVERING order can be cancelled (its in-flight
//     dispatch is voided — no stock was posted yet, so nothing reverses), a
//     mistaken dispatch can be voided (delivery.void: the delivery dies,
//     the PO steps back to CONFIRMED for a corrected re-dispatch), and a
//     request can be withdrawn pre-conversion (request.cancel settles its
//     PENDING approvals honestly as 'withdrawn')
//   - delivery receive: PHYSICAL GROUND TRUTH (§13) — per-line ordered vs
//     received, evidence photos (real Attachment links, see receiveDelivery),
//     GPS, note; ANY short line → 'discrepancy'
//     (flagged for review, never an accusation) + client & contractor
//     notifications; payment release stays gated by the invoices module's
//     3-way match. DOCUMENTED CHOICE: a short delivery still completes the
//     order ('delivered') — the flag rides the OrderDelivery row, matching
//     the seeded PO-2026-000009 semantics.
//   - rules: upsert/delete the project's §11 bands; suppliers + catalogs
//     upserts are role-scoped master-data edits (MD-6): contractor/admin on
//     the buyer side (the applyAction SUPPLIER_MASTER gate enforces the
//     policy matrix case 4), supplier sessions their OWN rows via the W5-3
//     pin. Suppliers are network-global rows; the audit event lands on the
//     dispatching project
//
// Money NEVER moves here — payment flows through the invoices module only.
// Every mutation returns a plain object; applyAction() writes the AuditEvent.
// Notifications (db rows, read by the notification center): approval.requested,
// request.approved, order.sent, delivery.received, delivery.discrepancy.

import { db } from '@/backend/lib/db'
import { assertNonNegativeMoneyCents, centsToKes, fmtKes, mulQtyCents, parseMoneyCents, sumCents, type Cents } from '@/backend/lib/money'
import { currentActor } from './session'
import { compareSuppliers as pureCompare } from './compare'
import { estimateRequestTotal, materialKey } from './insights'
import { requiredApproverRoles } from './policy'
import { materialMatches } from './compare'
import type { CompareResult, RuleLike } from './types'
import type { DeliveryDay } from './types'
import type { TxClient } from '@/backend/modules/ledger/service'

// ---------------- input helpers (money.ts/land.ts house conventions) ----------------

function kes(nCents: Cents): string {
  return fmtKes(nCents)
}

/** Display twin for values that are already KSh numbers (pure-engine outputs). */
function kesKSh(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function posNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function moneyNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Optional money payload → cents (issue #122): absent/null/'' → null (field
 * not set); anything present must be a non-negative ≤2-dp KSh amount or the
 * call throws — garbage never silently drops a money field.
 */
function optCents(v: unknown, field: string): Cents | null {
  if (v === undefined || v === null || v === '') return null
  return assertNonNegativeMoneyCents(v, field)
}

function optNum(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function notify(
  projectId: string,
  kind: string,
  title: string,
  body: string,
  audienceRole: string,
  recipient: string | null = null,
  // #196: notifications ride the caller's transaction when there is one — a
  // rolled-back receive must not leave orphan notification rows behind.
  client: TxClient = db,
) {
  await client.notification.create({
    data: { projectId, kind, title, body, audienceRole, recipient },
  })
}

const ROLE_LABELS: Record<string, string> = {
  supervisor: 'Site Supervisor',
  contractor: 'Contractor',
  client: 'Client',
  finance: 'Finance',
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

// ---------------- code generators ----------------

/** Next request code MR-#### (max numeric suffix on THIS project + 1). */
async function nextRequestCode(projectId: string): Promise<string> {
  const existing = await db.materialRequest.findMany({
    where: { projectId },
    select: { requestCode: true },
  })
  let max = 1000
  for (const { requestCode } of existing) {
    const n = parseInt(requestCode.replace(/^MR-/i, ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `MR-${max + 1}`
}

/** Next order code PO-YYYY-000NNN (max NNN on THIS project + 1, current year). */
async function nextOrderCode(projectId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PO-${year}-`
  const existing = await db.purchaseOrder.findMany({
    where: { projectId, orderCode: { startsWith: prefix } },
    select: { orderCode: true },
  })
  let max = 0
  for (const { orderCode } of existing) {
    const n = parseInt(orderCode.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`
}

// ---------------- entity fetchers ----------------

async function getRequestOrThrow(id: unknown, projectId: string) {
  const requestId = String(id ?? '')
  if (!requestId) throw new Error('Request id required')
  const request = await db.materialRequest.findFirst({
    where: { id: requestId, projectId },
    include: { lines: true, quotes: true, orders: true },
  })
  if (!request) throw new Error('Material request not found in this project')
  return request
}

async function getOrderOrThrow(id: unknown, projectId: string) {
  const orderId = String(id ?? '')
  if (!orderId) throw new Error('Order id required')
  const order = await db.purchaseOrder.findFirst({
    where: { id: orderId, projectId },
    include: { lines: true, supplier: true, request: true, deliveries: { include: { lines: true } } },
  })
  if (!order) throw new Error('Purchase order not found in this project')
  return order
}

async function getQuoteOrThrow(id: unknown, projectId: string) {
  const quoteId = String(id ?? '')
  if (!quoteId) throw new Error('Quote id required')
  const quote = await db.quote.findFirst({
    where: { id: quoteId, request: { projectId } },
    include: { request: { include: { lines: true } }, supplier: true },
  })
  if (!quote) throw new Error('Quote not found in this project')
  return quote
}

async function loadSuppliersWithCatalog() {
  return db.supplier.findMany({ include: { catalogItems: { orderBy: { name: 'asc' } } } })
}

/** Site coordinates: first parcel (by createdAt) with coords, else Nairobi. */
async function resolveSite(projectId: string) {
  const parcels = await db.landParcel.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { lat: true, lng: true, county: true, town: true, plotNumber: true },
  })
  const withCoords = parcels.find((p) => p.lat !== null && p.lng !== null)
  if (withCoords) {
    return {
      lat: withCoords.lat as number,
      lng: withCoords.lng as number,
      label: `Site — ${withCoords.plotNumber}${withCoords.town ? `, ${withCoords.town}` : ''}`,
    }
  }
  return { lat: -1.2921, lng: 36.8219, label: 'Nairobi (default — no parcel coords yet)' }
}

// ---------------- approval engine (Finder §10/§11) ----------------

/** Estimate the request total: best RECEIVED quote, else catalog averages. */
async function estimateForRequest(requestId: string) {
  const [lines, quotes, suppliers] = await Promise.all([
    db.materialRequestLine.findMany({ where: { requestId } }),
    db.quote.findMany({ where: { requestId } }),
    loadSuppliersWithCatalog(),
  ])
  return estimateRequestTotal(
    lines.map((l) => ({ materialName: l.materialName, qty: l.qty })),
    suppliers.map((s) => ({ catalogItems: s.catalogItems.map((c) => ({ ...c, unitPrice: centsToKes(c.unitPrice) })) })),
    quotes.map((q) => ({ status: q.status, totalLanded: centsToKes(q.totalLanded) })),
  )
}

// ---------------- read-side: landed-cost compare ----------------

/** `supply.compare` { materialName, qty, radiusKm?, deliveryDay? } → ranked rows. */
export async function compareSuppliers(
  projectId: string,
  payload: Record<string, unknown>,
): Promise<CompareResult> {
  const materialName = str(payload.materialName)
  if (!materialName) throw new Error('Material name required')
  const qty = posNumber(payload.qty)
  if (qty === null) throw new Error('Quantity must be a number greater than zero')
  const radiusKm = payload.radiusKm === undefined || payload.radiusKm === null || payload.radiusKm === ''
    ? null
    : posNumber(payload.radiusKm)
  const deliveryDay = ['any', 'same_day', 'next_day', 'two_days'].includes(String(payload.deliveryDay))
    ? (String(payload.deliveryDay) as DeliveryDay)
    : 'any'

  const [suppliers, site] = await Promise.all([loadSuppliersWithCatalog(), resolveSite(projectId)])
  return pureCompare(
    { materialName, qty, radiusKm, deliveryDay },
    suppliers.map((s) => ({
      id: s.id,
      businessName: s.businessName,
      county: s.county,
      town: s.town,
      lat: s.lat,
      lng: s.lng,
      deliveryFeeBase: centsToKes(s.deliveryFeeBase),
      freeDeliveryOver: s.freeDeliveryOver === null ? null : centsToKes(s.freeDeliveryOver),
      minimumOrder: centsToKes(s.minimumOrder),
      reliabilityScore: s.reliabilityScore,
      responseHours: s.responseHours,
      catalogItems: s.catalogItems.map((c) => ({ ...c, unitPrice: centsToKes(c.unitPrice) })),
    })),
    site,
  )
}

// ---------------- suppliers + catalog (MD-6: role-scoped master data) ----------------

// Buyer-side upserts reach this code only through the applyAction
// SUPPLIER_MASTER role gate (contractor/admin); supplier sessions arrive via
// the W5-3 pin with supplierId forced to their own link. The rows themselves
// stay network-global (no per-supplier ownership model on the buyer side —
// the audit event records who edited what, on the dispatching project).

/** `supplier.upsert` { id?, businessName, county, town?, phone?, … } — network-global rows. */
export async function upsertSupplier(_projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  const businessName = str(payload.businessName)
  const county = str(payload.county)

  const data: Record<string, unknown> = {}
  if (businessName) data.businessName = businessName
  if (county) data.county = county
  if (payload.town !== undefined) data.town = str(payload.town)
  if (payload.phone !== undefined) data.phone = str(payload.phone)
  if (payload.email !== undefined) data.email = str(payload.email)
  if (payload.warehouseLocation !== undefined) data.warehouseLocation = str(payload.warehouseLocation)
  if (payload.deliveryZones !== undefined) data.deliveryZones = str(payload.deliveryZones) ?? ''
  const deliveryFeeBase = optCents(payload.deliveryFeeBase, 'deliveryFeeBase')
  if (deliveryFeeBase !== null) data.deliveryFeeBase = deliveryFeeBase
  const freeDeliveryOver = optCents(payload.freeDeliveryOver, 'freeDeliveryOver')
  if (freeDeliveryOver !== null) data.freeDeliveryOver = freeDeliveryOver
  const minimumOrder = optCents(payload.minimumOrder, 'minimumOrder')
  if (minimumOrder !== null) data.minimumOrder = minimumOrder
  const reliabilityScore = payload.reliabilityScore !== undefined ? optNum(payload.reliabilityScore) : null
  if (reliabilityScore !== null) data.reliabilityScore = Math.max(0, Math.min(100, Math.round(reliabilityScore)))
  const responseHours = payload.responseHours !== undefined ? optNum(payload.responseHours) : null
  if (responseHours !== null) data.responseHours = Math.max(1, Math.round(responseHours))
  const lat = payload.lat !== undefined ? optNum(payload.lat) : null
  const lng = payload.lng !== undefined ? optNum(payload.lng) : null
  if (lat !== null) data.lat = lat
  if (lng !== null) data.lng = lng

  if (id) {
    const existing = await db.supplier.findUnique({ where: { id } })
    if (!existing) throw new Error('Supplier not found')
    const updated = await db.supplier.update({ where: { id }, data })
    return { id: updated.id, businessName: updated.businessName }
  }
  if (!businessName || !county) throw new Error('New suppliers need a business name and county')
  const created = await db.supplier.create({
    data: {
      businessName,
      county,
      town: (data.town as string | null) ?? null,
      phone: (data.phone as string | null) ?? null,
      email: (data.email as string | null) ?? null,
      warehouseLocation: (data.warehouseLocation as string | null) ?? null,
      deliveryZones: (data.deliveryZones as string) ?? '',
      deliveryFeeBase: (data.deliveryFeeBase as Cents | undefined) ?? 0n,
      freeDeliveryOver: (data.freeDeliveryOver as Cents | null | undefined) ?? null,
      minimumOrder: (data.minimumOrder as Cents | undefined) ?? 0n,
      reliabilityScore: (data.reliabilityScore as number) ?? 50,
      responseHours: (data.responseHours as number) ?? 24,
      lat: (data.lat as number | null) ?? null,
      lng: (data.lng as number | null) ?? null,
    },
  })
  return { id: created.id, businessName: created.businessName }
}

/** `catalog.upsert` { supplierId, id?, name, unit, unitPrice, stockQty?, minOrderQty? }. */
export async function upsertCatalogItem(_projectId: string, payload: Record<string, unknown>) {
  const supplierId = str(payload.supplierId)
  const id = str(payload.id)
  const name = str(payload.name)
  const unit = str(payload.unit)
  // issue #122: catalog prices are stored as integer cents — the KSh payload
  // is converted + validated here (a raw number would corrupt reads ×100).
  const unitPrice = assertNonNegativeMoneyCents(payload.unitPrice, 'unitPrice')

  if (id) {
    const existing = await db.catalogItem.findUnique({ where: { id } })
    if (!existing) throw new Error('Catalog item not found')
    if (supplierId && supplierId !== existing.supplierId) {
      throw new Error('Catalog item belongs to a different supplier')
    }
    const data: Record<string, unknown> = {}
    if (name) data.name = name
    if (unit) data.unit = unit
    data.unitPrice = unitPrice
    const stockQty = payload.stockQty !== undefined ? moneyNumber(payload.stockQty) : null
    if (stockQty !== null) data.stockQty = stockQty
    const minOrderQty = payload.minOrderQty !== undefined ? moneyNumber(payload.minOrderQty) : null
    if (minOrderQty !== null) data.minOrderQty = Math.max(1, minOrderQty)
    const updated = await db.catalogItem.update({ where: { id }, data })
    return { id: updated.id, name: updated.name }
  }

  if (!supplierId) throw new Error('supplierId required for a new catalog item')
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) throw new Error('Supplier not found')
  if (!name) throw new Error('Catalog item name required')
  const created = await db.catalogItem.create({
    data: {
      supplierId,
      name,
      unit: unit ?? 'unit',
      unitPrice,
      stockQty: moneyNumber(payload.stockQty) ?? 0,
      minOrderQty: Math.max(1, moneyNumber(payload.minOrderQty) ?? 1),
    },
  })
  return { id: created.id, name: created.name }
}

// ---------------- material requests ----------------

interface LineInput {
  materialName: string
  unit: string
  qty: number
}

/** Validate + normalize request lines (units default from the matching catalog). */
async function normalizeRequestLines(raw: unknown): Promise<LineInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('At least one request line is required')
  const suppliers = await loadSuppliersWithCatalog()
  const lines: LineInput[] = []
  for (const item of raw) {
    const rec = (item ?? {}) as Record<string, unknown>
    const materialName = str(rec.materialName)
    if (!materialName) throw new Error('Every line needs a material name')
    const qty = posNumber(rec.qty)
    if (qty === null) throw new Error(`Line "${materialName}": quantity must be greater than zero`)
    let unit = str(rec.unit)
    if (!unit) {
      // default the unit from the first catalog item matching the name
      for (const s of suppliers) {
        const match = s.catalogItems.find((c) => materialMatches(c.name, materialName))
        if (match) {
          unit = match.unit
          break
        }
      }
    }
    lines.push({ materialName, unit: unit ?? 'unit', qty })
  }
  return lines
}

/** `request.create` { lines, notes? } → DRAFT (wallet untouched — Finder §2). */
export async function createRequest(projectId: string, payload: Record<string, unknown>) {
  const lines = await normalizeRequestLines(payload.lines)
  const actor = await currentActor()
  const requestedByRole = actor.role ?? str(payload.requestedByRole) ?? 'contractor'
  const requestedByName = actor.name ?? str(payload.requestedByName) ?? 'Site Manager'
  const requestCode = await nextRequestCode(projectId)

  const request = await db.materialRequest.create({
    data: {
      projectId,
      requestCode,
      requestedByRole,
      requestedByName,
      notes: str(payload.notes),
      status: 'draft',
      lines: { create: lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })) },
    },
  })
  return { id: request.id, requestCode, lineCount: lines.length }
}

/** `request.update` { id, lines?, notes? } — edit while DRAFT. */
export async function updateRequest(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (request.status !== 'draft') {
    throw new Error(`Only DRAFT requests can be edited — ${request.requestCode} is ${request.status.toUpperCase()}`)
  }
  if (payload.lines !== undefined) {
    const lines = await normalizeRequestLines(payload.lines)
    await db.materialRequestLine.deleteMany({ where: { requestId: request.id } })
    await db.materialRequestLine.createMany({
      data: lines.map((l) => ({ requestId: request.id, materialName: l.materialName, unit: l.unit, qty: l.qty })),
    })
  }
  const data: Record<string, unknown> = {}
  if (payload.notes !== undefined) data.notes = str(payload.notes)
  await db.materialRequest.update({ where: { id: request.id }, data })
  return { id: request.id }
}

/**
 * `request.submit` { id } — into the approval engine (Finder §11).
 * Est total = best RECEIVED quote, else Σ(avg catalog unitPrice × qty).
 * Band-matching rules chain by priority; sole-approver = requester's own role
 * → auto-approve within limit; otherwise PENDING Approval rows per role.
 *
 * §24 client-direct ordering (backend wave): when the CLIENT raised the
 * request, their own rung in the chain is substituted with 'contractor' —
 * the site team that must commit the purchase. By construction this also
 * disables the sole-approver auto-approve shortcut for client requesters:
 * a client's request always waits for a site-team (and/or finance) signer.
 */
export async function submitRequest(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (request.status !== 'draft') {
    throw new Error(`Only DRAFT requests can be submitted — ${request.requestCode} is ${request.status.toUpperCase()}`)
  }

  const estimate = await estimateForRequest(request.id)
  const ruleRows = await db.approvalRule.findMany({ where: { projectId, active: true } })
  // RuleLike ladder runs in KSh (advisory bands); rows are cents — one conversion.
  const rules: RuleLike[] = ruleRows.map((r) => ({
    ...r,
    minAmount: centsToKes(r.minAmount),
    maxAmount: r.maxAmount === null ? null : centsToKes(r.maxAmount),
  }))
  let chain = requiredApproverRoles(rules, estimate.total)
  if (chain.length === 0) chain = ['client'] // conservative default, documented
  // §24: the client never sits on their own approval — their rung falls to
  // the contractor (auto-approve below then cannot fire for a client requester).
  if (request.requestedByRole === 'client') {
    chain = chain.map((r) => (r === 'client' ? 'contractor' : r))
  }

  const now = new Date()

  // Sole required approver IS the requester → auto-approve within limit (§10)
  if (chain.length === 1 && chain[0] === request.requestedByRole) {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'request',
        entityId: request.id,
        approverRole: chain[0],
        approverName: request.requestedByName,
        decision: 'approved',
        note: 'Auto-approved within limit',
        decidedAt: now,
      },
    })
    await db.materialRequest.update({ where: { id: request.id }, data: { status: 'approved' } })
    await notify(
      projectId,
      'request.approved',
      `Auto-approved: ${request.requestCode}`,
      `${kesKSh(estimate.total)} estimated — within the ${roleLabel(chain[0])} limit, no second sign-off needed.`,
      request.requestedByRole,
      null,
    )
    return { id: request.id, status: 'approved', estimatedTotal: estimate.total, autoApproved: true, chain }
  }

  // Otherwise: PENDING approval rows per required role, priority-ordered
  for (const role of chain) {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'request',
        entityId: request.id,
        approverRole: role,
        approverName: roleLabel(role),
        decision: 'pending',
      },
    })
  }
  await db.materialRequest.update({ where: { id: request.id }, data: { status: 'submitted' } })
  await notify(
    projectId,
    'approval.requested',
    `Approval needed: ${request.requestCode}`,
    `${kesKSh(estimate.total)} estimated (${estimate.source === 'quotes' ? 'from quotes' : 'from catalog averages'}) — waiting for the ${roleLabel(chain[0])} decision.`,
    chain[0],
    null,
  )
  return { id: request.id, status: 'submitted', estimatedTotal: estimate.total, chain }
}

/**
 * `request.decide` { id, decision: approve|reject, note? } — the actor's role
 * must match a PENDING approval for that entity; wrong roles are rejected
 * with a clear server-side message (the system controls who decides).
 * All approved → request APPROVED · any rejected → REJECTED.
 */
export async function decideApproval(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (request.status !== 'submitted') {
    throw new Error(`${request.requestCode} is ${request.status.toUpperCase()} — not awaiting a decision`)
  }
  const decision = payload.decision
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error("decision must be 'approve' or 'reject'")
  }

  // Seeded rows use entityType 'material_request'; ours use 'request' — both matched.
  const pending = await db.approval.findMany({
    where: {
      projectId,
      entityId: request.id,
      decision: 'pending',
      entityType: { in: ['request', 'material_request'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!pending.length) throw new Error(`No pending approval found for ${request.requestCode}`)

  // Actor resolution — the same documented pattern as modules/wallet/session.ts
  // requireDeciderRole: the signed-in session role decides; with NO session
  // (share-link / public path — the entry routes upstream already restrict
  // those callers to the CLIENT_ACTIONS allowlist) the decider is the client.
  const actor = await currentActor()
  const actorRole = actor.role ?? 'client'
  // §24 client-direct ordering: a client may raise requests, but may NEVER
  // approve their own — the ladder (submitRequest substituted their rung to
  // the contractor) waits for the site team. Honest refusal, before any
  // approval row is touched.
  if (actorRole === 'client' && request.requestedByRole === 'client') {
    throw new Error(
      `${request.requestCode} was raised by the client — a client cannot approve their own request (spec §24). ` +
        'The site team holds the decision.',
    )
  }
  const myRow = pending.find((p) => p.approverRole === actorRole)
  if (!myRow) {
    const waiting = pending.map((p) => roleLabel(p.approverRole)).join(' and ')
    throw new Error(
      `Only the ${waiting} role may decide ${request.requestCode} — you are ${roleLabel(actorRole)}. ` +
        'The approval chain is waiting for the right signer.',
    )
  }

  const note = str(payload.note)
  const now = new Date()
  const decided = decision === 'approve' ? 'approved' : 'rejected'
  await db.approval.update({
    where: { id: myRow.id },
    data: { decision: decided, decidedAt: now, approverName: actor.name ?? roleLabel(myRow.approverRole), note },
  })

  const all = await db.approval.findMany({
    where: { entityId: request.id, entityType: { in: ['request', 'material_request'] } },
  })
  if (all.some((a) => a.decision === 'rejected')) {
    await db.materialRequest.update({ where: { id: request.id }, data: { status: 'rejected' } })
    return { id: request.id, status: 'rejected' }
  }
  if (all.every((a) => a.decision === 'approved')) {
    await db.materialRequest.update({ where: { id: request.id }, data: { status: 'approved' } })
    const project = await db.project.findUnique({ where: { id: projectId } })
    await notify(
      projectId,
      'request.approved',
      `Approved: ${request.requestCode}`,
      `All required approvals are in — purchase orders can now be created against ${request.requestCode}.`,
      request.requestedByRole || 'contractor',
      project?.client ?? null,
    )
    return { id: request.id, status: 'approved' }
  }
  return { id: request.id, status: 'submitted', decided }
}

/**
 * `request.cancel` { id, reason } — #206: withdraw a material request in any
 * pre-conversion state (draft / submitted / approved-but-not-yet-ordered).
 * Reason required (the cancelOrder pattern). A submitted request's PENDING
 * Approval rows are settled HONESTLY — decision 'withdrawn' with a decidedAt
 * stamp and the reason on the row — never left dangling as decidable work
 * (decideApproval's submitted-guard makes them undecidable anyway). The
 * status flip is a CONDITIONAL claim, so a concurrent order.create (whose
 * approved→converted flip is itself conditional, same transaction) can never
 * leave a live purchase order on a withdrawn request: whoever commits first
 * wins and the loser's claim matches zero rows and fails with the winner's
 * status. converted/rejected/cancelled requests refuse with their state.
 */
export async function cancelRequest(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.id, projectId)
  if (!['draft', 'submitted', 'approved'].includes(request.status)) {
    throw new Error(
      `Only DRAFT, SUBMITTED or APPROVED (not yet ordered) requests can be withdrawn — ${request.requestCode} is ${request.status.toUpperCase()}`,
    )
  }
  const reason = str(payload.reason)
  if (!reason) throw new Error('A withdrawal reason is required')

  const now = new Date()
  return db.$transaction(async (tx) => {
    const claim = await tx.materialRequest.updateMany({
      where: { id: request.id, status: { in: ['draft', 'submitted', 'approved'] } },
      data: { status: 'cancelled', notes: `Withdrawn — ${reason}` },
    })
    if (claim.count === 0) {
      const winner = await tx.materialRequest.findUnique({ where: { id: request.id } })
      throw new Error(
        `Only DRAFT, SUBMITTED or APPROVED (not yet ordered) requests can be withdrawn — ${request.requestCode} is ${(winner?.status ?? request.status).toUpperCase()}`,
      )
    }
    // Settle the chain: every PENDING approval row becomes 'withdrawn' with a
    // stamp + the reason (the requester pulled the request — nobody decided).
    const pending = await tx.approval.findMany({
      where: {
        projectId,
        entityId: request.id,
        decision: 'pending',
        entityType: { in: ['request', 'material_request'] },
      },
      orderBy: { createdAt: 'asc' },
    })
    if (pending.length > 0) {
      await tx.approval.updateMany({
        where: { id: { in: pending.map((p) => p.id) } },
        data: { decision: 'withdrawn', decidedAt: now, note: `Withdrawn by the requester — ${reason}` },
      })
    }
    // Notify the affected role: whoever still owed a decision (the first
    // pending rung) when settling a chain, else the requester's own camp
    // (their raised/approved request is now dead).
    const audience = pending[0]?.approverRole ?? (request.requestedByRole || 'contractor')
    await notify(
      projectId,
      'request.cancelled',
      `Request withdrawn: ${request.requestCode}`,
      `${request.requestCode} was withdrawn — ${reason}.${pending.length > 0 ? ` Its ${pending.length} pending approval(s) were settled as withdrawn.` : ''}`,
      audience,
      null,
      tx,
    )
    return { id: request.id, status: 'cancelled', requestCode: request.requestCode, approvalsSettled: pending.length }
  })
}

// ---------------- quotes ----------------

/** `quote.request` { requestId, supplierIds: string[] } — Quote rows REQUESTED. */
export async function requestQuotes(projectId: string, payload: Record<string, unknown>) {
  const request = await getRequestOrThrow(payload.requestId, projectId)
  if (!['submitted', 'approved', 'converted'].includes(request.status)) {
    throw new Error(`Quotes are requested after submission — ${request.requestCode} is ${request.status.toUpperCase()}`)
  }
  const supplierIds = Array.isArray(payload.supplierIds) ? payload.supplierIds.map((s) => String(s)) : []
  if (!supplierIds.length) throw new Error('Pick at least one supplier to quote')

  const suppliers = await db.supplier.findMany({ where: { id: { in: supplierIds } } })
  if (suppliers.length !== new Set(supplierIds).size) throw new Error('One or more suppliers not found')

  const existing = await db.quote.findMany({
    where: { requestId: request.id, supplierId: { in: supplierIds } },
    select: { supplierId: true },
  })
  const already = new Set(existing.map((q) => q.supplierId))
  const fresh = supplierIds.filter((sid) => !already.has(sid))
  if (!fresh.length) {
    throw new Error('Those suppliers already have quotes on this request — await their response or decline stale ones')
  }
  await db.quote.createMany({
    data: fresh.map((supplierId) => ({
      requestId: request.id,
      supplierId,
      unitPrice: 0,
      deliveryFee: 0,
      transportFee: 0,
      fees: 0,
      totalLanded: 0,
      status: 'requested',
    })),
  })
  return { requestId: request.id, created: fresh.length, requestCode: request.requestCode }
}

/**
 * `quote.receive` { id, unitPrice, deliveryFee?, transportFee?, fees?,
 * deliveryEta?, stockOk?, validUntil?, terms?, lines? } → RECEIVED.
 *
 * v2 (F-PROCURE, spec §32): when `lines` is supplied (one row per REQUEST
 * line, positional — qty fixed from the request, only unitPrice is the
 * supplier's), per-line QuoteLine rows are stored and
 * totalLanded = Σ(qty × price) + deliveryFee + transportFee + fees.
 * Without `lines` the DOCUMENTED v1 CHOICE stands: a quote is per-request —
 * totalLanded = unitPrice × FIRST line's qty + delivery + transport + fees.
 * validUntil/terms ride the Quote row (also editable later via quote.update).
 */
export async function receiveQuote(projectId: string, payload: Record<string, unknown>) {
  const quote = await getQuoteOrThrow(payload.id, projectId)
  if (quote.status !== 'requested') throw new Error(`Quote is already ${quote.status.toUpperCase()}`)
  // issue #122: quote money is stored as integer cents — KSh payloads are
  // converted + validated here; totals accumulate exactly in bigint.
  const deliveryFee = optCents(payload.deliveryFee, 'deliveryFee') ?? 0n
  const transportFee = optCents(payload.transportFee, 'transportFee') ?? 0n
  const fees = optCents(payload.fees, 'fees') ?? 0n
  const deliveryEta = str(payload.deliveryEta)
  const stockOk = payload.stockOk === undefined ? true : Boolean(payload.stockOk)
  const validUntil = payload.validUntil ? new Date(String(payload.validUntil)) : undefined
  const terms = str(payload.terms) ?? undefined

  const rawLines = Array.isArray(payload.lines) ? payload.lines : []

  let unitPrice: Cents
  let totalLanded: Cents
  if (rawLines.length) {
    // Multi-line bid: one price per REQUEST line (positional, qty from request)
    const requestLines = quote.request.lines
    if (rawLines.length !== requestLines.length) {
      throw new Error(`This request has ${requestLines.length} line(s) — price every one (${rawLines.length} given)`)
    }
    const priced: Array<{ name: string; unit: string; qty: number; unitPrice: Cents }> = []
    for (let i = 0; i < requestLines.length; i++) {
      const rec = (rawLines[i] ?? {}) as Record<string, unknown>
      const price = parseMoneyCents(rec.unitPrice)
      if (price === null) throw new Error(`Line "${requestLines[i].materialName}": quoted unit price must be greater than zero`)
      priced.push({ name: requestLines[i].materialName, unit: requestLines[i].unit, qty: requestLines[i].qty, unitPrice: price })
    }
    unitPrice = priced[0].unitPrice // header price = primary (first) line — compare-basis
    totalLanded = sumCents([...priced.map((l) => mulQtyCents(l.qty, l.unitPrice)), deliveryFee, transportFee, fees])
    await db.quoteLine.deleteMany({ where: { quoteId: quote.id } })
    await db.quoteLine.createMany({
      data: priced.map((l) => ({ quoteId: quote.id, name: l.name, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, lineTotal: mulQtyCents(l.qty, l.unitPrice) })),
    })
  } else {
    unitPrice = parseMoneyCents(payload.unitPrice) ?? -1n
    if (unitPrice <= 0n) throw new Error('Quoted unit price must be greater than zero')
    const firstLine = quote.request.lines[0]
    if (!firstLine) throw new Error('The request has no lines to quote against')
    totalLanded = sumCents([mulQtyCents(firstLine.qty, unitPrice), deliveryFee, transportFee, fees])
  }

  const updated = await db.quote.update({
    where: { id: quote.id },
    data: { unitPrice, deliveryFee, transportFee, fees, totalLanded, deliveryEta, stockOk, validUntil, terms, status: 'received' },
  })
  // KSh at the action boundary (issue #122) — the row stores cents
  return { id: updated.id, totalLanded: centsToKes(totalLanded), lineCount: rawLines.length || undefined }
}

/** `quote.decline` { id, reason? } — supplier declined (reason rides the audit). */
export async function declineQuote(projectId: string, payload: Record<string, unknown>) {
  const quote = await getQuoteOrThrow(payload.id, projectId)
  if (quote.status !== 'requested') throw new Error(`Only REQUESTED quotes can be declined — this one is ${quote.status.toUpperCase()}`)
  await db.quote.update({ where: { id: quote.id }, data: { status: 'declined' } })
  return { id: quote.id }
}

// ---------------- purchase orders ----------------

/**
 * `order.create` { requestId, supplierId, quoteId?, paymentSource?, note? }
 * → only from an APPROVED request (its approval counts — orders are born
 * 'approved'; §12). Lines priced from the supplier's catalog by name match,
 * falling back to the quote's unit price. PO-YYYY-000NNN code.
 */
export async function createOrder(projectId: string, payload: Record<string, unknown>) {
  const requestId = str(payload.requestId)
  if (!requestId) throw new Error('requestId required — purchase orders come from approved requests')
  const request = await getRequestOrThrow(requestId, projectId)
  if (request.status !== 'approved') {
    throw new Error(
      `Purchase orders are created from APPROVED requests — ${request.requestCode} is ${request.status.toUpperCase()}`,
    )
  }
  const supplierId = str(payload.supplierId)
  if (!supplierId) throw new Error('supplierId required')
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, include: { catalogItems: true } })
  if (!supplier) throw new Error('Supplier not found')

  // Optional quote link — must belong to this request + supplier
  let quote: Awaited<ReturnType<typeof getQuoteOrThrow>> | null = null
  const quoteId = str(payload.quoteId)
  if (quoteId) {
    quote = await getQuoteOrThrow(quoteId, projectId)
    if (quote.requestId !== request.id || quote.supplierId !== supplierId) {
      throw new Error('The selected quote does not match this request/supplier')
    }
  }

  // Price every request line: supplier catalog first, quote price fallback.
  // #203: lineData carries the request line's id — the PO line keeps STRUCTURED
  // lineage back to the request line (one PO line per request line by
  // construction), so the BOQ-vs-actual "ordered/delivered" columns walk FKs
  // instead of name matching.
  const lineData: Array<{ name: string; unit: string; qty: number; unitPrice: Cents; lineTotal: Cents; requestLineId: string }> = []
  for (const line of request.lines) {
    let unitPrice: Cents | null = null
    const exact = supplier.catalogItems.find((c) => materialKey(c.name) === materialKey(line.materialName))
    const fuzzy = supplier.catalogItems.find((c) => materialMatches(c.name, line.materialName))
    const catalogHit = exact ?? fuzzy
    if (catalogHit) unitPrice = catalogHit.unitPrice
    else if (quote && quote.status === 'received' && quote.unitPrice > 0n && line.id === request.lines[0]?.id) {
      unitPrice = quote.unitPrice
    }
    if (unitPrice === null) {
      throw new Error(
        `${supplier.businessName} does not stock "${line.materialName}" — pick a supplier that stocks it or request a quote first`,
      )
    }
    const lineTotal = mulQtyCents(line.qty, unitPrice)
    lineData.push({ name: line.materialName, unit: line.unit, qty: line.qty, unitPrice, lineTotal, requestLineId: line.id })
  }

  const subtotal = sumCents(lineData.map((l) => l.lineTotal))
  const deliveryFee =
    supplier.freeDeliveryOver !== null && subtotal >= supplier.freeDeliveryOver ? 0n : supplier.deliveryFeeBase
  const total = subtotal + deliveryFee

  const paymentSource = ['client', 'contractor', 'project_wallet', 'finance'].includes(String(payload.paymentSource))
    ? String(payload.paymentSource)
    : 'client'
  const actor = await currentActor()
  // §24 client-direct ordering: a client-created request produces a
  // client-created PO — payload fallback only matters for sessionless
  // (share-link) traffic, same trust boundary as createRequest's requester.
  const createdByRole = actor.role ?? str(payload.createdByRole) ?? 'contractor'
  const orderCode = await nextOrderCode(projectId)

  // #206: the PO create and the request's approved→converted flip are ONE
  // transaction, and the flip is CONDITIONAL on the request still being
  // approved — a concurrent request.cancel (withdrawal) that commits in
  // between cannot leave a live purchase order on a withdrawn request.
  // Whoever commits first wins; the loser's conditional update matches zero
  // rows, the honest status error throws, and the whole create rolls back.
  const order = await db.$transaction(async (tx) => {
    const created = await tx.purchaseOrder.create({
      data: {
        orderCode,
        projectId,
        requestId: request.id,
        supplierId,
        subtotal,
        deliveryFee,
        total,
        status: 'approved', // the request's approval counts (documented)
        paymentSource,
        createdByRole,
        note: str(payload.note),
        lines: { create: lineData },
      },
    })
    const converted = await tx.materialRequest.updateMany({
      where: { id: request.id, status: 'approved' },
      data: { status: 'converted' },
    })
    if (converted.count === 0) {
      const winner = await tx.materialRequest.findUnique({ where: { id: request.id } })
      throw new Error(
        `Purchase orders are created from APPROVED requests — ${request.requestCode} is ${(winner?.status ?? request.status).toUpperCase()}`,
      )
    }
    return created
  })
  return { id: order.id, orderCode, total: centsToKes(total), subtotal: centsToKes(subtotal), deliveryFee: centsToKes(deliveryFee) }
}

/** `order.update` { id, note? } — note edits (v1 orders are born approved; edits are notes). */
export async function updateOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  const data: Record<string, unknown> = {}
  if (payload.note !== undefined) data.note = str(payload.note)
  if (!Object.keys(data).length) throw new Error('Nothing to update — v1 order edits are notes')
  await db.purchaseOrder.update({ where: { id: order.id }, data })
  return { id: order.id }
}

/** `order.approve` { id, note? } — band-checked; only meaningful for draft/pending orders. */
export async function approveOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (!['draft', 'pending_approval'].includes(order.status)) {
    throw new Error(`${order.orderCode} is ${order.status.toUpperCase()} — orders from approved requests need no separate approval`)
  }
  const ruleRows = await db.approvalRule.findMany({ where: { projectId, active: true } })
  // RuleLike ladder runs in KSh (advisory bands); rows are cents — one conversion.
  const rules: RuleLike[] = ruleRows.map((r) => ({
    ...r,
    minAmount: centsToKes(r.minAmount),
    maxAmount: r.maxAmount === null ? null : centsToKes(r.maxAmount),
  }))
  const chain = requiredApproverRoles(rules, centsToKes(order.total))
  const actor = await currentActor()
  if (actor.role && !chain.includes(actor.role)) {
    throw new Error(
      `Only ${chain.map(roleLabel).join(' / ') || 'the client'} may approve ${order.orderCode} at ${kes(order.total)} — you are signed in as ${roleLabel(actor.role)}`,
    )
  }
  const now = new Date()
  const pending = await db.approval.findFirst({
    where: { entityType: 'purchase_order', entityId: order.id, decision: 'pending' },
  })
  if (pending) {
    await db.approval.update({
      where: { id: pending.id },
      data: { decision: 'approved', decidedAt: now, approverName: actor.name ?? roleLabel(pending.approverRole), note: str(payload.note) },
    })
  } else {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'purchase_order',
        entityId: order.id,
        approverRole: actor.role ?? chain[0] ?? 'client',
        approverName: actor.name ?? roleLabel(chain[0] ?? 'client'),
        decision: 'approved',
        note: str(payload.note) ?? 'Approved via order.approve',
        decidedAt: now,
      },
    })
  }
  await db.purchaseOrder.update({ where: { id: order.id }, data: { status: 'approved' } })
  return { id: order.id, status: 'approved' }
}

/** `order.send` { id } → SENT (+ contractor notification). */
export async function sendOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (order.status !== 'approved') {
    throw new Error(`Only APPROVED orders can be sent — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  await db.purchaseOrder.update({ where: { id: order.id }, data: { status: 'sent' } })
  await notify(
    projectId,
    'order.sent',
    `PO sent: ${order.orderCode}`,
    `${kes(order.total)} sent to ${order.supplier.businessName} — awaiting their confirmation.`,
    'contractor',
    null,
  )
  return { id: order.id, status: 'sent', orderCode: order.orderCode }
}

/** `order.confirm` { id, note? } → CONFIRMED — supplier confirms (simulated). */
export async function confirmOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (order.status !== 'sent') {
    throw new Error(`Only SENT orders can be confirmed — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'confirmed', note: str(payload.note) ?? order.note },
  })
  return { id: order.id, status: 'confirmed', orderCode: order.orderCode }
}

/**
 * `order.dispatch` { orderId, note? } → DELIVERING + OrderDelivery DISPATCHED.
 * #206: the PO flip is a CONDITIONAL claim (sent/confirmed → delivering) and
 * the delivery row is created in the SAME transaction — the cancel+dispatch
 * race (both reads pass on 'sent', then both write) can no longer strand a
 * receivable delivery on a cancelled order: whoever commits first wins and
 * the loser's claim matches zero rows, failing with the winner's status. A
 * VOIDED delivery (delivery.void) does not block a corrected re-dispatch —
 * only a live (non-cancelled) dispatch record does; the cancelled row stays
 * for the audit trail.
 */
export async function dispatchOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.orderId ?? payload.id, projectId)
  if (!['sent', 'confirmed'].includes(order.status)) {
    throw new Error(`Only SENT or CONFIRMED orders can be dispatched — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  const existing = await db.orderDelivery.findFirst({ where: { orderId: order.id, status: { not: 'cancelled' } } })
  if (existing) throw new Error(`${order.orderCode} already has a dispatch record`)

  const now = new Date()
  return db.$transaction(async (tx) => {
    // The dispatch claim: the flip only lands while the order is still in a
    // pre-dispatch state. Winning it is what authorizes the delivery row.
    const claim = await tx.purchaseOrder.updateMany({
      where: { id: order.id, status: { in: ['sent', 'confirmed'] } },
      data: { status: 'delivering' },
    })
    if (claim.count === 0) {
      const winner = await tx.purchaseOrder.findUnique({ where: { id: order.id } })
      throw new Error(
        `Only SENT or CONFIRMED orders can be dispatched — ${order.orderCode} is ${(winner?.status ?? order.status).toUpperCase()}`,
      )
    }
    const delivery = await tx.orderDelivery.create({
      data: {
        orderId: order.id,
        status: 'dispatched',
        dispatchedAt: now,
        note: str(payload.note) ?? `Truck dispatched — ${order.lines.length} line(s), ${kes(order.total)}`,
      },
    })
    return { id: order.id, deliveryId: delivery.id, status: 'delivering', orderCode: order.orderCode }
  })
}

/**
 * `order.cancel` { id, reason } — from SENT/CONFIRMED/DELIVERING, with a
 * reason. #206 closes the delivering gap ("trucks turn around"): cancelling
 * a DELIVERING order also VOIDS its in-flight dispatch — every still-
 * receivable OrderDelivery row (dispatched/in_transit/arrived, a refused-at-
 * the-gate truck included) flips to 'cancelled' in the SAME transaction, so
 * the PO status and the delivery states move together and nothing is left
 * receivable (no stock was posted yet — receive is the only stock path and
 * it flips deliveries out of those states, so there is nothing to reverse).
 * Both audiences are notified. The PO flip itself is a CONDITIONAL claim, so
 * the cancel+dispatch and cancel+receive races lose honestly instead of
 * stranding state; DELIVERED/CLOSED orders refuse (their goods are ground
 * truth — reversing stock is the inventory module's job).
 */
export async function cancelOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (!['sent', 'confirmed', 'delivering'].includes(order.status)) {
    throw new Error(`Only SENT, CONFIRMED or DELIVERING orders can be cancelled — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  const reason = str(payload.reason)
  if (!reason) throw new Error('A cancellation reason is required')

  return db.$transaction(async (tx) => {
    const claim = await tx.purchaseOrder.updateMany({
      where: { id: order.id, status: { in: ['sent', 'confirmed', 'delivering'] } },
      data: { status: 'cancelled', note: `Cancelled — ${reason}` },
    })
    if (claim.count === 0) {
      const winner = await tx.purchaseOrder.findUnique({ where: { id: order.id } })
      throw new Error(
        `Only SENT, CONFIRMED or DELIVERING orders can be cancelled — ${order.orderCode} is ${(winner?.status ?? order.status).toUpperCase()}`,
      )
    }
    // Void the in-flight dispatch: every still-receivable delivery of this
    // order dies with it, note carrying the reason (the row stays for audit).
    const voided = await tx.orderDelivery.updateMany({
      where: { orderId: order.id, status: { in: ['dispatched', 'in_transit', 'arrived'] } },
      data: { status: 'cancelled', note: `Dispatch voided — order cancelled: ${reason}` },
    })
    await notify(
      projectId,
      'order.cancelled',
      `PO cancelled: ${order.orderCode}`,
      `${kes(order.total)} to ${order.supplier.businessName} cancelled — ${reason}.` +
        (voided.count > 0 ? ' The in-flight dispatch was voided — nothing was received into stock.' : ''),
      'contractor',
      null,
      tx,
    )
    await notify(
      projectId,
      'order.cancelled',
      `PO cancelled: ${order.orderCode}`,
      `${kes(order.total)} to ${order.supplier.businessName} cancelled — ${reason}.` +
        (voided.count > 0 ? ' The in-flight dispatch was voided — nothing was received into stock.' : ''),
      'client',
      null,
      tx,
    )
    return { id: order.id, status: 'cancelled', orderCode: order.orderCode, deliveriesVoided: voided.count }
  })
}

/**
 * `delivery.void` { deliveryId, reason } — #206: void a mistaken or reversed
 * dispatch. The delivery (dispatched/in_transit/arrived — the receivable
 * states) flips to 'cancelled' with the reason on the row, and the parent PO
 * steps back ONE rung on the documented ladder (delivering → confirmed, the
 * pre-dispatch state) so a CORRECTED dispatch can be recorded —
 * dispatchOrder's duplicate check ignores cancelled deliveries. Reason
 * required (the cancelOrder pattern); both audiences notified; NOTHING is
 * posted (receive never ran — that is the point). One transaction: the
 * delivery void and the PO flip live or die together, and both claims are
 * conditional so a concurrent receive, driver-leg move or order.cancel loses
 * honestly. Fail-closed when the PO is not DELIVERING: any other state with a
 * receivable delivery is legacy/manual data, and inventing e.g.
 * delivered→confirmed would un-receive stock that was already posted.
 */
export async function voidDelivery(projectId: string, payload: Record<string, unknown>) {
  const deliveryId = str(payload.deliveryId)
  if (!deliveryId) throw new Error('deliveryId required')
  const delivery = await db.orderDelivery.findFirst({
    where: { id: deliveryId, order: { projectId } },
    include: { order: { include: { supplier: true } } },
  })
  if (!delivery) throw new Error('Delivery not found in this project')
  if (!['dispatched', 'in_transit', 'arrived'].includes(delivery.status)) {
    throw new Error(
      `Only DISPATCHED, IN_TRANSIT or ARRIVED deliveries can be voided — this one is ${delivery.status.toUpperCase()} ` +
        '(a received/discrepancy record is physical ground truth; reversing stock is the inventory module\'s job)',
    )
  }
  const reason = str(payload.reason)
  if (!reason) throw new Error('A void reason is required')
  const order = delivery.order

  return db.$transaction(async (tx) => {
    // The void claim: only while the delivery is still receivable. Winning
    // it is what authorizes the PO step-back that follows.
    const claim = await tx.orderDelivery.updateMany({
      where: { id: delivery.id, status: { in: ['dispatched', 'in_transit', 'arrived'] } },
      data: { status: 'cancelled', note: `Dispatch voided — ${reason}` },
    })
    if (claim.count === 0) {
      const winner = await tx.orderDelivery.findUnique({ where: { id: delivery.id } })
      throw new Error(
        `Only DISPATCHED, IN_TRANSIT or ARRIVED deliveries can be voided — this one is ${(winner?.status ?? delivery.status).toUpperCase()}`,
      )
    }
    // The PO steps back to its pre-dispatch rung — CONFIRMED. Conditional on
    // DELIVERING, so the PO flip and the delivery void move together.
    const poClaim = await tx.purchaseOrder.updateMany({
      where: { id: order.id, status: 'delivering' },
      data: { status: 'confirmed' },
    })
    if (poClaim.count === 0) {
      const poNow = await tx.purchaseOrder.findUnique({ where: { id: order.id } })
      throw new Error(
        `${order.orderCode} is ${(poNow?.status ?? order.status).toUpperCase()} — only a DELIVERING order's dispatch can be voided. ` +
          'Cancel the order instead, or correct already-received stock through the inventory module.',
      )
    }
    const body =
      `${order.orderCode} (${order.supplier.businessName}): the dispatch was voided — ${reason}. ` +
      'The order is back to CONFIRMED and nothing was received into stock; record the corrected dispatch when the truck actually leaves.'
    await notify(projectId, 'delivery.voided', `Dispatch voided: ${order.orderCode}`, body, 'contractor', null, tx)
    await notify(projectId, 'delivery.voided', `Dispatch voided: ${order.orderCode}`, body, 'client', null, tx)
    return { id: delivery.id, orderId: order.id, status: 'cancelled', orderStatus: 'confirmed', orderCode: order.orderCode }
  })
}

/** `order.close` { id, note? } — from DELIVERED. */
export async function closeOrder(projectId: string, payload: Record<string, unknown>) {
  const order = await getOrderOrThrow(payload.id, projectId)
  if (order.status !== 'delivered') {
    throw new Error(`Only DELIVERED orders can be closed — ${order.orderCode} is ${order.status.toUpperCase()}`)
  }
  await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'closed', note: str(payload.note) ? `Closed — ${str(payload.note)}` : 'Closed after verified delivery' },
  })
  return { id: order.id, status: 'closed', orderCode: order.orderCode }
}

// ---------------- delivery verification (Finder §13 — ground truth) ----------------

/** Honest cap on one receive's photo set (uploads are rate-limited 10/min; payloads stay sane). */
const MAX_DELIVERY_PHOTOS = 24

/**
 * The #206 honest refusal when a receive targets a delivery whose parent
 * order was cancelled — names the PO, its state and the recorded cancellation
 * reason (cancelOrder writes `Cancelled — <reason>` into the note), and says
 * what to do instead. Shared by the fast-fail read, the transactional
 * re-check and the lost-claim branch so every path refuses identically.
 */
function cancelledOrderReceiveError(order: { orderCode: string; note: string | null }): string {
  return (
    `${order.orderCode} is CANCELLED — a cancelled purchase order can never be received or stocked ` +
    `(cancellation on record: "${order.note ?? 'no reason recorded'}"). ` +
    'If the goods are genuinely still coming, agree a fresh purchase order with the supplier first.'
  )
}

/** Validated photo refs for one receive — attachment ids from PRIOR /api/upload calls. */
export interface DeliveryPhotoRefs {
  /** Whole-delivery evidence attachment ids. */
  delivery: string[]
  /** orderLineId → that line's evidence attachment ids (discrepancy photos). */
  byOrderLine: Map<string, string[]>
}

/**
 * Validate the photo refs a receive payload carries. Fail-closed: every id
 * must exist, be an IMAGE attachment, and belong to THIS project (a foreign
 * project's file is never silently attached) — throws BEFORE any delivery
 * rows are written, so an invalid photo set records nothing. An id referenced
 * both whole-delivery AND on a line is treated as line-scoped (the more
 * specific reading wins; one photo = one link row).
 */
export async function collectDeliveryPhotoRefs(
  projectId: string,
  payload: Record<string, unknown>,
  rawLines: unknown[],
): Promise<DeliveryPhotoRefs> {
  const ids = new Set<string>()
  const byOrderLine = new Map<string, string[]>()
  const addAll = (raw: unknown, orderLineId?: string) => {
    if (raw === undefined || raw === null) return
    if (!Array.isArray(raw)) {
      throw new Error('photoIds must be an array of attachment ids from /api/upload')
    }
    for (const item of raw) {
      const id = str(item)
      if (!id) throw new Error('photoIds must be an array of attachment ids from /api/upload')
      ids.add(id)
      if (orderLineId) {
        const list = byOrderLine.get(orderLineId) ?? []
        if (!list.includes(id)) list.push(id)
        byOrderLine.set(orderLineId, list)
      }
    }
  }
  addAll(payload.photoIds)
  for (const item of rawLines) {
    const rec = (item ?? {}) as Record<string, unknown>
    addAll(rec.photoIds, str(rec.orderLineId) ?? undefined)
  }

  const refs: DeliveryPhotoRefs = { delivery: [], byOrderLine }
  if (ids.size === 0) return refs
  if (ids.size > MAX_DELIVERY_PHOTOS) {
    throw new Error(`At most ${MAX_DELIVERY_PHOTOS} evidence photos per delivery — got ${ids.size}`)
  }
  const rows = await db.attachment.findMany({ where: { id: { in: [...ids] } } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      throw new Error(`Photo attachment ${id} not found — upload it via /api/upload before recording the delivery`)
    }
    if (row.projectId !== projectId) {
      throw new Error(`Photo attachment ${id} belongs to another project — evidence must be uploaded for this one`)
    }
    if (!row.mimeType || !row.mimeType.startsWith('image/')) {
      throw new Error(`Attachment ${id} (${row.mimeType ?? 'unknown type'}) is not a photo — evidence must be a PNG or JPEG image`)
    }
  }
  const lineScoped = new Set<string>()
  for (const list of byOrderLine.values()) for (const id of list) lineScoped.add(id)
  refs.delivery = [...ids].filter((id) => !lineScoped.has(id))
  return refs
}

/**
 * Link validated photo attachments to a delivery as DeliveryPhoto rows —
 * IDEMPOTENT by construction: already-linked ids are filtered out before the
 * write and the @@unique(deliveryId, attachmentId) index backstops a
 * concurrent race, so replaying the same ids links nothing new (what
 * "re-verify must not duplicate links" pins on). Line-scoped refs land with
 * deliveryLineId pointing at the freshly written OrderDeliveryLine row
 * (discrepancy evidence); whole-delivery refs land with a null scope.
 * Returns the delivery's TOTAL linked photo rows — the honest count that
 * photoCount mirrors.
 */
export async function linkDeliveryPhotos(
  tx: TxClient,
  deliveryId: string,
  refs: DeliveryPhotoRefs,
  lineIdByOrderLineId: Map<string, string>,
  attachedBy: string,
): Promise<number> {
  // One row per attachment id: a line scope (more specific) overrides a
  // whole-delivery scope for the same photo.
  const scoped = new Map<string, string | null>()
  for (const id of refs.delivery) scoped.set(id, null)
  for (const [orderLineId, attachmentIds] of refs.byOrderLine) {
    const deliveryLineId = lineIdByOrderLineId.get(orderLineId) ?? null
    for (const id of attachmentIds) scoped.set(id, deliveryLineId)
  }
  // Idempotency: SQLite's createMany has no skipDuplicates, so the rows
  // already linked to THIS delivery are filtered out BEFORE the write, and a
  // concurrent duplicate (unique index DeliveryPhoto_deliveryId_attachmentId_key)
  // is tolerated — the first link wins, a replay links nothing new.
  // #196: runs on the caller's transaction — links live and die with the
  // receive that wrote them.
  const alreadyLinked = await tx.deliveryPhoto.findMany({
    where: { deliveryId },
    select: { attachmentId: true },
  })
  const linkedIds = new Set(alreadyLinked.map((r) => r.attachmentId as string))
  const toCreate = [...scoped]
    .filter(([attachmentId]) => !linkedIds.has(attachmentId))
    .map(([attachmentId, deliveryLineId]) => ({
      deliveryId,
      attachmentId,
      deliveryLineId,
      attachedBy,
    }))
  if (toCreate.length > 0) {
    try {
      await tx.deliveryPhoto.createMany({ data: toCreate })
    } catch (e) {
      if (!String(e).includes('Unique constraint')) throw e
      // Lost a concurrent race for the same (delivery, attachment) pair —
      // the other writer's link stands; ours is a duplicate by definition.
    }
  }
  return await tx.deliveryPhoto.count({ where: { deliveryId } })
}

/**
 * `delivery.receive` { deliveryId, lines: [{ orderLineId, qtyReceived,
 * qtyRejected?, damageNote?, condition?, photoIds? }], note?, photoIds?,
 * gpsLat?, gpsLng? } — per-line physical counts + inspection + evidence.
 * Accepts a truck that is DISPATCHED (§26 leg skipped — back-compat) or
 * ARRIVED (the driver leg ran: assign → dispatch → transit → arrive).
 * ANY qtyReceived < qtyOrdered → OrderDelivery 'discrepancy' ("Ordered X ·
 * Received Y — N missing, flagged for review") + client & contractor
 * notifications. Documented: the order still completes (DELIVERED) — the flag
 * rides the delivery row for review, matching seeded PO-2026-000009; payment
 * release stays gated by the invoices module's 3-way match.
 *
 * OVER-DELIVERY RULE (#201): qtyReceived > qtyOrdered on ANY line is REJECTED
 * up front — over-delivery is a decision, never a silent posting. Posture
 * (conservative by design): the receive accepts at most the ordered quantity
 * per line; excess stock must be arranged as a NEW purchase order, not
 * smuggled in through the receive count. Rationale: one delivery per PO
 * (dispatchOrder refuses a second dispatch record), so qtyOrdered IS the
 * remaining upper bound — no accumulation to track; short/damaged variances
 * stay flaggable because they are losses against paperwork, while overage
 * inflates the derived Site Store ledger AND the supplier's receivable with
 * no review gate at the receiving moment (the 3-way match only catches it at
 * invoice time, relative to billed qty).
 *
 * INVENTORY INTEGRATION (spec §28/§33/§34 — F-PROCURE): the same receive also
 * posts the store ledger — per line, net received = qtyReceived − qtyRejected
 * becomes a 'received' StockMovement (InventoryItem upsert keyed material +
 * unit + location 'Site Store', supplier from the PO, reference = orderCode);
 * the rejected quantity becomes 'damaged' when the line was inspected
 * damaged/with a damage note, else 'returned'. recordedBy = the receiver.
 * CatalogItem.stockQty is clamped = max(0, stockQty − qtyOrdered) for the
 * line's catalog item (supplier + name match; skipped silently when the
 * supplier's catalog has no such item — some POs price off quotes).
 *
 * EVIDENCE PHOTOS (issue "Photo attachments on delivery verification") —
 * the same flow site photos use, one step earlier: the receive dialog
 * uploads each photo FIRST via POST /api/upload (document mode → a file
 * under public/docs/ + an Attachment row stamped entityType 'order_delivery'
 * / entityId = deliveryId), then submits the returned attachment ids with
 * the verification:
 *   · payload.photoIds — whole-delivery evidence (the truck, the gate, the note)
 *   · payload.lines[].photoIds — that line's evidence; a short/damaged line's
 *     photos become the DISCREPANCY evidence (DeliveryPhoto.deliveryLineId
 *     points at the per-line count row, so the discrepancy report and banner
 *     can pull exactly those photos).
 * Everything is validated fail-closed BEFORE any delivery rows are written
 * (ids exist, belong to THIS project, are image attachments), then linked as
 * DeliveryPhoto rows — idempotently (linkDeliveryPhotos: pre-filtered writes
 * + the @@unique(deliveryId, attachmentId) index backstop), so replaying the
 * same ids links nothing new. photoCount is a
 * DENORMALIZED MIRROR of the linked rows, recomputed here from real links —
 * a client-supplied count is ignored (a typed number was never evidence;
 * legacy count-only rows predate this flow and the UI labels them honestly).
 * Replay: loadSupplySlice ships the links (+attachments) on every delivery —
 * the order card renders them exactly like the site-photo strip.
 *
 * ATOMICITY (#196): the WHOLE receive — line rewrite, photo links, Site Store
 * movements, catalog clamps, delivery + PO status flips, notifications — runs
 * in ONE db.$transaction, and the status flip is a CONDITIONAL update
 * (`status IN ('dispatched','arrived')`) that runs BEFORE any stock posting.
 * A crash/retry mid-receive therefore leaves zero partial state (the old shape
 * posted movements before flipping the status, so a retry double-counted the
 * derived stock), and two concurrent receives cannot both win — the loser's
 * conditional update matches zero rows and fails honestly.
 *
 * PARENT-ORDER GUARD (#206): the PO's state is part of the receive guard, not
 * just the delivery's. A CANCELLED order can never be stocked — the fast-fail
 * read refuses it up front, the transactional re-check refuses it again, and
 * the claim itself is conditional on the order NOT being cancelled, so an
 * order.cancel that commits between the read and the claim makes the receive
 * lose honestly (the cancel+receive race) instead of silently erasing the
 * cancellation by flipping the PO to 'delivered'. DOCUMENTED: a DELIVERED
 * order's re-staged delivery (the demo replay posture — seed-extras/domain.ts
 * resets the truck so the receive flow can replay, history living in the
 * audit ledger) stays receivable; 'cancelled' is the one PO state that must
 * never post stock.
 */
export async function receiveDelivery(projectId: string, payload: Record<string, unknown>) {
  const deliveryId = str(payload.deliveryId)
  if (!deliveryId) throw new Error('deliveryId required')
  // Fast-fail read (NOT the guard — the transactional claim below is): wrong
  // state / bad input dies here without touching anything.
  const delivery = await db.orderDelivery.findFirst({
    where: { id: deliveryId, order: { projectId } },
    include: { order: { include: { lines: true, supplier: true } }, lines: true },
  })
  if (!delivery) throw new Error('Delivery not found in this project')
  if (delivery.status === 'in_transit') {
    // §26 driver leg: the truck has not reached the site yet — count at the gate.
    throw new Error(
      'The truck is still in transit — record the arrival (delivery.arrive) before receiving',
    )
  }
  if (delivery.status !== 'dispatched' && delivery.status !== 'arrived') {
    throw new Error(`Delivery is already ${delivery.status.toUpperCase()} — it cannot be re-received`)
  }
  // #206: the parent order's state is part of the guard — a cancelled PO can
  // never be stocked, however receivable its delivery row reads (the
  // cancel+dispatch race used to strand exactly that shape).
  if (delivery.order.status === 'cancelled') {
    throw new Error(cancelledOrderReceiveError(delivery.order))
  }
  const rawLines = Array.isArray(payload.lines) ? payload.lines : []
  if (!rawLines.length) throw new Error('Per-line received quantities are required — count what physically arrived')

  // Validate every line input against the PO lines (counts + inspection)
  const received: Array<{
    orderLineId: string
    orderLineName: string
    unit: string
    unitPrice: Cents // PO-line cents — #282: passes through to StockMovement.unitCost UNTOUCHED (integer cents end-to-end; KSh never enters this path)
    qtyOrdered: number
    qtyReceived: number
    qtyRejected: number
    damageNote: string | null
    condition: string
  }> = []
  for (const item of rawLines) {
    const rec = (item ?? {}) as Record<string, unknown>
    const orderLine = delivery.order.lines.find((l) => l.id === String(rec.orderLineId))
    if (!orderLine) throw new Error('One or more lines do not belong to this purchase order')
    const qtyReceived = moneyNumber(rec.qtyReceived)
    if (qtyReceived === null) throw new Error(`Line "${orderLine.name}": received quantity must be zero or more`)
    const qtyRejected = moneyNumber(rec.qtyRejected) ?? 0
    if (qtyRejected < 0) throw new Error(`Line "${orderLine.name}": rejected quantity must be zero or more`)
    if (qtyReceived - qtyRejected < 0) {
      throw new Error(`Line "${orderLine.name}": rejected (${qtyRejected}) cannot exceed what arrived (${qtyReceived})`)
    }
    // #201 — the over-delivery bound: what ARRIVED can never exceed what was
    // ordered (one delivery per PO, so qtyOrdered is the remaining bound).
    // Rejected up front, before any row is written — see the rule above.
    if (qtyReceived > orderLine.qty) {
      throw new Error(
        `Line "${orderLine.name}": received ${qtyReceived} but only ${orderLine.qty} ${orderLine.unit} were ordered — over-delivery is not accepted at receive. Count at most the ordered quantity (short/damaged lines are flagged for review); arrange the excess with the supplier on a new purchase order.`,
      )
    }
    const conditionRaw = str(rec.condition) ?? 'ok'
    const condition = ['ok', 'damaged', 'partial'].includes(conditionRaw) ? conditionRaw : 'ok'
    received.push({
      orderLineId: orderLine.id,
      orderLineName: orderLine.name,
      unit: orderLine.unit,
      // #282: keep the PO line's integer CENTS — no centsToKes round-trip.
      // The old code converted to KSh here and postDeliveryToInventory then
      // stored that KSh number into the BigInt cents column (stockValue
      // ÷100 understated on every read). Cents in, cents stored.
      unitPrice: orderLine.unitPrice,
      qtyOrdered: orderLine.qty,
      qtyReceived,
      qtyRejected,
      damageNote: str(rec.damageNote),
      condition,
    })
  }

  const note = str(payload.note)
  // Evidence photos: validate the attachment refs fail-closed BEFORE any
  // rows are written (an invalid photo set records nothing). payload.photoCount
  // (the legacy typed number) is deliberately IGNORED — the honest count is
  // recomputed from the real DeliveryPhoto links below.
  const photoRefs = await collectDeliveryPhotoRefs(projectId, payload, rawLines)
  const gpsLat = optNum(payload.gpsLat)
  const gpsLng = optNum(payload.gpsLng)
  const actor = await currentActor()
  const receivedBy = actor.name ?? str(payload.receivedBy) ?? 'Site team'

  // ---- Variance analysis (pure — computed BEFORE any write so the claim
  // below can flip the delivery to its FINAL status up front) ----
  const short = received.filter((r) => r.qtyReceived < r.qtyOrdered)
  const orderCode = delivery.order.orderCode
  const supplierName = delivery.order.supplier.businessName
  const now = new Date()
  const targetStatus = short.length > 0 ? 'discrepancy' : 'received'
  const rejectedTotal = received.reduce((s, r) => s + r.qtyRejected, 0)
  let autoSummary = ''
  if (short.length > 0) {
    const first = short[0]
    const missing = Math.round((first.qtyOrdered - first.qtyReceived) * 100) / 100
    autoSummary = `Ordered ${first.qtyOrdered} · Received ${first.qtyReceived} — ${missing} missing, flagged for review${rejectedTotal > 0 ? ` · ${Math.round(rejectedTotal * 100) / 100} rejected on inspection` : ''}`
  }
  const fullNote =
    short.length > 0
      ? note
        ? `${autoSummary} — ${note}`
        : short.length > 1
          ? `${autoSummary} (${short.length} short lines in total — see per-line counts)`
          : autoSummary
      : note ?? 'All lines received in full'

  // ---- #196: ONE transaction for the whole receive. The old shape posted
  // Site Store movements BEFORE flipping the delivery status, so a crash (or
  // a retried request) between the two re-posted the stock and double-counted
  // the derived closing. Now: the status guard is re-checked transactionally
  // and the flip itself is a CONDITIONAL update that runs BEFORE any stock
  // posting — two concurrent receives cannot both win (the loser's
  // updateMany matches zero rows), and a failure at ANY step (lines, photos,
  // stock, PO flip, notifications) rolls the whole receive back to zero.
  return db.$transaction(async (tx) => {
    // Transactional re-check of the guard — the fast-fail read above is not
    // the guard; this one races inside the transaction that writes. The
    // parent order rides along (#206): its cancelled state refuses here too.
    const fresh = await tx.orderDelivery.findFirst({
      where: { id: deliveryId, order: { projectId } },
      include: { order: true },
    })
    if (!fresh) throw new Error('Delivery not found in this project')
    if (fresh.status === 'in_transit') {
      throw new Error(
        'The truck is still in transit — record the arrival (delivery.arrive) before receiving',
      )
    }
    if (fresh.status !== 'dispatched' && fresh.status !== 'arrived') {
      throw new Error(`Delivery is already ${fresh.status.toUpperCase()} — it cannot be re-received`)
    }
    if (fresh.order.status === 'cancelled') {
      throw new Error(cancelledOrderReceiveError(fresh.order))
    }
    // The claim: flip to the FINAL status only while still awaiting receive
    // AND the parent order is not cancelled (#206 — this is the guard that
    // closes the cancel+receive race: an order.cancel committing after the
    // re-check above makes this conditional update match zero rows).
    // Winning the claim is what authorizes every write that follows.
    const claim = await tx.orderDelivery.updateMany({
      where: {
        id: fresh.id,
        status: { in: ['dispatched', 'arrived'] },
        order: { status: { not: 'cancelled' } },
      },
      data: { status: targetStatus, receivedAt: now, receivedBy },
    })
    if (claim.count === 0) {
      // Lost a race with a concurrent receive / driver-leg transition / the
      // order being cancelled — nothing of ours was written; report the
      // winner's state honestly.
      const winner = await tx.orderDelivery.findFirst({
        where: { id: fresh.id },
        include: { order: true },
      })
      if (winner?.order.status === 'cancelled') {
        throw new Error(cancelledOrderReceiveError(winner.order))
      }
      throw new Error(
        `Delivery is already ${(winner?.status ?? fresh.status).toUpperCase()} — it cannot be re-received`,
      )
    }

    await tx.orderDeliveryLine.deleteMany({ where: { deliveryId: fresh.id } })
    await tx.orderDeliveryLine.createMany({
      data: received.map((r) => ({
        deliveryId: fresh.id,
        orderLineId: r.orderLineId,
        qtyOrdered: r.qtyOrdered,
        qtyReceived: r.qtyReceived,
        qtyRejected: r.qtyRejected,
        damageNote: r.damageNote,
        condition: r.condition,
      })),
    })

    // ---- Evidence photo links (issue "Photo attachments on delivery verification"):
    // map orderLineId → the fresh OrderDeliveryLine row so line-scoped photos
    // ride the exact per-line count record, then link (idempotent) and take the
    // honest count.
    let linkedPhotoCount = 0
    if (photoRefs.delivery.length > 0 || photoRefs.byOrderLine.size > 0) {
      const lineRows = await tx.orderDeliveryLine.findMany({ where: { deliveryId: fresh.id } })
      const lineIdByOrderLineId = new Map(lineRows.map((r) => [r.orderLineId as string, r.id as string]))
      linkedPhotoCount = await linkDeliveryPhotos(tx, fresh.id, photoRefs, lineIdByOrderLineId, receivedBy)
    }

    // ---- Site Store posting (spec §33/§34): movements + catalog stock clamp ----
    const inventoryResult = await postDeliveryToInventory(
      tx,
      projectId,
      { supplierId: delivery.order.supplierId, orderCode: delivery.order.orderCode },
      received,
      receivedBy,
    )

    // ---- Final enrichment (the status itself was claimed above, before the
    // stock posting, so a crash can never leave stock posted against a
    // still-awaiting delivery) ----
    await tx.orderDelivery.update({
      where: { id: fresh.id },
      data: {
        note: fullNote,
        photoCount: linkedPhotoCount,
        gpsLat,
        gpsLng,
      },
    })
    await tx.purchaseOrder.update({ where: { id: delivery.order.id }, data: { status: 'delivered' } })

    if (short.length > 0) {
      // Physical ground truth ≠ paperwork — flagged for review, never an accusation
      const body = `${orderCode} (${supplierName}): ${autoSummary}. Photos: ${linkedPhotoCount}. Reconcile with the supplier before releasing payment.`
      await notify(projectId, 'delivery.discrepancy', `Delivery discrepancy: ${orderCode}`, body, 'client', null, tx)
      await notify(projectId, 'delivery.discrepancy', `Delivery discrepancy: ${orderCode}`, body, 'contractor', null, tx)
    } else {
      await notify(
        projectId,
        'delivery.received',
        `Delivery received: ${orderCode}`,
        `${supplierName} delivered in full — verified on the ground by ${receivedBy}${linkedPhotoCount ? ` with ${linkedPhotoCount} photo(s)` : ''}.`,
        'contractor',
        null,
        tx,
      )
    }

    return {
      id: fresh.id,
      orderId: delivery.order.id,
      status: targetStatus,
      shortLines: short.length,
      photosLinked: linkedPhotoCount,
      inventory: inventoryResult,
    }
  })
}

/**
 * Post delivery lines into the Site Store ledger (spec §33/§34):
 *   · net = qtyReceived − qtyRejected → StockMovement 'received'
 *     (InventoryItem upsert keyed material+unit+location 'Site Store',
 *      supplier from the PO, reference = the PO code)
 *   · qtyRejected → 'damaged' when condition==='damaged' or a damageNote is
 *     present, else 'returned'
 *   · CatalogItem.stockQty clamped to max(0, stock − qtyOrdered) for the
 *     supplier's matching item (name exact, then fuzzy; silent skip on no match)
 * unitCost is the PO line's integer CENTS, stored as-is (#282 — the money
 * stays in cents from catalog → PO → movement; KSh appears only at the
 * payload read boundaries).
 * Returns a plain summary for the audit trail + toasts.
 */
async function postDeliveryToInventory(
  tx: TxClient,
  projectId: string,
  order: { supplierId: string; orderCode: string },
  lines: Array<{
    orderLineName: string
    unit: string
    unitPrice: Cents
    qtyOrdered: number
    qtyReceived: number
    qtyRejected: number
    damageNote: string | null
    condition: string
  }>,
  recordedBy: string,
) {
  const movements: Array<{ materialName: string; type: string; quantity: number }> = []
  const catalogClamped: string[] = []

  for (const line of lines) {
    // 1) Site Store stock line (upsert keyed project+material+location)
    const item = await tx.inventoryItem.upsert({
      where: { projectId_materialName_location: { projectId, materialName: line.orderLineName, location: 'Site Store' } },
      update: { unit: line.unit, supplierId: order.supplierId },
      create: { projectId, materialName: line.orderLineName, unit: line.unit, location: 'Site Store', supplierId: order.supplierId },
    })

    // 2) net received → 'received' movement (unitCost from the PO line —
    //    integer cents in, integer cents stored, #282)
    const net = Math.round((line.qtyReceived - line.qtyRejected) * 100) / 100
    if (net > 0) {
      await tx.stockMovement.create({
        data: {
          projectId,
          inventoryItemId: item.id,
          type: 'received',
          quantity: net,
          unitCost: line.unitPrice,
          reference: order.orderCode,
          note: line.condition !== 'ok' || line.damageNote ? `Inspected ${line.condition}${line.damageNote ? ` — ${line.damageNote}` : ''}` : null,
          recordedBy,
        },
      })
      movements.push({ materialName: line.orderLineName, type: 'received', quantity: net })
    }

    // 3) rejected qty → 'damaged' or 'returned' movement
    if (line.qtyRejected > 0) {
      const rejectedType = line.condition === 'damaged' || line.damageNote ? 'damaged' : 'returned'
      await tx.stockMovement.create({
        data: {
          projectId,
          inventoryItemId: item.id,
          type: rejectedType,
          quantity: line.qtyRejected,
          unitCost: null,
          reference: order.orderCode,
          note: line.damageNote ?? `Rejected on inspection (${line.condition})`,
          recordedBy,
        },
      })
      movements.push({ materialName: line.orderLineName, type: rejectedType, quantity: line.qtyRejected })
    }

    // 4) clamp the supplier's catalog stock for the ordered quantity (silent skip)
    const catalogItems = await tx.catalogItem.findMany({ where: { supplierId: order.supplierId } })
    const hit = catalogItems.find((c) => c.name === line.orderLineName) ?? catalogItems.find((c) => materialMatches(c.name, line.orderLineName))
    if (hit) {
      await tx.catalogItem.update({
        where: { id: hit.id },
        data: { stockQty: Math.max(0, Math.round((hit.stockQty - line.qtyOrdered) * 100) / 100) },
      })
      catalogClamped.push(hit.name)
    }
  }

  return { movementsPosted: movements.length, movements, catalogClamped }
}

/**
 * `delivery.dispatch` { deliveryId, note? } — the §26 driver-leg departure:
 * the truck with the ASSIGNED driver physically leaves for the site.
 * Requires driverName on the row (delivery.assign first — honest error
 * otherwise), stamps departedAt and keeps status 'dispatched' (deliveries
 * are born dispatched by order.dispatch; transit/arrive advance the leg).
 * An optional note still replaces the delivery note (v1 note-update
 * behavior rides along; it is no longer required).
 */
export async function updateDispatch(projectId: string, payload: Record<string, unknown>) {
  const deliveryId = str(payload.deliveryId)
  if (!deliveryId) throw new Error('deliveryId required')
  const delivery = await db.orderDelivery.findFirst({
    where: { id: deliveryId, order: { projectId } },
  })
  if (!delivery) throw new Error('Delivery not found in this project')
  if (delivery.status !== 'dispatched') {
    throw new Error(`Only DISPATCHED deliveries can depart — this one is ${delivery.status.toUpperCase()}`)
  }
  if (!str(delivery.driverName)) {
    throw new Error(
      'Assign a driver before dispatching the truck — delivery.assign { deliveryId, driverName, … } first (spec §26)',
    )
  }
  if (delivery.departedAt) {
    throw new Error(
      `Truck already departed at ${delivery.departedAt.toISOString()} — use delivery.transit / delivery.arrive for the next legs`,
    )
  }
  const note = str(payload.note)
  const updated = await db.orderDelivery.update({
    where: { id: delivery.id },
    data: { departedAt: new Date(), dispatchedAt: delivery.dispatchedAt ?? new Date(), note: note ?? delivery.note },
  })
  return { id: updated.id, departedAt: updated.departedAt, driverName: updated.driverName }
}

// ---------------- approval rules (Finder §11 — project-configurable) ----------------

const APPROVER_ROLES = ['supervisor', 'contractor', 'client', 'finance']

/** `rule.upsert` { id?, minAmount, maxAmount?, approverRole, priority?, active? }. */
export async function upsertRule(projectId: string, payload: Record<string, unknown>) {
  // issue #122: approval bands are stored in cents — KSh payload converted
  // + validated here; the ladder comparison and reads run on cents/KSh once.
  const minAmount = optCents(payload.minAmount, 'minAmount')
  if (minAmount === null) throw new Error('minAmount must be a zero-or-more KSh amount (max 2dp)')
  const maxAmount = optCents(payload.maxAmount, 'maxAmount')
  if (maxAmount !== null && maxAmount <= minAmount) {
    throw new Error('maxAmount must be greater than minAmount (or empty for no ceiling)')
  }
  const approverRole = str(payload.approverRole)
  if (!approverRole || !APPROVER_ROLES.includes(approverRole)) {
    throw new Error(`approverRole must be one of ${APPROVER_ROLES.join(', ')}`)
  }
  const priority = payload.priority !== undefined ? optNum(payload.priority) : null
  const active = payload.active === undefined ? true : Boolean(payload.active)

  const id = str(payload.id)
  if (id) {
    const existing = await db.approvalRule.findFirst({ where: { id, projectId } })
    if (!existing) throw new Error('Approval rule not found in this project')
    const updated = await db.approvalRule.update({
      where: { id },
      data: {
        minAmount,
        maxAmount,
        approverRole,
        priority: priority !== null ? Math.round(priority) : existing.priority,
        active,
      },
    })
    return { id: updated.id }
  }
  const created = await db.approvalRule.create({
    data: {
      projectId,
      minAmount,
      maxAmount,
      approverRole,
      priority: priority !== null ? Math.round(priority) : 100,
      active,
    },
  })
  return { id: created.id }
}

/** `rule.delete` { id } — remove an approval band. */
export async function deleteRule(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Rule id required')
  const existing = await db.approvalRule.findFirst({ where: { id, projectId } })
  if (!existing) throw new Error('Approval rule not found in this project')
  await db.approvalRule.delete({ where: { id } })
  return { id }
}
