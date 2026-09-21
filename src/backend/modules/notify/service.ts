// Notifications module — service layer.
//
// The single notify() entry point every domain SHOULD call on events
// (A-2-lite "events" — in-app rows now, external delivery where configured).
// Domains seeded in F-1 write rows with these kinds:
//
//   supply events:  approval.requested / approval.decided / quote.received /
//                   order.sent / order.confirmed / delivery.dispatched /
//                   delivery.discrepancy
//   invoice events: invoice.submitted / invoice.paid
//   intel events:   price.alert / digest.weekly / risk.flagged
//   platform kinds: milestone, variation, comment, recap, attendance, share…
//
// Rules: notifications are per-project scoped; audienceRole says WHO should
// act (client, contractor, finance, all); `read`/`readAt` are set by the
// notification-center mark-read path (/api/notifications — a client-side
// convenience route, not a domain mutation).
//
// Channels (honest delivery states):
//   · The in-app row is the source of truth and is written FIRST, exactly as
//     before — title/body/kind/audienceRole semantics unchanged.
//   · When a caller passes opts.sms AND an SMS provider is configured
//     (channels.ts: NOTIFY_SMS_WEBHOOK_URL first — the generic gateway — else
//     the AT_API_KEY + AT_USERNAME pair for the direct Africa's Talking
//     provider), notify() additionally attempts one real provider send and
//     records the outcome honestly via
//     markDelivered(): 'sent' (deliveredAt stamped) or 'failed' (leak-free
//     detail in deliveryDetail). The attempt NEVER throws into the caller.
//   · When a caller passes opts.push (W5-1 — the web push seam; call sites
//     opt in, none changed), notify() additionally attempts a real web push
//     to THAT user's recorded PushSubscription rows (the channel's address
//     book) when the VAPID pair is configured (VAPID_PUBLIC_KEY +
//     VAPID_PRIVATE_KEY) AND — in production — VAPID_SUBJECT names a real
//     contact (issue #354 / MD-2: unset or the mailto:admin@localhost
//     default fails closed there; dev keeps the labeled fallback). One row,
//     ONE aggregated honest outcome across the
//     user's subscriptions: 'sent' when at least one browser accepted
//     (deliveredAt stamped, providerRef = that subscription's endpoint),
//     'failed' when every attempt failed. Subscriptions the push service
//     answers 404/410 are pruned — nobody keeps pushing at a revoked one.
//   · With no provider configured, nothing external is contacted — every row
//     stays deliveryStatus 'logged' (fail-closed; if SMS/push was requested
//     the skip reason is recorded in deliveryDetail).
//   · WhatsApp/email are NOT wired: future providers implement ChannelProvider
//     (channels.ts) and get resolved here — the seam is the interface.
//
// Recipient preferences gate the SMS attempt (issue #36):
//   · The prefs model (User.notificationPrefs, recorded via PUT
//     /api/notifications) is a per-kind map { kind: { inApp: boolean } } —
//     there is NO explicit channel toggle today, so the gate is coarse and
//     per-KIND: an opt-out the recipient recorded for the notification's kind
//     ({ inApp: false }) skips the SMS attempt entirely (no fetch; the row
//     stays 'logged' with the skip reason in deliveryDetail). We never text a
//     user about a kind they muted — SMS is strictly more intrusive than the
//     in-app row the pref was recorded against.
//   · The in-app row is ALWAYS written regardless of prefs (the schema is
//     explicit: "the in-app channel is always on").
//   · DEFAULT FAIL-OPEN: a user with NO recorded prefs, an opted-in/absent
//     entry for the kind, an SMS opt without userId (recipient unknown), or
//     any preference-lookup failure → the attempt proceeds exactly as before
//     — behavior never silently changes for users who never opted out.
//     Lookup failures append an honest note to the recorded delivery detail.
//   · The gate only consults prefs (read-only); it never edits them.
//   · The SAME gate applies to the web push attempt (W5-1): push is also more
//     intrusive than the in-app row the pref was recorded against, so a muted
//     kind never reaches any external channel.

import { db } from '@/backend/lib/db'
import { getSmsProvider, resolvePushChannel, type ChannelSendInput } from './channels'
import type { NotifyOptions } from './types'

