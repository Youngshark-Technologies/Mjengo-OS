/**
 * MjengoOS service worker (v3 — offline app shell · issue #78 / audit FE-1).
 *
 * Strategy:
 *   - /api/**        → network-only. NEVER cached, NEVER served from cache.
 *   - HTML navigations → network-first → last-good cached app shell → the
 *     precached offline.html. In PRODUCTION the '/' shell is cached on every
 *     successful network fetch and served only when the network fails, so an
 *     offline RELOAD boots the real app (data + outbox live client-side in
 *     indexedDB). In DEV the v2 no-stale-shell rule stays: HTML is never
 *     cached and never served from cache — the dev server recompiles the same
 *     URL into different HTML on every edit.
 *   - /photos/**     → cache-first with an LRU cap (~100 entries, issue #78 /
 *     FE-8) in a version-independent cache: photo files are immutable
 *     content-keyed bytes, but months of site photos would grow CacheStorage
 *     unbounded on a low-storage Android and the browser's answer to quota
 *     pressure is evicting CacheStorage wholesale — which would silently kill
 *     the offline shell + icons too.
 *   - Immutable static assets (icons, manifest, offline shell, logo) →
 *     cache-first (same-origin, 200 responses only).
 *   - /_next/static/** → network-first with cache fallback — dev chunk URLs
 *     are stable-named but recompiled, so cache-first would serve stale code.
 *   - Non-GET and HMR paths → untouched, straight to the network.
 *
 * Background Sync (issues #193/#351): queuing an outbox item registers the
 * one-shot 'mjengoos-outbox' tag (feature-detected, Chromium only); when
 * connectivity returns — even with no page open — the browser fires the
 * `sync` event and the handler below asks any open client to drain, or —
 * with no client open — drains the HEADLESS-SAFE queued items itself from
 * the indexedDB record the app persists to (money/session-bound kinds
 * refuse honestly; see the sync section at the bottom for the full policy).
 */

const VERSION = 'mjengoos-2f-3'
const STATIC_CACHE = `mjengoos-static-${VERSION}`
// Photos outlive SW versions: immutable, content-keyed files (public/photos/
// <cuid>), so they live in a version-INDEPENDENT cache capped by the LRU
// below. Wiping them on every VERSION bump (v2 behavior) would re-download
// months of site photos for no honesty gain — a photo's bytes never change.
const PHOTO_CACHE = 'mjengoos-photos'

const PRECACHE_URLS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

// Dev vs prod for the HTML-shell rule (shouldCacheNavigationHtml semantics —
// sw-handlers.ts is the unit-tested statement). sw.js is ONE static file
// registered by both `next dev` and the production server (layout.tsx) with
// no build step, so the honest runtime signal is the SW's own origin
// hostname: the dev server serves from localhost/127.0.0.1, production
// deployments never do. Dev keeps v2's no-stale-shell rule; dev on a LAN
// hostname keeps the prod rule (a stale dev shell at worst — the next VERSION
// bump wipes it).
const IS_DEV =
  self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1'

// ---------------- install ----------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE)
      // addAll is atomic for this small, guaranteed-static set.
      await cache.addAll(PRECACHE_URLS)
      await self.skipWaiting()
    })(),
  )
})

// ---------------- activate ----------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep the current version's static cache AND the version-independent
      // photo cache (its LRU catalog lives inside it). Everything else is
      // deleted — every legacy cache name from the earlier PWA era
      // (kill-switch leftovers), every older STATIC_CACHE version — so
      // nothing stale can ever be served.
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n !== STATIC_CACHE && n !== PHOTO_CACHE)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

// ---------------- photo LRU (issue #78 / FE-8) ----------------
//
// photoLruEvictions semantics (sw-handlers.ts, unit-tested): when the photo
// set exceeds PHOTO_CACHE_CAP, delete the least-recently-used entries first;
// entries with no recorded use count as oldest; ties keep the cache's own key
// order. Recency lives in an in-SW Map persisted as a tiny JSON catalog
// INSIDE the photo cache (opaque key below) so it survives SW restarts; if
// the catalog is unreadable the LRU degrades gracefully to key order.

const PHOTO_LRU_KEY = '/__mjengoos/photo-lru.json'
const PHOTO_CACHE_CAP = 100 // mirrors sw-handlers.PHOTO_CACHE_CAP
/** Map<photoUrl, lastUsedEpochMs> — Map insertion order is the recency order. */
let photoLru = null

