/**
 * #352 — supplier-outbox persistence hardening, pinned behaviorally on the
 * REAL use-supplier-outbox store running against a FAKE localStorage (the
 * zustand `createJSONStorage` seam is what production uses — the store
 * module is imported dynamically AFTER the global is stubbed so the guarded
 * adapter actually engages; in plain node the same typeof guard keeps the
 * adapter inert, byte-identical to the pre-#352 default storage).
 *
 * This is the #337 suite's coverage, mirrored for the SUPPLIER surface (the
 * last unguarded surface — the owner store got the contract in #192/#337
 * and the extracted per-surface factory in #351):
 *   · a QuotaExceededError on the medium used to propagate straight out of
 *     set() (persist floats storage.setItem inside every setState): the
 *     running dispatch broke, the in-memory queue kept accepting, and every
 *     queued supplier action sat silently one tab-close from loss. Pinned
 *     now: the adapter CATCHES it, the dispatch completes fully, and the
 *     persistDegraded flag flips (the supplier portal banner's source);
 *   · the queue-only fallback: when the full write does not fit but a
 *     history-less one does, the irreplaceable part (the queued mutations)
 *     still banks — `syncHistory` is the capped inspection-only retention
 *     of ALREADY-SYNCED items (this surface's droppable slice; the owner
 *     drops its re-fetchable `data` instead);
 *   · recovery: a later successful full write self-heals the flags;
 *   · a reload AFTER a queue-only write rehydrates the queue intact and
 *     normalises the dropped slice (null → []);
 *   · a corrupt key is a hydration DEGRADATION (the onRehydrateStorage
 *     error arm), never a crash — the queue still works in memory;
 *   · multi-tab: a `storage` event on OUR key rehydrates this surface
 *     (debounced last-writer-wins — this surface STAYS on localStorage, so
 *     the #337 mechanism applies verbatim; the owner moved to indexedDB
 *     and re-reads on foreground, #351), and an orphaned 'syncing' item
 *     from a mid-drain snapshot returns to 'pending' instead of stranding;
 *   · restart: offline-queued items are on disk and a rehydrate restores
 *     them drainable;
 *   · wiring source pins (the portal banner, the guarded adapter, the
 *     storage listener, the non-persisted health flags) + EN/SW dictionary
 *     parity for the two new banner keys.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'
import type { OutboxItem } from '@/frontend/hooks/use-supplier-outbox'

// ---------------- the fake localStorage (quota-aware, the #337 double) ----------------

/** What the browser gives us: getItem/removeItem + a setItem that can throw. */
class FakeLocalStorage {
  store = new Map<string, string>()
  /** Hard quota / private mode: every write throws. */
  quotaExceeded = false
  /** Soft quota boundary: writes LONGER than this throw (bytes ≈ chars). */
  quotaBytes = Number.POSITIVE_INFINITY
  /** Security software: every READ throws (the medium is blind, not just full). */
  readRefused = false

  getItem(k: string): string | null {
    if (this.readRefused) {
      throw new Error('localStorage read refused')
    }
    return this.store.has(k) ? this.store.get(k)! : null
  }
  setItem(k: string, v: string): void {
    if (this.quotaExceeded || v.length > this.quotaBytes) {
      const e = new Error('mock quota exceeded')
      e.name = 'QuotaExceededError'
      throw e
    }
    this.store.set(k, String(v))
  }
  removeItem(k: string): void {
    this.store.delete(k)
  }
}

const fake = new FakeLocalStorage()

// The store must be created AFTER the stub exists: the #352 adapter's
// typeof guard decides at persist() creation whether storage is real.
vi.stubGlobal('localStorage', fake)

const {
  useSupplierOutbox,
  SUPPLIER_OUTBOX_KEY,
  shouldRehydrateFromSupplierStorageEvent,
  handleSupplierCrossTabStorageEvent,
  SUPPLIER_CROSS_TAB_REHYDRATE_DEBOUNCE_MS,
} = await import('@/frontend/hooks/use-supplier-outbox')

