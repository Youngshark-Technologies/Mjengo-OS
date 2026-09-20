/**
 * W5-1 — /api/push/{subscribe,unsubscribe} routes + the service-worker push
 * handler contract. NO NETWORK: getToken, db and (for the handler tests)
 * nothing external at all — web-push is never imported on these code paths
 * (routes only resolve env; the send path is pinned in
 * notify-channels.test.ts against a mocked web-push).
 *
 * Route contract (route-kit: guard → rate limit → zod strictObject → upsert):
 *   · session-scoped — no cookie → 401 on all three verbs; ANY signed-in
 *     role may subscribe (the diaspora client persona is the target);
 *   · GET /api/push/subscribe → { configured: false } with no VAPID pair
 *     (partial pair included — fail-closed), { configured: true, publicKey }
 *     with a complete pair;
 *   · POST /api/push/subscribe → PushSubscription.toJSON() validated
 *     (strictObject: unknown fields rejected), upserted ON THE ENDPOINT —
 *     one row per endpoint ever, re-ownership when another user subscribes
 *     from the same browser;
 *   · POST /api/push/unsubscribe → deleteMany scoped to the SESSION user +
 *     endpoint ({ ok, removed }) — an account revokes only its own row;
 *   · rate limits: 10/min per principal for both mutations → 429 + Retry-After.
 *
 * Service-worker contract (public/sw.js + the pure logic in
 * src/frontend/sw-handlers.ts the inline handlers mirror):
 *   · parsePushPayload accepts exactly the payload WebPushProvider sends
 *     (buildWebPushPayload round-trip — the SERVER payload IS what the SW
 *     parses) and rejects malformed messages;
 *   · the click deep-link is /?projectId=<encoded> (project boot), never a
 *     foreign URL (same-origin relative path only);
 *   · notificationOptionsFor: per-project tag (same project replaces, not
 *     stacks), icons, data.url;
 *   · sw.js SOURCE pins: push + notificationclick handlers wired with the
 *     same shapes, AND the fetch-strategy invariants intact — /api never
 *     cached, offline.html still the final navigation fallback, immutable
 *     cache-first, /_next/static network-first — with the push handlers
 *     strictly APPENDED after them. (sw.js v3 changed the navigation strategy
 *     on purpose — issue #78 — and its pins live in sw-offline-shell.test.ts;
 *     these invariants still hold.)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------ session mock
//
// route()-wrapped handlers authenticate through withGuard → the REAL
// getSessionFromReq → getToken. The seam to mock is getToken itself (the
// guard's session mapping then runs for real — the presign-routes idiom).
// tokenState.token = null → no session (401).

const tokenState: { token: Record<string, unknown> | null } = {
  token: {
    id: 'u-1',
    email: 'u-1@test.dev',
    name: 'Diaspora Client',
    role: 'client',
    projectId: 'p-1',
  },
}

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => tokenState.token),
}))

// ---------------------------------------------------------------- db mock

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>
  const state = {
    /** Rows keyed by endpoint (the upsert key). */
    pushSubscriptions: new Map<string, Row>(),
    /** Every upsert call (where/create/update) — the route's write shape. */
    upserts: [] as Array<{ where: Row; create: Row; update: Row }>,
    /** Every deleteMany where-clause (the revoke shape). */
    deleteManyCalls: [] as Array<Row>,
    reset() {
      state.pushSubscriptions.clear()
      state.upserts.length = 0
      state.deleteManyCalls.length = 0
    },
  }
  const pushSubscription = {
    async upsert({ where, create, update }: { where: { endpoint: string }; create: Row; update: Row }) {
      state.upserts.push({ where: { ...where }, create: { ...create }, update: { ...update } })
      const existing = state.pushSubscriptions.get(where.endpoint)
      if (existing) {
        Object.assign(existing, update)
        return { ...existing }
      }
      const row: Row = { id: `push_${where.endpoint}`, ...create }
      state.pushSubscriptions.set(where.endpoint, row)
      return { ...row }
    },
    async deleteMany({ where }: { where: { userId: string; endpoint: string } }) {
      state.deleteManyCalls.push({ ...where })
      let count = 0
      for (const [endpoint, row] of [...state.pushSubscriptions.entries()]) {
        if (row.userId === where.userId && endpoint === where.endpoint) {
          state.pushSubscriptions.delete(endpoint)
          count += 1
        }
      }
      return { count }
    },
  }
  // Issue #181 (SEC-15): the guard proves sessions against User.tokenVersion
  // now — a standing row at version 0 keeps this file's session fixtures
  // (no tokenVersion claim) UNrevoked, exactly what they mean to be.
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      return { id: where.id, tokenVersion: 0 }
    },
  }
  const db = { pushSubscription, user, __state: state }
  return { db }
})

