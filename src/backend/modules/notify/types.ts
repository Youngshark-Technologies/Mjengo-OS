// Notifications module — types for the notify slice (INTERNAL — the payload
// already carries `notifications`, so this module powers the service layer and
// future notification-center endpoints instead of adding a payload field).
//
// Kinds are open strings; the notification center groups them with icons and
// filters. audienceRole targets who should act; readAt is the read timestamp.

import type { Notification } from '@prisma/client'

// ---- domain enums (open sets — new kinds are append-only) ----

export type NotificationKind =
  | 'recap' | 'milestone' | 'variation' | 'anomaly' | 'comment' | 'attendance'
  | 'share' | 'system'
  // v2 procurement / land kinds:
  | 'approval.requested' | 'approval.decided' | 'quote.received' | 'order.confirmed'
  | 'delivery.dispatched' | 'delivery.discrepancy' | 'invoice.submitted'
  | 'invoice.paid' | 'price.alert' | 'digest.weekly' | 'risk.flagged'
  // v3 platform kinds (domain-event bus + background jobs, F-PLATFORM):
  | 'project.delayed' | 'attendance.absent' | 'budget.alert' | 'ledger.reconciled'
  // Issue #212: the scheduled reconciliation job found |derived − projected|
  // ≥ the alert threshold on an escrow wallet — EscrowWallet.balance no
  // longer matches the ledger. Alert-only kind (finance + contractor).
  | 'escrow.drift'
  // W6-2 diaspora trust digest (event policy 'digest.trust'):
  | 'trust.digest'
  // Issue #211: a verified M-Pesa settlement arrived with no matching intent
  // (classically a timed-out initiation) — real money on the rail, nothing
  // posted (fail-closed); finance must reconcile manually. Alert-only kind.
  | 'payment.orphaned'

export type NotificationChannel = 'in_app' | 'whatsapp' | 'sms' | 'push'
export type AudienceRole = 'client' | 'contractor' | 'supervisor' | 'finance' | 'all'

// ---- slice shapes ----

/** The notify slice — used by the notify service + notification center. */
export interface NotifySlice {
  notifications: Notification[]
  unreadCount: number
}

export const EMPTY_NOTIFY_SLICE: NotifySlice = { notifications: [], unreadCount: 0 }

/** Options when emitting a notification (all optional except title/body). */
export interface NotifyOptions {
  kind?: string
  audienceRole?: string
  recipient?: string
  channel?: string
  /** Honest channel state — defaults to 'logged' (in-app row, nothing sent externally). */
  deliveryStatus?: string
  /**
   * Additionally attempt a real SMS delivery to this number (E.164
   * recommended). Only honored when an SMS provider is configured — the
   * webhook gateway (NOTIFY_SMS_WEBHOOK_URL) or the direct Africa's Talking
   * pair (AT_API_KEY + AT_USERNAME); see channels.ts for the precedence and
   * the credential tradeoff. Otherwise the row honestly stays 'logged' and
   * nothing is sent. The attempt never throws into the caller — the outcome
   * lands in deliveryStatus/deliveryDetail.
   *
   * Recipient preference gate (issue #36): pass `userId` when the call site
   * knows WHICH app user it is texting — notify() consults that user's
   * recorded preferences (User.notificationPrefs, JSON { kind: { inApp } })
   * before the send. A kind the recipient opted out of ({ inApp: false })
   * skips the SMS attempt entirely (no fetch; honest skip reason in
   * deliveryDetail). Without `userId` — or with no/opted-in prefs for the
   * kind — the attempt proceeds (fail-open: today's behavior).
   */
  sms?: { to: string; userId?: string }
  /**
   * Additionally attempt a real WEB PUSH delivery to this app user's recorded
   * browser subscriptions (PushSubscription rows, POST /api/push/subscribe).
   * Only honored when the VAPID pair is configured (channels.ts:
   * VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY) AND — in production —
   * VAPID_SUBJECT names a real contact (issue #354 / MD-2: unset or the
   * mailto:admin@localhost default fails closed there; dev keeps the
   * labeled fallback); otherwise the row honestly stays
   * 'logged' and web-push is never contacted. Never throws into the caller —
   * the aggregated outcome lands in deliveryStatus/deliveryDetail.
   *
   * Recipient preference gate: the SAME per-kind gate as SMS (the
   * notificationPrefs { inApp: false } opt-out skips the push attempt
   * entirely — no subscription is contacted; the row records the honest skip
   * reason). userId is REQUIRED for push (unlike SMS there is no phone-number
   * fallback — the subscriptions ARE the address); without it nothing is sent.
   */
  push?: { userId: string }
}

/** Delivery lifecycle of an external channel row (in-app 'logged' is the default). */
export type DeliveryStatus = 'logged' | 'sent' | 'failed'
