/**
 * #128 — the SUPPLIER outbox lifecycle, pinned behaviorally on the REAL
 * use-supplier-outbox store (same conventions as outbox-auth-drain.test.ts /
 * outbox-auto-retry.test.ts: sonner mocked, global fetch stubbed, the zustand
 * store imported real — persist is inert in node). The persistence-across-
 * reload arm stubs a localStorage double and re-imports the module fresh
 * (vi.resetModules) so a second store instance rehydrates from storage.
 *
 * The parity contract with the owner app, pinned here:
 *   · dispatch offline (or when the network drops mid-send) → QUEUES a
 *     persisted pending item carrying type/payload/label/projectId and
 *     answers 'queued' — never a lost action;
 *   · a server REFUSAL is honest and final ('refused' + the server's message
 *     via the FE-6b toast) — it is NOT queued (an identical payload would
 *     fail again);
 *   · only SUPPLIER_ACTIONS can ever queue (the client mirror of the server
 *     allowlist — a buyer type is refused before it can strand in the queue);
 *   · the drain (setOnline offline→online, drainAfterAuth, retryAll, the
 *     #132 bounded auto-retry schedule) flushes POST /api/sync with per-item
 *     results; synced → history (capped) + dataVersion bump (the portal
 *     re-reads /api/supplier); failed keeps lastError/retryCount; 401 →
 *     auth-blocked (#191); a true network failure re-queues (never drops);
 *   · SESSION SCOPING: the supplier store is a SEPARATE persisted store
 *     (`mjengo-supplier-outbox`, never the owner `mjengo-os-store`) — a
 *     supplier drain never sends owner items and an owner drain never sends
 *     supplier items (both directions pinned);
 *   · a queued item SURVIVES a reload (localStorage double + a fresh module
 *     instance rehydrates it pending), and stale v0 shapes migrate.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import {
  useSupplierOutbox,
  type SupplierSendResult,
} from '@/frontend/hooks/use-supplier-outbox'
import { useMjengo, type OutboxItem } from '@/frontend/hooks/use-mjengo'
import { SUPPLIER_ACTIONS } from '@/shared/supplier-actions'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'

// ---------------- fetch test doubles (outbox-auth-drain conventions) ----------------

interface FakeRes {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const res = (body: unknown, ok = true, status = 200): FakeRes => ({
  ok,
  status,
  json: async () => body,
})

/** A queued SUPPLIER outbox item in the §40 'pending' state (pre-drain shape). */
function queuedItem(n: number): OutboxItem {
  return {
    id: `sq-${n}`,
    type: 'quote.receive',
    payload: { id: `quote-${n}`, unitPrice: 120 },
    label: `Quote submitted: RFQ-100${n}`,
    createdAt: Date.now(),
    projectId: 'proj-1',
    syncStatus: 'pending',
    retryCount: 0,
  }
}

/** An OWNER outbox item — used by the session-scoping pins. */
function ownerItem(n: number): OutboxItem {
  return {
    id: `oq-${n}`,
    type: 'task.update',
    payload: { id: `task-${n}`, progress: 50 },
    label: `Update task ${n}`,
    createdAt: Date.now(),
    projectId: 'proj-1',
    syncStatus: 'pending',
    retryCount: 0,
  }
}

function resetSupplier(overrides: Record<string, unknown> = {}) {
  useSupplierOutbox.setState({
    online: true,
    syncing: false,
    outbox: [],
    syncHistory: [],
    lastSyncAt: null,
    dataVersion: 0,
    ...overrides,
  } as never)
}

const sState = () => useSupplierOutbox.getState()
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  resetSupplier()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------- dispatch — offline-first ----------------