async function ensurePhotoLru() {
  if (photoLru) return photoLru
  photoLru = new Map()
  try {
    const catalog = await caches.match(PHOTO_LRU_KEY)
    if (catalog) {
      const json = await catalog.json()
      if (json && Array.isArray(json.entries)) {
        for (const entry of json.entries) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
            photoLru.set(entry[0], entry[1])
          }
        }
      }
    }
  } catch (e) {
    // Unreadable catalog → start fresh; existing entries degrade to oldest.
  }
  return photoLru
}

async function persistPhotoLru(lru) {
  try {
    const cache = await caches.open(PHOTO_CACHE)
    await cache.put(
      PHOTO_LRU_KEY,
      new Response(JSON.stringify({ entries: [...lru.entries()] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  } catch (e) {
    // Best-effort persist: losing the catalog only softens the LRU.
  }
}

/** Record a use of a photo URL (recency), then persist the catalog. */
async function touchPhotoLru(url) {
  const lru = await ensurePhotoLru()
  lru.delete(url)
  lru.set(url, Date.now())
  await persistPhotoLru(lru)
}

/** Delete the least-recently-used entries until the set is within the cap. */
async function trimPhotoCache(cache) {
  const keys = await cache.keys()
  const photoKeys = keys
    .map((request) => request.url)
    .filter((u) => new URL(u).pathname.startsWith('/photos/'))
  const lru = await ensurePhotoLru()
  const excess = photoKeys.length - PHOTO_CACHE_CAP
  if (excess <= 0) return
  // photoLruEvictions inline mirror: never-touched (absent from the map)
  // counts as 0 = oldest; stable tiebreak on the cache's own key order.
  const doomed = photoKeys
    .map((url, i) => ({ url, i, at: lru.get(url) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .slice(0, excess)
  await Promise.all(doomed.map((d) => cache.delete(d.url)))
}

// ---------------- fetch ----------------

self.addEventListener('fetch', (event) => {
  const request = event.request

  // HONESTY RULE: /api/* is NEVER cached and never served from cache.
  // Money, attendance, evidence and audit data must always come from the
  // network — a stale payroll or muster served offline would be a lie.
  // Pass straight through, no respondWith.
  if (new URL(request.url).pathname.startsWith('/api/')) return

  // Non-GET: never intercepted (POST/PATCH mutations must hit the network).
  if (request.method !== 'GET') return

  // Dev-server HMR & websocket plumbing: intercepting these breaks the dev
  // server's hot reload. Leave them to the network.
  const url = new URL(request.url)
  if (
    url.pathname.startsWith('/_next/webpack-hmr') ||
    url.pathname.includes('sockjs') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:'
  ) return

  // Only same-origin requests are ours to manage.
  if (url.origin !== self.location.origin) return

  // HTML navigations: network-first → last-good shell → offline shell
  // (issue #78 / FE-1). Production only — see IS_DEV above.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        // navigationShellKey semantics (sw-handlers.ts, unit-tested): the APP
        // serves exactly ONE HTML route, the client-side app at '/', so the
        // shell is cached/served under the single key '/'. Query strings
        // (?share=, ?projectId=) are read by the booted client — the server
        // HTML is identical. The shell is NOT auth-gated server-side (login
        // is an app state; anonymous and signed-in visitors get the same
        // HTML), so caching it exposes nothing. (The proxied marketing site
        // at /website and /offline.html itself stay on the v2 rule: network
        // first, offline.html fallback, never cached.)
        const shellKey = url.pathname === '/' ? '/' : null
        try {
          const response = await fetch(request)
          if (response.ok && !IS_DEV && shellKey) {
            const cache = await caches.open(STATIC_CACHE)
            await cache.put(shellKey, response.clone())
          }
          return response
        } catch {
          const shell = !IS_DEV && shellKey ? await caches.match(shellKey) : undefined
          return (
            shell ||
            (await caches.match('/offline.html')) ||
            new Response('Offline', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          )
        }
      })(),
    )
    return
  }

  // /photos/**: cache-first with the LRU cap (issue #78 / FE-8). Same-origin
  // 200 responses only; the cache is version-independent so SW updates do
  // not re-download months of immutable site photos.
  if (url.pathname.startsWith('/photos/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PHOTO_CACHE)
        const cached = await cache.match(request)
        if (cached) {
          // Recency is recorded fire-and-forget: serving must not wait on it.
          void touchPhotoLru(request.url)
          return cached
        }
        try {
          const response = await fetch(request)
          if (response.ok) {
            await cache.put(request, response.clone())
            await touchPhotoLru(request.url)
            await trimPhotoCache(cache)
          }
          return response
        } catch {
          return new Response('', { status: 504 })
        }
      })(),
    )
    return
  }

  // Immutable, never-recompiled assets: cache-first (icons, manifest,
  // offline shell, static logo). /_next/static/** is deliberately NOT here —
  // in dev, Turbopack serves chunks from STABLE filenames whose content
  // changes on every recompile; caching those cache-first would serve stale
  // code after any edit (verified live: an edited component kept running the
  // pre-edit chunk after reload). Chunks therefore go network-first below.
  const isImmutableAsset =
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/offline.html' ||
    url.pathname === '/logo.svg'

  if (isImmutableAsset) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        try {
          const response = await fetch(request)
          if (response.ok) {
            const cache = await caches.open(STATIC_CACHE)
            cache.put(request, response.clone())
          }
          return response
        } catch {
          return new Response('', { status: 504 })
        }
      })(),
    )
    return
  }

  // Next.js build output (/_next/static/**): network-first with cache
  // fallback. In dev the URLs are stable but content changes on recompile,
  // so the network answer always wins; in prod the chunks are
  // content-hashed/immutable and the browser HTTP cache keeps this cheap.
  // The SW copy is only served when the network is genuinely unreachable.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          if (response.ok) {
            const cache = await caches.open(STATIC_CACHE)
            cache.put(request, response.clone())
          }
          return response
        } catch {
          const cached = await caches.match(request)
          return (
            cached ||
            new Response('', { status: 504 })
          )
        }
      })(),
    )
    return
  }

  // Everything else (RSC payloads, /_next/image, data fetches): network,
  // untouched.
})

