// Supply & procurement (MjengoOS Finder) module — types for the `supply` slice.
//
// Carries the full procurement network state for a project: suppliers with
// catalogs, material requests (+lines), project approval rules + decisions,
// quotes, purchase orders (+lines, +deliveries with per-line counts). The
// landed-cost engine and ranking live in compare.ts (pure, shared with the
// client); dashboard math lives in insights.ts (pure as well).
//
// PURE, PRISMA-FREE shapes (CompareRow, …) are defined here so the client
// sections and the server service share ONE contract — the same pattern as
// modules/invoices/three-way.ts.

import type {
  Supplier, CatalogItem, MaterialRequest, MaterialRequestLine,
  ApprovalRule, Approval, Quote, QuoteLine, PurchaseOrder, PurchaseOrderLine,
  OrderDelivery, OrderDeliveryLine, DeliveryPhoto, Attachment,
} from '@prisma/client'

export type { ApprovalRule, Approval, Quote, QuoteLine, PurchaseOrder, PurchaseOrderLine, OrderDelivery, OrderDeliveryLine, DeliveryPhoto, Attachment } from '@prisma/client'

// ---- domain enums ----

export type RequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'converted' | 'cancelled'
export type QuoteStatus = 'requested' | 'received' | 'declined'
export type OrderStatus =
  | 'draft' | 'pending_approval' | 'approved' | 'sent' | 'confirmed'
  | 'delivering' | 'delivered' | 'closed' | 'cancelled'
export type PaymentSource = 'client' | 'contractor' | 'project_wallet' | 'finance'
// The full OrderDelivery ladder (schema comment): in_transit/arrived are the
// §26 driver legs; cancelled is the #206 voided dispatch (not receivable).
export type DeliveryStatus = 'dispatched' | 'in_transit' | 'arrived' | 'received' | 'discrepancy' | 'cancelled'
export type ApproverRole = 'supervisor' | 'contractor' | 'client' | 'finance'
// 'withdrawn' (#206): request.cancel settles PENDING rows when the requester
// pulls the request — a settlement, not a decision.
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'withdrawn'

// ---- slice shapes ----

/**
 * KSh-view DTOs (issue #122): the DB stores cents (BigInt); the payload
 * slice ships KSh numbers. Omit+override — a bigint must never reach JSON.
 */
export type CatalogItemKes = Omit<CatalogItem, 'unitPrice'> & { unitPrice: number }

export interface SupplierWithCatalog extends Omit<Supplier, 'deliveryFeeBase' | 'freeDeliveryOver' | 'minimumOrder'> {
  deliveryFeeBase: number
  freeDeliveryOver: number | null
  minimumOrder: number
  catalogItems: CatalogItemKes[]
}

export type QuoteLineKes = Omit<QuoteLine, 'unitPrice' | 'lineTotal'> & { unitPrice: number; lineTotal: number }
export type PurchaseOrderKes = Omit<PurchaseOrder, 'subtotal' | 'deliveryFee' | 'total'> & { subtotal: number; deliveryFee: number; total: number }

export interface RequestWithLines extends MaterialRequest {
  lines: MaterialRequestLine[]
  quotes: QuoteDetail[]
  orders: PurchaseOrderKes[]
}

export interface QuoteDetail extends Omit<Quote, 'unitPrice' | 'deliveryFee' | 'transportFee' | 'fees' | 'totalLanded'> {
  unitPrice: number
  deliveryFee: number
  transportFee: number
  fees: number
  totalLanded: number
  supplierName: string
  requestCode: string
  /** Per-line bid detail (spec §32) — present when the quote was received multi-line. */
  lines?: QuoteLineKes[]
}

/**
 * One linked evidence photo on a delivery (see the DeliveryPhoto model):
 * `attachment.storageKey` is the URL the UI replays (same /api/upload storage
 * site photos and documents use). `deliveryLineId` scopes the photo to one
 * inspected line's count — the DISCREPANCY evidence; null = whole-delivery.
 */
export interface DeliveryPhotoWithAttachment extends DeliveryPhoto {
  attachment: Attachment
}

export interface DeliveryWithLines extends OrderDelivery {
  lines: OrderDeliveryLine[]
  photos: DeliveryPhotoWithAttachment[]
}

export type PurchaseOrderLineKes = Omit<PurchaseOrderLine, 'unitPrice' | 'lineTotal'> & { unitPrice: number; lineTotal: number }

export interface OrderWithDetail extends PurchaseOrderKes {
  lines: PurchaseOrderLineKes[]
  supplierName: string
  requestCode: string | null
  deliveries: DeliveryWithLines[]
}

/** The `supply` slice of ProjectPayload — populated by repository.loadSupplySlice. */
export type ApprovalRuleKes = Omit<ApprovalRule, 'minAmount' | 'maxAmount'> & { minAmount: number; maxAmount: number | null }

export interface SupplySlice {
  suppliers: SupplierWithCatalog[]
  requests: RequestWithLines[]
  approvalRules: ApprovalRuleKes[]
  approvals: Approval[]
  quotes: QuoteDetail[]
  orders: OrderWithDetail[]
  /** SavedSupplier ids for THIS project (spec §30 "save supplier") — directory sorts them first. */
  savedSupplierIds: string[]
}

export const EMPTY_SUPPLY_SLICE: SupplySlice = {
  suppliers: [],
  requests: [],
  approvalRules: [],
  approvals: [],
  quotes: [],
  orders: [],
  savedSupplierIds: [],
}

// ---- PURE landed-cost engine contract (compare.ts — shared client/server) ----