describe('#128: dispatch queues offline and never drops', () => {
  it('offline → queues a pending item carrying type/payload/label/projectId, answers queued, toasts — no fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    resetSupplier({ online: false })

    const result: SupplierSendResult = await sState().dispatch(
      'quote.receive',
      { id: 'quote-1', unitPrice: 120, deliveryFee: 500 },
      'proj-1',
      'Quote submitted: RFQ-1001',
    )

    expect(result).toBe('queued')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sState().outbox).toHaveLength(1)
    const item = sState().outbox[0]
    expect(item).toMatchObject({
      type: 'quote.receive',
      label: 'Quote submitted: RFQ-1001',
      projectId: 'proj-1',
      syncStatus: 'pending',
      retryCount: 0,
    })
    expect(item.payload).toMatchObject({ id: 'quote-1', unitPrice: 120 })
    expect(item.id).toBeTruthy()
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'field.savedQueued', { count: 1 }))
  })

  it('online + network failure → queues exactly like the offline branch (the owner dispatch contract)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    const result = await sState().dispatch(
      'order.confirm',
      { id: 'po-1' },
      'proj-1',
      'order.confirm: PO-2026-000001',
    )

    expect(result).toBe('queued')
    expect(sState().outbox).toHaveLength(1)
    expect(sState().outbox[0].syncStatus).toBe('pending')
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'field.savedQueued', { count: 1 }))
  })

  it('online + server refusal → refused with the honest server message, NOTHING queued', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ ok: false, error: 'Quote is already RECEIVED' }, true, 200)))

    const result = await sState().dispatch('quote.receive', { id: 'quote-1' }, 'proj-1', 'Quote')

    expect(result).toBe('refused')
    expect(sState().outbox).toHaveLength(0)
    expect(toast.error).toHaveBeenCalledTimes(1)
    // The 8s duration is the portal's long-read honest-refusal UX (kept from
    // the original online-only dispatch).
    expect(toast.error).toHaveBeenCalledWith(
      translate(enDict, 'sync.serverRefused', { reason: 'Quote is already RECEIVED' }),
      { duration: 8000 },
    )
  })

  it('online + ok → applied, lastSyncAt stamped, nothing queued (the portal reloads off this)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: true, result: { id: 'quote-1' } })))

    const result = await sState().dispatch('quote.decline', { id: 'quote-1' }, 'proj-1', 'Quote declined: RFQ-1001')

    expect(result).toBe('applied')
    expect(sState().outbox).toHaveLength(0)
    expect(sState().lastSyncAt).not.toBeNull()
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/actions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ type: 'quote.decline', payload: { id: 'quote-1' }, projectId: 'proj-1' }),
    }))
  })

  it('a non-SUPPLIER_ACTIONS type is refused BEFORE it can strand in the queue (client mirror of the server allowlist)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    resetSupplier({ online: false })

    // Every type the supplier cards actually dispatch is allowlisted…
    for (const type of ['quote.receive', 'quote.decline', 'order.confirm', 'order.dispatch', 'catalog.upsert']) {
      expect(SUPPLIER_ACTIONS).toContain(type)
    }
    // …and a buyer type never queues, online or off.
    const result = await sState().dispatch('task.complete', { id: 't-1' }, 'proj-1', 'Complete task')

    expect(result).toBe('refused')
    expect(sState().outbox).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(translate(enDict, 'supplier.outbox.notPermitted'))
  })
})

// ---------------- drain — per-item lifecycle ----------------

