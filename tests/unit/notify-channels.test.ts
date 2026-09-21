/**
 * Notification channel invariants (src/backend/modules/notify/{channels,service}.ts).
 *
 * notify() writes an honest in-app row first; a real SMS delivery is only
 * attempted when the caller passes opts.sms AND a provider is configured —
 * the webhook (NOTIFY_SMS_WEBHOOK_URL, precedence FIRST) or the Africa's
 * Talking pair (AT_API_KEY + AT_USERNAME; partial pair = null, fail-closed).
 * A real web push (W5-1) is likewise attempted only when the caller passes
 * opts.push AND the VAPID pair is configured (partial pair = null, the same
 * fail-closed rule). This file swaps @/backend/lib/db for a tiny in-memory
 * stub, global fetch for a vi.fn() and the web-push package for a vi.fn(),
 * then pins:
 *  · no provider env → fetch/sendNotification NEVER called, row stays
 *    'logged' (fail-closed);
 *  · webhook + AT both set → the webhook wins (backwards compatible);
 *  · provider + 2xx → row 'sent', deliveredAt stamped, ref + honest detail
 *    (webhook { id } body; AT SMSMessageData.Recipients[0].messageId);
 *  · provider + non-2xx → row 'failed' with the HTTP status in the detail;
 *  · fetch throws / times out → row 'failed', never thrown into the caller,
 *    and the detail leaks nothing (error class only — no URLs, no keys);
 *  · request shapes: webhook JSON { to, text, metadata } with a bearer
 *    header ONLY when a token is set; AT form-urlencoded
 *    { username, to, message, from? } with the apiKey header — both with
 *    an 8s AbortSignal;
 *  · markDelivered() records deliveryDetail without stamping deliveredAt
 *    unless the status is 'sent' (the seam providers report through);
 *  · WEB PUSH (W5-1): getPushProvider resolution (partial pair → null);
 *    WebPushProvider.send shape — the buildWebPushPayload JSON contract
 *    (the SAME fields public/sw.js parses), per-call vapidDetails, 24h TTL,
 *    8s timeout, endpoint as providerRef, 404/410 → gone + the notify
 *    service PRUNES the dead subscription row, status-only leak-free
 *    details; notify() opts.push end-to-end — no pair / no subscription /
 *    no userId / muted kind → honest 'logged' skip notes, at-least-one
 *    success → 'sent', all-failed → 'failed', the in-app row always intact;
 *  · VAPID SUBJECT posture (issue #354 / MD-2): production REFUSES an unset
 *    or still-default mailto:admin@localhost subject (no provider — sends
 *    stay 'logged' with the refusal reason, the browser config probe
 *    answers null → { configured: false }, ONE loud log.error per process);
 *    dev/test keeps the labeled fallback with ONE log.warn; a real contact
 *    is used verbatim in every runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The web-push package, swapped for a vi.fn() — NO network in this suite.
vi.mock('web-push', () => ({
  sendNotification: vi.fn(async () => ({ statusCode: 201, body: '', headers: {} })),
}))

// In-memory Prisma stub: just enough of db.notification + db.user +
// db.pushSubscription for notify() + markDelivered() + the push attempt.
// __state exposes the tables for assertions.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    notifications: new Map<string, Record<string, unknown>>(),
    users: new Map<string, { notificationPrefs: string | null }>(),
    pushSubscriptions: new Map<string, Record<string, unknown>>(),
    /** Every pushSubscription.delete call (the 404/410 prune path). */
    deletedSubscriptionIds: [] as string[],
    reset() {
      state.notifications.clear()
      state.users.clear()
      state.pushSubscriptions.clear()
      state.deletedSubscriptionIds.length = 0
      state.seq = 0
    },
  }
  const notification = {
    async create({ data }: { data: Record<string, unknown> }) {
      const row: Record<string, unknown> = {
        id: `notif_${++state.seq}`,
        read: false,
        readAt: null,
        deliveredAt: null,
        deliveryDetail: null,
        ...data,
      }
      state.notifications.set(row.id as string, row)
      return { ...row }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.notifications.get(where.id)
      if (!row) throw new Error(`stub: notification ${where.id} not found`)
      Object.assign(row, data)
      return { ...row }
    },
  }
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      const row = state.users.get(where.id)
      return row ? { id: where.id, ...row } : null
    },
  }
  const pushSubscription = {
    async findMany({ where }: { where: { userId: string } }) {
      return [...state.pushSubscriptions.values()]
        .filter((r) => r.userId === where.userId)
        .map((r) => ({ ...r }))
    },
    async delete({ where }: { where: { id: string } }) {
      if (!state.pushSubscriptions.has(where.id)) {
        throw new Error(`stub: pushSubscription ${where.id} not found`)
      }
      state.pushSubscriptions.delete(where.id)
      state.deletedSubscriptionIds.push(where.id)
      return { id: where.id }
    },
  }
  const db = { notification, user, pushSubscription, __state: state }
  return { db }
})

import { sendNotification } from 'web-push'
import { db } from '@/backend/lib/db'
import {
  AtSmsProvider,
  buildWebPushPayload,
  DEFAULT_VAPID_SUBJECT,
  getSmsProvider,
  getPushProvider,
  getVapidPublicKey,
  resolvePushChannel,
  vapidSubjectVerdict,
  WebPushProvider,
  WebhookSmsProvider,
} from '@/backend/modules/notify/channels'
import { markDelivered, notify } from '@/backend/modules/notify/service'

