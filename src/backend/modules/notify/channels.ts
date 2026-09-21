import { sendNotification } from 'web-push'
import { log } from '@/backend/lib/log'

// Notifications module — external channel providers (the provider seam).
//
// The ChannelProvider interface is how notify() reaches people who are not
// staring at the app. SMS is wired today in two flavors behind the same
// interface — WebhookSmsProvider (generic gateway) and AtSmsProvider
// (Africa's Talking REST) — and WebPushProvider (VAPID web push) is the third;
// WhatsApp and email are future providers that implement the same interface
// and get resolved in service.ts — no new concepts needed.
//
// Honest by construction:
//   · A provider is only "configured" when its env is present — no URL, no
//     send; the notification row stays 'logged' (fail-closed, never fakes a
//     delivery).
//   · send() NEVER throws: every failure mode (timeout, non-2xx, network
//     error) comes back as { status: 'failed', detail } with an operator-
//     readable detail that leaks nothing internal — error CLASS only, never
//     stack traces, API keys or provider URLs (fetch error messages can
//     embed URLs).
//
// CREDENTIAL TRADEOFF (the operator's choice — both documented, both real):
//   · WebhookSmsProvider keeps provider credentials OUT of this app: the
//     gateway you own holds the Twilio/AT secrets and we only POST JSON to
//     it. One more moving part to run, zero secrets on the app server.
//   · AtSmsProvider calls Africa's Talking REST directly — no relay to
//     operate, but the app env then HOLDS the AT API key (AT_API_KEY +
//     AT_USERNAME). That key can send (and bill) SMS on your account:
//     env-file discipline (never committed, narrow read access) is the
//     mitigation. Webhook keeps precedence when both are configured — an
//     existing webhook deployment never changes behavior by adding AT vars.

// ── WebhookSmsProvider contract (env: NOTIFY_SMS_WEBHOOK_URL) ──────────────
//
// Generic SMS-gateway webhook: works with a plain relay you own, a
// Twilio-proxy, or an Africa's Talking-style callback endpoint. The gateway
// receives exactly one JSON POST per attempted SMS:
//
//   POST ${NOTIFY_SMS_WEBHOOK_URL}
//   Content-Type: application/json
//   Authorization: Bearer ${NOTIFY_SMS_WEBHOOK_TOKEN}     // header only if set
//   {
//     "to":       "+2547XXXXXXXX",     // E.164 recommended, passed through as-is
//     "text":     "Title\n\nBody",     // the full SMS body (title + blank line + body)
//     "metadata": { "projectId": "…", "kind": "…" }   // for routing / dedupe
//   }
//
// Response handling (the whole contract):
//   · any 2xx  → the gateway accepted the message = 'sent'. The body MAY be
//                JSON with a string `id` (or `providerRef`) — recorded as
//                providerRef for later correlation. Non-JSON/empty body is
//                fine; the ref is best-effort.
//   · non-2xx  → 'failed', detail carries the HTTP status.
//   · timeout  → 'failed' after 8s (AbortSignal.timeout — a stuck gateway
//                can never hang notify()).
//   · network  → 'failed', detail carries the error class only (e.g.
//                TypeError) — the URL/cause stays out of the row.
//
// The app holds no provider credentials beyond the optional bearer token;
// actual provider auth (Twilio SID/token, AT API key, …) lives in the gateway.