describe('#128: the drain flushes /api/sync with per-item results', () => {
  it('offline→online drains: POST /api/sync carries only the queued ids/types/payloads, all-ok moves them to history + bumps dataVersion', async () => {
    resetSupplier({ online: false, outbox: [queuedItem(1), queuedItem(2)] })
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'sq-1', ok: true }, { id: 'sq-2', ok: true }],
      data: null,
      projects: [],
    })))

    sState().setOnline(true)
    await vi.waitFor(() => expect(sState().syncing).toBe(false))

    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.backOnlineDraining'))
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sync')
    expect(JSON.parse(String(init.body))).toEqual({
      actions: [
        { id: 'sq-1', type: 'quote.receive', payload: { id: 'quote-1', unitPrice: 120 }, projectId: 'proj-1' },
        { id: 'sq-2', type: 'quote.receive', payload: { id: 'quote-2', unitPrice: 120 }, projectId: 'proj-1' },
      ],
    })
    expect(sState().outbox).toHaveLength(0) // drained…
    expect(sState().syncHistory).toHaveLength(2) // …and retained (never silently lost)
    expect(sState().syncHistory.every((o) => o.syncStatus === 'synced')).toBe(true)
    // The portal's post-drain refresh signal.
    expect(sState().dataVersion).toBe(1)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.doneOk', { count: 2 }))
  })

  it('per-item failure keeps lastError + the bounded retry schedule and does NOT block the rest of the batch', async () => {
    resetSupplier({ outbox: [queuedItem(1), queuedItem(2)] })
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'sq-1', ok: true }, { id: 'sq-2', ok: false, error: 'Quote not found in this project' }],
      data: null,
      projects: [],
    })))

    const result = await sState().syncNow()

    expect(result).toEqual({ synced: 1, failed: 1, conflicts: 0 })
    expect(sState().outbox).toHaveLength(1) // the failed item stays queued…
    const failed = sState().outbox[0]
    expect(failed.id).toBe('sq-2')
    expect(failed.syncStatus).toBe('failed')
    expect(failed.lastError).toBe('Quote not found in this project')
    expect(failed.retryCount).toBe(1)
    // #132: the bounded automatic retry is already booked (5s backoff).
    expect(failed.autoAttempts).toBe(1)
    expect(typeof failed.nextAttemptAt).toBe('number')
    // …the synced sibling moved on (a failing item never blocks the queue).
    expect(sState().syncHistory).toHaveLength(1)
    expect(sState().dataVersion).toBe(1)
    expect(toast.error).toHaveBeenCalledWith(translate(enDict, 'sync.doneFailed', { synced: 1, failed: 1 }))
  })

  it('a TRUE network-level failure re-queues everything as pending (never drops, no error toast)', async () => {
    resetSupplier({ outbox: [queuedItem(1), queuedItem(2)] })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    const result = await sState().syncNow()

    expect(result).toBeUndefined()
    for (const o of sState().outbox) {
      expect(o.syncStatus).toBe('pending')
      expect(o.lastError).toBeUndefined()
      expect(o.retryCount).toBe(0)
    }
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a 401 drain marks the batch auth-blocked; drainAfterAuth recovers it after re-login', async () => {
    resetSupplier({ outbox: [queuedItem(1), queuedItem(2)] })
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'Sign in required' }, false, 401)))

    await sState().syncNow()

    for (const o of sState().outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.authBlocked).toBe(true)
      expect(o.lastError).toBe(translate(enDict, 'sync.authBlockedItem'))
      expect(o.nextAttemptAt).toBeUndefined() // a sign-in, not a backoff, unblocks these
    }
    expect(toast.error).toHaveBeenCalledWith(translate(enDict, 'sync.sessionExpired', { count: 2 }))

    // Re-login: session authenticated + online → the batch re-queues and flushes.
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'sq-1', ok: true }, { id: 'sq-2', ok: true }],
      data: null,
      projects: [],
    })))
    const started = await sState().drainAfterAuth()

    expect(started).toBe(true)
    expect(sState().outbox).toHaveLength(0)
    expect(sState().syncHistory).toHaveLength(2)
  })

  it('retryAll is the manual escape hatch: failed items re-queue and drain NOW', async () => {
    resetSupplier({
      outbox: [{ ...queuedItem(1), syncStatus: 'failed', lastError: 'Sync failed', retryCount: 3, autoAttempts: 3 }],
    })
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'sq-1', ok: true }],
      data: null,
      projects: [],
    })))

    sState().retryAll()
    await vi.waitFor(() => expect(sState().syncing).toBe(false))

    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.retrying', { count: 1 }))
    expect(sState().outbox).toHaveLength(0)
    expect(sState().syncHistory).toHaveLength(1)
  })

  it('an empty queue is a no-op drain (no fetch, lastSyncAt still stamped)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await sState().syncNow()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sState().lastSyncAt).not.toBeNull()
  })
})