/**
 * Emit an in-app notification for a project event. Call this from action
 * handlers — never write db.notification rows directly from feature code.
 *
 * deliveryStatus defaults to 'logged' — an honest in-app row exists; no
 * external provider has been contacted. Passing opts.sms additionally
 * attempts a real SMS delivery WHEN a provider is configured (webhook URL or
 * Africa's Talking env pair — see channels.ts): the row then records the
 * real outcome ('sent'/'failed' + deliveryDetail) via markDelivered(). The
 * SMS attempt is additive — it can never break or delay-fail the in-app row.
 *
 * When opts.sms carries a userId, the recipient's recorded notification
 * preferences gate the attempt first (see the module header): a kind they
 * opted out of skips the send with an honest skip reason; anything else
 * fails open and proceeds as today.
 */
export async function notify(
  projectId: string,
  title: string,
  body: string,
  opts?: NotifyOptions,
): Promise<{ id: string }> {
  const row = await db.notification.create({
    data: {
      projectId,
      kind: typeof opts?.kind === 'string' && opts.kind ? opts.kind : 'system',
      title,
      body,
      channel: typeof opts?.channel === 'string' && opts.channel ? opts.channel : 'in_app',
      deliveryStatus: typeof opts?.deliveryStatus === 'string' && opts.deliveryStatus ? opts.deliveryStatus : 'logged',
      recipient: typeof opts?.recipient === 'string' ? opts.recipient : null,
      audienceRole: typeof opts?.audienceRole === 'string' ? opts.audienceRole : null,
    },
  })

  // Additive SMS attempt (opt-in via opts.sms). Catch-everything: a channel
  // problem must never take the in-app notification down with it. The
  // outcome feeds the push attempt's composition when BOTH channels are
  // opted in — one row, one honest combined state.
  let smsOutcome: ChannelOutcome | null = null
  if (opts?.sms) {
    smsOutcome = await attemptSmsDelivery(
      row.id,
      {
        to: typeof opts.sms.to === 'string' ? opts.sms.to : '',
        title,
        body,
        projectId,
        kind: row.kind,
      },
      typeof opts.sms.userId === 'string' && opts.sms.userId ? opts.sms.userId : undefined,
    )
  }

  // Additive web push attempt (opt-in via opts.push, W5-1). Same
  // catch-everything contract: the in-app row always survives a channel.
  // When an SMS attempt ran first, its outcome is composed in — a prior real
  // 'sent' is never downgraded by a push skip/failure (the ledger never
  // lies in either direction).
  if (opts?.push) {
    await attemptPushDelivery(
      row.id,
      { title, body, projectId, kind: row.kind },
      typeof opts.push.userId === 'string' && opts.push.userId ? opts.push.userId : undefined,
      smsOutcome,
    )
  }
  return { id: row.id }
}

/** The outcome one channel attempt recorded (or intends to record) on the row. */
interface ChannelOutcome {
  status: 'logged' | 'sent' | 'failed'
  detail: string
}

/** Outcome of consulting the recipient's recorded preferences for one SMS attempt. */
interface SmsPrefGate {
  /** false → skip the send entirely (the recipient opted out of this kind). */
  send: boolean
  /** Skip reason (send=false) or the honest why-the-gate-did-not-apply note (send=true). */
  detail?: string
}

/** Type guard: a per-kind pref entry as the recording route writes it ({ inApp }) — anything else fails open. */
function isPrefObject(v: unknown): v is { inApp?: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Resolve the recipient's notification preferences for one external attempt
 * (SMS or web push — the gate is channel-agnostic: an opt-out the recipient
 * recorded for the kind means "do not reach me about this", on any channel).
 * Never throws; every failure mode fails OPEN (the attempt proceeds — today's
 * behavior) with an honest note for the row. Coarse per-kind gate over
 * User.notificationPrefs — see the module header for the documented default.
 */
async function resolveRecipientPrefGate(userId: string | undefined, kind: string): Promise<SmsPrefGate> {
  if (!userId) return { send: true } // recipient user unknown — no gate, today's behavior
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    })
    if (!user) {
      return { send: true, detail: 'recipient user not found — preferences not consulted (fail-open)' }
    }
    const prefs = parseNotificationPrefs(user.notificationPrefs)
    if (!prefs) {
      return { send: true, detail: 'recipient preferences unreadable — attempted anyway (fail-open)' }
    }
    const kindPref: unknown = prefs[kind]
    if (isPrefObject(kindPref) && kindPref.inApp === false) {
      return {
        send: false,
        detail: `skipped: recipient preference disables "${kind}" notifications — nothing sent`,
      }
    }
    return { send: true } // opted in, or no entry for this kind — fail open per kind
  } catch {
    return { send: true, detail: 'recipient preference lookup failed — attempted anyway (fail-open)' }
  }
}