// ── AtSmsProvider contract (env: AT_API_KEY + AT_USERNAME) ────────────────
//
// Direct Africa's Talking REST v1 messaging call — the dominant Kenyan
// aggregator — for teams that standardize on AT and don't want to run a
// webhook relay. Mirrors WebhookSmsProvider exactly (same interface, same
// 8s timeout, same leak-free failure details). The request is the real AT
// REST shape, form-urlencoded (NOT JSON):
//
//   POST https://api.africaistalking.com/version1/messaging
//   Content-Type: application/x-www-form-urlencoded
//   apiKey: ${AT_API_KEY}                              // AT's auth header
//   username=${AT_USERNAME}&to=+2547XXXXXXXX&message=…&from=${AT_SENDER_ID}
//
//   · to        — the destination number, passed through as-is (E.164
//                 recommended; AT also accepts local 07.. format).
//   · message   — the full SMS body (title + blank line + body, exactly
//                 what the webhook provider sends as `text`).
//   · from      — AT_SENDER_ID, ONLY when set: a registered short code /
//                 alphanumeric sender id. Unset → AT uses the account's
//                 default sender (sandbox: the shared 7000-something id).
//   · username  — the AT account username ("sandbox" on sandbox accounts).
//   · AT_ENV=sandbox selects the sandbox host
//     (api.sandbox.africaistalking.com) for credential testing without
//     spending credit — anything else/unset = production host. Mirrors the
//     DARAJA_ENV pattern of the wallet module.
//
// Response handling (mirrors the webhook contract):
//   · 2xx → 'sent'. The body is JSON
//     { SMSMessageData: { Recipients: [{ messageId, … }], Message } } — the
//     first recipient's messageId is recorded as providerRef (best-effort:
//     a non-JSON/odd body is still 'sent', just without a ref).
//   · non-2xx → 'failed', detail carries the HTTP status ONLY — never the
//     body (an AT error body could echo request material; status suffices).
//   · timeout  → 'failed' after 8s (AbortSignal.timeout — a stuck AT API
//                can never hang notify()).
//   · network  → 'failed', detail carries the error class only (e.g.
//                TypeError) — the key/host stays out of the row.

// ── WebPushProvider contract (env: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY, ───
//    optional VAPID_SUBJECT) ──────────────────────────────────────────────
//
// The retention loop for the diaspora client persona: real web push to the
// browser subscriptions recorded via POST /api/push/subscribe (the PWA's sw.js
// already ships offline; push is the "tab is closed" half). Same honesty rules
// as the SMS providers — this is the third ChannelProvider behind the seam:
//
//   · CONFIGURED only when the VAPID PAIR is present. A partial pair (public
//     without private or vice versa) resolves to null — fail-closed, exactly
//     like a partial AT pair. With no provider: subscriptions are STILL stored
//     by the routes, but notify() send attempts honestly stay 'logged' and
//     web-push is never contacted.
//   · VAPID_SUBJECT (a mailto: or https:// URL the push services can contact
//     about your traffic — the VAPID spec's abuse-contact) is REQUIRED IN
//     PRODUCTION (issue #354 / MD-2): unset or left at the labeled
//     'mailto:admin@localhost' default, the channel FAILS CLOSED there — no
//     provider (sends stay 'logged' with the refusal reason, the browser
//     config probe answers { configured: false }), one loud log.error per
//     process. Dev/test keeps the labeled fallback with ONE log.warn — the
//     NEXTAUTH_SECRET dev-fallback posture (lib/next-auth-guard.ts).
//   · send() NEVER throws. web-push's sendNotification is called PER
//     SUBSCRIPTION with the per-call vapidDetails (no library-global
//     setVapidDetails state — the provider stays stateless and testable).
//     The payload is buildWebPushPayload(input) — the exact JSON shape
//     public/sw.js's push handler parses (title, body, projectId, kind —
//     the click deep-link /?projectId=<id> is derived client-side from
//     projectId). TTL is 24h: a milestone text that wakes a phone four weeks
//     later is a lie about freshness.
//   · Outcomes: 2xx from the push service → 'sent' with the subscription
//     endpoint as providerRef (the push service's own correlation handle for
//     that browser). A 404/410 answer means the subscription is GONE —
//     'failed' with { gone: true } so the notify service prunes the dead row
//     instead of pushing at it forever. Any other status → 'failed' with the
//     HTTP status only. Network/timeout → 'failed' with the error class only
//     (WebPushError messages embed the endpoint URL — they never reach the
//     row). The 8s cap rides along as web-push's socket timeout.
//   · Keys: the app env holds the VAPID PRIVATE key — env-file discipline as
//     documented for AT_API_KEY. The PUBLIC key is handed to browsers by GET
//     /api/push/subscribe ({ configured: false } when the pair is not set).

/** One browser push subscription, as the routes store it / the provider needs it. */
export interface PushSubscriptionTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Web-push TTL: 24h — stale site news waking a phone later is dishonest. */
const PUSH_TTL_SEC = 24 * 60 * 60

/**
 * The labeled DEV fallback VAPID subject (push services want a contact for
 * abuse replies). Issue #354 / MD-2: production REFUSES it — unset or default
 * fails closed there; only non-production runtimes run on this fallback.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@localhost'

/** Africa's Talking REST hosts (AT_ENV=sandbox switches to the sandbox one). */
const AT_PROD_BASE = 'https://api.africaistalking.com'
const AT_SANDBOX_BASE = 'https://api.sandbox.africaistalking.com'

