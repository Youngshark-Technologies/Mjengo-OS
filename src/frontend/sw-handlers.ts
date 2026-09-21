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

import {
  SYNC_HISTORY_CAP,
  withAutoRetrySchedule,
  type OutboxItem,
  type SyncItemResult,
} from '@/frontend/lib/outbox'
import { OUTBOX_DB_NAME, OUTBOX_DB_STORE, OUTBOX_DB_VERSION } from '@/frontend/lib/outbox-idb'

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
 * indexedDB (#351), so the shell is all the network owes us). DEV: never — the
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
// HONEST POSTURE (#351 updated this): the outbox now lives in indexedDB
// (lib/outbox-idb.ts), which the SW reads on the same origin — so the sw.js
// `sync` handler BOTH asks open clients to drain (postMessage
// { type: 'mjengoos:drain' } — app.tsx's container listener runs syncNow
// with the full store, toasts and §41 resolution UI) AND, with NO client
// open, drains the headless-safe pending items itself from the indexedDB
// record (the #351 section below — money/session-bound kinds refuse
// honestly and wait for a tab). Safari/Firefox never fire `sync` at all
// (feature-detected at registration); their queue keeps the page-lifetime
// behavior. These pure functions are the canonical, unit-tested statement
// of that contract (tests/unit/sw-offline-shell.test.ts pins the helpers +
// sw.js wiring; tests/unit/outbox-background-sync.test.ts pins the enqueue
// seam behaviorally; tests/unit/outbox-headless-drain.test.ts pins the
// closed-app drain); public/sw.js mirrors the tag + payload constants and
// the drain inline, exactly like the push and SKIP_WAITING halves.

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

// ------------- #351 · closed-app outbox drain (Background Sync + indexedDB) --------------
//
// #193 registered the one-shot 'mjengoos-outbox' tag at enqueue time but the
// SW could not READ the outbox (localStorage is page-only), so a closed app
// deferred honestly to the next app open. The outbox now lives in indexedDB
// (lib/outbox-idb.ts — same zustand persist seam, different medium), which
// the SW reads on the same origin: the `sync` handler can finally DRAIN with
// no tab open. These pure functions are the canonical, unit-tested statement
// of that drain; public/sw.js mirrors them inline (a static script cannot
// import this module — the same house pattern as the push and offline
// halves; tests pin the wiring by reading the file).
//
// THE HEADLESS POLICY (deliberate, fail-closed — an explicit allowlist, so a
// NEW action kind refuses headless until a human adds it here):
//   · DRAIN HEADLESS: the non-financial field + evidence families
//     (attendance.*, task.*, phase.*, worker.*, material.create, delivery.*,
//     consumption.create, alert/comment/notification/photo/zone updates).
//     Their worst-case closed-app outcome is an idempotent replay (§57
//     item-id markers + exact-replay fingerprints), a clean apply, or a
//     human-decides conflict that parks in the sync sheet on the next app
//     open — never a money movement, never a silent overwrite.
//   · REFUSE HEADLESS (stay 'pending', drain on the next app open):
//     - MONEY rows (escrow.*, milestone.decide, variation.decide,
//       invoice.pay/decide, wages.pay, payment.*, wallet.*, expense.create,
//       transaction.delete, project.update's budget rescale): money needs a
//       human watching the outcome — the same hard stop #150 gave the
//       waiting-worklist ("auto-paying a payroll hours after the attempt is
//       a large idempotency surface").
//     - share.regenerate: the new link exists only in the drain response —
//       a headless drain would invalidate the old one unseen.
//     - supply/marketplace (supplier.*, catalog.*, request.*, quote.*,
//       order.*), AI, land, professionals, inventory, intel families:
//       role-pinned sessions, flag gates, ephemeral payloads or high-stakes
//       rows — and the SUPPLIER portal's outbox is a separate store/session
//       by design (#128), never drained through the owner record.
//
// The SW's fetch to /api/sync is same-origin, so the session cookie rides it
// exactly like the app's drain; an expired session answers 401 and the batch
// is marked auth-blocked (#191 semantics — it waits for a sign-in, never
// auto-retried blindly).

/**
 * The owner store's persisted record key. Mirrors use-mjengo's
 * MJENGO_STORE_KEY ('mjengo-os-store') — a static import would cycle
 * (use-mjengo imports this module); tests pin the two literals equal.
 */
export const OUTBOX_DB_RECORD_KEY = 'mjengo-os-store'

/** Action kinds the SW may drain with no tab open (see the policy comment). */
export const HEADLESS_DRAIN_TYPES: readonly string[] = [
  'attendance.checkin',
  'attendance.setStatus',
  'attendance.record',
  'attendance.exception',
  'attendance.override',
  'task.create',
  'task.update',
  'task.delete',
  'task.assign',
  'task.block',
  'task.unblock',
  'task.verify',
  'task.complete',
  'phase.create',
  'phase.update',
  'worker.create',
  'worker.update',
  'material.create',
  'delivery.create',
  'delivery.assign',
  'delivery.transit',
  'delivery.arrive',
  'consumption.create',
  'alert.ack',
  'comment.add',
  'comment.resolve',
  'notification.read',
  'notification.readAll',
  'photo.apply',
  'photo.zone',
  'zone.create',
  'zone.delete',
]

/** A pending outbox item the SW may replay headless (allowlist + §40 state). */
export function isHeadlessDrainable(item: {
  type: string
  syncStatus?: string
}): boolean {
  return (item.syncStatus ?? 'pending') === 'pending' && HEADLESS_DRAIN_TYPES.includes(item.type)
}

/** The persisted owner-store record shape the drain reads and writes. */
export interface HeadlessDrainSnapshot {
  state?: { outbox?: OutboxItem[]; syncHistory?: OutboxItem[] } & Record<string, unknown>
  version?: number
}

/** One queued action as POST /api/sync receives it (the store's drain body shape). */
export interface HeadlessSyncAction {
  id: string
  type: string
  payload: unknown
  projectId?: string | null
}

/** The fixed lastError a headless 401 stamps (the store uses the i18n twin). */
export const HEADLESS_AUTH_BLOCKED_MESSAGE = 'Session expired — this action waits for a sign-in.'

/** The fixed lastError a headless server-level refusal stamps when the body has no reason. */
export const HEADLESS_SERVER_REFUSAL_MESSAGE = 'Sync refused while the app was closed.'

/**
 * Mark one item's §40 lifecycle transition from a drain result — the pure
 * mirror of use-mjengo syncNow's marking (synced → history; failed →
 * lastError + bounded #132 retry schedule; conflict → §41 metadata). No
 * toasts, no payload refresh: those need a tab; the record's state is all
 * the next app open needs.
 */
export function markHeadlessDrainOutcome(item: OutboxItem, result: SyncItemResult, nowMs: number): OutboxItem {
  if (result.ok) {
    return { ...item, syncStatus: 'synced' as const, syncedAt: nowMs, lastError: undefined }
  }
  if ('conflict' in result) {
    return {
      ...item,
      syncStatus: 'conflict' as const,
      conflictReason: result.reason,
      conflictRule: result.rule,
      conflictAt: nowMs,
      conflictStatus: result.status,
      conflictServerVersion: result.serverVersion,
      conflictBaseVersion: result.baseVersion,
      suggestion: result.suggestion,
    }
  }
  return {
    ...item,
    syncStatus: 'failed' as const,
    lastError: result.error,
    retryCount: (item.retryCount ?? 0) + 1,
    // #132: schedule the bounded automatic retry (the app re-arms the timer
    // on its next open — the schedule itself is persisted right here).
    ...withAutoRetrySchedule(item),
  }
}

/**
 * Apply a whole drain batch's per-item results to the persisted snapshot
 * (pure): synced items move into the capped history, everything else keeps
 * its live-queue place with its new lifecycle state. Items the batch did not
 * report are untouched.
 */
export function applyHeadlessDrainResults(
  snapshot: HeadlessDrainSnapshot,
  results: readonly SyncItemResult[],
  nowMs: number,
): { snapshot: HeadlessDrainSnapshot; synced: number; failed: number; conflicts: number } {
  const byId = new Map(results.map((r) => [r.id, r]))
  let synced = 0
  let failed = 0
  let conflicts = 0
  const outbox = (snapshot.state?.outbox ?? []).map((o) => {
    const r = byId.get(o.id)
    if (!r) return o // not part of this drain
    if (r.ok) synced += 1
    else if ('conflict' in r) conflicts += 1
    else failed += 1
    return markHeadlessDrainOutcome(o, r, nowMs)
  })
  // Retain: live queue keeps pending/syncing/failed/conflict; synced items →
  // history (capped) — the store's exact split, so the next app open sees
  // the same shape its own drains produce.
  const live = outbox.filter((o) => o.syncStatus !== 'synced')
  const finished = outbox.filter((o) => o.syncStatus === 'synced')
  return {
    snapshot: {
      ...snapshot,
      state: {
        ...snapshot.state,
        outbox: live,
        syncHistory: [...(snapshot.state?.syncHistory ?? []), ...finished].slice(-SYNC_HISTORY_CAP),
      },
    },
    synced,
    failed,
    conflicts,
  }
}

/**
 * Mark a whole batch auth-blocked (the headless 401 arm — #191 semantics):
 * failed + authBlocked + the fixed session-expired lastError, NO auto-retry
 * schedule (retrying without a session just 401s again); drainAfterAuth()
 * re-queues it once a tab authenticates.
 */
export function markHeadlessAuthBlocked(
  snapshot: HeadlessDrainSnapshot,
  ids: ReadonlySet<string>,
): { snapshot: HeadlessDrainSnapshot; count: number } {
  let count = 0
  const outbox = (snapshot.state?.outbox ?? []).map((o) => {
    if (!ids.has(o.id) || (o.syncStatus ?? 'pending') === 'synced') return o
    count += 1
    return {
      ...o,
      syncStatus: 'failed' as const,
      authBlocked: true,
      lastError: HEADLESS_AUTH_BLOCKED_MESSAGE,
      retryCount: (o.retryCount ?? 0) + 1,
    }
  })
  return {
    snapshot: { ...snapshot, state: { ...snapshot.state, outbox } },
    count,
  }
}

/**
 * Mark a whole batch failed with a server-level refusal reason (the headless
 * non-ok arm — the store's #191 discipline: a server that ANSWERED is
 * surfaced per-item, never silently re-queued as pending).
 */
export function markHeadlessServerRefusal(
  snapshot: HeadlessDrainSnapshot,
  ids: ReadonlySet<string>,
  reason: string,
): { snapshot: HeadlessDrainSnapshot; count: number } {
  let count = 0
  const outbox = (snapshot.state?.outbox ?? []).map((o) => {
    if (!ids.has(o.id) || (o.syncStatus ?? 'pending') === 'synced') return o
    count += 1
    return {
      ...o,
      syncStatus: 'failed' as const,
      lastError: reason,
      retryCount: (o.retryCount ?? 0) + 1,
      ...withAutoRetrySchedule(o),
    }
  })
  return {
    snapshot: { ...snapshot, state: { ...snapshot.state, outbox } },
    count,
  }
}

/** What one headless drain did (surfaced in the SW console, pinned by tests). */
export interface HeadlessDrainReport {
  /** Headless-safe pending items sent to /api/sync. */
  sent: number
  /** Pending items refused headless (money/session-bound — they wait for a tab). */
  refused: number
  synced: number
  failed: number
  conflicts: number
  authBlocked: number
}

/**
 * The closed-app drain, orchestrated over injected seams (the record
 * read/write IS the #351 kv seam — the in-memory implementation backs the
 * unit tests; public/sw.js mirrors this over raw indexedDB):
 *   · reads the persisted owner-store record; an absent or corrupt record
 *     drains NOTHING (a corrupt record is the app rehydrate's degradation to
 *     surface, and the legacy localStorage queue is app-side-only — the SW
 *     cannot read it; both deferrals are the documented honest posture);
 *   · sends only the headless-safe pending items (isHeadlessDrainable);
 *   · a NETWORK failure rejects (the caller's event.waitUntil rejects →
 *     Chromium retries the one-shot tag on its own backoff — the items were
 *     never marked, so the retry re-sends them and §57 idempotency bounds
 *     any double-send);
 *   · a 401 marks the batch auth-blocked; any other server-level answer is
 *     surfaced per-item as failed; per-item results apply the §40 lifecycle
 *     and the record is written back.
 */
export interface HeadlessDrainDeps {
  readRecord(): Promise<string | null>
  writeRecord(value: string): Promise<void>
  postSync(actions: readonly HeadlessSyncAction[]): Promise<{ status: number; json(): Promise<unknown> }>
  now(): number
}

export async function drainOutboxHeadless(deps: HeadlessDrainDeps): Promise<HeadlessDrainReport> {
  const report: HeadlessDrainReport = { sent: 0, refused: 0, synced: 0, failed: 0, conflicts: 0, authBlocked: 0 }

  const raw = await deps.readRecord()
  if (raw === null) return report
  let snapshot: HeadlessDrainSnapshot
  try {
    snapshot = JSON.parse(raw) as HeadlessDrainSnapshot
  } catch {
    return report // corrupt record — the app's rehydrate owns surfacing it
  }
  const outbox = snapshot.state?.outbox
  if (!Array.isArray(outbox)) return report

  const batch = outbox.filter(isHeadlessDrainable)
  report.refused = outbox.filter(
    (o) => (o.syncStatus ?? 'pending') === 'pending' && !isHeadlessDrainable(o),
  ).length
  if (batch.length === 0) return report
  report.sent = batch.length

  // A throw here IS the network failure — it propagates so the sync event's
  // waitUntil rejects and Chromium re-fires the tag later.
  const res = await deps.postSync(
    batch.map(({ id, type, payload, projectId }) => ({ id, type, payload, projectId })),
  )

  if (res.status === 401) {
    const marked = markHeadlessAuthBlocked(snapshot, new Set(batch.map((b) => b.id)))
    await deps.writeRecord(JSON.stringify(marked.snapshot))
    report.authBlocked = marked.count
    return report
  }

  const json = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown; results?: unknown } | null
  if (!json || typeof json !== 'object' || json.ok !== true) {
    const reason =
      typeof json?.error === 'string' && json.error.trim() ? json.error : HEADLESS_SERVER_REFUSAL_MESSAGE
    const marked = markHeadlessServerRefusal(snapshot, new Set(batch.map((b) => b.id)), reason)
    await deps.writeRecord(JSON.stringify(marked.snapshot))
    report.failed = marked.count
    return report
  }

  const results = (Array.isArray(json.results) ? json.results : []) as SyncItemResult[]
  const applied = applyHeadlessDrainResults(snapshot, results, deps.now())
  await deps.writeRecord(JSON.stringify(applied.snapshot))
  report.synced = applied.synced
  report.failed = applied.failed
  report.conflicts = applied.conflicts
  return report
}