// ---------------- push (W5-1 — web push notifications) ----------------
//
// The push half of the honest VAPID channel (WebPushProvider in
// src/backend/modules/notify/channels.ts). Payload shape, exactly what the
// provider sends (buildWebPushPayload): { title, body, projectId, kind } —
// the click deep-link /?projectId=<id> is derived HERE from projectId; the
// server never guesses app routing.
//
// The canonical, unit-tested logic lives in src/frontend/sw-handlers.ts
// (pure functions). This inline wiring mirrors it 1:1 because public/sw.js
// is a STATIC script — no bundler step — and the offline strategy above is
// load-bearing and deliberately hand-rolled: this section is strictly
// APPENDED after the fetch strategy (tests/unit/push-routes.test.ts pins
// the payload contract + wiring by reading the file; the v3 strategy pins
// live in tests/unit/sw-offline-shell.test.ts).

self.addEventListener('push', (event) => {
  // Parse defensively (sw-handlers.parsePushPayload semantics): a malformed
  // payload shows the generic notification — the handler never crashes.
  let payload = null
  try {
    payload = event.data ? event.data.json() : null
  } catch (e) {
    payload = null
  }
  const isPayload =
    payload !== null &&
    typeof payload === 'object' &&
    typeof payload.title === 'string' &&
    payload.title.trim() !== ''
  const title = isPayload ? payload.title : 'MjengoOS'
  const body = isPayload && typeof payload.body === 'string' ? payload.body : ''
  const projectId =
    isPayload && typeof payload.projectId === 'string' && payload.projectId !== '' ? payload.projectId : null
  // Deep-link: /?projectId=<encoded> — encodeURIComponent stops an id with
  // separators from smuggling extra params or a fragment.
  const deepLink = projectId ? `/?projectId=${encodeURIComponent(projectId)}` : '/'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Per-project tag: a second push for the same project REPLACES the
      // previous notification instead of stacking them.
      tag: projectId ? `mjengoos-${projectId}` : 'mjengoos',
      data: { url: deepLink },
    }),
  )
})

// ---------------- notificationclick (W5-1 — deep-link to the project) ------
//
// Focus the app window (navigating it to the deep-link when it is elsewhere)
// or open a new one at the deep-link (sw-handlers.clickTargetUrl semantics).
// The target is ALWAYS a same-origin relative path from data.url, built
// above from projectId — a payload can never steer the click off-origin.

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = event.notification.data && event.notification.data.url
  const path = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
  const target = self.location.origin + path
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin + '/') && 'focus' in client) {
          if (typeof client.navigate === 'function' && client.url.split('#')[0] !== target) {
            try {
              await client.navigate(target)
            } catch (e) {
              // navigate can be refused (transient activation rules / client
              // being torn down) — focusing the existing window still lands
              // the user in the app.
            }
          }
          return await client.focus()
        }
      }
      // No app window open → open the deep-link directly.
      return await self.clients.openWindow(target)
    })(),
  )
})