/**
 * Parse User.notificationPrefs → a kind→pref map, or null when the stored
 * value is present but unreadable (malformed JSON / not an object). A MISSING
 * value and an UNREADABLE one are different honest states: absent returns {}
 * (no gate), unreadable returns null (gate could not be consulted → fail open
 * + note). Never throws.
 */
function parseNotificationPrefs(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return {}
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    return null // present but not an object — unreadable
  } catch {
    return null // malformed JSON — unreadable
  }
}

/**
 * One honest SMS attempt for a freshly created notification row. Never
 * throws; every outcome (sent / failed / skipped-and-why) lands in the row's
 * deliveryStatus + deliveryDetail via markDelivered(), and is RETURNED so a
 * later push attempt (when both channels are opted in) can compose one
 * honest combined state. The recipient's recorded preferences are consulted
 * FIRST — an opted-out kind never reaches the provider (no fetch at all).
 * Returns null only when the belt-and-braces catch fired.
 */
async function attemptSmsDelivery(id: string, input: ChannelSendInput, userId?: string): Promise<ChannelOutcome | null> {
  try {
    const gate = await resolveRecipientPrefGate(userId, input.kind)
    if (!gate.send) {
      return await markAndReturn(id, 'logged', gate.detail)
    }
    if (!input.to) {
      return await markAndReturn(id, 'logged', 'SMS requested but no recipient number provided — nothing sent')
    }
    const provider = getSmsProvider()
    if (!provider) {
      // Fail-closed: nothing configured → nothing sent — say so honestly.
      return await markAndReturn(
        id,
        'logged',
        'SMS requested but no provider configured (NOTIFY_SMS_WEBHOOK_URL or AT_API_KEY+AT_USERNAME unset) — nothing sent',
      )
    }
    const result = await provider.send(input)
    // When the gate could not be consulted (lookup failure / unknown user /
    // unreadable prefs), append the honest note to the real outcome detail.
    return await markAndReturn(id, result.status, gate.detail ? `${result.detail} — ${gate.detail}` : result.detail)
  } catch {
    // Belt-and-braces: provider.send already returns instead of throwing and
    // markDelivered swallows its own errors — but a channel attempt must
    // NEVER propagate into notify().
    try {
      await markDelivered(id, 'failed', 'SMS delivery attempt errored')
    } catch {
      // row gone — nothing to record
    }
    return null
  }
}

/** Record an outcome on the row and hand it back for later composition. */
async function markAndReturn(
  id: string,
  status: 'logged' | 'sent' | 'failed',
  detail?: string,
): Promise<ChannelOutcome> {
  await markDelivered(id, status, detail)
  return { status, detail: detail ?? '' }
}

/**
 * One honest WEB PUSH attempt for a freshly created notification row (W5-1).
 * Targets EVERY PushSubscription the recipient user recorded — one row, one
 * aggregated outcome: at least one browser accepted → 'sent' (deliveredAt
 * stamped, detail carries the first accepted subscription's endpoint as the
 * provider ref); every attempt failed → 'failed'. Subscriptions the push
 * service answered 404/410 (gone) are pruned right here — a revoked endpoint
 * is deleted, not retried forever. Every skip state (no user, muted kind, no
 * subscriptions, no VAPID pair, no usable production VAPID subject)
 * honestly stays 'logged' with the reason.
 * Never throws into notify().
 */