// ---------------- #132 — the shared bounded auto-retry cadence ----------------

describe('#128: the bounded auto-retry cadence runs for the supplier host too', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('5s → 30s → 2min → manual-only (3 automatic attempts, then the sheet footer)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ ok: true, results: [{ id: 'sq-1', ok: false, error: 'Row is locked' }], data: null, projects: [] })))
    resetSupplier({ outbox: [queuedItem(1)] })

    await sState().syncNow()
    expect(sState().outbox[0].autoAttempts).toBe(1) // +5s booked

    await vi.advanceTimersByTimeAsync(5_000) // auto #1 fails → +30s
    expect(sState().outbox[0].autoAttempts).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000) // auto #2 fails → +2min
    expect(sState().outbox[0].autoAttempts).toBe(3)
    await vi.advanceTimersByTimeAsync(120_000) // auto #3 fails → exhausted
    const item = sState().outbox[0]
    expect(item.syncStatus).toBe('failed')
    expect(item.autoAttempts).toBe(3)
    expect(item.nextAttemptAt).toBeUndefined()

    // Nothing fires ever again on its own.
    const calls = vi.mocked(fetch).mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
  })

  it('a successful automatic retry recovers the item (full cycle, retained in history)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      res({ ok: true, results: [{ id: 'sq-1', ok: false, error: 'Row is locked' }], data: null, projects: [] })))
    resetSupplier({ outbox: [queuedItem(1)] })

    await sState().syncNow()
    expect(sState().outbox[0].syncStatus).toBe('failed')

    vi.mocked(fetch).mockImplementation(async () => res({
      ok: true,
      results: [{ id: 'sq-1', ok: true }],
      data: null,
      projects: [],
    }))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sState().outbox).toHaveLength(0)
    expect(sState().syncHistory).toHaveLength(1)
    expect(sState().dataVersion).toBe(1)
  })
})

// ---------------- session scoping — never the owner's queue ----------------

describe('#128: session scoping — the supplier outbox never drains owner items (and vice versa)', () => {
  it('a supplier drain POSTs ONLY supplier items; the owner queue is untouched', async () => {
    resetSupplier({ outbox: [queuedItem(1)] })
    useMjengo.setState({ online: true, syncing: false, outbox: [ownerItem(1), ownerItem(2)], syncHistory: [], lastSyncAt: null } as never)
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'sq-1', ok: true }],
      data: null,
      projects: [],
    })))

    await sState().syncNow()

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { actions: Array<{ id: string }> }
    expect(body.actions.map((a) => a.id)).toEqual(['sq-1']) // ONLY the supplier item
    // The owner queue is untouched by the supplier drain.
    const ownerIds = useMjengo.getState().outbox.map((o) => o.id)
    expect(ownerIds).toEqual(['oq-1', 'oq-2'])
  })

  it('an owner drain POSTs ONLY owner items; the supplier queue is untouched', async () => {
    resetSupplier({ outbox: [queuedItem(1)] })
    useMjengo.setState({ online: true, syncing: false, outbox: [ownerItem(1)], syncHistory: [], lastSyncAt: null } as never)
    vi.stubGlobal('fetch', vi.fn(async () => res({
      ok: true,
      results: [{ id: 'oq-1', ok: true }],
      data: null,
      projects: [],
    })))

    await useMjengo.getState().syncNow()

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { actions: Array<{ id: string }> }
    expect(body.actions.map((a) => a.id)).toEqual(['oq-1'])
    expect(useSupplierOutbox.getState().outbox.map((o) => o.id)).toEqual(['sq-1'])
  })

  it('the two stores persist under DIFFERENT localStorage keys and share no state', () => {
    const supplierSrc = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    const ownerSrc = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(supplierSrc).toContain("name: 'mjengo-supplier-outbox'")
    // #192 moved the owner key behind the exported MJENGO_STORE_KEY const
    // (the guarded storage adapter needs the name) — pin BOTH the const's
    // value and its use, the same invariant the literal pin carried.
    expect(ownerSrc).toContain("export const MJENGO_STORE_KEY = 'mjengo-os-store'")
    expect(ownerSrc).toContain('name: MJENGO_STORE_KEY')
    // The supplier store consumes the SHARED core (lib/outbox) but never the
    // owner store — no entanglement by construction.
    expect(supplierSrc).not.toContain("from '@/frontend/hooks/use-mjengo'")
    expect(supplierSrc).toContain("from '@/frontend/lib/outbox'")
  })
})