const sendMock = vi.mocked(sendNotification)

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    notifications: Map<string, Record<string, unknown>>
    users: Map<string, { notificationPrefs: string | null }>
    pushSubscriptions: Map<string, Record<string, unknown>>
    deletedSubscriptionIds: string[]
    reset: () => void
  }
}

const fetchMock = vi.fn()

const ENV_KEYS = [
  'NOTIFY_SMS_WEBHOOK_URL',
  'NOTIFY_SMS_WEBHOOK_TOKEN',
  'AT_API_KEY',
  'AT_USERNAME',
  'AT_SENDER_ID',
  'AT_ENV',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  state.reset()
  fetchMock.mockReset()
  sendMock.mockReset()
  sendMock.mockResolvedValue({ statusCode: 201, body: '', headers: {} })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

const row = (id: string) => state.notifications.get(id) as Record<string, unknown>

const ok = (body = '') => new Response(body, { status: 200 })

/** A 2xx Africa's Talking response body, the real REST shape. */
const atOk = (messageId?: string) =>
  new Response(
    JSON.stringify({
      SMSMessageData: {
        Recipients: messageId ? [{ messageId, number: '+254700000001', status: 'Success', statusCode: 101 }] : [],
        Message: 'Sent to 1/1 Total Cost: KES 0.80',
      },
    }),
    { status: 200 },
  )

describe('getSmsProvider — env resolution is fail-closed', () => {
  it('returns null when NOTIFY_SMS_WEBHOOK_URL is unset', () => {
    expect(getSmsProvider({})).toBeNull()
    expect(getSmsProvider()).toBeNull() // live env was scrubbed in beforeEach
  })

  it('returns null for a blank/whitespace-only URL', () => {
    expect(getSmsProvider({ NOTIFY_SMS_WEBHOOK_URL: '   ' })).toBeNull()
    expect(getSmsProvider({ NOTIFY_SMS_WEBHOOK_URL: '' })).toBeNull()
  })

  it('returns the WebhookSmsProvider when the URL is set', () => {
    const p = getSmsProvider({ NOTIFY_SMS_WEBHOOK_URL: 'https://sms.example/send' })
    expect(p).toBeInstanceOf(WebhookSmsProvider)
    expect(p?.id).toBe('webhook-sms')
    expect(p?.label).toBeTruthy()
  })
})

describe('notify() with no provider configured — default behavior unchanged', () => {
  it('no env + sms requested → fetch never called, row stays logged, honest skip note', async () => {
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).toContain('no provider configured')
    expect(String(row(id).deliveryDetail)).toContain('nothing sent')
  })

  it('no env + no sms opt → row is exactly as today (logged, no detail, no fetch)', async () => {
    const { id } = await notify('proj-1', 'Delivery received', 'Cement 50 bags', { kind: 'delivery.dispatched' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveryDetail).toBeNull()
    expect(row(id).deliveredAt).toBeNull()
    expect(row(id).channel).toBe('in_app')
  })

  it('provider configured + no sms opt → SMS is opt-in: fetch never called', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    await notify('proj-1', 'Recap', 'Day 47 — 37% complete', { kind: 'recap' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('notify() with provider configured — honest send outcomes', () => {
  beforeEach(() => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
  })

  it('2xx with an { id } body → sent, deliveredAt stamped, ref in detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gw-42' }), { status: 200 }))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('accepted')
    expect(String(row(id).deliveryDetail)).toContain('gw-42')
    // in-app row semantics unchanged by the SMS attempt
    expect(row(id).title).toBe('Milestone released')
    expect(row(id).kind).toBe('milestone')
  })

  it('2xx with empty body → sent, plain accepted detail', async () => {
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveryDetail).toBe('SMS gateway accepted')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
  })

  it('2xx with a providerRef key → recorded as the ref', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ providerRef: 'AT-9981' }), { status: 200 }))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('sent')
    expect(String(row(id).deliveryDetail)).toContain('AT-9981')
  })

  it('non-2xx (500) → failed with the HTTP status, no deliveredAt, row intact', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const { id } = await notify('proj-1', 'Delivery discrepancy', 'Short by 5 bags', {
      kind: 'delivery.discrepancy',
      sms: { to: '+254700000001' },
    })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe('SMS gateway responded HTTP 500')
    expect(row(id).deliveredAt).toBeNull()
    expect(row(id).title).toBe('Delivery discrepancy') // in-app row survived
  })

  it('fetch throws (network) → failed, never throws into the caller, no URL leak', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed http://10.0.0.5:9200/secret-path'))
    const res = await notify('proj-1', 'Budget pace 92%', 'Spend ahead of plan', {
      kind: 'budget.alert',
      sms: { to: '+254700000001' },
    })
    expect(res).toEqual({ id: 'notif_1' }) // resolved, not rejected
    expect(row(res.id).deliveryStatus).toBe('failed')
    expect(row(res.id).deliveryDetail).toBe('SMS gateway unreachable (TypeError)')
    expect(String(row(res.id).deliveryDetail)).not.toContain('10.0.0.5')
    expect(String(row(res.id).deliveryDetail)).not.toContain('secret-path')
  })

  it('fetch times out (TimeoutError DOMException) → failed with honest timeout detail', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe('SMS gateway timed out after 8s')
  })
})