async function attemptPushDelivery(
  id: string,
  input: Omit<ChannelSendInput, 'to' | 'pushSubscription'>,
  userId: string | undefined,
  priorSms?: ChannelOutcome | null,
): Promise<void> {
  try {
    // Push has no phone-number fallback: without a userId there is no address
    // to push to — say so honestly, send nothing.
    if (!userId) {
      await markPushOutcome(id, 'logged', 'Web push requested but no recipient user provided — nothing sent', priorSms)
      return
    }
    const gate = await resolveRecipientPrefGate(userId, input.kind)
    if (!gate.send) {
      await markPushOutcome(id, 'logged', gate.detail ?? 'skipped: recipient preference opted out of this kind — nothing sent', priorSms)
      return
    }
    let subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    try {
      subs = await db.pushSubscription.findMany({ where: { userId } })
    } catch {
      await markPushOutcome(id, 'logged', 'Web push subscription lookup failed — nothing sent (fail-closed)', priorSms)
      return
    }
    if (subs.length === 0) {
      await markPushOutcome(id, 'logged', 'Web push requested but this user has no recorded subscription — nothing sent', priorSms)
      return
    }
    const { provider, refusalDetail } = resolvePushChannel()
    if (!provider) {
      // Fail-closed: no sendable VAPID setup → nothing sent — say so
      // honestly, with the precise reason (no pair, or issue #354's
      // production subject refusal). The subscriptions stay stored for the
      // day the operator configures them.
      await markPushOutcome(id, 'logged', refusalDetail, priorSms)
      return
    }

    let delivered = 0
    let pruned = 0
    let firstFailureDetail = ''
    let firstAcceptedEndpoint = ''
    for (const sub of subs) {
      const result = await provider.send({
        ...input,
        to: sub.endpoint,
        pushSubscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      })
      if (result.ok) {
        delivered += 1
        if (!firstAcceptedEndpoint && result.providerRef) firstAcceptedEndpoint = result.providerRef
        continue
      }
      if (!firstFailureDetail) firstFailureDetail = result.detail
      if (result.gone) {
        pruned += 1
        try {
          await db.pushSubscription.delete({ where: { id: sub.id } })
        } catch {
          // row already gone (concurrent unsubscribe) — the outcome stands
        }
      }
    }

    const suffix =
      (gate.detail ? ` — ${gate.detail}` : '') +
      (pruned > 0 ? ` — ${pruned} gone subscription(s) pruned` : '')
    if (delivered > 0) {
      await markPushOutcome(
        id,
        'sent',
        `Web push delivered to ${delivered} of ${subs.length} subscription(s)` +
          (firstAcceptedEndpoint ? ` (ref ${firstAcceptedEndpoint})` : '') +
          suffix,
        priorSms,
      )
    } else {
      await markPushOutcome(
        id,
        'failed',
        (firstFailureDetail || 'Web push failed') + ` — 0 of ${subs.length} subscription(s) delivered` + suffix,
        priorSms,
      )
    }
  } catch {
    // Belt-and-braces: provider.send returns instead of throwing and
    // markDelivered swallows its own errors — but a channel attempt must
    // NEVER propagate into notify().
    try {
      await markDelivered(id, 'failed', 'Web push delivery attempt errored')
    } catch {
      // row gone — nothing to record
    }
  }
}

/**
 * Record the push outcome on the row, composing with a prior SMS outcome
 * when both channels were opted in (one row, one honest combined state):
 * a prior real 'sent' is never downgraded by a push skip/failure — but the
 * detail always states both channels' outcomes verbatim.
 */
async function markPushOutcome(
  id: string,
  status: 'logged' | 'sent' | 'failed',
  detail: string,
  priorSms?: ChannelOutcome | null,
): Promise<void> {
  const finalStatus = priorSms?.status === 'sent' ? 'sent' : status
  const finalDetail = priorSms ? `${detail} — SMS: ${priorSms.detail}` : detail
  await markDelivered(id, finalStatus, finalDetail)
}

/**
 * Update a notification's delivery state — the seam providers report through.
 * 'sent' stamps deliveredAt; any other status just records the state
 * honestly. deliveryDetail (optional) carries the provider's leak-free
 * outcome detail (e.g. 'SMS gateway responded HTTP 500' / '…timed out after
 * 8s') or the honest skip reason; omit it to leave the current detail alone.
 */
export async function markDelivered(
  id: string,
  status: 'logged' | 'sent' | 'failed',
  deliveryDetail?: string,
): Promise<{ id: string; deliveryStatus: string; deliveryDetail: string | null } | null> {
  try {
    const row = await db.notification.update({
      where: { id },
      data: {
        deliveryStatus: status,
        ...(status === 'sent' ? { deliveredAt: new Date() } : {}),
        ...(deliveryDetail !== undefined ? { deliveryDetail } : {}),
      },
    })
    return { id: row.id, deliveryStatus: row.deliveryStatus, deliveryDetail: row.deliveryDetail ?? null }
  } catch {
    return null // row gone (deleted project) — nothing to update
  }
}

/**
 * Bulk mark-read for a project — the server-side half of the notification
 * center. Sets BOTH `read` (drives the bell badge) and `readAt` (only where
 * it was still null, so the first-read timestamp is preserved).
 */
export async function markRead(
  projectId: string,
  ids: string[] | 'all',
): Promise<{ updated: number }> {
  const where = ids === 'all' ? { projectId, read: false } : { projectId, id: { in: ids }, read: false }
  const result = await db.notification.updateMany({ where, data: { read: true, readAt: new Date() } })
  return { updated: result.count }
}

/** Mark every notification of a project read (legacy readAll semantics). */
export async function markAllRead(projectId: string): Promise<{ updated: number }> {
  return markRead(projectId, 'all')
}