// ---------------- helpers (outbox-persistence conventions) ----------------

/** A queued SUPPLIER action in the §40 'pending' state. */
function queuedItem(n: number, labelPad = 0): OutboxItem {
  return {
    id: `sq-${n}`,
    type: 'quote.receive',
    payload: { id: `quote-${n}`, unitPrice: 120 },
    label: `Quote submitted: RFQ-100${n}${'x'.repeat(labelPad)}`,
    createdAt: Date.now(),
    projectId: 'proj-1',
    syncStatus: 'pending',
    retryCount: 0,
  }
}

/**
 * Reset the store to a clean slate (the pre-#352 tests' resetSupplier, with
 * the health flags explicit). The reset's own persist write settles in the
 * flush below, so quota-boundary tests start from a known on-disk baseline.
 */
function resetStore(overrides: Record<string, unknown> = {}) {
  useSupplierOutbox.setState({
    online: true,
    syncing: false,
    outbox: [],
    syncHistory: [],
    lastSyncAt: null,
    dataVersion: 0,
    persistDegraded: false,
    persistQueueOnly: false,
    ...overrides,
  } as never)
}

const state = () => useSupplierOutbox.getState()
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const persisted = () => JSON.parse(fake.getItem(SUPPLIER_OUTBOX_KEY)!) as {
  state: { outbox: OutboxItem[]; syncHistory: OutboxItem[] | null } & Record<string, unknown>
  version?: number
}
/**
 * Settle the guarded write chain: the fallback retry and the health-flag
 * flip (which is itself a setState → one more guarded write, whose report
 * is a no-op at the sink) all run as microtasks after the triggering
 * action returned; the TDZ-deferred first report rides a macrotask. Two
 * macrotask rounds cover the deepest chain.
 */
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
/** One macrotask — enough for a fresh module's hydration to finish. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** Real-time sleep — the debounce tests deliberately avoid fake timers (an aborted fake-timer test would leave the setTimeout stub installed and poison every later hook). */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Offline dispatch of one supplier action (the offline→queue branch). */
async function enqueueQuote(): Promise<'queued'> {
  return state().dispatch(
    'quote.receive',
    { id: 'quote-1', unitPrice: 120, deliveryFee: 500 },
    'proj-1',
    'Quote submitted: RFQ-1001',
  )
}

// Captured BEFORE any test stubs it — afterEach restores fetch to THIS so
// per-test fetch doubles never leak (the localStorage stub must stay: the
// store module was created against it).
const originalFetch = globalThis.fetch

beforeEach(async () => {
  vi.clearAllMocks()
  // A clean device before every scenario: quota off, boundary at infinity.
  fake.quotaExceeded = false
  fake.quotaBytes = Number.POSITIVE_INFINITY
  fake.store.clear()
  resetStore()
  await flush()
})

afterEach(() => {
  vi.useRealTimers() // safety net: an aborted fake-timer test must not poison later hooks
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', originalFetch)
})

// ---------------- quota / private-mode write failures ----------------