export { OUTBOX_DB_NAME, OUTBOX_DB_STORE, OUTBOX_DB_VERSION }

// ------------- #193 (registration half) — kept last for its section's readability -------------

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

// ------------- #357 · PWA install cue (FE-11 residual) ---------------------
//
// The OTHER half of audit FE-11: #148 landed the staleness cue ("app updated
// — reload"); the install cue is what remained. The app is an installable
// PWA (public/manifest.webmanifest, display: standalone) but never SAID so —
// the browser's own install affordances are buried in chrome menus, and the
// beforeinstallprompt event (Chromium family) fires whether anyone listens
// or not. Same idiom as the staleness cue: these pure functions are the
// canonical, unit-tested statement (tests/unit/install-cue.test.ts); the
// watch half lives in src/frontend/pwa/install-cue-watch.ts (DI, behavioral
// tests with fake windows/storages) and the UI half in
// src/frontend/pwa/install-cue.tsx, mounted from the root layout.
//
// HONESTY POSTURE (the house rule — no fake flows):
//  · the REAL cue shows only when the browser itself offered the install
//    (beforeinstallprompt captured — Chromium's own eligibility heuristics);
//    its Install button runs the browser's native prompt(), never a look-
//    alike;
//  · iOS/Safari NEVER fires beforeinstallprompt — there the cue is
//    INSTRUCTIONS-ONLY ("Share → Add to Home Screen"), no button, no
//    imitation; after the user adds it, the standalone display check keeps
//    every future session silent;
//  · every other browser where the event never fires (Firefox desktop, …)
//    gets NO cue at all — we do not know their steps, so we show nothing
//    rather than guess.

