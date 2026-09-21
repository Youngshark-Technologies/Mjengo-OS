// Shared offline-outbox core (spec §40/§41, #132, #191 — extracted for #128).
//
// The OWNER app (use-mjengo.ts) and the SUPPLIER portal (use-supplier-outbox.ts)
// run the SAME outbox discipline — one persisted item shape, one lifecycle
// (pending → syncing → synced | failed | conflict), one bounded auto-retry
// cadence, one migration-normalizer — against DIFFERENT stores, sessions and
// transports. This module is everything that is genuinely shared between them
// and NOTHING that isn't: pure types, pure functions, constants, and a
// parameterized auto-retry engine. It never touches a store instance, a
// transport endpoint, or a session — each app wires those itself, so the owner
// app's state and the supplier portal's state can never entangle (different
// zustand stores, different localStorage keys, different reducers).
//
// use-mjengo.ts re-exports the item types + normalizeOutboxItem +
// AUTO_RETRY_* so its long-standing public API (panels, tests) is unchanged.

import { BASE36_CHARSET, randomChars } from '@/shared/ids'

/** Per-item sync lifecycle (spec §40): pending → syncing → synced | failed | conflict. */
export type OutboxSyncStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict'

/** Which side of a conflict the deterministic rule leaves in charge (spec §41). */
export type ConflictRule = 'server-wins' | 'human-decides'

export interface OutboxItem {
  id: string
  type: string
  payload: any
  label: string
  createdAt: number
  projectId?: string | null
  /** v2 (spec §40/§41): the item's full sync lifecycle. Old persisted items are migrated to 'pending'. */
  syncStatus: OutboxSyncStatus
  /** How many drain attempts returned a hard failure for this item (manual + auto). */
  retryCount: number
  /** Server's explanation when the drain hit a conflict — kept until (and after) resolution. */
  conflictReason?: string
  conflictRule?: ConflictRule
  conflictAt?: number
  /**
   * Entity-version rejection metadata (issue "Outbox conflict metadata +
   * entity versions") — set when the server REJECTED the item 'stale-version':
   * the row moved on while this device was offline.
   */
  conflictStatus?: 'REJECTED'
  /** The row's server version at rejection — what a re-send must re-base onto. */
  conflictServerVersion?: number
  /** The client version the rejected edit was authored against. */
  conflictBaseVersion?: number
  /** The server's deterministic suggestion (keep-server by policy — §41). */
  suggestion?: 'keep-server'
  /** Last hard failure message (syncStatus 'failed'). */
  lastError?: string
  /**
   * #191: the last drain was refused 401 (session expired mid-offline) — the
   * item waits for a SIGN-IN, not a data fix. Surfaced as failed + a
   * session-expired lastError; drainAfterAuth() re-queues it once a session
   * authenticates again. Never auto-retried blindly (retrying without a
   * session just 401s again).
   */
  authBlocked?: boolean
  /**
   * #132 — bounded auto-retry bookkeeping for hard failures: how many of the
   * max 3 automatic attempts this item has consumed (stamped when a failure
   * schedules the NEXT attempt). Persisted with the outbox so a reload does
   * not reset the schedule. Auth-blocked (#191) and conflict items never
   * carry a schedule — they wait for a sign-in / a human decision.
   */
  autoAttempts?: number
  /** #132 — epoch ms when this failed item becomes eligible for its next automatic retry (unset once the 3 attempts are exhausted → manual-only). */
  nextAttemptAt?: number
  syncedAt?: number
  /** Set when a human resolved a conflict: server version kept, local version applied, or the item dropped. */
  resolution?: 'keep-server' | 'keep-mine-applied' | 'discarded'
}

/** One synced/resolved outbox item, retained (bounded) so nothing is silently lost (§52). */
export type SyncHistoryItem = OutboxItem

/**
 * Per-item result contract of POST /api/sync (mirror of the route's
 * SyncItemResult). The conflict arm's version-rejection metadata (status
 * 'REJECTED' / serverVersion / baseVersion / suggestion) is optional —
 * present only on 'stale-version' rejections.
 */
export type SyncItemResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string }
  | {
      id: string
      ok: false
      conflict: true
      reason: string
      rule: ConflictRule
      status?: 'REJECTED'
      serverVersion?: number
      baseVersion?: number
      suggestion?: 'keep-server'
    }

/**
 * Fresh outbox item ids (both apps): timestamp + random suffix, unique per
 * device. MD-4 (#350): the suffix is drawn from the shared CSPRNG seam
 * (src/shared/ids.ts) — the id shape is unchanged (<base36 ts>-<6 base36
 * chars>) but the draw is no longer Math.random (predictable); the suffix is
 * now always exactly 6 chars (Math.random().toString(36) could yield fewer).
 */
export function uid() {
  return `${Date.now().toString(36)}-${randomChars(6, BASE36_CHARSET)}`
}