// ---------------- message (SKIP_WAITING — issue #148 staleness cue) --------
//
// The update prompt (src/frontend/pwa/sw-update-prompt.tsx over the watch in
// sw-update-watch.ts) asks a WAITING worker to take over NOW: the user
// clicked Reload, so the page posts { type: 'SKIP_WAITING' } at the worker,
// this handler calls skipWaiting(), and the page reloads on controllerchange.
// The install handler above ALREADY skipWaiting()'s (v3 behavior — a new
// deploy activates as soon as its install finishes), so a worker is normally
// active long before the click and the prompt just reloads; this is the
// belt-and-braces path for one still waiting when the click lands.
// isSkipWaitingMessage semantics (sw-handlers.ts, unit-tested) mirrored
// inline — a static script cannot import the module, and any OTHER message
// posted at the worker is ignored.

self.addEventListener('message', (event) => {
  if (
    event.data !== null &&
    typeof event.data === 'object' &&
    !Array.isArray(event.data) &&
    event.data.type === 'SKIP_WAITING'
  ) {
    self.skipWaiting()
  }
})

// ---------------- sync (#193/#351 — Background Sync outbox drain) ---------------
//
// The Background Sync half of the offline outbox. When the app queues an
// outbox item it registers the one-shot tag 'mjengoos-outbox' (the
// registerOutboxSync helper in src/frontend/sw-handlers.ts — the canonical,
// unit-tested statement; the tag + payload constants are mirrored inline
// here because this is a static script with no bundler step) wherever the
// browser supports it (Chrome/Edge/Android — the primary field audience;
// Safari/Firefox never fire this event and keep the page-lifetime drain
// behavior). When connectivity returns — EVEN IF no page is open — Chromium
// re-launches this worker and fires 'sync', retrying on its own backoff
// while the tag's promise rejects.
//
// #351 — THE CLOSED-APP DRAIN IS REAL NOW. The outbox lives in indexedDB
// (lib/outbox-idb.ts — the same record the app's zustand persist writes),
// which this worker reads on the same origin:
//   · a client IS open → postMessage { type: 'mjengoos:drain' } at every
//     window client (app.tsx's container listener, guarded by
//     isDrainRequestMessage semantics) — the app drains with the full
//     store, toasts and §41 resolution UI, and this worker stays out of it;
//   · NO client open → drain the HEADLESS-SAFE pending items straight from
//     the indexedDB record: POST /api/sync with the same body shape the
//     app's drain sends (the session cookie rides the same-origin fetch),
//     then write the per-item §40 outcomes back. The allowlist below is the
//     policy: the non-financial field + evidence families whose worst-case
//     closed-app outcome is an idempotent replay (§57 item-id markers), a
//     clean apply, or a human-decides conflict that parks in the sync sheet
//     on the next app open — never a money movement, never a silent
//     overwrite.
//
// WHAT STILL REFUSES HEADLESS (deliberate, fail-closed — mirrored from
// sw-handlers.ts, pinned by tests reading both files):
//   · MONEY rows (escrow.*, milestone.decide, variation.decide,
//     invoice.pay/decide, wages.pay, payment.*, wallet.*, expense.create,
//     transaction.delete, project.update): money needs a human watching the
//     outcome — the #150 waiting-worklist hard stop, same reasoning.
//   · share.regenerate (the new link exists only in the drain response),
//     and the supply/marketplace/AI/land/professionals/inventory/intel
//     families (role-pinned sessions, flag gates, ephemeral payloads,
//     high-stakes rows; the supplier portal's outbox is a separate
//     store/session by design and is never drained through this record).
//   · an expired session (401): the batch is marked auth-blocked (#191
//     semantics — it waits for a sign-in, never auto-retried blindly).
//   · a network failure mid-drain: the waitUntil promise REJECTS so
//     Chromium re-fires the one-shot tag on its own backoff; the items were
//     never marked, so the retry re-sends them and §57 idempotency bounds
//     any double-send.
//   · the LEGACY localStorage queue (pre-#351 installs): localStorage is
//     invisible to this worker, so until the first post-upgrade app open
//     adopts it (lib/outbox-idb.ts), this worker honestly drains nothing.

const OUTBOX_SYNC_TAG = 'mjengoos-outbox'
const DRAIN_REQUEST_MESSAGE_TYPE = 'mjengoos:drain'