/** Requested delivery speed (Finder spec §6 — "delivery day"). */
export type DeliveryDay = 'any' | 'same_day' | 'next_day' | 'two_days'

export interface CompareInput {
  materialName: string
  qty: number
  radiusKm?: number | null
  deliveryDay?: DeliveryDay | null
}

/** A supplier + its best-matching catalog item, flattened for the pure engine. */
export interface CompareCandidate {
  supplierId: string
  businessName: string
  county: string
  town?: string | null
  lat?: number | null
  lng?: number | null
  deliveryFeeBase: number
  freeDeliveryOver?: number | null
  minimumOrder: number
  reliabilityScore: number // 0-100
  responseHours: number
  item: {
    id: string
    name: string
    unit: string
    unitPrice: number
    stockQty: number
    minOrderQty: number
    /** Catalog listing metadata (spec §29 Product/Brand/Specification) — display-only. */
    category?: string | null
    brand?: string | null
    specification?: string | null
  }
}

export type StockState = 'full' | 'partial' | 'none'
export type EtaTier = 'same day' | 'next day' | '2+ days'

export interface ScoreParts {
  price: number
  distance: number
  stock: number
  speed: number
  reliability: number
  total: number
}

/** One ranked result row — everything the UI table + breakdown needs. */
export interface CompareRow {
  supplierId: string
  businessName: string
  county: string
  town: string | null
  itemName: string
  unit: string
  /** Catalog listing metadata (spec §29) — shown in search rows when present. */
  category: string | null
  brand: string | null
  specification: string | null
  unitPrice: number
  qty: number
  productCost: number
  deliveryFee: number
  transportFee: number
  totalLanded: number
  distanceKm: number | null
  stockQty: number
  stockState: StockState
  minOrderQty: number
  minimumOrder: number
  meetsMinOrder: boolean
  etaTier: EtaTier
  reliabilityScore: number
  scores: ScoreParts
  flags: { bestOverall: boolean; cheapestUnit: boolean }
}

export interface CompareSite {
  lat: number
  lng: number
  label: string
}

export interface CompareResult {
  site: CompareSite
  rows: CompareRow[]
}

/** The exact weighted-score formula (documented once, used everywhere):
 *  price 0.45 (best-landed/landed, normalized against the BEST total)
 *  distance 0.15 (best-km/km)
 *  stock 0.15 (full=1 · partial=0.5 · none=0)
 *  delivery speed 0.10 (same-day=1 · next-day=0.6 · 2+=0.3)
 *  reliability 0.15 (supplier reliabilityScore/100)
 */
export const COMPARE_WEIGHTS = { price: 0.45, distance: 0.15, stock: 0.15, speed: 0.1, reliability: 0.15 } as const

// ---- PURE approval-band contract (policy.ts / insights.ts — shared) ----

export interface RuleLike {
  id?: string
  minAmount: number
  maxAmount: number | null
  approverRole: string
  priority: number
  active: boolean
}

// ---- PURE estimation + BOQ-lite contract (insights.ts — shared) ----

export interface EstimateBasis {
  total: number
  source: 'quotes' | 'catalog'
  unpricedLines: string[] // material names with no catalog/quote price found
}

export interface BoqMaterialRow {
  materialKey: string
  displayNames: string[]
  unit: string
  required: number
  purchased: number
  remaining: number
}

// ---- PURE BOQ-vs-actual lineage contract (insights.ts boqProgress — #203) ----
// The LINEAGE counterpart of BoqMaterialRow: per BoqLine, the whole
// estimated → requested → ordered → delivered → consumed chain walked over
// the FK links stamped by boqToRequest / createOrder / consumeStock — never
// over material-name matching. Unlinked (legacy/name-only) request lines are
// NOT guessed into these rows; boqProgress lists them separately so the UI
// can label the gap with the same honesty as BOQ-lite.

/** One BOQ line's chain position — every qty is 2-dp rounded. */
export interface BoqProgressRow {
  /** The BOQ this line belongs to (multiple BOQs share the view). */
  boqId: string
  boqLineId: string
  materialName: string
  unit: string
  /** BoqLine.qty — the estimate-of-record the client signed off on. */
  estimated: number
  /** Σ MaterialRequestLine.qty where boqLineId = this line, live requests (draft/submitted/approved/converted — rejected/cancelled excluded). */
  requested: number
  /** Σ PurchaseOrderLine.qty reached through requestLineId, non-cancelled orders. */
  ordered: number
  /** Σ OrderDeliveryLine.qtyReceived reached through orderLineId → requestLineId, non-voided deliveries. */
  delivered: number
  /** Σ StockMovement.quantity of type 'consumed' attributed via requestLineId. */
  consumed: number
  /**
   * estimated − consumed, SIGNED: negative is an OVERRUN of the
   * estimate-of-record (the quantity-overrun detection #203 exists for).
   * Unlike BOQ-lite's display-floored remaining, the sign is kept —
   * overruns must be visible, not clipped.
   */
  remaining: number
}

/** A live request line with no BOQ lineage (legacy or manually created). */
export interface BoqUnlinkedRequestLine {
  requestId: string
  requestCode: string
  materialName: string
  unit: string
  qty: number
}

/** The BOQ-vs-actual view: per-line rows + the honest unlinked listing. */
export interface BoqProgressResult {
  rows: BoqProgressRow[]
  unlinked: BoqUnlinkedRequestLine[]
}

export interface ProcurementTotals {
  required: number
  purchased: number
  committed: number
  remaining: number
  pendingRequests: number
  pendingApprovals: number
  ordersInTransit: number
  discrepancies: number
}
