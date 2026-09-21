/**
 * #351 — the closed-app outbox drain (Background Sync + indexedDB), pinned
 * three ways:
 *
 *  1. THE SEAM (src/frontend/lib/outbox-idb.ts) — the real adapter code
 *     against the IN-MEMORY kv implementation (jsdom/node have no
 *     indexedDB; the seam exists exactly so the semantics are testable
 *     without a browser): kv roundtrips, the serialized operation ORDER,
 *     and the read-through LEGACY ADOPTION contract (read-through →
 *     migrate-write → clear-only-after-the-write; a failed write keeps the
 *     legacy key; a kv record that exists is never re-adopted; a refused
 *     legacy read is absent, never a crash);
 *  2. THE DRAIN (src/frontend/sw-handlers.ts #351 section) — the pure §40
 *     marking functions and the orchestrated drainOutboxHeadless over
 *     injected in-memory deps: headless-safe batch selection (money/
 *     session-bound kinds REFUSE and stay pending), order preservation, the
 *     401 → auth-blocked arm (#191 semantics — no auto-retry schedule),
 *     server-level refusals surfaced per-item, per-item results applied
 *     with the capped history, and a network failure REJECTING so
 *     Chromium's one-shot tag retries (items never marked);
 *  3. THE MIRROR (public/sw.js) — the static worker cannot import the
 *     tested module, so its inline copy is pinned EQUAL by reading the
 *     file: the DB constants, the record key, the allowlist, the messages,
 *     the #132 retry constants, and the sync-handler structure.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  createInMemoryKvStore,
  createIndexedDbStateStorage,
  type LegacyStorage,
  OUTBOX_DB_NAME,
  OUTBOX_DB_VERSION,
  OUTBOX_DB_STORE,
} from '@/frontend/lib/outbox-idb'
import { AUTO_RETRY_DELAYS_MS, AUTO_RETRY_MAX_ATTEMPTS, SYNC_HISTORY_CAP, type OutboxItem, type SyncItemResult } from '@/frontend/lib/outbox'
import {
  OUTBOX_DB_RECORD_KEY,
  HEADLESS_DRAIN_TYPES,
  HEADLESS_AUTH_BLOCKED_MESSAGE,
  HEADLESS_SERVER_REFUSAL_MESSAGE,
  isHeadlessDrainable,
  markHeadlessDrainOutcome,
  applyHeadlessDrainResults,
  markHeadlessAuthBlocked,
  markHeadlessServerRefusal,
  drainOutboxHeadless,
  type HeadlessDrainDeps,
  type HeadlessDrainSnapshot,
  type HeadlessSyncAction,
} from '@/frontend/sw-handlers'
import { MJENGO_STORE_KEY } from '@/frontend/hooks/use-mjengo'
import { ACTION_PAYLOAD_SCHEMAS } from '@/backend/api/action-schemas'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const SW_SOURCE = readSrc('public/sw.js')

// ---------------- helpers ----------------

/** A queued outbox item with the given §40 state. */
function item(id: string, type = 'attendance.checkin', syncStatus: OutboxItem['syncStatus'] = 'pending'): OutboxItem {
  return {
    id,
    type,
    payload: { workerId: 'w-1' },
    label: `item ${id}`,
    createdAt: 1_700_000_000_000,
    projectId: 'pl-1',
    syncStatus,
    retryCount: 0,
  }
}

/** A persisted owner-store record (the shape the SW reads). */
function snapshot(items: OutboxItem[], history: OutboxItem[] = []): string {
  return JSON.stringify({
    state: { outbox: items, syncHistory: history, online: true, data: null, lastSyncAt: null },
    version: 2,
  })
}

/** The parsed record after a drain wrote it back. */
function parseWritten(raw: string): { outbox: OutboxItem[]; syncHistory: OutboxItem[] } {
  const parsed = JSON.parse(raw) as HeadlessDrainSnapshot
  return {
    outbox: (parsed.state?.outbox ?? []) as OutboxItem[],
    syncHistory: (parsed.state?.syncHistory ?? []) as OutboxItem[],
  }
}

/**
 * In-memory drain deps: the record under test, every write captured, every
 * POST captured, the response programmable, the clock fixed.
 */