describe('provider request shape (the webhook contract)', () => {
  it('POSTs { to, text: title + \\n\\n + body, metadata } with bearer token when set', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    process.env.NOTIFY_SMS_WEBHOOK_TOKEN = 'tok-123'
    fetchMock.mockResolvedValueOnce(ok())
    await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254712345678' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://sms.example/send')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.authorization).toBe('Bearer tok-123')
    expect(JSON.parse(init.body as string)).toEqual({
      to: '+254712345678',
      text: 'Milestone released\n\nKSh 1.2M released',
      metadata: { projectId: 'proj-1', kind: 'milestone' },
    })
    expect(init.signal).toBeInstanceOf(AbortSignal) // 8s timeout cap travels with the call
  })

  it('no token → no authorization header at all', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    fetchMock.mockResolvedValueOnce(ok())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(init.headers.authorization).toBeUndefined()
    expect(init.headers['content-type']).toBe('application/json')
  })
})

describe('markDelivered — the seam providers report through', () => {
  it('failed + detail → records the detail, never stamps deliveredAt', async () => {
    const { id } = await notify('proj-1', 't', 'b', {})
    await markDelivered(id, 'failed', 'SMS gateway responded HTTP 502')
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe('SMS gateway responded HTTP 502')
    expect(row(id).deliveredAt).toBeNull()
  })

  it('sent without detail → stamps deliveredAt and leaves the existing detail alone', async () => {
    const { id } = await notify('proj-1', 't', 'b', {})
    await markDelivered(id, 'failed', 'SMS gateway responded HTTP 502')
    const out = await markDelivered(id, 'sent')
    expect(out).toEqual({ id, deliveryStatus: 'sent', deliveryDetail: 'SMS gateway responded HTTP 502' })
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(row(id).deliveryDetail).toBe('SMS gateway responded HTTP 502')
  })

  it('unknown id → null (row gone — same honest swallow as before)', async () => {
    expect(await markDelivered('gone', 'sent', 'detail')).toBeNull()
  })
})

describe("getSmsProvider — Africa's Talking resolution (webhook keeps precedence)", () => {
  it('AT pair set, no webhook → the AtSmsProvider', () => {
    const p = getSmsProvider({ AT_API_KEY: 'at-key', AT_USERNAME: 'mjengo' })
    expect(p).toBeInstanceOf(AtSmsProvider)
    expect(p?.id).toBe('at-sms')
    expect(p?.label).toBeTruthy()
  })

  it('PARTIAL AT pair → null (fail-closed: never a provider that 401s on every send)', () => {
    expect(getSmsProvider({ AT_API_KEY: 'at-key' })).toBeNull()
    expect(getSmsProvider({ AT_USERNAME: 'mjengo' })).toBeNull()
    expect(getSmsProvider({ AT_API_KEY: '   ', AT_USERNAME: 'mjengo' })).toBeNull()
    expect(getSmsProvider({ AT_API_KEY: 'at-key', AT_USERNAME: '' })).toBeNull()
  })

  it('webhook + AT both set → webhook wins (backwards compatible, resolution level)', () => {
    const p = getSmsProvider({
      NOTIFY_SMS_WEBHOOK_URL: 'https://sms.example/send',
      AT_API_KEY: 'at-key',
      AT_USERNAME: 'mjengo',
    })
    expect(p).toBeInstanceOf(WebhookSmsProvider)
    expect(p?.id).toBe('webhook-sms')
  })

  it('webhook + AT both set → the WEBHOOK receives the call (notify() end-to-end)', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    process.env.AT_API_KEY = 'at-key'
    process.env.AT_USERNAME = 'mjengo'
    fetchMock.mockResolvedValueOnce(ok())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://sms.example/send') // NOT the AT endpoint
    expect(init.headers['content-type']).toBe('application/json') // the webhook JSON contract
  })
})

