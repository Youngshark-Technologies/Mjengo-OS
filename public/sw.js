/**
 * MjengoOS service worker (v3 — offline app shell · issue #78 / audit FE-1).
 *
 * Strategy:
 *   - /api/**        → network-only. NEVER cached, NEVER served from cache.
 *   - HTML navigations → network-first → last-good cached app shell → the
 *     precached offline.html. In PRODUCTION the '/' shell is cached on every
 *     successful network fetch and served only when the network fails, so an
 *     offline RELOAD boots the real app (data + outbox live client-side in
 *     localStorage). In DEV the v2 no-stale-shell rule stays: HTML is never
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
 * Background Sync (issue #193): queuing an outbox item registers the
 * one-shot 'mjengoos-outbox' tag (feature-detected, Chromium only); when
 * connectivity returns — even with no page open — the browser fires the
 * `sync` event and the handler below asks any open client to drain. A
 * CLOSED app defers honestly to the next app open: the outbox lives in the
 * page's localStorage, which this worker cannot read (see the sync section
 * at the bottom for the full posture).
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

// ---------------- sync (#193 — Background Sync outbox drain) ---------------
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
// HONEST LIMIT (the issue's documented posture): the outbox lives in the
// page's localStorage, which this worker CANNOT read, and the drain logic
// (auth, per-item §41 conflict semantics, #132 retry schedules) lives in
// the app store. So this handler's job is to ASK, not to drain: postMessage
// { type: 'mjengoos:drain' } at every open window client — an open page
// runs syncNow() (app.tsx's container listener, guarded by
// isDrainRequestMessage semantics). With NO client open there is nothing
// this worker can honestly do: the waitUntil promise RESOLVES (Chromium
// then consumes the one-shot tag instead of pointlessly re-firing it at a
// closed app on its own backoff — the next enqueue re-registers), and the
// drain defers honestly to the next app open (boot + setOnline + the #191
// drainAfterAuth path all drain the queue). A true closed-app drain
// requires moving the outbox to SW-readable storage (IndexedDB) — the
// persistence issue, deliberately out of scope here.

const OUTBOX_SYNC_TAG = 'mjengoos-outbox'
const DRAIN_REQUEST_MESSAGE_TYPE = 'mjengoos:drain'

self.addEventListener('sync', (event) => {
  // Only our tag — anything else another layer registered is not ours to act on.
  if (event.tag !== OUTBOX_SYNC_TAG) return
  event.waitUntil(
    (async () => {
      // Ask every open app window to drain (the notificationclick client
      // idiom): this worker cannot read the outbox or run the drain itself.
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      await Promise.all(
        windowClients.map((client) => client.postMessage({ type: DRAIN_REQUEST_MESSAGE_TYPE })),
      )
    })(),
  )
})