import { db } from '@/backend/lib/db'
import { GET as subscribeGet, POST as subscribePost } from '@/app/api/push/subscribe/route'
import { POST as unsubscribePost } from '@/app/api/push/unsubscribe/route'
import { buildWebPushPayload } from '@/backend/modules/notify/channels'
import {
  clickTargetUrl,
  deepLinkFor,
  notificationOptionsFor,
  parsePushPayload,
} from '@/frontend/sw-handlers'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    pushSubscriptions: Map<string, Record<string, unknown>>
    upserts: Array<{ where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }>
    deleteManyCalls: Array<Record<string, unknown>>
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

const VAPID_PUBLIC = 'BPub-route-test-key-not-real-000000000000000'
const VAPID_PRIVATE = 'priv-route-test-key-not-real-000000000000000'

const ENV_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const
const savedEnv: Record<string, string | undefined> = {}

/** Unique principal per test by default so token buckets never bleed. */
let principalSeq = 0
function freshToken(overrides: Record<string, unknown> = {}) {
  principalSeq += 1
  tokenState.token = {
    id: `u-${principalSeq}`,
    email: `u-${principalSeq}@test.dev`,
    name: 'Test User',
    role: 'client',
    projectId: 'p-1',
    ...overrides,
  }
}

const ENDPOINT = 'https://fcm.example/push/send/route-abc-123'

/** A valid PushSubscription.toJSON() body as the browser produces it. */
function subscriptionBody(over: Record<string, unknown> = {}) {
  return {
    endpoint: ENDPOINT,
    keys: { p256dh: 'p256dh-route-test', auth: 'auth-route-test' },
    expirationTime: null,
    ...over,
  }
}

function post(url: string, body: unknown, opts: { raw?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.raw ?? JSON.stringify(body),
  })
}

const SUBSCRIBE_URL = 'http://localhost/api/push/subscribe'
const UNSUBSCRIBE_URL = 'http://localhost/api/push/unsubscribe'

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  state.reset()
  freshToken()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---------------------------------------------------------------- GET config

describe('GET /api/push/subscribe — the honest config probe', () => {
  it('no session → 401 (session-scoped, like every guarded route)', async () => {
    tokenState.token = null
    const res = await subscribeGet(new NextRequest(SUBSCRIBE_URL))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Sign in required')
  })

  it('no VAPID env → { ok: true, configured: false } — honest, no key leaked', async () => {
    const res = await subscribeGet(new NextRequest(SUBSCRIBE_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, configured: false })
  })

  it('PARTIAL pair (public without private) → configured: false (fail-closed)', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    const res = await subscribeGet(new NextRequest(SUBSCRIBE_URL))
    expect(await res.json()).toEqual({ ok: true, configured: false })
  })

  it('complete pair → { ok: true, configured: true, publicKey }', async () => {
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE
    const res = await subscribeGet(new NextRequest(SUBSCRIBE_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, configured: true, publicKey: VAPID_PUBLIC })
  })
})

// ---------------------------------------------------------------- POST subscribe