describe('#352: a failing medium write is caught, the dispatch survives, degradation is LOUD', () => {
  it('offline dispatch under a hard quota never throws, still queues optimistically, and flips persistDegraded', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    resetStore({ online: false, outbox: [] })
    await flush()
    fake.quotaExceeded = true

    // Before #352 this rejected: persist floats storage.setItem inside
    // set(), so the QuotaExceededError broke the dispatch mid-flight.
    await expect(enqueueQuote()).resolves.toBe('queued')

    expect(state().outbox).toHaveLength(1) // queued in memory (the source of truth)
    expect(state().outbox[0].syncStatus).toBe('pending')
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'field.savedQueued', { count: 1 }))
    // Degradation is LOUD: the red-banner flag + the console seam.
    expect(state().persistDegraded).toBe(true)
    expect(state().persistQueueOnly).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('persistence write failed'), expect.any(Error))
    // And nothing new reached the medium — it is still the last good write.
    expect(persisted().state.outbox).toHaveLength(0)
  })

  it('the online-when-network-lies branch completes fully under quota (queued toast fires — the dispatch ran to the end)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetStore({ online: true, outbox: [] })
    await flush()
    fake.quotaExceeded = true
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    await expect(enqueueQuote()).resolves.toBe('queued')
    await flush()

    expect(state().outbox).toHaveLength(1)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'field.savedQueued', { count: 1 }))
    expect(state().persistDegraded).toBe(true)
  })

  it('private-mode hard failure keeps the in-memory store fully functional across many writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.quotaExceeded = true

    for (let i = 0; i < 5; i++) {
      useSupplierOutbox.setState({ outbox: [...state().outbox, queuedItem(100 + i)] } as never)
    }
    await flush()
    expect(state().outbox).toHaveLength(5)
    expect(state().persistDegraded).toBe(true)
    expect(state().persistQueueOnly).toBe(false)
    // Nothing NEW reached disk — the key still holds the LAST GOOD
    // snapshot (empty, from the pre-quota baseline write), which is exactly
    // what the banner announces: work after that point is memory-only.
    expect(fake.getItem(SUPPLIER_OUTBOX_KEY)).not.toBeNull()
    expect(persisted().state.outbox).toHaveLength(0)
  })

  it('a corrupt key never crashes the boot — the store runs from memory and the first successful write HEALS the snapshot', async () => {
    // A key the JSON seam cannot parse (a half-written snapshot after a
    // hard power cut, or security software mangling the value). The honest
    // semantics of the health flags: they report the MEDIUM's write
    // health — the lost snapshot is gone either way, and this medium
    // still writes, so the first successful write replaces the garbage
    // with a fresh valid snapshot (self-heal, the same transition every
    // successful write reports 'ok' through).
    vi.resetModules()
    fake.store.set(SUPPLIER_OUTBOX_KEY, '{not json')
    const { useSupplierOutbox: fresh } = await import('@/frontend/hooks/use-supplier-outbox')
    await tick()
    await tick()

    // The store initialised (hydration failed → defaults) and dispatches.
    fresh.setState({ online: false, outbox: [] } as never)
    await expect(
      fresh.getState().dispatch('quote.receive', { id: 'q-9', unitPrice: 1 }, 'proj-1', 'Quote: RFQ-9'),
    ).resolves.toBe('queued')
    await flush()
    expect(fresh.getState().outbox).toHaveLength(1) // the queue lives in memory
    // The garbage was REPLACED by a valid snapshot carrying the queue —
    // the next reload hydrates cleanly.
    expect(() => JSON.parse(fake.getItem(SUPPLIER_OUTBOX_KEY)!)).not.toThrow()
    expect(persisted().state.outbox).toHaveLength(1)
    // And the flags settled back to healthy (the medium writes fine).
    expect(fresh.getState().persistDegraded).toBe(false)
  })

  it('a medium that refuses reads AND writes (security software / private mode) surfaces a STICKY degradation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
    fake.readRefused = true
    fake.quotaExceeded = true
    const { useSupplierOutbox: fresh } = await import('@/frontend/hooks/use-supplier-outbox')
    await tick()
    await tick()

    // The hydration error arm fired AND every write fails — the red banner
    // STAYS (no self-heal: the medium refuses both directions).
    expect(fresh.getState().persistDegraded).toBe(true)
    fresh.setState({ online: false, outbox: [] } as never)
    await expect(
      fresh.getState().dispatch('quote.receive', { id: 'q-9', unitPrice: 1 }, 'proj-1', 'Quote: RFQ-9'),
    ).resolves.toBe('queued')
    await flush()
    expect(fresh.getState().outbox).toHaveLength(1) // in-memory queue functional
    expect(fresh.getState().persistDegraded).toBe(true) // still loud
    fake.readRefused = false
  })
})

// ---------------- the queue-only fallback (the bounding decision's teeth) ----------------