/** One attempted delivery to one external channel. */
export interface ChannelSendInput {
  to: string
  title: string
  body: string
  projectId: string
  kind: string
  /**
   * Web-push only: the full subscription this send targets (endpoint +
   * p256dh/auth keys). `to` carries the same subscription's endpoint URL so
   * providerRef/details stay a single string like the SMS providers. The SMS
   * providers ignore this field.
   */
  pushSubscription?: PushSubscriptionTarget
}

/** The honest outcome of one attempt — never thrown, always returned. */
export interface ChannelSendResult {
  ok: boolean
  status: 'sent' | 'failed'
  /** Provider-side reference (e.g. gateway message id) when one is available. */
  providerRef?: string
  /** Operator-readable, leak-free detail recorded in Notification.deliveryDetail. */
  detail: string
  /**
   * Web-push only: the push service answered 404/410 — the subscription no
   * longer exists. The notify service prunes the stored row; nobody keeps
   * sending to a revoked subscription.
   */
  gone?: boolean
}

/** A delivery channel (SMS today; WhatsApp/email are future implementations). */
export interface ChannelProvider {
  readonly id: string
  readonly label: string
  send(input: ChannelSendInput): Promise<ChannelSendResult>
}

/** Hard cap on any single provider call — 8s, then the attempt fails honestly. */
const SEND_TIMEOUT_MS = 8_000

/**
 * The default SMS provider: a JSON POST to a generic SMS webhook (keeps all
 * provider credentials in the gateway — the documented tradeoff above).
 * Built via getSmsProvider() so the env is read at call time (never cached
 * across a long-lived process — or across tests).
 */
export class WebhookSmsProvider implements ChannelProvider {
  readonly id = 'webhook-sms'
  readonly label = 'SMS webhook gateway'

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          to: input.to,
          text: `${input.title}\n\n${input.body}`,
          metadata: { projectId: input.projectId, kind: input.kind },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })

      if (!res.ok) {
        return { ok: false, status: 'failed', detail: `SMS gateway responded HTTP ${res.status}` }
      }

      // 2xx = the gateway accepted the message. Best-effort ref capture:
      // body MAY be JSON { "id": "…" } (or { "providerRef": "…" }).
      const providerRef = await readProviderRef(res)
      return {
        ok: true,
        status: 'sent',
        ...(providerRef ? { providerRef } : {}),
        detail: providerRef ? `SMS gateway accepted (ref ${providerRef})` : 'SMS gateway accepted',
      }
    } catch (err) {
      // Never throw into the caller. Error CLASS only in the detail —
      // messages/causes can embed internal URLs, stack traces stay out.
      const name = err instanceof Error ? err.name : 'unknown'
      if (name === 'TimeoutError') {
        return { ok: false, status: 'failed', detail: `SMS gateway timed out after ${SEND_TIMEOUT_MS / 1000}s` }
      }
      return { ok: false, status: 'failed', detail: `SMS gateway unreachable (${name})` }
    }
  }
}

/** Read an optional { id } / { providerRef } string from a 2xx body — best-effort. */
async function readProviderRef(res: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await res.text())
    if (parsed && typeof parsed === 'object') {
      const ref = (parsed as Record<string, unknown>).providerRef ?? (parsed as Record<string, unknown>).id
      if (typeof ref === 'string' && ref) return ref
    }
  } catch {
    // not JSON / empty body — no ref, still 'sent'
  }
  return undefined
}

/**
 * Direct Africa's Talking REST provider — for teams standardized on AT.
 * Same honesty rules as WebhookSmsProvider: never throws, 8s cap, leak-free
 * details (no API key, no host) on every failure path.
 */
export class AtSmsProvider implements ChannelProvider {
  readonly id = 'at-sms'
  readonly label = "Africa's Talking SMS"

  constructor(
    private readonly apiKey: string,
    private readonly username: string,
    private readonly senderId?: string,
    private readonly baseUrl: string = AT_PROD_BASE,
  ) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    try {
      // The real AT REST v1 shape: form-urlencoded fields, apiKey header.
      const form = new URLSearchParams({
        username: this.username,
        to: input.to,
        message: `${input.title}\n\n${input.body}`,
        ...(this.senderId ? { from: this.senderId } : {}),
      })
      const res = await fetch(`${this.baseUrl}/version1/messaging`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          apikey: this.apiKey,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })

      if (!res.ok) {
        // Status ONLY — the AT error body is not echoed (leak-free).
        return { ok: false, status: 'failed', detail: `Africa's Talking responded HTTP ${res.status}` }
      }

      // 2xx = AT accepted the message. Best-effort ref capture from the real
      // response shape: SMSMessageData.Recipients[0].messageId.
      const providerRef = await readAtMessageId(res)
      return {
        ok: true,
        status: 'sent',
        ...(providerRef ? { providerRef } : {}),
        detail: providerRef
          ? `Africa's Talking accepted (messageId ${providerRef})`
          : `Africa's Talking accepted`,
      }
    } catch (err) {
      // Never throw into the caller. Error CLASS only in the detail — an
      // AT fetch failure message can embed the host/URL; it stays out.
      const name = err instanceof Error ? err.name : 'unknown'
      if (name === 'TimeoutError') {
        return { ok: false, status: 'failed', detail: `Africa's Talking timed out after ${SEND_TIMEOUT_MS / 1000}s` }
      }
      return { ok: false, status: 'failed', detail: `Africa's Talking unreachable (${name})` }
    }
  }
}

/** Read SMSMessageData.Recipients[0].messageId from a 2xx AT body — best-effort. */
async function readAtMessageId(res: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await res.text())
    if (parsed && typeof parsed === 'object') {
      const data = (parsed as Record<string, unknown>).SMSMessageData
      if (data && typeof data === 'object') {
        const recipients = (data as Record<string, unknown>).Recipients
        if (Array.isArray(recipients)) {
          const first = recipients[0] as Record<string, unknown> | undefined
          const ref = first?.messageId
          if (typeof ref === 'string' && ref) return ref
        }
      }
    }
  } catch {
    // not JSON / empty body — no ref, still 'sent'
  }
  return undefined
}

/**
 * Resolve the SMS provider from env, at call time. Precedence (documented,
 * backwards compatible): webhook FIRST (a webhook deployment is unchanged by
 * AT env appearing), then the Africa's Talking pair, else null → no external
 * send is attempted and the notification row stays 'logged' (fail-closed,
 * honest). A PARTIAL AT pair (key without username or vice versa) resolves to
 * null, not to a provider that will 401 on every send — fail closed.
 */
export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): ChannelProvider | null {
  const url = (env.NOTIFY_SMS_WEBHOOK_URL ?? '').trim()
  if (url) {
    const token = (env.NOTIFY_SMS_WEBHOOK_TOKEN ?? '').trim()
    return new WebhookSmsProvider(url, token || undefined)
  }
  const apiKey = (env.AT_API_KEY ?? '').trim()
  const username = (env.AT_USERNAME ?? '').trim()
  if (apiKey && username) {
    const senderId = (env.AT_SENDER_ID ?? '').trim()
    const sandbox = (env.AT_ENV ?? '').trim().toLowerCase() === 'sandbox'
    return new AtSmsProvider(apiKey, username, senderId || undefined, sandbox ? AT_SANDBOX_BASE : AT_PROD_BASE)
  }
  return null
}

// ── WebPushProvider (VAPID) ──────────────────────────────────────────────────

/**
 * The JSON payload one web push carries — THE CONTRACT shared with the service
 * worker (public/sw.js parses exactly these fields; src/frontend/sw-handlers.ts
 * is the mirrored pure parser the tests round-trip against). Pure and exported
 * so provider tests and sw-handler tests can pin the same shape without a
 * network. The deep-link (/?projectId=<id>) is derived client-side from
 * projectId — the server never guesses the app's routing.
 */
export function buildWebPushPayload(input: ChannelSendInput): string {
  return JSON.stringify({
    title: input.title,
    body: input.body,
    projectId: input.projectId,
    kind: input.kind,
  })
}

/**
 * Real web push to one browser subscription via the web-push library (VAPID).
 * Same honesty rules as the SMS providers: never throws, leak-free details
 * (WebPushError messages embed the endpoint — only the HTTP status / error
 * class ever reaches the row), and a 24h TTL. vapidDetails ride each call —
 * no library-global setVapidDetails state.
 */
