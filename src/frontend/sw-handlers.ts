// Service-worker handler logic (W5-1 + W7 PWA offline) — PURE and unit-tested.
//
// public/sw.js is a plain static script (no bundler step — its offline
// behavior is load-bearing and deliberately hand-rolled), so it cannot
// import this module directly. Instead it wires the SAME logic inline, and
// these exported pure functions are the canonical, tested statement of the
// contract:
//   · the PAYLOAD the server sends (buildWebPushPayload in
//     src/backend/modules/notify/channels.ts — { title, body, projectId,
//     kind }) is what parsePushPayload accepts (tests round-trip both sides);
//   · the CLICK deep-link is /?projectId=<id> (the app boots straight into
//     that project), built ONLY from projectId — the server never guesses
//     app routing;
//   · a notificationclick never navigates off-origin: the target comes from
//     notification.data.url, which this module always builds as a
//     same-origin relative path.
//
// tests/unit/push-routes.test.ts pins all of this plus the sw.js source
// wiring (readFileSync assertions), so the inline copy cannot drift silently.

/** The normalized payload one push carries (all fields the sw uses). */
export interface PushNotificationPayload {
  title: string
  body: string
  projectId: string | null
  kind: string | null
}

/**
 * Parse whatever the push message carried into a payload, or null when it is
 * not the server's shape (the sw then shows a generic notification instead
 * of crashing the handler). Accepts the already-parsed JSON object (the
 * sw's event.data.json()) or a JSON string (event.data.text()).
 */
export function parsePushPayload(data: unknown): PushNotificationPayload | null {
  let parsed: unknown = data
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  // title is the one required field; body/projectId/kind are optional but
  // must be strings when present.
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null
  if (obj.body !== undefined && typeof obj.body !== 'string') return null
  if (obj.projectId !== undefined && typeof obj.projectId !== 'string') return null
  if (obj.kind !== undefined && typeof obj.kind !== 'string') return null
  return {
    title: obj.title,
    body: typeof obj.body === 'string' ? obj.body : '',
    projectId: typeof obj.projectId === 'string' && obj.projectId ? obj.projectId : null,
    kind: typeof obj.kind === 'string' && obj.kind ? obj.kind : null,
  }
}

/**
 * The deep-link for a payload's project: /?projectId=<encoded id> — the app
 * boots that project directly. No project → the app root. The id is
 * encodeURIComponent'd so an id containing separators cannot smuggle extra
 * query params or fragments.
 */
export function deepLinkFor(projectId: string | null): string {
  if (!projectId) return '/'
  return `/?projectId=${encodeURIComponent(projectId)}`
}

/**
 * showNotification options for a payload: body, icons from the precached
 * PWA icons, a per-project tag (a second push for the same project REPLACES
 * the previous notification instead of stacking), and data.url — the
 * same-origin deep-link notificationclick opens.
 */
export function notificationOptionsFor(payload: PushNotificationPayload): {
  body: string
  icon: string
  badge: string
  tag: string
  data: { url: string }
} {
  return {
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.projectId ? `mjengoos-${payload.projectId}` : 'mjengoos',
    data: { url: deepLinkFor(payload.projectId) },
  }
}

/**
 * The URL a notificationclick navigates to: notification.data.url when it is
 * a safe SAME-ORIGIN relative path (starts with '/', not '//'), else the app
 * root. The origin is passed in (self.location.origin in the sw) — a payload
 * can never steer the click to a foreign site.
 */
export function clickTargetUrl(data: unknown, origin: string): string {
  let url = '/'
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const raw = (data as Record<string, unknown>).url
    if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) url = raw
  }
  return `${origin.replace(/\/$/, '')}${url}`
}

// ------------- W7 PWA offline (issue #78 / audit FE-1 + FE-8) --------------
//
// The v3 service-worker additions (offline app shell + photo LRU) follow the
// same contract as the push handlers above: public/sw.js is a STATIC script
// with no bundler step, so it cannot import this module — it mirrors the SAME
// logic inline, and these pure functions are the canonical, unit-tested
// statement (tests/unit/sw-offline-shell.test.ts pins both the helpers and
// the sw.js source wiring by reading the file, exactly like push-routes).

/** Hostnames `next dev` serves the SW from — production deployments never do. */
export const DEV_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1']