/** localStorage key remembering a dismissed install cue (guarded write). */
export const INSTALL_CUE_DISMISS_KEY = 'mjengo-os-install-cue-dismissed'

/**
 * Is the app ALREADY running as an installed PWA (#357)? Two honest signals:
 * the CSS display-mode media query (`(display-mode: standalone)` — the
 * W3C-manifest way, matches how Chrome/Edge launch installed apps) or iOS's
 * non-standard `navigator.standalone` (Safari sets it in home-screen web
 * apps; it never fires beforeinstallprompt). Either true → the app IS the
 * install — no cue, ever.
 */
export function isStandaloneDisplay(
  displayModeStandalone: boolean | undefined,
  iOSStandalone: boolean | undefined,
): boolean {
  return displayModeStandalone === true || iOSStandalone === true
}

/**
 * May the browser-native install cue show (#357)? TRUE only when the browser
 * itself offered the install (a beforeinstallprompt event was captured —
 * Chromium's eligibility heuristics passed), the user has not dismissed the
 * cue, and the app is not installed yet. No event → no cue: a button that
 * pretends to install where the browser never offered is a fake flow.
 */
export function shouldShowInstallCue(
  eventCaptured: boolean,
  dismissed: boolean,
  installed: boolean,
): boolean {
  return eventCaptured && !dismissed && !installed
}