export class WebPushProvider implements ChannelProvider {
  readonly id = 'web-push'
  readonly label = 'Web push (VAPID)'

  constructor(
    private readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string = DEFAULT_VAPID_SUBJECT,
  ) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    const subscription = input.pushSubscription
    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      // Defensive: the notify service always passes a full subscription; a
      // half-shaped one is a bug, reported honestly, never thrown.
      return { ok: false, status: 'failed', detail: 'Web push attempted without a complete subscription — nothing sent' }
    }
    try {
      await sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        buildWebPushPayload(input),
        {
          vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
          TTL: PUSH_TTL_SEC,
          timeout: SEND_TIMEOUT_MS, // the same 8s cap the SMS providers enforce
        },
      )
      // web-push resolves only on 2xx from the push service. The subscription
      // endpoint is the provider-side reference for this browser.
      return {
        ok: true,
        status: 'sent',
        providerRef: subscription.endpoint,
        detail: 'Web push accepted by the push service',
      }
    } catch (err) {
      // Never throw into the caller. WebPushError carries a statusCode (and a
      // message that embeds the endpoint) — status/class ONLY in the detail.
      const status = (err as { statusCode?: unknown }).statusCode
      if (typeof status === 'number') {
        const gone = status === 404 || status === 410
        return {
          ok: false,
          status: 'failed',
          detail: gone
            ? `Push service responded HTTP ${status} (subscription gone)`
            : `Push service responded HTTP ${status}`,
          ...(gone ? { gone: true } : {}),
        }
      }
      const name = err instanceof Error ? err.name : 'unknown'
      return { ok: false, status: 'failed', detail: `Web push unreachable (${name})` }
    }
  }
}

/**
 * (issue #354 / MD-2) The VAPID subject posture as ONE pure verdict — the
 * same shape as lib/next-auth-guard.ts's nextAuthSecretVerdict, so the
 * decision is unit-testable without a provider or a network:
 *
 *   · a real contact (non-empty, not the labeled default) → ok, used verbatim;
 *   · unset / blank / still 'mailto:admin@localhost' + NODE_ENV=production
 *     → NOT ok — the channel refuses (fail closed);
 *   · the same values on any other runtime → ok on the labeled
 *     DEFAULT_VAPID_SUBJECT fallback (fellBack: true — dev stays usable,
 *     exactly like the NEXTAUTH_SECRET dev fallback).
 */
export type VapidSubjectVerdict =
  | { ok: true; subject: string; fellBack: false }
  | { ok: true; subject: string; fellBack: true; problem: 'unset' | 'localhost-default' }
  | { ok: false; problem: 'unset' | 'localhost-default' }

export function vapidSubjectVerdict(
  subject: string | null | undefined,
  nodeEnv: string | undefined,
): VapidSubjectVerdict {
  const trimmed = (subject ?? '').trim()
  if (trimmed && trimmed !== DEFAULT_VAPID_SUBJECT) return { ok: true, subject: trimmed, fellBack: false }
  const problem: 'unset' | 'localhost-default' = trimmed ? 'localhost-default' : 'unset'
  if (nodeEnv === 'production') return { ok: false, problem }
  return { ok: true, subject: DEFAULT_VAPID_SUBJECT, fellBack: true, problem }
}

/**
 * (issue #354) Runtime×problem keys already warned in THIS process — the
 * once-only Set pattern of lib/webhook-secret-warning.ts. A real process
 * never changes NODE_ENV mid-run, so this is one line per posture; tests
 * that flip NODE_ENV get one line per distinct runtime they pass in.
 */
const vapidSubjectWarned = new Set<string>()

/**
 * ONE loud line per process for a refusal-grade VAPID subject: log.error in
 * production (the channel just failed closed — the operator must know),
 * log.warn elsewhere (the labeled fallback is active — set a real contact
 * before any real deployment). Mirrors the NEXTAUTH_SECRET guard's split.
 */