describe("notify() with the AT provider configured — honest send outcomes", () => {
  beforeEach(() => {
    process.env.AT_API_KEY = 'at-key-123'
    process.env.AT_USERNAME = 'mjengo'
  })

  it("2xx with SMSMessageData.Recipients[0].messageId → sent, deliveredAt stamped, ref in detail", async () => {
    fetchMock.mockResolvedValueOnce(atOk('ATXid_1abc23'))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('accepted')
    expect(String(row(id).deliveryDetail)).toContain('ATXid_1abc23')
    // in-app row semantics unchanged by the SMS attempt
    expect(row(id).title).toBe('Milestone released')
    expect(row(id).kind).toBe('milestone')
  })

  it("provider-level: send() returns the messageId as providerRef (the seam result shape)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          SMSMessageData: {
            Recipients: [{ messageId: 'ATXid_9zyx87', number: '+254700000001', status: 'Success', statusCode: 101 }],
            Message: 'Sent to 1/1 Total Cost: KES 0.80',
          },
        }),
        { status: 200 },
      ),
    )
    const provider = getSmsProvider()
    expect(provider).toBeInstanceOf(AtSmsProvider)
    const result = await provider!.send({
      to: '+254700000001',
      title: 'Milestone released',
      body: 'KSh 1.2M released',
      projectId: 'proj-1',
      kind: 'milestone',
    })
    expect(result).toEqual({
      ok: true,
      status: 'sent',
      providerRef: 'ATXid_9zyx87',
      detail: "Africa's Talking accepted (messageId ATXid_9zyx87)",
    })
  })

  it('2xx with an empty/odd body → still sent, no ref (best-effort capture)', async () => {
    fetchMock.mockResolvedValueOnce(ok(''))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveryDetail).toBe("Africa's Talking accepted")
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
  })

  it('non-2xx (401) → failed with status-only detail — body never echoed, row intact', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 401, status: 'InvalidApiKey' }] } }), {
        status: 401,
      }),
    )
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001' },
    })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe("Africa's Talking responded HTTP 401")
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).not.toContain('InvalidApiKey') // no body content
    expect(String(row(id).deliveryDetail)).not.toContain('at-key-123') // no credential material
    expect(row(id).title).toBe('Milestone released') // in-app row survived
  })

  it('non-2xx (500) → failed with status-only detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe("Africa's Talking responded HTTP 500")
  })

  it('fetch throws (network) → failed, error class only — no key, no host in the detail', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed https://api.africaistalking.com/version1/messaging key=at-key-123'),
    )
    const res = await notify('proj-1', 'Budget pace 92%', 'Spend ahead of plan', {
      kind: 'budget.alert',
      sms: { to: '+254700000001' },
    })
    expect(res).toEqual({ id: 'notif_1' }) // resolved, not rejected
    expect(row(res.id).deliveryStatus).toBe('failed')
    expect(row(res.id).deliveryDetail).toBe("Africa's Talking unreachable (TypeError)")
    expect(String(row(res.id).deliveryDetail)).not.toContain('at-key-123')
    expect(String(row(res.id).deliveryDetail)).not.toContain('africaistalking.com')
  })

  it('fetch times out (TimeoutError DOMException) → failed with honest timeout detail', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const { id } = await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveryDetail).toBe("Africa's Talking timed out after 8s")
  })

  it("send() never throws into notify() — the in-app row survives EVERY failure mode", async () => {
    const arms = [
      () => fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 })),
      () => fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')),
      () => fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError')),
      () => fetchMock.mockRejectedValueOnce('not even an Error object'),
    ]
    let seq = 0
    for (const arm of arms) {
      arm()
      const res = await notify('proj-1', 'Row survives', 'every failure', {
        kind: 'milestone',
        sms: { to: '+254700000001' },
      })
      const r = row(res.id)
      expect(res.id).toBe(`notif_${++seq}`) // notify() resolved and created the row
      expect(r.title).toBe('Row survives')
      expect(r.deliveryStatus).toBe('failed') // every arm above is a failure mode
      expect(r.deliveredAt).toBeNull()
    }
  })
})

describe("AT provider request shape (the real AT REST contract)", () => {
  beforeEach(() => {
    process.env.AT_API_KEY = 'at-key-123'
    process.env.AT_USERNAME = 'mjengo'
  })

  it('POSTs form-urlencoded username/to/message with the apiKey header to the AT endpoint', async () => {
    fetchMock.mockResolvedValueOnce(atOk())
    await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254712345678' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.africaistalking.com/version1/messaging')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.headers.apikey).toBe('at-key-123') // AT's auth header
    const form = new URLSearchParams(init.body as string)
    expect(form.get('username')).toBe('mjengo')
    expect(form.get('to')).toBe('+254712345678')
    expect(form.get('message')).toBe('Milestone released\n\nKSh 1.2M released')
    expect(form.get('from')).toBeNull() // no AT_SENDER_ID → no from field at all
    expect(init.signal).toBeInstanceOf(AbortSignal) // 8s timeout cap travels with the call
  })

  it('AT_SENDER_ID set → the from field carries it', async () => {
    process.env.AT_SENDER_ID = 'MJENGOS'
    fetchMock.mockResolvedValueOnce(atOk())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = new URLSearchParams(init.body as string)
    expect(form.get('from')).toBe('MJENGOS')
  })

  it('AT_ENV=sandbox → the sandbox host is used (credential testing without billing)', async () => {
    process.env.AT_ENV = 'sandbox'
    fetchMock.mockResolvedValueOnce(atOk())
    await notify('proj-1', 't', 'b', { sms: { to: '+254700000001' } })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.sandbox.africaistalking.com/version1/messaging')
  })
})

// ---------------------------------------------------------------- web push (W5-1)

const VAPID_PUBLIC = 'BPub-test-key-not-real-0000000000000000000000'
const VAPID_PRIVATE = 'priv-test-key-not-real-0000000000000000000000'
const ENDPOINT = 'https://fcm.example/push/send/abc-123'
const SUB_KEYS = { p256dh: 'p256dh-test-key', auth: 'auth-test-secret' }

function seedUser(userId: string, notificationPrefs: string | null = null) {
  state.users.set(userId, { notificationPrefs })
}

function seedPush(userId = 'u-1', endpoint = ENDPOINT) {
  const row = { id: `push_${endpoint}`, userId, endpoint, p256dh: SUB_KEYS.p256dh, auth: SUB_KEYS.auth }
  state.pushSubscriptions.set(row.id, row)
  return row
}