/**
 * Should this origin's service worker cache and serve cached HTML for
 * document navigations? PRODUCTION: yes — the last-good app shell is what an
 * offline RELOAD boots (issue #78/FE-1; data + outbox live client-side in
 * localStorage, so the shell is all the network owes us). DEV: never — the
 * dev server recompiles the same URL into different HTML on every edit;
 * caching it would serve a stale dev shell (the v2 no-stale-shell rule).
 * Honest mechanism: sw.js is ONE static file registered by both dev and prod
 * (layout.tsx), with no build step, so the SW's own origin hostname is the
 * only reliable runtime signal.
 */
export function shouldCacheNavigationHtml(hostname: string): boolean {
  return !DEV_HOSTNAMES.includes(hostname)
}

/**
 * The cache key a navigation's HTML is stored under: the APP serves exactly
 * one HTML route — the client-side app at '/' (query strings such as
 * ?share= / ?projectId= are read by the booted client; the server HTML is
 * identical), so every app-shell navigation caches AND serves under the
 * single key '/'. Any other path → null: not an app shell, not cached. (The
 * proxied marketing site at /website and /offline.html itself stay on the v2
 * rule: network-first with the offline.html fallback, never cached.)
 */
export function navigationShellKey(pathname: string): string | null {
  return pathname === '/' ? '/' : null
}

/** LRU cap for /photos/** cache entries (issue #78/FE-8: quota pressure). */
export const PHOTO_CACHE_CAP = 100

/**
 * Which cached photo URLs to delete when the set exceeds `cap` (issue #78 /
 * FE-8): least-recently-used first. A URL absent from `lastUsed` (never
 * served from the cache since the catalog was recorded, or the LRU catalog
 * was lost with a SW restart) counts as OLDEST; ties keep the cache's own key
 * order, so the result is deterministic. Returns the eviction list in delete
 * order — empty when the set is within the cap.
 */