function makeDeps(initialRecord: string | null) {
  let record = initialRecord
  const writes: string[] = []
  const posted: { status: number; actions: HeadlessSyncAction[] }[] = []
  let respond: () => { status: number; json: () => Promise<unknown> } = () => ({
    status: 200,
    json: async () => ({ ok: true, results: [] }),
  })
  const deps: HeadlessDrainDeps = {
    readRecord: async () => record,
    writeRecord: async (value) => {
      writes.push(value)
      record = value
    },
    postSync: async (actions) => {
      const r = respond()
      posted.push({ status: r.status, actions })
      return { status: r.status, json: r.json }
    },
    now: () => 1_700_000_000_000,
  }
  return { deps, writes, posted, setRespond: (fn: typeof respond) => { respond = fn } }
}

// ---------------- 1 · the seam (lib/outbox-idb.ts, in-memory kv) ----------------

describe('#351 seam: the in-memory kv + the state-storage adapter', () => {
  it('kv roundtrips: get absent → null; put → get; delete → get absent; delete of absent never throws', async () => {
    const kv = createInMemoryKvStore()
    expect(await kv.get('k')).toBeNull()
    await kv.put('k', 'v1')
    expect(await kv.get('k')).toBe('v1')
    await kv.delete('k')
    expect(await kv.get('k')).toBeNull()
    await expect(kv.delete('k')).resolves.toBeUndefined()
  })

  it('kv quota knobs: a hard refusal rejects with QuotaExceededError; a byte boundary refuses only above it', async () => {
    const kv = createInMemoryKvStore()
    kv.quotaExceeded = true
    await expect(kv.put('k', 'v')).rejects.toMatchObject({ name: 'QuotaExceededError' })
    kv.quotaExceeded = false
    kv.quotaBytes = 3
    await kv.put('k', 'abc') // exactly at the boundary fits
    await expect(kv.put('k', 'abcd')).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(await kv.get('k')).toBe('abc') // the refused write never landed
  })

  it('operations are SERIALIZED in issue order — a later read sees the writes issued before it', async () => {
    const storage = createIndexedDbStateStorage(createInMemoryKvStore(), null)
    await storage.setItem('k', 'v1')
    const log: string[] = []
    // Interleaved without awaiting: the adapter's ordered chain must run
    // them in exactly this order (an eager pre-hydration write can never
    // slip between an adoption read and the store's merge write).
    const p1 = storage.getItem('k').then((v) => log.push(`get1:${v}`))
    const p2 = storage.setItem('k', 'v2').then(() => log.push('set2'))
    const p3 = storage.getItem('k').then((v) => log.push(`get3:${v}`))
    await Promise.all([p1, p2, p3])
    expect(log).toEqual(['get1:v1', 'set2', 'get3:v2'])
  })

  it('the read-through adoption: getItem hands the legacy snapshot back verbatim (kv still empty, legacy intact)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const kv = createInMemoryKvStore()
    const legacyStore = new Map<string, string>([['k', JSON.stringify({ state: { outbox: [item('q-1')] }, version: 1 })]])
    const legacy: LegacyStorage = {
      get: (name) => legacyStore.get(name) ?? null,
      remove: (name) => {
        legacyStore.delete(name)
      },
    }
    const storage = createIndexedDbStateStorage(kv, legacy)

    const value = await storage.getItem('k')
    expect(value).toBe(legacyStore.get('k')) // the hydrating store gets the legacy snapshot AS-IS
    expect(kv.records.has('k')).toBe(false) // nothing was written yet
    expect(legacyStore.has('k')).toBe(true) // and the legacy key survives as the on-disk fallback
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('adopting the legacy localStorage outbox snapshot'))
    infoSpy.mockRestore()
  })

  it('the adoption completes only through a successful write — the legacy key is cleared AFTER the kv write lands', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const kv = createInMemoryKvStore()
    const legacyStore = new Map<string, string>([['k', 'legacy-snapshot']])
    const legacy: LegacyStorage = {
      get: (name) => legacyStore.get(name) ?? null,
      remove: (name) => {
        legacyStore.delete(name)
      },
    }
    const storage = createIndexedDbStateStorage(kv, legacy)
    await storage.getItem('k') // adoption pending

    await storage.setItem('k', JSON.stringify({ state: { outbox: [] }, version: 2 }))
    expect(kv.records.get('k')).toContain('"version":2')
    expect(legacyStore.has('k')).toBe(false) // cleared — only now
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('legacy localStorage key cleared'))
    infoSpy.mockRestore()
  })

  it('a FAILED adoption write keeps the legacy key (no silent data loss) — the next successful write clears it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const kv = createInMemoryKvStore()
    const legacyStore = new Map<string, string>([['k', 'legacy-snapshot']])
    const legacy: LegacyStorage = {
      get: (name) => legacyStore.get(name) ?? null,
      remove: (name) => {
        legacyStore.delete(name)
      },
    }
    const storage = createIndexedDbStateStorage(kv, legacy)
    await storage.getItem('k') // adoption pending

    kv.quotaExceeded = true
    await expect(storage.setItem('k', 'migrated-snapshot')).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(legacyStore.has('k')).toBe(true) // the on-disk fallback survives the failed write

    kv.quotaExceeded = false
    await storage.setItem('k', 'migrated-snapshot')
    expect(legacyStore.has('k')).toBe(false)
  })

  it('a kv record that already exists is never re-adopted (the legacy key is inert, not resurrected)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const kv = createInMemoryKvStore()
    const legacyStore = new Map<string, string>([['k', 'stale-legacy-snapshot']])
    const legacy: LegacyStorage = {
      get: (name) => legacyStore.get(name) ?? null,
      remove: (name) => {
        legacyStore.delete(name)
      },
    }
    const storage = createIndexedDbStateStorage(kv, legacy)
    await storage.setItem('k', 'kv-record') // steady state — no adoption pending

    expect(await storage.getItem('k')).toBe('kv-record') // the kv record wins
    await storage.setItem('k', 'kv-record-2')
    expect(legacyStore.has('k')).toBe(true) // a write that never adopted clears nothing
    expect(kv.records.get('k')).toBe('kv-record-2')
  })

  it('a refused legacy READ is absent, never a crash (security software posture — the legacyLocalStorage guard)', async () => {
    // The production LegacyStorage (legacyLocalStorage) wraps every read
    // and removal in its own guard: security software refusing localStorage
    // reads as ABSENT, a refused removal keeps the stale key around
    // (harmless — the kv write is the record). Pinned on a fresh module
    // world with a partially-refusing localStorage global.
    vi.resetModules()
    const legacyStore = new Map<string, string>([['k', 'legacy-snapshot']])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => {
        if (k === 'read-refused') throw new Error('localStorage read refused')
        return legacyStore.get(k) ?? null
      },
      removeItem: (k: string) => {
        throw new Error('localStorage remove refused')
      },
    })
    try {
      const { createIndexedDbStateStorage, legacyLocalStorage } = await import('@/frontend/lib/outbox-idb')
      expect(legacyLocalStorage).not.toBeNull()
      const storage = createIndexedDbStateStorage(createInMemoryKvStore(), legacyLocalStorage)

      // A refused read is absent — never a crash, never a rejected hydrate.
      await expect(storage.getItem('read-refused')).resolves.toBeNull()

      // An adoptable key still adopts; the refusing REMOVE is swallowed by
      // the same guard (the kv write is the durable record; the stale
      // legacy key lingering is the documented harmless outcome).
      await expect(storage.getItem('k')).resolves.toBe('legacy-snapshot')
      await expect(storage.setItem('k', 'migrated')).resolves.toBeUndefined()
      expect(legacyStore.has('k')).toBe(true) // remove refused → key lingers, harmlessly
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('removeItem cancels a pending adoption — a later fresh write does not clear the legacy key', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const kv = createInMemoryKvStore()
    const legacyStore = new Map<string, string>([['k', 'legacy-snapshot']])
    const storage = createIndexedDbStateStorage(kv, {
      get: (name) => legacyStore.get(name) ?? null,
      remove: (name) => {
        legacyStore.delete(name)
      },
    })
    await storage.getItem('k') // adoption pending
    await storage.removeItem('k') // the record is being wiped — the adoption is off
    await storage.setItem('k', 'fresh')
    expect(legacyStore.has('k')).toBe(true) // the cancelled adoption clears nothing
    expect(kv.records.get('k')).toBe('fresh')
  })

  it('a null legacy (node/SSR) is a plain kv passthrough', async () => {
    const kv = createInMemoryKvStore()
    const storage = createIndexedDbStateStorage(kv, null)
    expect(await storage.getItem('k')).toBeNull()
    await storage.setItem('k', 'v')
    expect(await storage.getItem('k')).toBe('v')
  })
})