describe('#352: the queue-only fallback banks the irreplaceable part', () => {
  it('when the full write does not fit but a history-less one does, the queue reaches disk without syncHistory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Baseline: a successful FULL write so we can place the quota boundary
    // BETWEEN the full and the slimmed serialized sizes. The history (the
    // capped inspection-only retention of ALREADY-SYNCED items) is this
    // surface's droppable slice — big enough to dominate the payload.
    resetStore({ outbox: [queuedItem(1)], syncHistory: Array.from({ length: 50 }, (_, i) => queuedItem(500 + i, 150)) })
    await flush()
    const full = fake.getItem(SUPPLIER_OUTBOX_KEY)!
    const slim = JSON.stringify({ ...JSON.parse(full), state: { ...JSON.parse(full).state, syncHistory: null } })
    expect(full.length).toBeGreaterThan(slim.length + 1_000) // the history genuinely dominates
    fake.quotaBytes = slim.length + Math.floor((full.length - slim.length) / 2)

    // One more queued action under the boundary → full write throws, the
    // fallback (syncHistory dropped) fits.
    await enqueueQuote()
    await flush()

    expect(state().outbox).toHaveLength(2)
    expect(state().persistQueueOnly).toBe(true)
    expect(state().persistDegraded).toBe(false) // the fallback banked the queue — amber, not red
    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(2) // the irreplaceable part banked
    expect(onDisk.state.syncHistory).toBeNull() // the inspection-only retention dropped
  })

  it('a later successful FULL write self-heals the flags (the banner clears)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.quotaExceeded = true
    useSupplierOutbox.setState({ online: true } as never)
    await flush()
    expect(state().persistDegraded).toBe(true)

    // Storage freed up (or the private window ended).
    fake.quotaExceeded = false
    fake.quotaBytes = Number.POSITIVE_INFINITY
    useSupplierOutbox.setState({ online: false } as never)
    await flush()

    expect(state().persistDegraded).toBe(false)
    expect(state().persistQueueOnly).toBe(false)
    expect(persisted().state.syncHistory).not.toBeNull() // the full payload is back on disk
  })

  it('a reload AFTER a queue-only write rehydrates the queue intact and normalises the dropped slice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A queue-only-shaped key on disk: the queue banked, history dropped.
    fake.store.set(SUPPLIER_OUTBOX_KEY, JSON.stringify({
      state: {
        online: false,
        outbox: [queuedItem(1), queuedItem(2)],
        syncHistory: null,
        lastSyncAt: 123,
      },
      version: 1,
    }))

    vi.resetModules()
    const { useSupplierOutbox: reloaded } = await import('@/frontend/hooks/use-supplier-outbox')
    await tick()
    await tick()

    // The queue survived (the whole point of the fallback)…
    expect(reloaded.getState().outbox).toHaveLength(2)
    expect(reloaded.getState().outbox.every((o) => o.syncStatus === 'pending')).toBe(true)
    // …and the dropped slice reads back as an empty array (migrate
    // normalises the null), never a crash on .map.
    expect(reloaded.getState().syncHistory).toEqual([])
  })
})

// ---------------- restart durability ----------------

describe('#352: restart durability — the guarded adapter never changes WHAT persists', () => {
  it('offline-queued items are on disk and a rehydrate restores them drainable', async () => {
    resetStore({ online: false, outbox: [] })
    await flush()
    await enqueueQuote()
    await flush()

    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(1)
    expect(onDisk.version).toBe(1)
    expect(onDisk.state.online).toBe(false) // the queue does not drain itself on reload

    // The relaunch: memory empty, key intact → rehydrate → queue restored.
    const bytes = fake.getItem(SUPPLIER_OUTBOX_KEY)!
    useSupplierOutbox.setState({ outbox: [] } as never)
    await flush() // the memory-reset's own (empty) write settles FIRST…
    fake.store.set(SUPPLIER_OUTBOX_KEY, bytes) // …then the app died AFTER this write
    await useSupplierOutbox.persist.rehydrate()

    expect(state().outbox).toHaveLength(1)
    expect(state().outbox[0].syncStatus).toBe('pending') // drainable
  })

  it("the health flags are deliberately NOT persisted — they are this tab's live read of the medium", () => {
    const src = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    // The #352 mirror of the owner's partialize decision pin: the flags
    // ride the STORE but never the SNAPSHOT (a reload re-derives them from
    // the first write's outcome instead of inheriting a stale banner).
    expect(src).toContain('partialize: (s) => ({')
    expect(src).not.toMatch(/partialize[^]*persistDegraded/)
  })
})