export function photoLruEvictions(
  urls: readonly string[],
  lastUsed: ReadonlyMap<string, number>,
  cap: number = PHOTO_CACHE_CAP,
): string[] {
  const excess = urls.length - cap
  if (excess <= 0) return []
  return urls
    .map((url, i) => ({ url, i, at: lastUsed.get(url) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .slice(0, excess)
    .map((e) => e.url)
}

// ------------- #148 · SW staleness cue (waiting-worker update prompt) ------
//
// The app caches the '/' shell in production (v3 strategy above), so a new
// deploy only reaches a RUNNING tab when the user reloads. The staleness cue:
// the client watch (src/frontend/pwa/sw-update-watch.ts, wired into the UI by
// sw-update-prompt.tsx) detects a worker that finished installing under the
// old page and offers "app updated — reload". Same idiom as the push and
// offline halves: these pure functions are the canonical, unit-tested
// statement (tests/unit/sw-update-prompt.test.ts); public/sw.js mirrors the
// SKIP_WAITING message handling inline, and the watch module mirrors the
// decisions by CALLING these helpers (never by re-deriving them).

/** The message the Reload action posts to a WAITING worker (see sw.js). */
export const SKIP_WAITING_MESSAGE_TYPE = 'SKIP_WAITING'

/**
 * How often focus/visibility may trigger a registration.update() check
 * (#148 AC: "bounded frequency" — a field user flipping between apps all day
 * must not hammer the server for sw.js byte-compares; the browser's own
 * navigation check stays the other update path). One hour.
 */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 60 * 60 * 1000

/**
 * Safety net for the Reload click (#148 AC 2): after posting SKIP_WAITING the
 * page reloads on controllerchange — but a worker that died mid-activate
 * never flips the controller, and a click that silently no-ops is a lie. The
 * grace period reloads anyway. Long enough not to race a healthy activation
 * (single skipWaiting hop), short enough to feel instant.
 */
export const SKIP_WAITING_RELOAD_GRACE_MS = 3000

/**
 * Is a worker state change the staleness cue (#148 AC 1 + 3)? TRUE only for
 * a worker that FINISHED INSTALLING (state 'installed' — it now holds the new
 * version) while this page is already controlled by an older worker. On the
 * FIRST install there is no controller, so nothing prompts — the page that
 * registered the SW is loading the new version already.
 */
export function shouldShowUpdatePrompt(workerState: string, hasController: boolean): boolean {
  return workerState === 'installed' && hasController
}

/**
 * May a foreground signal (focus / tab visible again) trigger an update check
 * now (#148 AC 4)? Never-checked → yes; otherwise only once per
 * UPDATE_CHECK_MIN_INTERVAL_MS. The bound is on ATTEMPTS — a failed check
 * (offline field tablet) must not retry on every focus either.
 */
export function shouldCheckForUpdates(
  lastCheckedAtMs: number | null,
  nowMs: number,
  minIntervalMs: number = UPDATE_CHECK_MIN_INTERVAL_MS,
): boolean {
  if (lastCheckedAtMs === null) return true
  return nowMs - lastCheckedAtMs >= minIntervalMs
}

/**
 * Is this message the page's SKIP_WAITING ask? The sw.js message handler
 * mirrors this check inline (a static script cannot import the module) —
 * anything else posted at the worker is ignored.
 */
export function isSkipWaitingMessage(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).type === SKIP_WAITING_MESSAGE_TYPE
  )
}

// ------------- #193 · Background Sync (one-shot outbox drain tag) ---------
//
// The outbox's drain triggers were all page-lifetime-bound (window `online`,
// manual Sync, the retry footer, the #132 auto-retry timer) — if the PWA is
// CLOSED when connectivity returns, queued mutations sit until the next app
// open. Background Sync closes that gap on Chromium (Chrome/Edge/Android —
// the primary field audience): queuing an outbox item registers a ONE-SHOT
// tag; the browser re-launches the SW and fires `sync` when connectivity
// returns, even with no page open. Safari/Firefox have no Background Sync —
// feature-detected, they keep today's behavior exactly (progressive
// enhancement, the PWA-first answer to #41).
//
// HONEST LIMIT (the issue's sanctioned posture): the SW cannot drain a
// CLOSED app itself — the outbox lives in the page's localStorage (invisible
// to the SW) and the drain logic (auth, per-item §41 conflict semantics,
// retry schedules) lives in the app store. So the sw.js `sync` handler's
// only job is to ASK: postMessage { type: 'mjengoos:drain' } at every open
// client (app.tsx's container listener runs syncNow). With no client open
// the drain defers honestly to the next app open (boot + setOnline + #191
// drainAfterAuth all drain the queue); a true closed-app drain needs the
// outbox in SW-readable storage (IndexedDB) — the persistence issue, out
// of scope. These pure functions are the canonical, unit-tested statement
// of that contract (tests/unit/sw-offline-shell.test.ts pins the helpers +
// sw.js wiring; tests/unit/outbox-background-sync.test.ts pins the enqueue
// seam behaviorally); public/sw.js mirrors the tag + payload constants
// inline exactly like the push and SKIP_WAITING halves.

/** The one-shot Background Sync tag registered when an outbox item queues. */
export const OUTBOX_SYNC_TAG = 'mjengoos-outbox'

/** Message type the sw.js `sync` handler posts at open clients to request a drain. */
export const DRAIN_REQUEST_MESSAGE_TYPE = 'mjengoos:drain'

/**
 * Is this message the SW asking the page to drain the outbox (#193)? The
 * sw.js sync handler posts { type: 'mjengoos:drain' } at its window clients;
 * app.tsx's container listener mirrors this check before running syncNow.
 * Anything else posted at the container is ignored.
 */
export function isDrainRequestMessage(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).type === DRAIN_REQUEST_MESSAGE_TYPE
  )
}

/**
 * The Background Sync manager of a service-worker registration, or null when
 * the browser does not support the API (#193 feature detection). Structural:
 * a missing `sync`, a non-object, or a non-function `register` all read as
 * unsupported — the caller then keeps today's page-lifetime behavior, and
 * nothing throws.
 */
export function syncManagerOf(
  registration: unknown,
): { register: (tag: string) => Promise<void> } | null {
  if (registration === null || typeof registration !== 'object' || Array.isArray(registration)) {
    return null
  }
  const sync = (registration as Record<string, unknown>).sync
  if (sync === null || typeof sync !== 'object' || Array.isArray(sync)) return null
  const register = (sync as Record<string, unknown>).register
  return typeof register === 'function'
    ? (sync as { register: (tag: string) => Promise<void> })
    : null
}

/**
 * Register the one-shot outbox drain tag (#193) — progressive enhancement,
 * called from the outbox ENQUEUE seams (use-mjengo dispatch). MUST NEVER
 * break enqueueing: an unsupported browser (Safari/Firefox), a missing
 * registration, or any register refusal (permission/quota) resolves false
 * instead of throwing. Re-registration while the tag is already pending is
 * fine — the browser coalesces one-shot tags by name.
 */
export async function registerOutboxSync(registration: unknown): Promise<boolean> {
  const sync = syncManagerOf(registration)
  if (!sync) return false
  try {
    await sync.register(OUTBOX_SYNC_TAG)
    return true
  } catch {
    // NotAllowedError / quota / any refusal: the queue keeps its
    // page-lifetime drain behavior — the write itself already landed.
    return false
  }
}
