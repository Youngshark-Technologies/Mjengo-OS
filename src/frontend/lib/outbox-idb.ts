// Offline-outbox persistence medium — indexedDB (issue #351).
//
// WHY THE MOVE: the outbox (and the whole owner-store snapshot it rides in)
// used to persist through localStorage — invisible to the service worker.
// Background Sync (#193) could therefore only ASK an open tab to drain; with
// the app closed, queued mutations sat until the next app open ("closed-app
// defers honestly", the documented limit). indexedDB is readable from BOTH
// the page and the SW on the same origin, so the 'mjengoos-outbox' sync tag
// can now drain headless-safe queued items with NO tab open (see
// sw-handlers.ts + public/sw.js for the drain policy — money/session-bound
// kinds still refuse honestly).
//
// THE SEAM (deliberately small, no dependencies — plain indexedDB API):
//   · `OutboxKvStore` — get/put/delete over string records. EVERYTHING above
//     this interface is medium-agnostic: the zustand `createJSONStorage`
//     adapter (the #192 seam the store already used), the guarded wrapper
//     (lib/guarded-storage.ts) and the SW drain logic all speak kv, so
//     jsdom (no indexedDB) runs the SAME semantics against the in-memory
//     implementation (`createInMemoryKvStore`) instead of a browser-API mock.
//   · `createIndexedDbKvStore` — the real implementation. Opens lazily on
//     first use (never at module scope, so importing the module in node/SSR
//     stays inert), caches the open database handle, and drops the cache on
//     any failure so a transient private-mode refusal retries next write.
//   · `createIndexedDbStateStorage` — the StateStorage adapter the store
//     wires through createJSONStorage: ordered get/set/remove against the
//     kv plus the READ-THROUGH LEGACY ADOPTION below.
//
// LEGACY ADOPTION (localStorage → indexedDB, first run): when the kv has no
// record for the key yet but the legacy localStorage key exists, getItem
// returns the legacy snapshot AS-IS and records the pending adoption. The
// legacy snapshot's persisted version (v1) is older than the store's (v2),
// so zustand runs `migrate` and re-writes the merged state through setItem —
// and THAT successful write is what clears the legacy key (never before: if
// the write fails, the legacy key stays as the on-disk fallback — no silent
// data loss). Both steps log. The service worker cannot read localStorage,
// so adoption is app-side only; until the first post-upgrade app open, the
// SW honestly drains nothing (the queue is still safe in localStorage).
//
// ORDERING: every operation runs through a serialized per-adapter promise
// chain. indexedDB transactions would serialize the writes anyway, but the
// chain additionally guarantees the adoption read completes before any early
// pre-hydration write, so an eager setState can never slip a defaults-only
// snapshot between the adoption and the store's merge.

import type { StateStorage } from 'zustand/middleware'

/** One indexedDB database for the outbox mediums, version-independent of app releases. */
export const OUTBOX_DB_NAME = 'mjengoos-outbox'
export const OUTBOX_DB_VERSION = 1
/** The single object store: string records keyed by the persist name. */
export const OUTBOX_DB_STORE = 'kv'

/**
 * The small async persistence seam (issue #351's sanctioned boundary): string
 * records in, string records out. The real implementation is indexedDB; the
 * in-memory implementation backs the unit tests (jsdom has no indexedDB).
 */
export interface OutboxKvStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Wrap a plain indexedDB request in a promise (the entire raw-API surface used). */
function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
  })
}

/**
 * The REAL kv implementation — plain indexedDB API, no dependencies.
 *
 * Never touches `indexedDB` at module scope: the open is lazy (first
 * operation) so importing this module in node/SSR is inert, exactly like the
 * localStorage seam it replaces. A failed open or a failed operation clears
 * the cached handle so the next operation retries the open instead of being
 * poisoned by one rejection (private-mode refusals are often transient).
 */
export function createIndexedDbKvStore(): OutboxKvStore {
  let openPromise: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    if (openPromise) return openPromise
    openPromise = (async () => {
      if (typeof indexedDB === 'undefined') throw new Error('indexedDB unavailable')
      const request = indexedDB.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(OUTBOX_DB_STORE)) db.createObjectStore(OUTBOX_DB_STORE)
      }
      try {
        return await requestAsPromise(request)
      } catch (e) {
        openPromise = null // do not cache a rejection — the next op re-opens
        throw e
      }
    })()
    return openPromise
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open()
    try {
      return await requestAsPromise(run(db.transaction(OUTBOX_DB_STORE, mode).objectStore(OUTBOX_DB_STORE)))
    } catch (e) {
      openPromise = null // a closed/invalidated handle — re-open next op
      throw e
    }
  }

  return {
    get: (key) => withStore('readonly', (store) => store.get(key) as IDBRequest<string | undefined>).then((v) => v ?? null),
    put: (key, value) => withStore('readwrite', (store) => store.put(value, key)).then(() => undefined),
    delete: (key) => withStore('readwrite', (store) => store.delete(key)).then(() => undefined),
  }
}