// ---------------- 2a · the pure drain policy ----------------

describe('#351 policy: what drains headless and what refuses', () => {
  it('the allowlist covers the non-financial field + evidence families — every entry a REAL documented action (no typo dead-ends)', () => {
    // Fail-closed by construction: anything not listed refuses headless.
    const schemaKeys = new Set(Object.keys(ACTION_PAYLOAD_SCHEMAS))
    expect(HEADLESS_DRAIN_TYPES.length).toBeGreaterThanOrEqual(30)
    for (const type of HEADLESS_DRAIN_TYPES) {
      expect(schemaKeys.has(type), `"${type}" is not a documented action type`).toBe(true)
    }
    // The families the policy documents as headless-safe.
    for (const prefix of ['attendance.', 'task.', 'phase.', 'worker.', 'delivery.', 'comment.', 'notification.', 'zone.', 'photo.']) {
      expect(HEADLESS_DRAIN_TYPES.some((t) => t.startsWith(prefix)), `no "${prefix}*" kind drains headless`).toBe(true)
    }
    for (const kind of ['material.create', 'consumption.create', 'alert.ack']) {
      expect(HEADLESS_DRAIN_TYPES).toContain(kind)
    }
  })

  it('MONEY rows refuse headless — money needs a human watching the outcome (the #150 hard stop)', () => {
    const refuses = [
      // escrow/milestone/variation (MONEY_ACTIONS)
      'escrow.topup', 'milestone.create', 'milestone.decide', 'variation.decide',
      // invoices (INVOICE_ACTIONS — invoice.pay moves real money)
      'invoice.create', 'invoice.decide', 'invoice.pay',
      // wages + ledger + budget
      'wages.pay', 'expense.create', 'transaction.delete', 'project.update',
      // wallets (WALLET_ACTIONS)
      'payment.request', 'payment.decide', 'payment.pay', 'wallet.create', 'wallet.deposit', 'wallet.withdraw', 'wallet.transfer', 'transaction.reverse',
      // payroll approve (TRUST_ACTIONS' money arm)
      'payroll.approve',
    ]
    for (const kind of refuses) {
      expect(HEADLESS_DRAIN_TYPES).not.toContain(kind)
      expect(isHeadlessDrainable(item('x', kind)), `"${kind}" must refuse headless`).toBe(false)
    }
  })

  it('session-bound / high-stakes families refuse headless (share, supply/marketplace, AI, land, professionals, inventory, intel)', () => {
    const refuses = [
      'share.regenerate', // the new link exists only in the drain response
      'supplier.upsert', 'catalog.upsert', 'request.create', 'request.decide', 'quote.request', 'order.confirm', // SUPPLY_ACTIONS (the supplier portal's own store/session)
      'ai.drawReview', 'ai.trustDigest', // AI_ACTIONS
      'team.add', 'team.update', 'team.remove', // PROFESSIONALS_ACTIONS
    ]
    for (const kind of refuses) {
      expect(HEADLESS_DRAIN_TYPES).not.toContain(kind)
      expect(isHeadlessDrainable(item('x', kind)), `"${kind}" must refuse headless`).toBe(false)
    }
  })

  it('only PENDING items drain headless — syncing/failed/conflict/synced are not the SW\'s to replay', () => {
    expect(isHeadlessDrainable(item('x', 'attendance.checkin', 'pending'))).toBe(true)
    expect(isHeadlessDrainable({ type: 'attendance.checkin' })).toBe(true) // missing syncStatus reads as pending (migration-safe)
    expect(isHeadlessDrainable(item('x', 'attendance.checkin', 'syncing'))).toBe(false)
    expect(isHeadlessDrainable(item('x', 'attendance.checkin', 'failed'))).toBe(false)
    expect(isHeadlessDrainable(item('x', 'attendance.checkin', 'conflict'))).toBe(false)
    expect(isHeadlessDrainable(item('x', 'attendance.checkin', 'synced'))).toBe(false)
    // An unknown kind refuses (fail-closed).
    expect(isHeadlessDrainable(item('x', 'brand-new.kind'))).toBe(false)
  })
})

