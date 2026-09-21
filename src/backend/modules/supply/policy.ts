// Supply & procurement (Finder) module — role permissions + approval band math.
//
// Finder spec §1 — who can INITIATE vs APPROVE vs PAY. Anyone authorized can
// request; the SYSTEM controls approval bands (§11) and payment (invoices
// module — money never moves here):
//
//   Role             | Can
//   -----------------+-----------------------------------------------------------
//   client           | request · create orders · approve in band · pay invoices ·
//                    | set spending limits (approval rules)
//   contractor       | request · create orders · approve within limits · manage
//                    | suppliers/catalog · receive deliveries
//   site supervisor  | request · order within authorized limits · confirm delivery
//   procurement off. | request quotes · compare · negotiate · create POs
//   finance          | approve in band (>250k chain) · invoices/payments
//   admin            | site-team omnibus (demo login belongs here)
//
// Default approval bands (project-configurable ApprovalRule rows, spec §11):
//   < KES 10,000        → supervisor
//   KES 10,000–50,000   → contractor
//   KES 50,000–250,000  → client
//   > KES 250,000       → client + finance (chain)
//
// Payment NEVER auto-releases on unmatched 3-way totals — the invoices module
// warns and lets a human decide.

import type { RuleLike } from './types'

export type SupplyRole =
  | 'client' | 'contractor' | 'supervisor' | 'procurement' | 'finance' | 'admin' | 'share_client'
export type SupplyAction =
  | 'request.create' | 'request.submit' | 'request.decide' | 'request.cancel'
  | 'quote.request' | 'quote.receive' | 'quote.decline'
  | 'order.create' | 'order.approve' | 'order.send' | 'order.confirm'
  | 'order.dispatch' | 'order.cancel' | 'order.close'
  | 'delivery.receive' | 'delivery.dispatch' | 'delivery.void'
  | 'supplier.upsert' | 'catalog.upsert'
  | 'rule.upsert' | 'rule.delete'
  | 'supply.compare' | 'supply.view'

const SITE_TEAM: SupplyRole[] = ['contractor', 'supervisor', 'procurement', 'finance', 'admin']

/** Role permission matrix (Finder §1 — initiator-broad, decisioner-narrow). */
export function supplyCan(role: SupplyRole, action: SupplyAction): boolean {
  // The share/client surface reads procurement data; every share-link mutation
  // is blocked upstream (share-route allowlist) and read actions are open.
  if (role === 'share_client') {
    return action === 'supply.view' || action === 'supply.compare'
  }
  // §24 client-direct ordering (backend wave): the client may ALSO raise
  // their own material requests and place purchase orders directly. They
  // still never run the rest of the loop (quotes, dispatch, receive,
  // suppliers, rules stay site-team), and request.decide stays open for the
  // CLIENT_ACTIONS band-approval seam — a client deciding OTHER people's
  // requests the bands route to them. A client's OWN request can never be
  // approved by them (service.decideApproval §24 guard + submitRequest
  // ladder substitution) — creation is not self-approval.
  if (role === 'client') {
    return (
      action === 'supply.view' ||
      action === 'supply.compare' ||
      action === 'request.create' ||
      action === 'order.create' ||
      action === 'request.decide'
    )
  }
  if (!SITE_TEAM.includes(role)) return false

  switch (action) {
    // 1) Anyone on the site team may initiate requests and shop around (§1)
    case 'request.create':
    case 'request.submit':
    case 'quote.request':
    case 'quote.receive':
    case 'quote.decline':
    case 'supply.compare':
    case 'supply.view':
    case 'order.create':
      return true

    // 2) Decisions belong to the band the rules engine resolves — never
    //    role-checked here (the server checks the actor against the PENDING
    //    Approval row in request.decide). Kept permissive in the matrix;
    //    the real gate is service.decideApproval.
    case 'request.decide':
      return true

    // 3) PO lifecycle + delivery ground truth — site team (contractor/
    //    supervisor receive; §1 "confirm delivery"). #206 adds the
    //    cancellation pair: request.cancel (withdrawal settles the approval
    //    chain — a site-team act, deliberately NOT in the client's §24 seam:
    //    a client may RAISE requests, but pulling one out of an in-flight
    //    approval chain is loop management) and delivery.void (voiding a
    //    mistaken dispatch rewrites the buyer's ground-truth record — the
    //    supplier portal keeps only order.confirm/order.dispatch, so a
    //    supplier cannot silently erase its own dispatch).
    case 'order.send':
    case 'order.confirm':
    case 'order.dispatch':
    case 'order.cancel':
    case 'order.close':
    case 'order.approve':
    case 'request.cancel':
    case 'delivery.receive':
    case 'delivery.dispatch':
    case 'delivery.void':
      return true

    // 4) Suppliers/catalog — contractor manages the network (§1). MD-6: this
    //    matrix case is now ENFORCED at the action layer (mjengo.ts
    //    SUPPLIER_MASTER_ACTIONS gate) for buyer-side roles too, not just the
    //    client/share seam — supervisor/procurement/qs/finance can no longer
    //    demo-edit any supplier's network-global rows. Supplier sessions edit
    //    their own rows via the W5-3 pin (supplier-scope.ts).
    case 'supplier.upsert':
    case 'catalog.upsert':
      return role === 'contractor' || role === 'admin'

    // 5) Spending limits — client sets them; contractor/admin may tune in
    //    this demo build (the ledger records every change)
    case 'rule.upsert':
    case 'rule.delete':
      return role === 'contractor' || role === 'admin'

    default:
      return false
  }
}

/**
 * Rules whose band [minAmount, maxAmount) contains the amount (maxAmount
 * null = no ceiling), ordered by priority. Multiple rules may chain — the
 * >250k band is TWO rules (client + finance), spec §11.
 */
export function matchingRules(rules: RuleLike[], amount: number): RuleLike[] {
  return rules
    .filter((r) => r.active && amount >= r.minAmount && (r.maxAmount === null || amount < r.maxAmount))
    .sort((a, b) => a.priority - b.priority)
}

/**
 * Required approver roles for an amount: matching rules, priority-ordered,
 * deduped by role (first/lowest-priority occurrence wins). Empty when no
 * active rule matches — callers apply the conservative default (client).
 */
export function requiredApproverRoles(rules: RuleLike[], amount: number): string[] {
  const roles: string[] = []
  for (const r of matchingRules(rules, amount)) {
    if (!roles.includes(r.approverRole)) roles.push(r.approverRole)
  }
  return roles
}

/** Back-compat resolver (F-1 stub contract): first-match-by-priority role. */
export function resolveApproverRole(
  rules: Array<{ minAmount: number; maxAmount: number | null; approverRole: string; priority: number; active: boolean }>,
  amount: number,
): string | null {
  return requiredApproverRoles(rules, amount)[0] ?? null
}