/**
 * The honest iOS heuristic (#357): iPhone/iPad/iPod in the UA, or an
 * iPadOS 13+ device masquerading as Macintosh Safari with multi-touch (the
 * documented detection compromise — iPadOS hides "iPad" from the UA). No
 * iOS browser fires beforeinstallprompt, so these are exactly the devices
 * whose only install path is Safari's Share → Add to Home Screen.
 */
export function looksLikeIOS(userAgent: string, maxTouchPoints: number | undefined): boolean {
  const ua = userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return true
  if (ua.includes('macintosh') && (maxTouchPoints ?? 0) > 1) return true
  return false
}

/**
 * May the minimal instructions-only iOS hint show (#357)? TRUE only on an
 * iOS-class device, not already installed (standalone), not dismissed, and
 * ONLY while no real install event has arrived — if a browser ever does fire
 * beforeinstallprompt on iOS, the REAL cue (shouldShowInstallCue) wins and
 * the hint stands down. The hint carries instructions and a "Got it" — never
 * an install button.
 */
export function shouldShowIosInstallHint(
  iOSDevice: boolean,
  standalone: boolean,
  dismissed: boolean,
  installed: boolean,
  eventCaptured: boolean,
): boolean {
  return iOSDevice && !standalone && !dismissed && !installed && !eventCaptured
}