describe('POST /api/push/subscribe — store the subscription (upsert on the endpoint)', () => {
  it('no session → 401, nothing written', async () => {
    tokenState.token = null
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    expect(res.status).toBe(401)
    expect(state.upserts.length).toBe(0)
  })

  it('valid session + valid subscription → row stored, { ok: true }', async () => {
    // No VAPID pair — storing is INDEPENDENT of send capability (fail-closed
    // channel, honest address book).
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(state.pushSubscriptions.size).toBe(1)
    const row = state.pushSubscriptions.get(ENDPOINT)
    expect(row).toMatchObject({
      userId: tokenState.token?.id,
      endpoint: ENDPOINT,
      p256dh: 'p256dh-route-test',
      auth: 'auth-route-test',
    })
  })

  it('re-subscribing the SAME endpoint → upsert (one row, keys refreshed) — one per user+endpoint', async () => {
    await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody({ keys: { p256dh: 'p-new', auth: 'a-new' } })))
    expect(res.status).toBe(200)
    expect(state.pushSubscriptions.size).toBe(1) // still exactly one row per endpoint
    expect(state.upserts.length).toBe(2) // and the second call UPSERTED (where: endpoint)
    expect(state.upserts[1].where).toEqual({ endpoint: ENDPOINT })
    expect(state.pushSubscriptions.get(ENDPOINT)).toMatchObject({ p256dh: 'p-new', auth: 'a-new' })
  })

  it('a DIFFERENT user subscribing from the same browser → the row is re-owned', async () => {
    await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    freshToken() // a new session on the same browser
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    expect(res.status).toBe(200)
    expect(state.pushSubscriptions.size).toBe(1)
    expect(state.pushSubscriptions.get(ENDPOINT)).toMatchObject({ userId: tokenState.token?.id })
  })

  it('the expirationTime rides along as a Date; the user-agent is kept as the device hint', async () => {
    const res = await subscribePost(
      post(
        SUBSCRIBE_URL,
        subscriptionBody({ expirationTime: 1790000000000 }),
        { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126 TestAgent' } },
      ),
    )
    expect(res.status).toBe(200)
    const row = state.pushSubscriptions.get(ENDPOINT)
    expect(row?.expirationTime).toEqual(new Date(1790000000000))
    expect(String(row?.userAgent)).toContain('Chrome/126')
  })

  it('missing keys → 400 zod error (field-path in the body)', async () => {
    const res = await subscribePost(post(SUBSCRIBE_URL, { endpoint: ENDPOINT }))
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error?: string; field?: string }
    expect(json.error).toBeTruthy()
    expect(json.field).toContain('keys')
    expect(state.upserts.length).toBe(0)
  })

  it('non-URL endpoint → 400', async () => {
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody({ endpoint: 'not a url' })))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { field?: string }).field).toBe('endpoint')
  })

  it('empty p256dh → 400', async () => {
    const res = await subscribePost(
      post(SUBSCRIBE_URL, subscriptionBody({ keys: { p256dh: '', auth: 'a' } })),
    )
    expect(res.status).toBe(400)
  })

  it('unknown extra field → 400 (strictObject: typo protection)', async () => {
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody({ extra: 'nope' })))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toContain('extra')
  })

  it('unparseable JSON → 400 Invalid JSON body; non-object JSON → 400', async () => {
    const res = await subscribePost(post(SUBSCRIBE_URL, null, { raw: '{not-json' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe('Invalid JSON body')
    const res2 = await subscribePost(post(SUBSCRIBE_URL, null, { raw: '[1,2,3]' }))
    expect(res2.status).toBe(400)
    expect(((await res2.json()) as { error?: string }).error).toBe('Body must be a JSON object')
  })

  it('ANY signed-in role may subscribe — the client persona (role "client") is the target', async () => {
    freshToken({ role: 'client' })
    const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    expect(res.status).toBe(200)
    expect(state.pushSubscriptions.size).toBe(1)
  })

  it('10 mutations/min per principal → the 11th is 429 + Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
      expect(res.status).toBe(200)
    }
    const res11 = await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    expect(res11.status).toBe(429)
    expect((await res11.json()).error).toBe('Too many requests')
    expect(Number(res11.headers.get('Retry-After'))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------- POST unsubscribe

describe('POST /api/push/unsubscribe — revoke the stored subscription', () => {
  it('no session → 401, nothing deleted', async () => {
    tokenState.token = null
    const res = await unsubscribePost(post(UNSUBSCRIBE_URL, { endpoint: ENDPOINT }))
    expect(res.status).toBe(401)
    expect(state.deleteManyCalls.length).toBe(0)
  })

  it('revokes the stored row: deleteMany scoped to (session user, endpoint)', async () => {
    await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    const res = await unsubscribePost(post(UNSUBSCRIBE_URL, { endpoint: ENDPOINT }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removed: 1 })
    expect(state.deleteManyCalls).toEqual([{ userId: tokenState.token?.id, endpoint: ENDPOINT }])
    expect(state.pushSubscriptions.size).toBe(0) // the row is GONE
  })

  it('no stored row → honest { removed: 0 } (idempotent unsubscribe)', async () => {
    const res = await unsubscribePost(post(UNSUBSCRIBE_URL, { endpoint: ENDPOINT }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removed: 0 })
  })

  it('scoped to the SESSION user — another user owning the row is not revoked by me', async () => {
    await subscribePost(post(SUBSCRIBE_URL, subscriptionBody()))
    const owner = tokenState.token?.id
    freshToken() // someone else's session on a different browser
    const res = await unsubscribePost(post(UNSUBSCRIBE_URL, { endpoint: ENDPOINT }))
    expect(await res.json()).toEqual({ ok: true, removed: 0 }) // not my row
    expect(state.pushSubscriptions.get(ENDPOINT)).toMatchObject({ userId: owner }) // still there
  })

  it('missing endpoint → 400 zod error', async () => {
    const res = await unsubscribePost(post(UNSUBSCRIBE_URL, {}))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { field?: string }).field).toBe('endpoint')
  })

  it('non-URL endpoint → 400; unknown field → 400 (strictObject)', async () => {
    const res = await unsubscribePost(post(UNSUBSCRIBE_URL, { endpoint: 'not a url' }))
    expect(res.status).toBe(400)
    const res2 = await unsubscribePost(post(UNSUBSCRIBE_URL, { endpoint: ENDPOINT, why: 'nope' }))
    expect(res2.status).toBe(400)
    expect(((await res2.json()) as { error?: string }).error).toContain('why')
  })
})

// ------------------------------------------------- sw push handler (pure logic)

describe('parsePushPayload — the payload shape the sw handler accepts', () => {
  it('accepts the exact payload the provider sends (buildWebPushPayload round-trip)', () => {
    const payload = buildWebPushPayload({
      to: ENDPOINT,
      title: 'Milestone released',
      body: 'KSh 1.2M released',
      projectId: 'proj-1',
      kind: 'milestone',
    })
    // The sw receives event.data.json() — i.e. the parsed provider payload.
    const parsed = parsePushPayload(JSON.parse(payload))
    expect(parsed).toEqual({
      title: 'Milestone released',
      body: 'KSh 1.2M released',
      projectId: 'proj-1',
      kind: 'milestone',
    })
  })

  it('accepts a JSON string too (event.data.text() shape)', () => {
    expect(parsePushPayload('{"title":"t","body":"b","projectId":"p","kind":"k"}')).toEqual({
      title: 't',
      body: 'b',
      projectId: 'p',
      kind: 'k',
    })
  })

  it('projectId and kind are optional; body defaults to empty', () => {
    expect(parsePushPayload({ title: 'Only a title' })).toEqual({
      title: 'Only a title',
      body: '',
      projectId: null,
      kind: null,
    })
  })

  it('malformed payloads → null (the generic notification path, never a crash)', () => {
    expect(parsePushPayload(null)).toBeNull()
    expect(parsePushPayload('not json')).toBeNull()
    expect(parsePushPayload(42)).toBeNull()
    expect(parsePushPayload([1, 2])).toBeNull()
    expect(parsePushPayload({})).toBeNull() // no title
    expect(parsePushPayload({ title: '' })).toBeNull() // blank title
    expect(parsePushPayload({ title: 't', body: 7 })).toBeNull() // wrong type
    expect(parsePushPayload({ title: 't', projectId: 7 })).toBeNull()
  })
})

describe('deepLinkFor + notificationOptionsFor — the click routing', () => {
  it('deep-links to the project: /?projectId=<encoded id>', () => {
    expect(deepLinkFor('proj-1')).toBe('/?projectId=proj-1')
    // An id with separators cannot smuggle extra params or a fragment.
    expect(deepLinkFor('a&b=c#x')).toBe('/?projectId=a%26b%3Dc%23x')
  })

  it('no project → the app root', () => {
    expect(deepLinkFor(null)).toBe('/')
    expect(deepLinkFor('')).toBe('/')
  })

  it('notification options carry the deep-link, per-project tag and icons', () => {
    const options = notificationOptionsFor({ title: 't', body: 'b', projectId: 'proj-1', kind: 'milestone' })
    expect(options).toEqual({
      body: 'b',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'mjengoos-proj-1', // same project replaces, not stacks
      data: { url: '/?projectId=proj-1' },
    })
    expect(notificationOptionsFor({ title: 't', body: '', projectId: null, kind: null }).tag).toBe('mjengoos')
  })
})

describe('clickTargetUrl — the click can never leave the origin', () => {
  it('a safe relative path → origin + path', () => {
    expect(clickTargetUrl({ url: '/?projectId=proj-1' }, 'https://app.example')).toBe('https://app.example/?projectId=proj-1')
  })

  it('a foreign absolute URL → the app root (payload cannot steer the click off-origin)', () => {
    expect(clickTargetUrl({ url: 'https://evil.example/phish' }, 'https://app.example')).toBe('https://app.example/')
  })

  it('protocol-relative //host → the app root', () => {
    expect(clickTargetUrl({ url: '//evil.example' }, 'https://app.example')).toBe('https://app.example/')
  })

  it('missing/garbage data → the app root', () => {
    expect(clickTargetUrl(null, 'https://app.example')).toBe('https://app.example/')
    expect(clickTargetUrl({ url: 42 }, 'https://app.example')).toBe('https://app.example/')
  })
})

// ------------------------------------------- sw.js source pins (no silent drift)

const SW_SOURCE = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')

describe('public/sw.js — push handlers wired, fetch-strategy invariants intact', () => {
  it('registers exactly one push and one notificationclick handler (appended)', () => {
    expect(SW_SOURCE.match(/self\.addEventListener\('push'/g)).toEqual(["self.addEventListener('push'"])
    expect(SW_SOURCE.match(/self\.addEventListener\('notificationclick'/g)).toEqual([
      "self.addEventListener('notificationclick'",
    ])
  })

  it('the push handler parses the contract fields and deep-links /?projectId=<encoded>', () => {
    const pushSection = SW_SOURCE.slice(SW_SOURCE.indexOf("self.addEventListener('push'"))
    expect(pushSection).toContain("payload.title")
    expect(pushSection).toContain("payload.body")
    expect(pushSection).toContain("payload.projectId")
    expect(pushSection).toContain("encodeURIComponent(projectId)")
    expect(pushSection).toContain("data: { url: deepLink }")
    // Malformed payload → the generic MjengoOS notification, never a crash.
    expect(pushSection).toContain("'MjengoOS'")
    // Per-project tag: same project replaces, not stacks.
    expect(pushSection).toContain('mjengoos-')
  })

  it('the notificationclick target is always a same-origin relative path', () => {
    const clickSection = SW_SOURCE.slice(SW_SOURCE.indexOf("self.addEventListener('notificationclick'"))
    // sw-handlers.clickTargetUrl semantics: startsWith('/') && !startsWith('//').
    expect(clickSection).toContain("raw.startsWith('/')")
    expect(clickSection).toContain("!raw.startsWith('//')")
    expect(clickSection).toContain('client.focus()')
    expect(clickSection).toContain('openWindow(target)')
  })

  it('FETCH-STRATEGY INVARIANTS SURVIVE v3 — the load-bearing rules in public/sw.js', () => {
    // /api/** is never cached, never served from cache (the money honesty rule).
    expect(SW_SOURCE).toContain("pathname.startsWith('/api/')")
    // HTML navigations fall back to the precached offline shell.
    expect(SW_SOURCE).toContain("caches.match('/offline.html')")
    // Precache list unchanged (offline shell + manifest + icons).
    expect(SW_SOURCE).toContain("'/offline.html',")
    expect(SW_SOURCE).toContain("'/manifest.webmanifest',")
    expect(SW_SOURCE).toContain("'/icons/icon-192.png',")
    expect(SW_SOURCE).toContain("'/icons/icon-512.png',")
    // Immutable assets stay cache-first; /_next/static stays network-first.
    expect(SW_SOURCE).toContain('isImmutableAsset')
    expect(SW_SOURCE).toContain("url.pathname.startsWith('/_next/static/')")
    // Non-GET and HMR paths pass straight through.
    expect(SW_SOURCE).toContain("request.method !== 'GET'")
    expect(SW_SOURCE).toContain('/_next/webpack-hmr')
    // Exactly ONE fetch listener (the appended push handlers did not add one).
    expect(SW_SOURCE.match(/self\.addEventListener\('fetch'/g)).toEqual(["self.addEventListener('fetch'"])
  })

  it('the push handlers are strictly APPENDED after the fetch strategy', () => {
    const fetchIdx = SW_SOURCE.indexOf("self.addEventListener('fetch'")
    const pushIdx = SW_SOURCE.indexOf("self.addEventListener('push'")
    const clickIdx = SW_SOURCE.indexOf("self.addEventListener('notificationclick'")
    expect(pushIdx).toBeGreaterThan(fetchIdx)
    expect(clickIdx).toBeGreaterThan(pushIdx)
    // The strategy's closing comment ("Everything else…") still precedes them.
    expect(SW_SOURCE.indexOf('Everything else (RSC payloads')).toBeLessThan(pushIdx)
  })
})