// ---------------- multi-tab coordination (the #337 storage-event mechanism) ----------------

describe('#352: cross-tab rehydration (debounced last-writer-wins)', () => {
  it('shouldRehydrateFromSupplierStorageEvent: only OUR key rehydrates (null key = a clear — deliberately ignored)', () => {
    expect(shouldRehydrateFromSupplierStorageEvent({ key: SUPPLIER_OUTBOX_KEY })).toBe(true)
    expect(shouldRehydrateFromSupplierStorageEvent({ key: 'mjengo-os-store' })).toBe(false) // the OWNER key is not ours
    expect(shouldRehydrateFromSupplierStorageEvent({ key: 'unrelated-key' })).toBe(false)
    expect(shouldRehydrateFromSupplierStorageEvent({ key: null })).toBe(false)
  })

  it('a storage event on our key rehydrates after the debounce; foreign keys schedule nothing', async () => {
    const rehydrateSpy = vi.spyOn(useSupplierOutbox.persist, 'rehydrate')
    resetStore({ outbox: [queuedItem(1)] })
    await flush()
    const before = state().outbox.length

    // The OTHER surface (PWA window vs browser tab) writes a newer
    // snapshot: one extra queued action. Direct map write — same-surface
    // writes never fire their own storage event.
    fake.store.set(SUPPLIER_OUTBOX_KEY, JSON.stringify({
      state: { online: true, outbox: [queuedItem(1), queuedItem(2)], syncHistory: [], lastSyncAt: 456 },
      version: 1,
    }))

    handleSupplierCrossTabStorageEvent({ key: 'unrelated-key' })
    handleSupplierCrossTabStorageEvent({ key: null })
    await sleep(SUPPLIER_CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)
    expect(state().outbox).toHaveLength(before) // foreign keys: still our snapshot
    expect(rehydrateSpy).not.toHaveBeenCalled()

    handleSupplierCrossTabStorageEvent({ key: SUPPLIER_OUTBOX_KEY })
    expect(state().outbox).toHaveLength(before) // debounced: not yet
    await sleep(SUPPLIER_CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)
    expect(rehydrateSpy).toHaveBeenCalledTimes(1)
    expect(state().outbox).toHaveLength(before + 1) // the peer's newer queue is ours now
    rehydrateSpy.mockRestore()
  })

  it('bursts of writes from an active peer coalesce into ONE rehydrate', async () => {
    const rehydrateSpy = vi.spyOn(useSupplierOutbox.persist, 'rehydrate')
    resetStore({ outbox: [queuedItem(1)] })
    await flush()

    handleSupplierCrossTabStorageEvent({ key: SUPPLIER_OUTBOX_KEY })
    handleSupplierCrossTabStorageEvent({ key: SUPPLIER_OUTBOX_KEY })
    handleSupplierCrossTabStorageEvent({ key: SUPPLIER_OUTBOX_KEY })
    await sleep(SUPPLIER_CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)

    expect(rehydrateSpy).toHaveBeenCalledTimes(1)
    rehydrateSpy.mockRestore()
  })

  it('an orphaned syncing item from a peer mid-drain snapshot returns to pending (un-stranded, drainable)', async () => {
    resetStore({ outbox: [queuedItem(1)] })
    await flush()
    // A snapshot written while the OTHER surface was mid-drain: the item
    // is 'syncing' on disk, but no drain owns it here. syncNow only drains
    // 'pending' — without the orphan normalization it would strand forever
    // showing "Syncing…".
    fake.store.set(SUPPLIER_OUTBOX_KEY, JSON.stringify({
      state: {
        online: true,
        outbox: [queuedItem(1), { ...queuedItem(9), syncStatus: 'syncing' }],
        syncHistory: [],
        lastSyncAt: 789,
      },
      version: 1,
    }))

    handleSupplierCrossTabStorageEvent({ key: SUPPLIER_OUTBOX_KEY })
    // The debounce (250ms) plus the deferred orphan-normalization tick
    // (0ms after the merge) both settle well inside this sleep — the
    // assertion is the OUTCOME: the orphan is back to drainable 'pending'.
    await sleep(SUPPLIER_CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)

    expect(state().outbox).toHaveLength(2)
    expect(state().outbox.find((o) => o.id === 'sq-9')?.syncStatus).toBe('pending')
  })
})