/** A WebPushError-shaped rejection (statusCode + endpoint-bearing message). */
function webPushError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`web push error at ${ENDPOINT}`), {
    statusCode,
    body: '',
    headers: {},
    endpoint: ENDPOINT,
  })
}

describe('getPushProvider — VAPID resolution is fail-closed', () => {
  it('returns null when no VAPID env is set', () => {
    expect(getPushProvider({})).toBeNull()
    expect(getPushProvider()).toBeNull() // live env was scrubbed in beforeEach
  })

  it('returns null for a PARTIAL pair (public without private or vice versa)', () => {
    expect(getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC })).toBeNull()
    expect(getPushProvider({ VAPID_PRIVATE_KEY: VAPID_PRIVATE })).toBeNull()
    expect(getPushProvider({ VAPID_PUBLIC_KEY: '   ', VAPID_PRIVATE_KEY: VAPID_PRIVATE })).toBeNull()
    expect(getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: '' })).toBeNull()
  })

  it('returns the WebPushProvider when the pair is complete', () => {
    const p = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    expect(p).toBeInstanceOf(WebPushProvider)
    expect(p?.id).toBe('web-push')
    expect(p?.label).toBeTruthy()
  })
})

describe('WebPushProvider.send — the seam result shape (web-push mocked, no network)', () => {
  const sendInput = {
    to: ENDPOINT,
    title: 'Milestone released',
    body: 'KSh 1.2M released',
    projectId: 'proj-1',
    kind: 'milestone',
    pushSubscription: { endpoint: ENDPOINT, keys: SUB_KEYS },
  }

  it('success → sent with the endpoint as providerRef and the honest detail', async () => {
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send(sendInput)
    expect(result).toEqual({
      ok: true,
      status: 'sent',
      providerRef: ENDPOINT,
      detail: 'Web push accepted by the push service',
    })
  })

  it('request shape: the sw payload contract + per-call vapidDetails + 24h TTL + 8s timeout', async () => {
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const provider = getPushProvider({
      VAPID_PUBLIC_KEY: VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: VAPID_PRIVATE,
      VAPID_SUBJECT: 'mailto:ops@test.dev',
    })
    await provider!.send(sendInput)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const [subscription, payload, options] = sendMock.mock.calls[0] as [
      { endpoint: string; keys: unknown },
      string,
      Record<string, unknown>,
    ]
    // The subscription exactly as the browser recorded it (endpoint + keys).
    expect(subscription).toEqual({ endpoint: ENDPOINT, keys: SUB_KEYS })
    // THE SW CONTRACT: exactly the four fields public/sw.js parses — the
    // deep-link is derived client-side from projectId, never sent.
    expect(JSON.parse(payload)).toEqual({
      title: 'Milestone released',
      body: 'KSh 1.2M released',
      projectId: 'proj-1',
      kind: 'milestone',
    })
    expect(options).toEqual({
      vapidDetails: {
        subject: 'mailto:ops@test.dev',
        publicKey: VAPID_PUBLIC,
        privateKey: VAPID_PRIVATE,
      },
      TTL: 24 * 60 * 60, // 24h — stale site news never wakes a phone
      timeout: 8_000, // the same 8s cap the SMS providers enforce
    })
  })

  it('VAPID_SUBJECT unset → the documented default contact, not a crash', async () => {
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    await provider!.send(sendInput)
    const [, , options] = sendMock.mock.calls[0] as [unknown, unknown, { vapidDetails: { subject: string } }]
    expect(options.vapidDetails.subject).toBe('mailto:admin@localhost')
  })

  it('410 (subscription gone) → failed + gone flag — the service prunes the row', async () => {
    sendMock.mockRejectedValueOnce(webPushError(410))
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send(sendInput)
    expect(result).toEqual({
      ok: false,
      status: 'failed',
      detail: 'Push service responded HTTP 410 (subscription gone)',
      gone: true,
    })
  })

  it('404 (subscription gone) → failed + gone flag too', async () => {
    sendMock.mockRejectedValueOnce(webPushError(404))
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send(sendInput)
    expect(result.gone).toBe(true)
    expect(result.detail).toBe('Push service responded HTTP 404 (subscription gone)')
  })

  it('other non-2xx (500) → failed, status ONLY — no endpoint, no body content', async () => {
    sendMock.mockRejectedValueOnce(webPushError(500))
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send(sendInput)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.detail).toBe('Push service responded HTTP 500')
    expect(result.gone).toBeUndefined()
    expect(result.detail).not.toContain(ENDPOINT) // leak-free
  })

  it('network error → failed, error class only — the endpoint never reaches the detail', async () => {
    sendMock.mockRejectedValueOnce(new TypeError(`fetch failed ${ENDPOINT}`))
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send(sendInput)
    expect(result).toEqual({ ok: false, status: 'failed', detail: 'Web push unreachable (TypeError)' })
    expect(result.detail).not.toContain(ENDPOINT)
  })

  it('a non-Error rejection → honest unknown-class detail, never a throw', async () => {
    sendMock.mockRejectedValueOnce('not even an Error')
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send(sendInput)
    expect(result).toEqual({ ok: false, status: 'failed', detail: 'Web push unreachable (unknown)' })
  })

  it('no complete subscription on the input → failed without contacting web-push', async () => {
    const provider = getPushProvider({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })
    const result = await provider!.send({
      to: ENDPOINT,
      title: 't',
      body: 'b',
      projectId: 'proj-1',
      kind: 'milestone',
      // pushSubscription deliberately omitted
    })
    expect(result).toEqual({
      ok: false,
      status: 'failed',
      detail: 'Web push attempted without a complete subscription — nothing sent',
    })
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('buildWebPushPayload — the payload the service worker parses', () => {
  it('carries exactly the four contract fields', () => {
    expect(
      JSON.parse(
        buildWebPushPayload({
          to: ENDPOINT,
          title: 'Milestone released',
          body: 'KSh 1.2M released',
          projectId: 'proj-1',
          kind: 'milestone',
        }),
      ),
    ).toEqual({ title: 'Milestone released', body: 'KSh 1.2M released', projectId: 'proj-1', kind: 'milestone' })
  })
})

describe('notify() with opts.push — honest end-to-end outcomes (web-push mocked)', () => {
  const pushOpt = { push: { userId: 'u-1' } }

  it('no VAPID env + push requested → web-push NEVER called, row stays logged with the skip note', async () => {
    seedUser('u-1')
    seedPush()
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      ...pushOpt,
    })
    expect(sendMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).toContain('no VAPID pair configured')
    expect(String(row(id).deliveryDetail)).toContain('nothing sent')
    // The stored subscription survives — it is the address book, not a send log.
    expect(state.pushSubscriptions.size).toBe(1)
  })

  it('VAPID env set but no push opt → push is opt-in: web-push never called', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1')
    seedPush()
    await notify('proj-1', 'Recap', 'Day 47 — 37% complete', { kind: 'recap' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('VAPID env + push + user has no recorded subscription → logged, honest note', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1')
    const { id } = await notify('proj-1', 't', 'b', { kind: 'milestone', ...pushOpt })
    expect(sendMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(String(row(id).deliveryDetail)).toContain('no recorded subscription')
  })

  it('push without a userId (defensive path) → logged, honest note, nothing sent', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    const { id } = await notify('proj-1', 't', 'b', { kind: 'milestone', push: {} as { userId: string } })
    expect(sendMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(String(row(id).deliveryDetail)).toContain('no recipient user')
  })

  it('recipient opted out of the kind (prefs gate) → no send, honest skip reason', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1', JSON.stringify({ milestone: { inApp: false } }))
    seedPush()
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      ...pushOpt,
    })
    expect(sendMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(String(row(id).deliveryDetail)).toContain('skipped: recipient preference disables "milestone"')
  })

  it('success → sent, deliveredAt stamped, endpoint ref in the detail, in-app row intact', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1')
    seedPush()
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      ...pushOpt,
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('Web push delivered to 1 of 1 subscription(s)')
    expect(String(row(id).deliveryDetail)).toContain(`(ref ${ENDPOINT})`)
    expect(row(id).title).toBe('Milestone released')
    expect(row(id).kind).toBe('milestone')
    expect(row(id).channel).toBe('in_app')
  })

  it('failure (500) → failed honestly recorded, no deliveredAt, row intact', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1')
    seedPush()
    sendMock.mockRejectedValueOnce(webPushError(500))
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      ...pushOpt,
    })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).toContain('Push service responded HTTP 500')
    expect(String(row(id).deliveryDetail)).toContain('0 of 1 subscription(s) delivered')
    expect(row(id).title).toBe('Milestone released') // in-app row survived
  })

  it('410 (gone) → failed AND the dead subscription row is pruned', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1')
    seedPush()
    sendMock.mockRejectedValueOnce(webPushError(410))
    const { id } = await notify('proj-1', 't', 'b', { kind: 'milestone', ...pushOpt })
    expect(row(id).deliveryStatus).toBe('failed')
    expect(String(row(id).deliveryDetail)).toContain('1 gone subscription(s) pruned')
    expect(state.deletedSubscriptionIds).toEqual([`push_${ENDPOINT}`])
    expect(state.pushSubscriptions.size).toBe(0) // nobody keeps pushing at a revoked endpoint
  })

  it('two subscriptions, one success + one gone → sent (1 of 2) AND the gone row pruned', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    seedUser('u-1')
    seedPush('u-1', ENDPOINT)
    seedPush('u-1', 'https://fcm.example/push/send/def-456')
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} }) // abc-123 accepted
    sendMock.mockRejectedValueOnce(webPushError(410)) // def-456 gone
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      ...pushOpt,
    })
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(row(id).deliveryStatus).toBe('sent') // at least one browser accepted
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('delivered to 1 of 2 subscription(s)')
    expect(String(row(id).deliveryDetail)).toContain(`(ref ${ENDPOINT})`)
    expect(String(row(id).deliveryDetail)).toContain('1 gone subscription(s) pruned')
    expect(state.pushSubscriptions.size).toBe(1) // only the live one remains
  })

  it('both channels opted in: SMS sent + push skipped (no VAPID) → stays sent with BOTH outcomes stated', async () => {
    process.env.NOTIFY_SMS_WEBHOOK_URL = 'https://sms.example/send'
    // No VAPID pair → the push attempt honestly skips.
    seedUser('u-1')
    seedPush()
    fetchMock.mockResolvedValueOnce(ok())
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      sms: { to: '+254700000001', userId: 'u-1' },
      ...pushOpt,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // the SMS send happened
    expect(sendMock).not.toHaveBeenCalled() // the push send did not
    // The row never lies in either direction: 'sent' (SMS really delivered)
    // with the honest push skip reason + the SMS outcome in the detail.
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(String(row(id).deliveryDetail)).toContain('no VAPID pair configured')
    expect(String(row(id).deliveryDetail)).toContain('SMS gateway accepted')
  })
})