// The indexedDB record the app persists the owner store under — mirrors
// sw-handlers.ts (OUTBOX_DB_* + OUTBOX_DB_RECORD_KEY) and lib/outbox-idb.ts;
// a static script cannot import them, and tests pin the literals equal.
const OUTBOX_DB_NAME = 'mjengoos-outbox'
const OUTBOX_DB_VERSION = 1
const OUTBOX_DB_STORE = 'kv'
const OUTBOX_DB_RECORD_KEY = 'mjengo-os-store'

// The headless-safe allowlist — the exact policy list from sw-handlers.ts
// (HEADLESS_DRAIN_TYPES). Fail-closed by construction: anything not listed
// stays 'pending' and drains on the next app open.
const HEADLESS_DRAIN_TYPES = [
  'attendance.checkin', 'attendance.setStatus', 'attendance.record', 'attendance.exception', 'attendance.override',
  'task.create', 'task.update', 'task.delete', 'task.assign', 'task.block', 'task.unblock', 'task.verify', 'task.complete',
  'phase.create', 'phase.update',
  'worker.create', 'worker.update',
  'material.create',
  'delivery.create', 'delivery.assign', 'delivery.transit', 'delivery.arrive',
  'consumption.create',
  'alert.ack', 'comment.add', 'comment.resolve',
  'notification.read', 'notification.readAll',
  'photo.apply', 'photo.zone', 'zone.create', 'zone.delete',
]

const HEADLESS_AUTH_BLOCKED_MESSAGE = 'Session expired — this action waits for a sign-in.'
const HEADLESS_SERVER_REFUSAL_MESSAGE = 'Sync refused while the app was closed.'
const SYNC_HISTORY_CAP = 50 // mirrors lib/outbox.ts
const AUTO_RETRY_MAX_ATTEMPTS = 3 // mirrors lib/outbox.ts (#132)
const AUTO_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] // mirrors lib/outbox.ts

/** #132 — the bounded auto-retry stamp a headless failure schedules (mirror of withAutoRetrySchedule). */
function withAutoRetryScheduleHeadless(o) {
  const attempts = o.autoAttempts ?? 0
  if (attempts >= AUTO_RETRY_MAX_ATTEMPTS) return {}
  const delay = AUTO_RETRY_DELAYS_MS[Math.min(attempts, AUTO_RETRY_DELAYS_MS.length - 1)]
  return { autoAttempts: attempts + 1, nextAttemptAt: Date.now() + delay }
}

/** Is this persisted item a pending action this worker may replay headless? */
function isHeadlessDrainable(item) {
  return (item.syncStatus ?? 'pending') === 'pending' && HEADLESS_DRAIN_TYPES.includes(item.type)
}

/** One indexedDB request → promise (the entire raw-API surface this drain uses). */
function idbRequestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
  })
}

function openOutboxDb() {
  const request = indexedDB.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(OUTBOX_DB_STORE)) db.createObjectStore(OUTBOX_DB_STORE)
  }
  return idbRequestAsPromise(request)
}

function idbGet(db, key) {
  return idbRequestAsPromise(
    db.transaction(OUTBOX_DB_STORE, 'readonly').objectStore(OUTBOX_DB_STORE).get(key),
  ).then((v) => v ?? null)
}

function idbPut(db, key, value) {
  return idbRequestAsPromise(
    db.transaction(OUTBOX_DB_STORE, 'readwrite').objectStore(OUTBOX_DB_STORE).put(value, key),
  ).then(() => undefined)
}

/**
 * The closed-app drain (inline mirror of sw-handlers.ts drainOutboxHeadless
 * — the canonical, unit-tested statement; tests pin this wiring by reading
 * this file). Throws ONLY on network/indexedDB failure so the sync event's
 * waitUntil rejects and Chromium retries the tag.
 */