// ---------------- wiring + copy (source pins, house style) ----------------

describe('#352: wiring — the degradation is reachable end to end on the supplier surface', () => {
  it('the supplier portal renders the persistence banner from the health flags', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-portal.tsx')
    expect(src).toContain('const persistDegraded = useSupplierOutbox((s) => s.persistDegraded)')
    expect(src).toContain('const persistQueueOnly = useSupplierOutbox((s) => s.persistQueueOnly)')
    expect(src).toContain('(persistDegraded || persistQueueOnly) && (')
    expect(src).toContain("t('supplier.persist.degraded')")
    expect(src).toContain("t('supplier.persist.queueOnly')")
    expect(src).toContain("role={persistDegraded ? 'alert' : 'status'}")
  })

  it('use-supplier-outbox wires the guarded adapter on its own key and the storage-event listener', () => {
    const src = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    // The guarded seam (quota caught at the zustand storage adapter), on
    // THIS surface's own key, with syncHistory as the fallback's drop.
    expect(src).toContain('const guardedSupplierStorage = createGuardedStorage({')
    expect(src).toContain('label: SUPPLIER_OUTBOX_KEY')
    expect(src).toContain("droppableSlice: 'syncHistory'")
    // The medium guard keeps node/SSR inert (no phantom localStorage).
    expect(src).toContain("if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable')")
    // Multi-tab: the storage event rehydrates (debounced) — this surface
    // STAYS on localStorage, so the #337 mechanism applies verbatim.
    expect(src).toContain("window.addEventListener('storage', handleSupplierCrossTabStorageEvent)")
    expect(src).toContain('void useSupplierOutbox.persist.rehydrate()')
    // The orphan normalization is wired at the rehydrate seam.
    expect(src).toMatch(/orphaned[^]*syncStatus === 'syncing' \? \{ \.\.\.o, syncStatus: 'pending' as const \} : o/)
  })

  it('the guarded factory is the SAME extracted policy the owner store runs (#351 extraction, no fork)', () => {
    const supplierSrc = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    const ownerSrc = readSrc('src/frontend/hooks/use-mjengo.ts')
    const factorySrc = readSrc('src/frontend/lib/guarded-storage.ts')
    expect(supplierSrc).toContain("from '@/frontend/lib/guarded-storage'")
    expect(ownerSrc).toContain("from '@/frontend/lib/guarded-storage'")
    // The factory owns the contract's teeth (the queue-only retry with the
    // droppable slice dropped) — pinned once here so neither surface's
    // wiring can silently drift from it.
    expect(factorySrc).toContain('onHealth(\'queue-only\')')
    expect(factorySrc).toContain('onHealth(\'degraded\')')
  })

  it('every new user-facing key exists in BOTH dictionaries (compile parity + runtime)', () => {
    const keys = ['supplier.persist.degraded', 'supplier.persist.queueOnly'] as const
    const enKeys = new Set(Object.keys(enDict))
    const swKeys = new Set(Object.keys(swDict))
    for (const key of keys) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
    // Both sides interpolate through the real translate().
    expect(translate(enDict, 'supplier.persist.queueOnly')).toContain('queued actions are still saved')
    expect(translate(swDict, 'supplier.persist.degraded')).toContain('hifadhi ya kifaa hiki imejaa')
  })
})