// ------------------------------------------- VAPID subject posture (issue #354 / MD-2)

describe('vapidSubjectVerdict — the pure production/dev split (issue #354)', () => {
  it('a real contact → ok, trimmed, used verbatim (no fallback flag)', () => {
    expect(vapidSubjectVerdict('mailto:ops@mjengo.example', 'production')).toEqual({
      ok: true,
      subject: 'mailto:ops@mjengo.example',
      fellBack: false,
    })
    expect(vapidSubjectVerdict('  https://mjengo.example/contact  ', 'production')).toEqual({
      ok: true,
      subject: 'https://mjengo.example/contact',
      fellBack: false,
    })
    // A real contact is a real contact in every runtime.
    expect(vapidSubjectVerdict('mailto:ops@mjengo.example', 'development').fellBack).toBe(false)
    expect(vapidSubjectVerdict('mailto:ops@mjengo.example', undefined).fellBack).toBe(false)
  })

  it('unset / blank → production REFUSES; every other runtime runs on the labeled fallback', () => {
    for (const unset of [undefined, '', '   ']) {
      expect(vapidSubjectVerdict(unset, 'production'), `subject=${String(unset)}`).toEqual({ ok: false, problem: 'unset' })
      for (const mode of ['development', 'test', 'staging', undefined]) {
        expect(vapidSubjectVerdict(unset, mode), `subject=${String(unset)} nodeEnv=${String(mode)}`).toEqual({
          ok: true,
          subject: DEFAULT_VAPID_SUBJECT,
          fellBack: true,
          problem: 'unset',
        })
      }
    }
  })

  it('still the mailto:admin@localhost default → the same refusal/fallback split (it is not a real contact)', () => {
    for (const subject of [DEFAULT_VAPID_SUBJECT, `  ${DEFAULT_VAPID_SUBJECT}  `]) {
      expect(vapidSubjectVerdict(subject, 'production'), `subject=${subject}`).toEqual({
        ok: false,
        problem: 'localhost-default',
      })
      expect(vapidSubjectVerdict(subject, 'development'), `subject=${subject}`).toEqual({
        ok: true,
        subject: DEFAULT_VAPID_SUBJECT,
        fellBack: true,
        problem: 'localhost-default',
      })
    }
  })
})