async function drainOutboxHeadlessSw() {
  const db = await openOutboxDb()
  const raw = await idbGet(db, OUTBOX_DB_RECORD_KEY)
  if (raw === null) return
  let snapshot
  try {
    snapshot = JSON.parse(raw)
  } catch (e) {
    // Corrupt record — the app's rehydrate owns surfacing it (degraded).
    return
  }
  const outbox = Array.isArray(snapshot.state && snapshot.state.outbox) ? snapshot.state.outbox : []
  const batch = outbox.filter(isHeadlessDrainable)
  if (batch.length === 0) return

  // The same body shape the app's drain sends; same-origin fetch carries
  // the session cookie exactly like the app's.
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actions: batch.map(({ id, type, payload, projectId }) => ({ id, type, payload, projectId })),
    }),
  })

  const writeBack = async (next) => {
    await idbPut(db, OUTBOX_DB_RECORD_KEY, JSON.stringify(next))
  }

  if (res.status === 401) {
    // #191 semantics: the batch waits for a sign-in — failed + authBlocked,
    // NO auto-retry schedule (retrying without a session just 401s again).
    const now = Date.now()
    const ids = new Set(batch.map((b) => b.id))
    let count = 0
    snapshot.state.outbox = outbox.map((o) => {
      if (!ids.has(o.id) || (o.syncStatus ?? 'pending') === 'synced') return o
      count += 1
      return { ...o, syncStatus: 'failed', authBlocked: true, lastError: HEADLESS_AUTH_BLOCKED_MESSAGE, retryCount: (o.retryCount ?? 0) + 1 }
    })
    await writeBack(snapshot)
    console.warn(`[mjengoos-outbox] headless drain auth-blocked ${count} item(s) — waiting for a sign-in`)
    return
  }

  // Defensive parse: a non-JSON error body (proxy 502 page) must not fall
  // into the network-failure path — the server DID answer.
  const json = await res.json().catch(() => null)
  if (!json || json.ok !== true) {
    // Server-level refusal (500/413/429/403…): surfaced per-item as failed
    // with the reason — never silently re-queued (the app's #191 discipline).
    const reason =
      json && typeof json.error === 'string' && json.error.trim() ? json.error : HEADLESS_SERVER_REFUSAL_MESSAGE
    const ids = new Set(batch.map((b) => b.id))
    let count = 0
    snapshot.state.outbox = outbox.map((o) => {
      if (!ids.has(o.id) || (o.syncStatus ?? 'pending') === 'synced') return o
      count += 1
      return { ...o, syncStatus: 'failed', lastError: reason, retryCount: (o.retryCount ?? 0) + 1, ...withAutoRetryScheduleHeadless(o) }
    })
    await writeBack(snapshot)
    console.warn(`[mjengoos-outbox] headless drain refused: ${count} item(s) failed (${reason})`)
    return
  }

  // Per-item results — the §40 lifecycle transitions the app's syncNow
  // applies (synced → capped history; failed → lastError + bounded #132
  // schedule; conflict → §41 metadata).
  const now = Date.now()
  const results = Array.isArray(json.results) ? json.results : []
  const byId = new Map(results.map((r) => [r.id, r]))
  const marked = outbox.map((o) => {
    const r = byId.get(o.id)
    if (!r) return o // not part of this drain
    if (r.ok) return { ...o, syncStatus: 'synced', syncedAt: now, lastError: undefined }
    if ('conflict' in r) {
      return {
        ...o,
        syncStatus: 'conflict',
        conflictReason: r.reason,
        conflictRule: r.rule,
        conflictAt: now,
        conflictStatus: r.status,
        conflictServerVersion: r.serverVersion,
        conflictBaseVersion: r.baseVersion,
        suggestion: r.suggestion,
      }
    }
    return {
      ...o,
      syncStatus: 'failed',
      lastError: r.error,
      retryCount: (o.retryCount ?? 0) + 1,
      ...withAutoRetryScheduleHeadless(o),
    }
  })
  const live = marked.filter((o) => o.syncStatus !== 'synced')
  const finished = marked.filter((o) => o.syncStatus === 'synced')
  snapshot.state.outbox = live
  snapshot.state.syncHistory = [...(snapshot.state.syncHistory ?? []), ...finished].slice(-SYNC_HISTORY_CAP)
  await writeBack(snapshot)
  console.info(
    `[mjengoos-outbox] headless drain: ${finished.length} synced, ` +
      `${live.filter((o) => o.syncStatus === 'failed').length} failed, ` +
      `${live.filter((o) => o.syncStatus === 'conflict').length} conflict(s)`,
  )
}

self.addEventListener('sync', (event) => {
  // Only our tag — anything else another layer registered is not ours to act on.
  if (event.tag !== OUTBOX_SYNC_TAG) return
  event.waitUntil(
    (async () => {
      // A client IS open → ask it to drain (the full-store drain with toasts
      // and §41 resolution UI); this worker stays out of the way.
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (windowClients.length > 0) {
        await Promise.all(
          windowClients.map((client) => client.postMessage({ type: DRAIN_REQUEST_MESSAGE_TYPE })),
        )
        return
      }
      // NO client open → the closed-app drain from the indexedDB record.
      await drainOutboxHeadlessSw()
    })(),
  )
})