/**
 * The in-memory kv implementation for tests (jsdom has no indexedDB — the
 * sanctioned seam from #351): same semantics as the real one, plus the quota
 * knobs the #192/#337 fake-localStorage suites used (hard refusal, or a
 * byte boundary the test can place between a full and a slimmed write).
 */
export interface InMemoryOutboxKvStore extends OutboxKvStore {
  /** The backing records — read it in tests to assert what reached "disk". */
  readonly records: Map<string, string>
  /** Hard refusal on every put (private-mode shape). */
  quotaExceeded: boolean
  /** Value-length boundary; a put above it refuses (quota shape). */
  quotaBytes: number
}

export function createInMemoryKvStore(): InMemoryOutboxKvStore {
  const records = new Map<string, string>()
  const store: InMemoryOutboxKvStore = {
    records,
    quotaExceeded: false,
    quotaBytes: Number.POSITIVE_INFINITY,
    async get(key) {
      return records.has(key) ? (records.get(key) as string) : null
    },
    async put(key, value) {
      if (this.quotaExceeded || value.length > this.quotaBytes) {
        const e = new Error('mock quota exceeded')
        e.name = 'QuotaExceededError'
        throw e
      }
      records.set(key, value)
    },
    async delete(key) {
      records.delete(key)
    },
  }
  return store
}

/** The legacy medium an adoption can read from (localStorage behind a guard). */
export interface LegacyStorage {
  get(name: string): string | null
  remove(name: string): void
}

/** localStorage as a LegacyStorage, absent-safe for node/SSR. */
export const legacyLocalStorage: LegacyStorage | null =
  typeof localStorage === 'undefined'
    ? null
    : {
        get: (name) => {
          try {
            return localStorage.getItem(name)
          } catch {
            return null // a refused read (security software) reads as absent
          }
        },
        remove: (name) => {
          try {
            localStorage.removeItem(name)
          } catch {
            // A refused removal keeps the legacy fallback around — harmless.
          }
        },
      }

/**
 * The StateStorage adapter the owner store wires through zustand's
 * `createJSONStorage` (the SAME public seam the localStorage medium used):
 * ordered kv operations + the read-through legacy adoption. Guarded-write
 * semantics (quota catch, queue-only fallback, degradation surfacing) live in
 * lib/guarded-storage.ts, which WRAPS this adapter — separation of medium
 * and policy, so the supplier surface (#352) can reuse the policy on its own
 * localStorage medium.
 */
export function createIndexedDbStateStorage(
  kv: OutboxKvStore,
  legacy: LegacyStorage | null = legacyLocalStorage,
): StateStorage {
  // Serialized operations (see the ORDERING note atop this module).
  let chain: Promise<unknown> = Promise.resolve()
  function ordered<T>(op: () => Promise<T>): Promise<T> {
    const next = chain.then(op, op)
    chain = next.catch(() => undefined)
    return next
  }

  /** Keys whose legacy snapshot was handed to a hydrating store but not yet re-written. */
  const pendingAdoptions = new Set<string>()

  return {
    getItem: (name) =>
      ordered(async () => {
        const current = await kv.get(name)
        if (current !== null) return current
        if (!legacy) return null
        const legacyValue = legacy.get(name)
        if (legacyValue === null) return null
        // READ-THROUGH ADOPTION: hand the legacy snapshot to the hydrating
        // store verbatim. Its persisted version is older than the store's,
        // so zustand migrates AND re-writes the merged state through setItem
        // below — that successful write clears the legacy key. If the store
        // never writes (corrupt legacy snapshot → hydrate fails → degraded
        // banner, exactly the pre-#351 corrupt-key posture), the legacy key
        // survives as the on-disk record: nothing is lost silently.
        pendingAdoptions.add(name)
        console.info(
          `[${name}] adopting the legacy localStorage outbox snapshot into indexedDB (issue #351)`,
        )
        return legacyValue
      }),

    setItem: (name, value) =>
      ordered(async () => {
        await kv.put(name, value)
        if (pendingAdoptions.delete(name) && legacy) {
          // The migrated snapshot is safely in indexedDB — the legacy key's
          // job is done. Only ever cleared AFTER a successful write.
          legacy.remove(name)
          console.info(`[${name}] legacy localStorage key cleared after the indexedDB write landed (issue #351)`)
        }
      }),

    removeItem: (name) =>
      ordered(async () => {
        pendingAdoptions.delete(name)
        await kv.delete(name)
      }),
  }
}