/** Normalise a possibly-stale persisted outbox item to the v2 shape (migration-safe). */
export function normalizeOutboxItem(item: OutboxItem): OutboxItem {
  return {
    ...item,
    syncStatus: item.syncStatus ?? 'pending',
    retryCount: typeof item.retryCount === 'number' ? item.retryCount : 0,
    authBlocked: item.authBlocked === true,
    // #132: pre-auto-retry items start with a clean slate (0 attempts used,
    // no schedule) — their next hard failure schedules the first backoff.
    autoAttempts: typeof item.autoAttempts === 'number' ? item.autoAttempts : 0,
    nextAttemptAt: typeof item.nextAttemptAt === 'number' ? item.nextAttemptAt : undefined,
  }
}

/** Retention cap for the synced/resolved history — the live queue is never pruned. */
export const SYNC_HISTORY_CAP = 50

// ---------------- #132 — bounded auto-retry for failed outbox items ----------------

/** Up to 3 automatic attempts, then manual-only (the panel's retry footer). */
export const AUTO_RETRY_MAX_ATTEMPTS = 3

/** Backoff cadence before each automatic attempt: 5s → 30s → 2min. */
export const AUTO_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const

/**
 * #132 — stamp the next bounded auto-retry onto a hard-failed item: 5s →
 * 30s → 2min, at most 3 automatic attempts, then manual-only. Auth-blocked
 * (#191 — a 401 waits for a sign-in, retrying without a session just 401s
 * again) and conflict items are never given a schedule by the callers.
 */
export function withAutoRetrySchedule(o: OutboxItem): Partial<OutboxItem> {
  const attempts = o.autoAttempts ?? 0
  if (attempts >= AUTO_RETRY_MAX_ATTEMPTS) return {} // exhausted → manual-only
  const delay = AUTO_RETRY_DELAYS_MS[Math.min(attempts, AUTO_RETRY_DELAYS_MS.length - 1)]
  return { autoAttempts: attempts + 1, nextAttemptAt: Date.now() + delay }
}

/**
 * #132 — the single-timer auto-retry engine, parameterized by its HOST store
 * (owner or supplier). Extracted for #128 so both apps run the IDENTICAL
 * backoff discipline without sharing any state: the host supplies its own
 * getState/requeue/syncNow, the engine owns only the module-level timer.
 *
 * Timer bookkeeping lives outside the store on purpose — it is process state,
 * never persisted; the SCHEDULE itself (nextAttemptAt/autoAttempts) is, so a
 * reload restores it (each store's rehydrate hook re-arms) instead of
 * resetting it.
 */
export interface AutoRetryHost {
  /** The host store's live state (read at timer fire, never cached). */
  getState(): { online: boolean; syncing: boolean; outbox: OutboxItem[] }
  /** Re-queue the given failed items as pending (the host's own setState). */
  requeue(ids: Set<string>): void
  /** Start one drain of the pending queue (the host's own syncNow). */
  syncNow(): Promise<unknown>
}

export function createAutoRetryEngine(host: AutoRetryHost) {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * (Re)arm the single auto-retry timer for the soonest scheduled failure.
   * No-op when nothing is scheduled. Safe to call repeatedly — always
   * recomputed from current state, so a newly-stamped earlier attempt
   * preempts a later one.
   */
  function arm(): void {
    clear()
    const soonest = host.getState().outbox.reduce<number | null>((acc, o) => {
      if (o.syncStatus !== 'failed' || o.authBlocked === true) return acc
      if (typeof o.nextAttemptAt !== 'number') return acc
      return acc === null || o.nextAttemptAt < acc ? o.nextAttemptAt : acc
    }, null)
    if (soonest === null) return
    timer = setTimeout(run, Math.max(0, soonest - Date.now()))
  }

  /**
   * #132 — re-queue hard-failed items whose backoff has elapsed (failed →
   * pending). Conflicts and auth-blocked items are structurally excluded: a
   * conflict needs a human §41 decision, an auth-blocked item needs a sign-in
   * (drainAfterAuth owns it). Returns how many items were re-queued.
   */
  function requeueDue(): number {
    const s = host.getState()
    const due = new Set(
      s.outbox
        .filter((o) =>
          o.syncStatus === 'failed' &&
          o.authBlocked !== true &&
          typeof o.nextAttemptAt === 'number' &&
          o.nextAttemptAt <= Date.now())
        .map((o) => o.id),
    )
    if (due.size === 0) return 0
    host.requeue(due)
    return due.size
  }

  /**
   * The timer body: while online, re-queue due failures into one drain.
   * Offline at fire time → parked (the next reconnect re-runs the pass);
   * mid-drain → re-check shortly after the in-flight syncNow settles (its
   * finally re-arms for any new failures anyway).
   */
  function run(): void {
    timer = null
    const s = host.getState()
    if (!s.online) return
    if (s.syncing) {
      timer = setTimeout(run, 1_000)
      return
    }
    if (requeueDue() > 0) void host.syncNow()
    arm()
  }

  return { clear, arm, requeueDue }
}
