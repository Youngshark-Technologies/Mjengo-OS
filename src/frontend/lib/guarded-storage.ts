// Guarded persistence adapter factory — the #192 contract, parameterized
// per surface (extracted for #351/#352 so the owner app and the supplier
// portal run the IDENTICAL write-failure discipline against their OWN media
// and keys; the #192/#337 original lived inline in use-mjengo.ts).
//
// THE CONTRACT (unchanged from #192, now async-capable — media may be
// localStorage OR the #351 indexedDB bridge):
//   · every write failure is CAUGHT — the triggering action never sees the
//     exception; the in-memory store remains the source of truth;
//   · a quota failure retries ONCE with the surface's droppable slice
//     dropped (queue-only fallback): the mutation queue is the only part of
//     the payload that is NOT re-derivable, so a full device still banks the
//     user's work. The owner drops `data` (re-fetchable from /api/project);
//     the supplier drops `syncHistory` (capped, inspection-only retention);
//   · the outcome is REPORTED through `onHealth` — the store flips its
//     non-persisted persistDegraded/persistQueueOnly flags → the app-level
//     amber/red banner. Degradation is LOUD, never silent;
//   · a later successful FULL write self-heals (reports 'ok' again).
//
// Re-entrancy note: with the async-capable media the health report lands in
// a microtask AFTER the triggering setState returned, so the flag-flip's own
// persist write cannot re-enter this adapter synchronously; the report
// transitions still converge (a report equal to the current flags is a
// no-op at the sink, and alternating outcomes settle because the medium's
// own failure is what reports failure). The #192 synchronous depth guard
// stays in the surface's sink for belt-and-braces.

import type { StateStorage } from 'zustand/middleware'

/** The adapter's write outcome — 'ok' | 'queue-only' (fallback banked the queue) | 'degraded' (nothing reached disk). */
export type PersistHealth = 'ok' | 'queue-only' | 'degraded'

/** The raw-medium subset the guarded wrapper needs (localStorage or the #351 indexedDB bridge). */
export type RawStateStorage = Pick<StateStorage, 'getItem' | 'setItem' | 'removeItem'>

export interface GuardedStorageOptions {
  /** Identifies the surface in the degradation console.error (its persisted key). */
  label: string
  /** The raw medium adapter. Its setItem may be sync or promise-returning; either failure mode is caught. */
  storage: RawStateStorage
  /**
   * The persisted-state slice the queue-only fallback retries WITHOUT — the
   * re-derivable, least-irreplaceable slice for this surface ('data' for the
   * owner store, 'syncHistory' for the supplier store).
   */
  droppableSlice: string
  /** Health outcomes surface here — the surface flips its persistDegraded/persistQueueOnly flags. */
  onHealth: (health: PersistHealth) => void
}

/**
 * Wrap a raw medium in the #192 guarded-write discipline. The returned
 * adapter's setItem NEVER rejects (persist floats it inside every setState;
 * an escaping rejection would be an unhandled promise rejection instead of
 * a surfaced banner).
 */
export function createGuardedStorage(options: GuardedStorageOptions): StateStorage {
  const { label, storage, droppableSlice, onHealth } = options

  async function writeGuarded(name: string, value: string): Promise<void> {
    try {
      await storage.setItem(name, value)
      onHealth('ok')
      return
    } catch (e) {
      // QuotaExceededError / private-mode refusal / an indexedDB failure
      // (the #351 medium). NEVER rethrow: this runs inside every setState,
      // so an escaping exception would break the action that called set() —
      // the exact silent-loss failure mode #192 exists to fix.
      console.error(`[${label}] persistence write failed — surfacing degradation`, e)
    }
    // Queue-only fallback (the #192 bounding decision, per-surface): drop
    // the droppable slice and retry once, so the irreplaceable part (the
    // queued mutations + their §41 conflict state) still reaches disk.
    try {
      const parsed = JSON.parse(value) as { state?: Record<string, unknown> }
      if (parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object') {
        await storage.setItem(name, JSON.stringify({ ...parsed, state: { ...parsed.state, [droppableSlice]: null } }))
        onHealth('queue-only')
      } else {
        // Not the shape we know how to slim (should never happen — the
        // value is always createJSONStorage's { state, version }).
        onHealth('degraded')
      }
    } catch {
      // Even the slimmed write does not fit (hard quota / private mode):
      // nothing reaches disk — the loud banner is the only honest signal.
      onHealth('degraded')
    }
  }

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => writeGuarded(name, value),
    removeItem: (name) => {
      // A failing removal never loses data the app still holds in memory.
      void Promise.resolve(storage.removeItem(name)).catch(() => undefined)
    },
  }
}

/**
 * #337 cross-tab rehydrate decision, parameterized by the surface's key:
 * only writes to OUR key rehydrate (a `storage` event fires for every
 * same-origin localStorage key). `key === null` is a clear() from another
 * surface — deliberately NOT ours to react to (the surface keeps working
 * from memory and its next write re-creates the key).
 */
export function shouldRehydrateFromStorageEventFor(key: string, e: { key: string | null }): boolean {
  return e.key === key
}