describe('resolvePushChannel / getPushProvider — VAPID_SUBJECT fail-closed in production (issue #354)', () => {
  const PAIR = { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE }

  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('production + pair + VAPID_SUBJECT unset → NO provider, honest refusal detail, ONE loud error naming the fix', () => {
    const res = resolvePushChannel({ ...PAIR, NODE_ENV: 'production' })
    expect(res.provider).toBeNull()
    expect(res.refusalDetail).toContain('Web push refused')
    expect(res.refusalDetail).toContain('VAPID_SUBJECT is unset in production')
    expect(res.refusalDetail).toContain('nothing sent')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    // The line is actionable: names the env key, the fail-closed state, a
    // real-contact example. (json log mode in production — substring match.)
    const line = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('VAPID_SUBJECT')
    expect(line).toMatch(/FAILS CLOSED/i)
    expect(line).toContain('mailto:')
    expect(warnSpy).not.toHaveBeenCalled()
    // once-per-process: a second resolution is still refused, but silent.
    expect(resolvePushChannel({ ...PAIR, NODE_ENV: 'production' }).provider).toBeNull()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('production + pair + still the localhost default → refused the same way, with its own reason', () => {
    const res = resolvePushChannel({ ...PAIR, NODE_ENV: 'production', VAPID_SUBJECT: DEFAULT_VAPID_SUBJECT })
    expect(res.provider).toBeNull()
    expect(res.refusalDetail).toContain('mailto:admin@localhost default in production')
    expect(res.refusalDetail).toContain('nothing sent')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('mailto:admin@localhost')
  })

  it('production + pair + a real subject → the provider resolves and SENDS with that subject (configured → used)', async () => {
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const provider = getPushProvider({ ...PAIR, NODE_ENV: 'production', VAPID_SUBJECT: 'mailto:ops@mjengo.example' })
    expect(provider).toBeInstanceOf(WebPushProvider)
    const result = await provider!.send({
      to: ENDPOINT,
      title: 'Milestone released',
      body: 'KSh 1.2M released',
      projectId: 'proj-1',
      kind: 'milestone',
      pushSubscription: { endpoint: ENDPOINT, keys: SUB_KEYS },
    })
    expect(result.ok).toBe(true)
    const [, , options] = sendMock.mock.calls[0] as [unknown, unknown, { vapidDetails: { subject: string } }]
    expect(options.vapidDetails.subject).toBe('mailto:ops@mjengo.example')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('dev + pair + unset → the labeled fallback subject IS used, with ONE warning (the NEXTAUTH_SECRET dev style)', async () => {
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const provider = getPushProvider({ ...PAIR, NODE_ENV: 'development' })
    expect(provider).toBeInstanceOf(WebPushProvider)
    await provider!.send({
      to: ENDPOINT,
      title: 't',
      body: 'b',
      projectId: 'proj-1',
      kind: 'milestone',
      pushSubscription: { endpoint: ENDPOINT, keys: SUB_KEYS },
    })
    const [, , options] = sendMock.mock.calls[0] as [unknown, unknown, { vapidDetails: { subject: string } }]
    expect(options.vapidDetails.subject).toBe(DEFAULT_VAPID_SUBJECT)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('VAPID_SUBJECT')
    expect(line).toContain('mailto:admin@localhost')
    expect(line).toContain('production fails')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('dev + pair + the default EXPLICITLY set → same labeled fallback, its own one-time warning', async () => {
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const provider = getPushProvider({ ...PAIR, NODE_ENV: 'development', VAPID_SUBJECT: DEFAULT_VAPID_SUBJECT })
    expect(provider).toBeInstanceOf(WebPushProvider)
    await provider!.send({
      to: ENDPOINT,
      title: 't',
      body: 'b',
      projectId: 'proj-1',
      kind: 'milestone',
      pushSubscription: { endpoint: ENDPOINT, keys: SUB_KEYS },
    })
    const [, , options] = sendMock.mock.calls[0] as [unknown, unknown, { vapidDetails: { subject: string } }]
    expect(options.vapidDetails.subject).toBe(DEFAULT_VAPID_SUBJECT)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('mailto:admin@localhost')
  })
})

describe('getVapidPublicKey — the browser config probe refuses with the channel (issue #354)', () => {
  const PAIR = { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE }

  it('production + pair + unset subject → null (configured:false — the UI must not offer a dead subscription)', () => {
    // Note: the once-per-process posture error already fired at the first
    // resolution in this process (the resolvePushChannel suite above), so
    // this asserts the PROBE's refusal, not the log line.
    expect(getVapidPublicKey({ ...PAIR, NODE_ENV: 'production' })).toBeNull()
  })

  it('production + pair + the localhost default → null as well', () => {
    expect(getVapidPublicKey({ ...PAIR, NODE_ENV: 'production', VAPID_SUBJECT: DEFAULT_VAPID_SUBJECT })).toBeNull()
  })

  it('production + pair + a real subject → the public key (the channel can send)', () => {
    expect(getVapidPublicKey({ ...PAIR, NODE_ENV: 'production', VAPID_SUBJECT: 'mailto:ops@mjengo.example' })).toBe(
      VAPID_PUBLIC,
    )
  })

  it('non-production + pair + unset subject → the key (the labeled fallback keeps dev usable)', () => {
    expect(getVapidPublicKey({ ...PAIR, NODE_ENV: 'development' })).toBe(VAPID_PUBLIC)
    expect(getVapidPublicKey({ ...PAIR })).toBe(VAPID_PUBLIC) // no NODE_ENV at all
  })

  it('no pair → null in every runtime (unchanged — the pre-#354 rule)', () => {
    expect(getVapidPublicKey({ NODE_ENV: 'production' })).toBeNull()
    expect(getVapidPublicKey({ NODE_ENV: 'development' })).toBeNull()
  })
})

describe('notify() with opts.push in production — the subject refusal lands honestly in the row (issue #354)', () => {
  let prevNodeEnv: string | undefined
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('pair set, subject unset → row stays logged with the refusal reason; web-push NEVER called; subscription kept', async () => {
    seedUser('u-1')
    seedPush()
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      push: { userId: 'u-1' },
    })
    expect(sendMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(row(id).deliveredAt).toBeNull()
    expect(String(row(id).deliveryDetail)).toContain('Web push refused')
    expect(String(row(id).deliveryDetail)).toContain('VAPID_SUBJECT is unset in production')
    expect(String(row(id).deliveryDetail)).toContain('nothing sent')
    // The stored subscription survives — it is the address book, not a send log.
    expect(state.pushSubscriptions.size).toBe(1)
  })

  it('pair set, subject still the localhost default → the same refusal with its own reason', async () => {
    process.env.VAPID_SUBJECT = DEFAULT_VAPID_SUBJECT
    seedUser('u-1')
    seedPush()
    const { id } = await notify('proj-1', 't', 'b', { kind: 'milestone', push: { userId: 'u-1' } })
    expect(sendMock).not.toHaveBeenCalled()
    expect(row(id).deliveryStatus).toBe('logged')
    expect(String(row(id).deliveryDetail)).toContain('mailto:admin@localhost default in production')
    expect(state.pushSubscriptions.size).toBe(1)
  })

  it('pair + a real subject → production is NOT blanket-refused: the send proceeds and the row records it', async () => {
    process.env.VAPID_SUBJECT = 'mailto:ops@mjengo.example'
    seedUser('u-1')
    seedPush()
    sendMock.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
    const { id } = await notify('proj-1', 'Milestone released', 'KSh 1.2M released', {
      kind: 'milestone',
      push: { userId: 'u-1' },
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    const [, , options] = sendMock.mock.calls[0] as [unknown, unknown, { vapidDetails: { subject: string } }]
    expect(options.vapidDetails.subject).toBe('mailto:ops@mjengo.example')
    expect(row(id).deliveryStatus).toBe('sent')
    expect(row(id).deliveredAt).toBeInstanceOf(Date)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