function warnVapidSubjectPostureOnce(env: NodeJS.ProcessEnv, problem: 'unset' | 'localhost-default'): void {
  const nodeEnv = env.NODE_ENV ?? '<unset>'
  const key = `${nodeEnv}|${problem}`
  if (vapidSubjectWarned.has(key)) return
  vapidSubjectWarned.add(key)
  const state = problem === 'unset' ? 'is unset' : 'is still the mailto:admin@localhost dev default'
  if (env.NODE_ENV === 'production') {
    log.error(
      'notify',
      `PRODUCTION POSTURE: VAPID_SUBJECT ${state} — web push FAILS CLOSED ` +
        `(sends stay deliveryStatus "logged" with the refusal reason; the browser config probe answers ` +
        `{ configured: false }) until a real contact is set. Set VAPID_SUBJECT to a mailto: or https:// URL ` +
        `the push services (FCM, Apple, Mozilla) can contact about your traffic ` +
        `(e.g. mailto:ops@yourdomain.example) and restart (MD-2, issue #354).`,
    )
    return
  }
  log.warn(
    'notify',
    `VAPID_SUBJECT ${state} — pushes in this ${nodeEnv} runtime run on the labeled ` +
      `mailto:admin@localhost fallback (the push services want a contact for abuse replies). ` +
      `Set a real mailto:/https:// contact before any real deployment; production fails ` +
      `closed without it (MD-2, issue #354).`,
  )
}

/**
 * Resolve the web push channel from env, at call time (same discipline as
 * getSmsProvider — never cached across a long-lived process or tests).
 * VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY BOTH required: a partial pair resolves
 * to no provider, not to a provider that would fail every send — fail closed.
 * Issue #354 / MD-2: in production the pair is ALSO not enough — an unset or
 * still-default VAPID_SUBJECT refuses the channel the same way. With no
 * provider, notify() push attempts honestly stay 'logged' (refusalDetail
 * carries the precise reason for the row) and web-push is never contacted
 * (subscriptions are still stored by the routes).
 */
export function resolvePushChannel(
  env: NodeJS.ProcessEnv = process.env,
): { provider: WebPushProvider | null; refusalDetail: string } {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim()
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim()
  if (!publicKey || !privateKey) {
    return {
      provider: null,
      refusalDetail:
        'Web push requested but no VAPID pair configured (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY unset) — nothing sent',
    }
  }
  const verdict = vapidSubjectVerdict(env.VAPID_SUBJECT, env.NODE_ENV)
  if (verdict.ok) {
    if (verdict.fellBack) {
      // Non-production on the labeled fallback — usable, but say it once.
      warnVapidSubjectPostureOnce(env, verdict.problem)
    }
    return { provider: new WebPushProvider(publicKey, privateKey, verdict.subject), refusalDetail: '' }
  }
  // Production fail-closed (issue #354): no provider, one loud error, and
  // the honest refusal reason for every notification row.
  warnVapidSubjectPostureOnce(env, verdict.problem)
  return {
    provider: null,
    refusalDetail:
      verdict.problem === 'unset'
        ? 'Web push refused: VAPID_SUBJECT is unset in production (set a real mailto:/https:// contact — the labeled dev fallback is not accepted there, issue #354) — nothing sent'
        : 'Web push refused: VAPID_SUBJECT is still the mailto:admin@localhost default in production (set a real contact, issue #354) — nothing sent',
  }
}

/**
 * The send-capability half of resolvePushChannel — kept for the provider
 * tests' direct use; the notify service reads resolvePushChannel() so the
 * row gets the refusalDetail from the SAME resolution.
 */
export function getPushProvider(env: NodeJS.ProcessEnv = process.env): WebPushProvider | null {
  return resolvePushChannel(env).provider
}

/**
 * The PUBLIC half of the VAPID pair, handed to browsers by GET
 * /api/push/subscribe so they can create a subscription. Returns the key only
 * when the channel can actually SEND: a COMPLETE pair (a public key without
 * its private half cannot send — reporting configured would be a lie) whose
 * VAPID subject would not be refused in this runtime (issue #354: a pair
 * without a real production subject fails closed exactly like a partial
 * pair); null otherwise, which the route renders as { configured: false }.
 */
export function getVapidPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim()
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim()
  if (!publicKey || !privateKey) return null
  const verdict = vapidSubjectVerdict(env.VAPID_SUBJECT, env.NODE_ENV)
  if (!verdict.ok) {
    // The channel cannot send — reporting configured would be a lie. The
    // once-only posture error (issue #354) names the fix for the operator;
    // the probe firing it means a production misconfiguration is loud even
    // before the first notify() attempt.
    warnVapidSubjectPostureOnce(env, verdict.problem)
    return null
  }
  return publicKey
}