// ---------------- 2b · the pure §40 marking functions ----------------

describe('#351 marking: the §40 lifecycle transitions the headless drain writes back', () => {
  it('markHeadlessDrainOutcome — ok → synced (syncedAt stamped, lastError cleared)', () => {
    const now = 1_700_000_123_456
    const marked = markHeadlessDrainOutcome(
      { ...item('q-1'), lastError: 'old failure' },
      { id: 'q-1', ok: true },
      now,
    )
    expect(marked.syncStatus).toBe('synced')
    expect(marked.syncedAt).toBe(now)
    expect(marked.lastError).toBeUndefined()
  })

  it('markHeadlessDrainOutcome — conflict → the full §41 metadata', () => {
    const now = 1_700_000_123_456
    const marked = markHeadlessDrainOutcome(
      item('q-1', 'task.update'),
      { id: 'q-1', ok: false, conflict: true, reason: 'stale version', rule: 'server-wins', status: 'REJECTED', serverVersion: 7, baseVersion: 5, suggestion: 'keep-server' },
      now,
    )
    expect(marked.syncStatus).toBe('conflict')
    expect(marked).toMatchObject({
      conflictReason: 'stale version',
      conflictRule: 'server-wins',
      conflictAt: now,
      conflictStatus: 'REJECTED',
      conflictServerVersion: 7,
      conflictBaseVersion: 5,
      suggestion: 'keep-server',
    })
  })

  it('markHeadlessDrainOutcome — failure → lastError + retryCount+1 + the bounded #132 schedule; exhausted → manual-only', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-28T08:00:00Z'))
      const marked = markHeadlessDrainOutcome(item('q-1'), { id: 'q-1', ok: false, error: 'row missing' }, Date.now())
      expect(marked.syncStatus).toBe('failed')
      expect(marked.lastError).toBe('row missing')
      expect(marked.retryCount).toBe(1)
      expect(marked.autoAttempts).toBe(1) // 5s → 30s → 2min, max 3 (#132)
      expect(marked.nextAttemptAt).toBe(Date.now() + 5_000)

      // An item that already used its 3 automatic attempts gets NO schedule
      // — the sync sheet's retry footer is the manual escape hatch.
      const exhausted = markHeadlessDrainOutcome(
        { ...item('q-2'), autoAttempts: 3 },
        { id: 'q-2', ok: false, error: 'still failing' },
        Date.now(),
      )
      expect(exhausted.autoAttempts).toBe(3)
      expect(exhausted.nextAttemptAt).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('applyHeadlessDrainResults — synced items move to the CAPPED history, the rest keep their live-queue place; counts returned', () => {
    const now = 1_700_000_123_456
    const history = Array.from({ length: SYNC_HISTORY_CAP }, (_, i) => item(`h-${i}`, 'attendance.checkin', 'synced'))
    const snap: HeadlessDrainSnapshot = {
      state: { outbox: [item('q-1'), item('q-2', 'task.update'), item('q-3', 'task.update'), item('q-4')], syncHistory: history, online: true },
      version: 2,
    }
    const results: SyncItemResult[] = [
      { id: 'q-1', ok: true },
      { id: 'q-2', ok: false, conflict: true, reason: 'stale', rule: 'server-wins' },
      { id: 'q-3', ok: false, error: 'nope' },
    ]
    const applied = applyHeadlessDrainResults(snap, results, now)

    expect(applied.synced).toBe(1)
    expect(applied.conflicts).toBe(1)
    expect(applied.failed).toBe(1)
    expect(applied.snapshot.state?.outbox?.map((o) => o.id)).toEqual(['q-2', 'q-3', 'q-4']) // q-1 left the live queue; q-4 untouched
    expect(applied.snapshot.state?.outbox?.find((o) => o.id === 'q-4')?.syncStatus).toBe('pending')
    // The capped retention: 50 existing + 1 newly synced → the OLDEST falls off.
    expect(applied.snapshot.state?.syncHistory).toHaveLength(SYNC_HISTORY_CAP)
    expect(applied.snapshot.state?.syncHistory?.at(-1)?.id).toBe('q-1')
    expect(applied.snapshot.state?.syncHistory?.[0]?.id).toBe('h-1')
    expect(applied.snapshot.version).toBe(2) // the rest of the record survives the write-back
  })

  it('applyHeadlessDrainResults — duplicate result ids mark the item ONCE (the by-id dedupe seam; the LAST result wins)', () => {
    const snap: HeadlessDrainSnapshot = { state: { outbox: [item('q-1')], syncHistory: [] }, version: 2 }
    const applied = applyHeadlessDrainResults(snap, [
      { id: 'q-1', ok: true },
      { id: 'q-1', ok: false, error: 'shadowed duplicate' },
    ], 1)
    // One mark, not two: the by-id map cannot double-apply a lifecycle
    // transition to the same queued item (the server reports one result
    // per action id — a duplicate is its contract violation, and the
    // adapter deterministically keeps the last one).
    expect(applied.synced).toBe(0)
    expect(applied.failed).toBe(1)
    const q1 = applied.snapshot.state?.outbox?.[0]
    expect(q1?.syncStatus).toBe('failed')
    expect(q1?.lastError).toBe('shadowed duplicate')
    expect(applied.snapshot.state?.syncHistory).toHaveLength(0)
  })

  it('markHeadlessAuthBlocked — the 401 arm: failed + authBlocked + the fixed message, NO auto-retry schedule, synced items untouched', () => {
    const snap: HeadlessDrainSnapshot = {
      state: { outbox: [item('q-1'), item('q-2', 'task.update', 'synced'), item('q-3')] },
    }
    const marked = markHeadlessAuthBlocked(snap, new Set(['q-1', 'q-2', 'not-queued']))
    expect(marked.count).toBe(1) // only q-1 was queued+pending
    const q1 = marked.snapshot.state?.outbox?.find((o) => o.id === 'q-1')
    expect(q1).toMatchObject({ syncStatus: 'failed', authBlocked: true, lastError: HEADLESS_AUTH_BLOCKED_MESSAGE, retryCount: 1 })
    expect(q1?.nextAttemptAt).toBeUndefined() // retrying without a session just 401s again (#191)
    expect(marked.snapshot.state?.outbox?.find((o) => o.id === 'q-2')?.syncStatus).toBe('synced')
    expect(marked.snapshot.state?.outbox?.find((o) => o.id === 'q-3')?.syncStatus).toBe('pending')
  })

  it('markHeadlessServerRefusal — surfaced per-item with the reason + the bounded schedule (never silently re-queued)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-28T08:00:00Z'))
      const snap: HeadlessDrainSnapshot = { state: { outbox: [item('q-1'), item('q-2')] } }
      const marked = markHeadlessServerRefusal(snap, new Set(['q-1']), 'db is locked')
      expect(marked.count).toBe(1)
      const q1 = marked.snapshot.state?.outbox?.find((o) => o.id === 'q-1')
      expect(q1).toMatchObject({ syncStatus: 'failed', lastError: 'db is locked', retryCount: 1 })
      expect(q1?.nextAttemptAt).toBe(Date.now() + 5_000)
      expect(marked.snapshot.state?.outbox?.find((o) => o.id === 'q-2')?.syncStatus).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------- 3 · the orchestrated closed-app drain ----------------

describe('#351 drain: drainOutboxHeadless over the injected seams', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('no record (first install / legacy localStorage era) → an honest all-zero report, nothing sent, nothing written', async () => {
    const { deps, writes, posted } = makeDeps(null)
    const report = await drainOutboxHeadless(deps)
    expect(report).toEqual({ sent: 0, refused: 0, synced: 0, failed: 0, conflicts: 0, authBlocked: 0 })
    expect(posted).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it('a corrupt record drains NOTHING (the app rehydrate owns surfacing it) — and never throws', async () => {
    const { deps, posted, writes } = makeDeps('{not json')
    const report = await drainOutboxHeadless(deps)
    expect(report.sent).toBe(0)
    expect(posted).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it('a record without an outbox array → an honest no-op', async () => {
    const { deps } = makeDeps(JSON.stringify({ state: { online: true }, version: 2 }))
    const report = await drainOutboxHeadless(deps)
    expect(report).toEqual({ sent: 0, refused: 0, synced: 0, failed: 0, conflicts: 0, authBlocked: 0 })
  })

  it('batch selection: only headless-safe PENDING items are sent, in queue order, with the exact body shape; money refuses and stays pending', async () => {
    const record = snapshot([
      item('q-1', 'attendance.checkin'),
      item('q-2', 'wages.pay'), // money — refuses headless
      item('q-3', 'task.update', 'failed'), // not pending — not the SW's to replay
      item('q-4', 'delivery.arrive'),
    ])
    const { deps, posted, writes, setRespond } = makeDeps(record)
    setRespond(() => ({ status: 200, json: async () => ({ ok: true, results: [{ id: 'q-1', ok: true }, { id: 'q-4', ok: true }] }) }))

    const report = await drainOutboxHeadless(deps)

    expect(report.sent).toBe(2)
    expect(report.refused).toBe(1) // the money row — counted, never sent
    expect(report.synced).toBe(2)
    expect(posted).toHaveLength(1)
    expect(posted[0].actions).toEqual([
      { id: 'q-1', type: 'attendance.checkin', payload: { workerId: 'w-1' }, projectId: 'pl-1' },
      { id: 'q-4', type: 'delivery.arrive', payload: { workerId: 'w-1' }, projectId: 'pl-1' },
    ])
    // The write-back: money stayed pending, failed stayed failed, synced left the live queue.
    const written = parseWritten(writes[0])
    expect(written.outbox.map((o) => [o.id, o.syncStatus])).toEqual([['q-2', 'pending'], ['q-3', 'failed']])
    expect(written.syncHistory.map((o) => o.id)).toEqual(['q-1', 'q-4'])
  })

  it('a 401 marks the batch auth-blocked (#191 — waits for a sign-in, NO schedule) and writes the record back', async () => {
    const record = snapshot([item('q-1'), item('q-2', 'task.update')])
    const { deps, writes, setRespond } = makeDeps(record)
    setRespond(() => ({ status: 401, json: async () => ({ error: 'session expired' }) }))

    const report = await drainOutboxHeadless(deps)

    expect(report).toMatchObject({ sent: 2, authBlocked: 2, synced: 0 })
    const written = parseWritten(writes[0])
    for (const o of written.outbox) {
      expect(o.syncStatus).toBe('failed')
      expect(o.authBlocked).toBe(true)
      expect(o.lastError).toBe(HEADLESS_AUTH_BLOCKED_MESSAGE)
      expect(o.nextAttemptAt).toBeUndefined()
    }
  })

  it('a server-level refusal is surfaced per-item with its reason + the bounded schedule (a server that ANSWERED is never a silent re-queue)', async () => {
    const record = snapshot([item('q-1')])
    const { deps, writes, setRespond } = makeDeps(record)
    setRespond(() => ({ status: 500, json: async () => ({ ok: false, error: 'database is locked' }) }))

    const report = await drainOutboxHeadless(deps)

    expect(report).toMatchObject({ sent: 1, failed: 1 })
    const q1 = parseWritten(writes[0]).outbox[0]
    expect(q1.syncStatus).toBe('failed')
    expect(q1.lastError).toBe('database is locked')
    expect(q1.autoAttempts).toBe(1)
    expect(typeof q1.nextAttemptAt).toBe('number')
  })

  it('a server-level refusal with an unparseable body (proxy 502 page) uses the honest fixed message', async () => {
    const record = snapshot([item('q-1')])
    const { deps, writes, setRespond } = makeDeps(record)
    setRespond(() => ({ status: 502, json: async () => { throw new Error('not json') } }))

    const report = await drainOutboxHeadless(deps)

    expect(report.failed).toBe(1)
    expect(parseWritten(writes[0]).outbox[0].lastError).toBe(HEADLESS_SERVER_REFUSAL_MESSAGE)
  })

  it('ok:true with per-item conflicts stamps the §41 metadata and keeps the items queued', async () => {
    const record = snapshot([item('q-1', 'task.update')])
    const { deps, writes, setRespond } = makeDeps(record)
    setRespond(() => ({
      status: 200,
      json: async () => ({ ok: true, results: [{ id: 'q-1', ok: false, conflict: true, reason: 'stale-version', rule: 'human-decides', status: 'REJECTED', serverVersion: 9, baseVersion: 4, suggestion: 'keep-server' }] }),
    }))

    const report = await drainOutboxHeadless(deps)

    expect(report).toMatchObject({ sent: 1, conflicts: 1 })
    const q1 = parseWritten(writes[0]).outbox[0]
    expect(q1.syncStatus).toBe('conflict')
    expect(q1).toMatchObject({ conflictReason: 'stale-version', conflictRule: 'human-decides', conflictStatus: 'REJECTED', conflictServerVersion: 9, conflictBaseVersion: 4, suggestion: 'keep-server' })
  })

  it('ok:true with NO results for our ids → nothing is marked, the record is rewritten unchanged (the items stay pending)', async () => {
    const record = snapshot([item('q-1')])
    const { deps, writes } = makeDeps(record)

    const report = await drainOutboxHeadless(deps)

    expect(report).toMatchObject({ sent: 1, synced: 0, failed: 0, conflicts: 0 })
    const written = parseWritten(writes[0])
    expect(written.outbox[0].syncStatus).toBe('pending')
  })

  it("a NETWORK failure REJECTS (the sync tag retries on Chromium's own backoff) and writes NOTHING — items were never marked", async () => {
    const record = snapshot([item('q-1')])
    const { deps, writes, setRespond } = makeDeps(record)
    setRespond(() => {
      throw new Error('fetch failed')
    })

    await expect(drainOutboxHeadless(deps)).rejects.toThrow('fetch failed')
    expect(writes).toHaveLength(0)
  })

  it('the fixed clock stamps syncedAt (the drain reports what happened, and when, through the injected now())', async () => {
    const record = snapshot([item('q-1')])
    const { deps, writes, setRespond } = makeDeps(record)
    setRespond(() => ({ status: 200, json: async () => ({ ok: true, results: [{ id: 'q-1', ok: true }] }) }))

    await drainOutboxHeadless(deps)

    expect(parseWritten(writes[0]).syncHistory[0].syncedAt).toBe(1_700_000_000_000)
  })
})

// ---------------- 4 · the mirror (public/sw.js pinned equal) ----------------

describe('#351 mirror: public/sw.js wires the SAME drain the tested module describes', () => {
  it('the DB constants match lib/outbox-idb.ts exactly (a static script cannot import them)', () => {
    expect(OUTBOX_DB_NAME).toBe('mjengoos-outbox')
    expect(OUTBOX_DB_VERSION).toBe(1)
    expect(OUTBOX_DB_STORE).toBe('kv')
    expect(SW_SOURCE).toContain(`const OUTBOX_DB_NAME = '${OUTBOX_DB_NAME}'`)
    expect(SW_SOURCE).toContain(`const OUTBOX_DB_VERSION = ${OUTBOX_DB_VERSION}`)
    expect(SW_SOURCE).toContain(`const OUTBOX_DB_STORE = '${OUTBOX_DB_STORE}'`)
    // The worker opens/creates the same store the app's kv uses.
    expect(SW_SOURCE).toContain('if (!db.objectStoreNames.contains(OUTBOX_DB_STORE)) db.createObjectStore(OUTBOX_DB_STORE)')
  })

  it('the record key is the owner store\'s persist key — the SW reads exactly what the app wrote', () => {
    expect(OUTBOX_DB_RECORD_KEY).toBe(MJENGO_STORE_KEY)
    expect(MJENGO_STORE_KEY).toBe('mjengo-os-store')
    expect(SW_SOURCE).toContain(`const OUTBOX_DB_RECORD_KEY = '${OUTBOX_DB_RECORD_KEY}'`)
  })

  it('the sw.js allowlist equals the canonical HEADLESS_DRAIN_TYPES (drift is pinned dead)', () => {
    const match = SW_SOURCE.match(/const HEADLESS_DRAIN_TYPES = \[([^]*?)\]/)
    expect(match).not.toBeNull()
    const swList = (match![1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    expect(swList).toEqual([...HEADLESS_DRAIN_TYPES])
  })

  it('the sw.js refusal messages + the §40/#132 mirror constants equal the canonical values', () => {
    expect(SW_SOURCE).toContain(`const HEADLESS_AUTH_BLOCKED_MESSAGE = '${HEADLESS_AUTH_BLOCKED_MESSAGE}'`)
    expect(SW_SOURCE).toContain(`const HEADLESS_SERVER_REFUSAL_MESSAGE = '${HEADLESS_SERVER_REFUSAL_MESSAGE}'`)
    // SYNC_HISTORY_CAP + the #132 cadence mirror lib/outbox.ts.
    expect(SYNC_HISTORY_CAP).toBe(50)
    expect(AUTO_RETRY_MAX_ATTEMPTS).toBe(3)
    expect(AUTO_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000])
    expect(SW_SOURCE).toContain(`const SYNC_HISTORY_CAP = ${SYNC_HISTORY_CAP} // mirrors lib/outbox.ts`)
    expect(SW_SOURCE).toContain(`const AUTO_RETRY_MAX_ATTEMPTS = ${AUTO_RETRY_MAX_ATTEMPTS} // mirrors lib/outbox.ts`)
    expect(SW_SOURCE).toContain('const AUTO_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] // mirrors lib/outbox.ts')
  })

  it('the sync handler: open clients are ASKED to drain; no client → the headless drain runs', () => {
    expect(SW_SOURCE).toContain('self.clients.matchAll({ type: \'window\', includeUncontrolled: true })')
    expect(SW_SOURCE).toContain('if (windowClients.length > 0) {')
    expect(SW_SOURCE).toContain('client.postMessage({ type: DRAIN_REQUEST_MESSAGE_TYPE })')
    expect(SW_SOURCE).toContain('await drainOutboxHeadlessSw()')
  })

  it('the honest refusal lines are documented in the worker (money waits for a tab; the legacy queue is app-side)', () => {
    expect(SW_SOURCE).toContain('WHAT STILL REFUSES HEADLESS')
    expect(SW_SOURCE).toContain('never a money movement')
    expect(SW_SOURCE).toContain('the LEGACY localStorage queue (pre-#351 installs)')
  })
})