// ---------------- persistence across reload ----------------

/** Minimal Storage double (vitest runs node-only — no real localStorage). */
function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k) => map.get(String(k)) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(String(k)) },
    setItem: (k, v) => { map.set(String(k), String(v)) },
  } as Storage
}

/** Await a macrotask so zustand-persist's async rehydrate settles. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('#128: a queued action survives a reload (persisted, rehydrated pending)', () => {
  it('queue offline → the item lands under mjengo-supplier-outbox → a FRESH store instance rehydrates it pending', async () => {
    vi.resetModules()
    const storage = makeStorage()
    vi.stubGlobal('localStorage', storage)

    const { useSupplierOutbox: first } = await import('@/frontend/hooks/use-supplier-outbox')
    first.setState({ online: false, outbox: [], syncHistory: [], syncing: false, lastSyncAt: null })
    const result = await first.getState().dispatch(
      'catalog.upsert',
      { supplierId: 'sup-1', name: 'Cement', unit: 'bag', unitPrice: 750, stockQty: 40 },
      'proj-1',
      'Catalog updated: Cement',
    )
    expect(result).toBe('queued')

    // The persisted state carries the queued item under the SUPPLIER key.
    const raw = storage.getItem('mjengo-supplier-outbox')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw!) as { state: { outbox: OutboxItem[] } }
    expect(persisted.state.outbox).toHaveLength(1)
    expect(persisted.state.outbox[0]).toMatchObject({ type: 'catalog.upsert', syncStatus: 'pending', label: 'Catalog updated: Cement' })

    // "Reload": a fresh module instance rehydrates from the same storage.
    vi.resetModules()
    const { useSupplierOutbox: reloaded } = await import('@/frontend/hooks/use-supplier-outbox')
    await tick()

    const outbox = reloaded.getState().outbox
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ type: 'catalog.upsert', syncStatus: 'pending', projectId: 'proj-1' })
    // The reload also rehydrates the persisted online flag — the queue does
    // not drain itself until connectivity returns.
    expect(reloaded.getState().online).toBe(false)
  })

  it('a stale v0 persisted item (pre-lifecycle shape) migrates to pending/retryCount 0 on rehydrate', async () => {
    vi.resetModules()
    const storage = makeStorage()
    vi.stubGlobal('localStorage', storage)
    // A v0-shape item: no syncStatus, no retryCount (the owner store's v0→v1
    // migration story, mirrored for the supplier key).
    storage.setItem('mjengo-supplier-outbox', JSON.stringify({
      state: {
        online: true,
        lastSyncAt: null,
        outbox: [{
          id: 'legacy-1', type: 'order.confirm', payload: { id: 'po-9' },
          label: 'order.confirm: PO-2026-000009', createdAt: Date.now(), projectId: 'proj-1',
        }],
        syncHistory: [],
      },
      version: 1,
    }))

    const { useSupplierOutbox: reloaded } = await import('@/frontend/hooks/use-supplier-outbox')
    await tick()

    const item = reloaded.getState().outbox[0]
    expect(item.syncStatus).toBe('pending')
    expect(item.retryCount).toBe(0)
    expect(item.autoAttempts).toBe(0)
  })
})

// ---------------- wiring + honesty source pins ----------------

describe('#128: wiring — the drain is reachable end to end on the supplier surface', () => {
  it('the portal wires connectivity, post-auth drain, the post-drain refresh, and mounts the sync control', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-portal.tsx')
    // Real connectivity drives the SUPPLIER store (owner app parity).
    expect(src).toContain("window.addEventListener('offline', onOffline)")
    expect(src).toContain("window.addEventListener('online', onOnline)")
    expect(src).toContain('useSupplierOutbox.getState().setOnline(false)')
    expect(src).toContain('useSupplierOutbox.getState().setOnline(true)')
    // #191 parity: re-login drains an auth-blocked supplier queue.
    expect(src).toContain('drainAfterAuth()')
    // The post-drain refresh signal (this store owns no payload of its own).
    expect(src).toContain('if (dataVersion > 0) void load()')
    // The pending/syncing indicator is mounted in the header.
    expect(src).toContain('<SupplierSyncControl />')
    // Dispatch is offline-first through the store.
    expect(src).toContain(".dispatch(type, actionPayload, projectId, label)")
  })

  it('the sync control renders the per-item lifecycle + retry footer and only appears with work', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-sync-control.tsx')
    expect(src).toContain('if (outbox.length === 0 && !syncing) return null')
    expect(src).toContain("t('outbox.status.queued')")
    expect(src).toContain("t('outbox.status.syncing')")
    expect(src).toContain("t('outbox.status.failed')")
    expect(src).toContain("t('outbox.autoRetryNote'")
    expect(src).toContain("t('outbox.autoRetryExhausted'")
    expect(src).toContain("t('outbox.authBlockedNote'")
    expect(src).toContain("t('outbox.retryFailed'")
    expect(src).toContain('retryAll')
    // The trigger drains the pending queue (owner Sync contract).
    expect(src).toContain('if (!syncing && pending.length > 0) void syncNow()')
    // The queued-count badge is the visible pending indicator.
    expect(src).toContain("t('header.aria.queuedActions', { count: outbox.length })")
  })

  it('the store drains through /api/sync and queues only SUPPLIER_ACTIONS (source of truth = the shared list)', () => {
    const src = readSrc('src/frontend/hooks/use-supplier-outbox.ts')
    expect(src).toContain("fetch('/api/sync'")
    expect(src).toContain('SUPPLIER_ACTIONS')
    expect(src).toContain('mjengo-supplier-outbox')
    // The dispatch transport for ONLINE actions stays /api/actions.
    expect(src).toContain("fetch('/api/actions'")
  })

  it('no supplier action family is versioned/financial today — a §41 conflict is impossible; if that changes, the panel needs resolution UI', () => {
    // Extract the SERVER's sets straight out of the sync route (the
    // outbox-versions source-pin idiom): if a supplier type ever joins the
    // versioned or financial families, this pin FAILS LOUDLY — the supplier
    // sync sheet has no keep-server/keep-mine buttons yet.
    const syncSrc = readSrc('src/backend/api/sync.ts')
    const setOf = (name: string): string[] => {
      const body = syncSrc.match(new RegExp(`const ${name} = new Set<string>\\(\\[([^\\]]+)\\]`))?.[1] ?? ''
      return body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    }
    const conflictable = new Set([
      ...setOf('VERSIONED_TASK_TYPES'),
      ...setOf('VERSIONED_ATTENDANCE_TYPES'),
      ...setOf('FINANCIAL_TYPES'),
    ])
    for (const type of SUPPLIER_ACTIONS) {
      expect(conflictable.has(type), `supplier action "${type}" is now conflictable — the supplier sync sheet needs §41 resolution UI`).toBe(false)
    }
  })

  it('every new user-facing key exists in BOTH dictionaries (compile parity + runtime)', () => {
    const keys = ['supplier.outbox.notPermitted', 'supplier.outbox.conflictNote'] as const
    const enKeys = new Set(Object.keys(enDict))
    const swKeys = new Set(Object.keys(swDict))
    for (const key of keys) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
    // The Kiswahili side interpolates through the real translate().
    expect(translate(swDict, 'supplier.outbox.conflictNote')).toBe(
      'Mgogoro wa usawazishaji — kitendo hiki hakikutumwa. Kinasalia kwenye foleni hapa hadi kitatatuliwa.'
    )
  })
})
