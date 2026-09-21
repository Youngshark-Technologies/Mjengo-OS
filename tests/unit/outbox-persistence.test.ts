/**
 * #192/#337/#351 — outbox persistence hardening, pinned behaviorally on the
 * REAL use-mjengo store running against a FAKE indexedDB (the #351 medium —
 * the zustand `createJSONStorage` seam is what production uses; the store
 * module is imported dynamically AFTER the globals are stubbed so the
 * guarded adapter actually engages; in plain node the same typeof guard
 * keeps the adapter inert, byte-identical to the pre-#192 default storage).
 *
 * The scenarios, end to end:
 *   · a QuotaExceededError on the medium's put used to propagate straight
 *     out of set() (persist floats storage.setItem inside every setState):
 *     the running action broke, the in-memory store kept queueing, and
 *     every mutation was silently one tab-close from loss. Pinned now: the
 *     adapter CATCHES it, the action completes fully, and the
 *     persistDegraded flag flips (the app.tsx banner's source);
 *   · the queue-only fallback: when the full write does not fit but a
 *     data-less one does, the irreplaceable part (the mutation queue)
 *     still banks — `data` is re-fetchable, the queue is not;
 *   · recovery: a later successful full write self-heals the flags;
 *   · the #351 medium itself: offline-queued items are in the indexedDB
 *     record the service worker reads, a relaunch rehydrates them
 *     drainable, and an UNREADABLE medium (private-mode open refusal)
 *     surfaces as degradation — never a crash, never silent;
 *   · the #351 LEGACY ADOPTION: a pre-#351 install's localStorage snapshot
 *     is read through on first run, migrated, and the legacy key cleared
 *     only after the migrated write lands (a failed write keeps it — no
 *     silent data loss); a kv record that already exists is never
 *     re-adopted;
 *   · cross-tab: #351 replaced the localStorage `storage` event (indexedDB
 *     has none) with a foreground re-read (visibilitychange/focus) — the
 *     debounced rehydrate is pinned, and an orphaned 'syncing' item from a
 *     mid-drain snapshot returns to 'pending' instead of stranding forever;
 *   · the #192 bounding decision is pinned, not faked: `data` STAYS
 *     persisted (the offline boot serves it — issue #78), the payload is
 *     measured against a documented budget, and the outbox stays unbounded
 *     by design (spec §52: the live queue is never pruned);
 *   · wiring source pins (app.tsx banner + hydration hold, panel
 *     device-local note, the guarded adapter + foreground listeners) +
 *     EN/SW dictionary parity for every new user-facing key.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import { FakeIndexedDB } from './fake-indexeddb'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'
import type { OutboxItem } from '@/frontend/hooks/use-mjengo'

// ---------------- the fake media (the #351 medium + the legacy one) ----------------

/** The indexedDB double the owner store now persists through (#351). */
const fakeIdb = new FakeIndexedDB()

/** The LEGACY localStorage double (pre-#351 installs adopt from it). */
class FakeLocalStorage {
  store = new Map<string, string>()

  getItem(k: string): string | null {
    return this.store.has(k) ? this.store.get(k)! : null
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v))
  }
  removeItem(k: string): void {
    this.store.delete(k)
  }
}
const legacy = new FakeLocalStorage()

// Both media must exist BEFORE the store module is imported: the #192/#351
// adapter's typeof guards decide at persist() creation whether storage is real.
vi.stubGlobal('indexedDB', fakeIdb)
vi.stubGlobal('localStorage', legacy)

const {
  useMjengo,
  MJENGO_STORE_KEY,
  shouldRehydrateFromForeground,
  handleCrossTabForegroundSignal,
  CROSS_TAB_REHYDRATE_DEBOUNCE_MS,
} = await import('@/frontend/hooks/use-mjengo')
const { OUTBOX_DB_NAME, OUTBOX_DB_STORE } = await import('@/frontend/lib/outbox-idb')

// ---------------- helpers (outbox-auth-drain conventions) ----------------

/** A queued outbox item in the §40 'pending' state. */
function queuedItem(n: number): OutboxItem {
  return {
    id: `q-${n}`,
    type: 'attendance.checkin',
    payload: { workerId: `w-${n}` },
    label: `Check in worker ${n}`,
    createdAt: Date.now(),
    projectId: 'pl-1',
    syncStatus: 'pending',
    retryCount: 0,
  }
}

/** Minimal owner ProjectPayload the optimistic reducers can chew (attendance path). */
function smallData(paddingTransactions = 60): unknown {
  return {
    project: { id: 'pl-1', name: 'Hardening Site', client: 'Amina', clientType: 'individual', location: 'Nairobi', status: 'active', startDate: '2026-01-05', targetDate: '2026-06-30', budget: 2_500_000, shareToken: null },
    phases: [],
    workers: [{
      id: 'w-1', projectId: 'pl-1', name: 'Juma', role: 'Fundi', phone: '0700000000', dailyRate: 1_200, active: true,
      attendances: [],
      todayStatus: { status: null, checkIn: null, checkOut: null, method: null, wage: 0, paid: false },
      weekEarnings: 0,
    }],
    materials: [], deliveries: [], consumptions: [], photos: [], alerts: [], recaps: [],
    // padding: a realistic transactions ledger so `data` dominates the
    // persisted size (the queue-only fallback's reason to exist).
    transactions: Array.from({ length: paddingTransactions }, (_, i) => ({
      id: `tx-${i}`, projectId: 'pl-1', type: 'material', amount: 4_500 + i, method: 'mpesa',
      reference: `QGH${100000 + i}`, note: `Cement and ballast delivery ${i} for the foundation works`,
      date: `2026-02-${String((i % 27) + 1).padStart(2, '0')}`, createdAt: `2026-02-${String((i % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
    })),
    summary: { budgetTotal: 2_500_000, budgetSpent: 0, budgetSpentPct: 0, materialSpend: 0, wagesToday: 0, wagesUnpaid: 0, fundisExpected: 1, fundisToday: 0, progressPct: 0, unackedAlerts: 0 },
    escrow: null, milestones: [], variations: [], zones: [], notifications: [], auditEvents: [], photoComments: [],
    land: { parcels: [] }, professionals: { team: [] }, supply: { deliveries: [], rfqs: [], quotes: [], orders: [] },
    invoices: { invoices: [] }, intel: { flags: {} }, inventory: { items: [] }, boq: { items: [] }, finance: { wallets: [] }, drawPacks: [],
  }
}

/**
 * A representative LARGE project payload for the #192 size budget — the
 * honest upper-middle of a 6-month, 120-fundi site at demo scale (the
 * server's reads are take-capped, #105/#154/#155: the roster caps
 * phases/transactions/workers/photos at 200-500 and the detail payload's
 * lifetime scans are bounded by the project's own rows). This models the
 * biggest shape the record can honestly carry; the budget assertion below
 * documents the measured ceiling.
 */
function largeProjectPayload(): unknown {
  const d = (n: number) => new Date(Date.UTC(2026, 0, 1 + Math.floor(n / 24), n % 24)).toISOString()
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)
  return {
    project: { id: 'pl-1', name: 'Riverside Maisonette', client: 'Amina Otieno', clientType: 'individual', location: 'Karen, Nairobi', status: 'active', startDate: d(0), targetDate: d(4000), budget: 8_500_000, shareToken: 'share-large' },
    phases: range(30).map((p) => ({
      id: `ph-${p}`, projectId: 'pl-1', name: `Phase ${p + 1} — structure and finishing`, order: p + 1,
      budget: 280_000, status: 'in_progress', progressManual: 45, progress: 45, createdAt: d(p), updatedAt: d(p + 50),
      tasks: range(15).map((t) => ({
        id: `t-${p}-${t}`, phaseId: `ph-${p}`, title: `Task ${p + 1}.${t + 1} — slab formwork, rebar tying and concrete pour`,
        status: 'in_progress', progress: 40, dueDate: null, version: 3, blockedReason: null, createdAt: d(t), updatedAt: d(t + 10),
      })),
    })),
    workers: range(120).map((w) => ({
      id: `w-${w}`, projectId: 'pl-1', name: `Fundi Waaminifu ${w + 1}`, role: 'Mwisho (Finisher)', phone: '+254711000000',
      dailyRate: 1_400, active: true, weekEarnings: 8_400,
      todayStatus: { status: 'present', checkIn: d(9), checkOut: null, method: 'geofence', wage: 1_400, paid: false, verification: 'verified', exceptionReason: null },
      attendances: range(45).map((a) => ({
        id: `att-${w}-${a}`, workerId: `w-${w}`, projectId: 'pl-1',
        date: `2026-0${(a % 9) + 1}-${String((a % 27) + 1).padStart(2, '0')}`,
        status: 'present', wage: 1_400, paid: a < 40, method: 'geofence', verification: 'verified', version: 2, exceptionReason: null, createdAt: d(a),
      })),
    })),
    materials: range(250).map((m) => ({
      id: `m-${m}`, projectId: 'pl-1', name: `Material ${m} — certified batch`, unit: 'bag', unitPrice: 850,
      deliveredQty: 400 + m, deliveredCost: 340_000 + m, consumedQty: 120 + m, onSiteQty: 280 + m, stockValue: 238_000 + m,
      lowStock: false, deliveries: range(3).map((i) => ({ id: `dl-${m}-${i}`, quantity: 100 + i, unitCost: 850, totalCost: 85_000, supplier: 'Bamburi', date: d(m + i), source: 'manual', rawTranscript: null, createdAt: d(m + i) })),
      createdAt: d(m), updatedAt: d(m + 20),
    })),
    deliveries: range(600).map((i) => ({
      id: `dlx-${i}`, projectId: 'pl-1', materialId: `m-${i % 250}`, quantity: 120, unitCost: 850, totalCost: 102_000,
      supplier: `Supplier ${i % 12}`, date: d(i), source: 'whatsapp', rawTranscript: 'Ametuma lori la cement 120 bags asubuhi', createdAt: d(i),
    })),
    consumptions: range(400).map((i) => ({
      id: `cn-${i}`, projectId: 'pl-1', materialId: `m-${i % 250}`, quantity: 30, materialName: 'Material', unit: 'bag',
      phaseName: `Phase ${(i % 30) + 1}`, date: d(i), note: 'Slab pour', createdAt: d(i),
    })),
    photos: range(600).map((i) => ({
      id: `ph-${i}`, projectId: 'pl-1', phaseId: `ph-${i % 30}`, url: `/photos/photo-${i}-a1b2c3d4e5f6.webp`,
      caption: `Site progress — ${i}: slab curing, formwork stripped`, progressPct: i % 100, aiAnalysis: { structural: 'ok', safety: 'helmet worn' },
      createdAt: d(i), updatedAt: d(i),
    })),
    alerts: range(200).map((i) => ({ id: `al-${i}`, projectId: 'pl-1', type: 'budget', severity: 'warning', message: `Budget threshold alert ${i}`, acknowledged: i % 2 === 0, createdAt: d(i) })),
    transactions: range(800).map((i) => ({
      id: `tx-${i}`, projectId: 'pl-1', type: i % 2 ? 'material' : 'wage', amount: 4_500 + (i % 900), method: i % 3 ? 'mpesa' : 'cash',
      reference: `QGH${100000 + i}`, note: `Payment for works batch ${i}`, date: d(i), createdAt: d(i),
    })),
    recaps: range(5).map((i) => ({ id: `rc-${i}`, projectId: 'pl-1', week: `2026-W${i + 10}`, summary: 'Steady progress on structure', createdAt: d(i * 24) })),
    summary: { budgetTotal: 8_400_000, budgetSpent: 3_100_000, budgetSpentPct: 37, materialSpend: 2_200_000, wagesToday: 168_000, wagesUnpaid: 24_000, fundisExpected: 120, fundisToday: 116, progressPct: 41, unackedAlerts: 7 },
    escrow: { id: 'es-1', projectId: 'pl-1', balance: 1_200_000, createdAt: d(0), updatedAt: d(100) },
    milestones: range(100).map((i) => ({ id: `ms-${i}`, projectId: 'pl-1', title: `Milestone ${i + 1} — payment and inspection`, amount: 120_000, status: i % 3 ? 'pending' : 'release_requested', createdAt: d(i) })),
    variations: range(60).map((i) => ({ id: `vr-${i}`, projectId: 'pl-1', title: `Variation ${i} — extra retaining wall`, budgetImpact: 80_000, status: 'submitted', createdAt: d(i) })),
    zones: range(50).map((i) => ({ id: `zn-${i}`, projectId: 'pl-1', name: `Zone ${i}`, x: i, y: i % 40, w: 20, h: 14, createdAt: d(i) })),
    notifications: range(60).map((i) => ({ id: `nt-${i}`, projectId: 'pl-1', type: 'sync', title: `Notification ${i}`, body: 'Queued actions synced', read: i % 2 === 0, createdAt: d(i) })),
    auditEvents: range(200).map((i) => ({ id: `ae-${i}`, projectId: 'pl-1', action: `task.update`, actor: `user-${i % 8}`, detail: `Task ${i} progress updated to ${i % 100} percent by the site supervisor`, createdAt: d(i) })),
    photoComments: range(150).map((i) => ({ id: `pc-${i}`, photoId: `ph-${i % 600}`, projectId: 'pl-1', author: 'Amina', role: 'client', message: 'This looks great — proceed', resolved: i % 3 === 0, createdAt: d(i) })),
    land: { parcels: range(3).map((i) => ({ id: `lp-${i}`, titleNo: `LR 2090/${1000 + i}`, sizeHa: 0.4, status: 'verified' })) },
    professionals: { team: range(8).map((i) => ({ id: `pr-${i}`, name: `Professional ${i}`, role: 'engineer', firm: 'Firm Ltd' })) },
    supply: {
      deliveries: range(200).map((i) => ({ id: `sd-${i}`, material: 'Cement 32.5N', qty: 200, supplier: `Supplier ${i % 12}`, date: d(i) })),
      rfqs: range(100).map((i) => ({ id: `rf-${i}`, title: `RFQ ${i} — aggregates`, status: 'open', createdAt: d(i) })),
      quotes: range(100).map((i) => ({ id: `qt-${i}`, rfqId: `rf-${i}`, amount: 210_000, status: 'submitted' })),
      orders: range(100).map((i) => ({ id: `po-${i}`, quoteId: `qt-${i}`, status: 'delivered', total: 210_000 })),
    },
    invoices: { invoices: range(50).map((i) => ({ id: `in-${i}`, number: `INV-2026-${i}`, amount: 340_000, status: 'paid', issuedAt: d(i) })) },
    intel: { flags: { money: true, finder: true } },
    inventory: { items: range(100).map((i) => ({ id: `iv-${i}`, name: `Tool ${i}`, qty: 5 + i, unit: 'pcs', condition: 'good' })) },
    boq: { items: range(150).map((i) => ({ id: `bq-${i}`, description: `BOQ line ${i} — reinforcement steel Y12`, qty: 40, unit: 'm', rate: 1_200 })) },
    finance: { wallets: range(3).map((i) => ({ id: `fw-${i}`, label: `M-Pesa till ${i}`, balance: 250_000 })) },
    drawPacks: range(10).map((i) => ({ id: `dp-${i}`, milestoneId: `ms-${i}`, status: 'frozen', hash: `sha256-${i}` })),
  }
}

function resetStore(overrides: Record<string, unknown> = {}) {
  useMjengo.setState({
    online: true,
    syncing: false,
    viewMode: 'owner',
    outbox: [queuedItem(1), queuedItem(2)],
    syncHistory: [],
    lastSyncAt: null,
    persistDegraded: false,
    persistQueueOnly: false,
    data: smallData() as never,
    ...overrides,
  } as never)
}

const state = () => useMjengo.getState()
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
/** The persisted record, as the service worker reads it (#351). */
const persisted = () => JSON.parse(fakeIdb.record(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY)!) as {
  state: { outbox: OutboxItem[]; data: unknown } & Record<string, unknown>
  version?: number
}
/**
 * Settle the ASYNC medium: the serialized kv chain + the guarded fallback +
 * the health-flag flip (which is itself a setState → one more write) all
 * run as microtasks/macrotasks after the triggering action returned. Two
 * macrotask rounds cover the deepest chain (including the TDZ-deferred
 * health report from a module-init write).
 */
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
/** One macrotask — enough for a fresh module's hydration to finish. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** Real-time sleep — the debounce tests below deliberately avoid fake timers (an aborted fake-timer test would leave the setTimeout stub installed and poison every later hook). */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Captured BEFORE any test stubs it — afterEach restores fetch to THIS, so
// per-test fetch doubles never leak (vi.unstubAllGlobals is NOT an option
// here: it would also remove the module-scoped media stubs the store was
// created against).
const originalFetch = globalThis.fetch

beforeEach(async () => {
  vi.clearAllMocks()
  // A clean device before every scenario: quota off, boundary at infinity,
  // no records, no legacy key. resetStore's own write is flushed so tests
  // that place a quota boundary start from a known on-disk baseline.
  fakeIdb.quotaExceeded = false
  fakeIdb.quotaBytes = Number.POSITIVE_INFINITY
  fakeIdb.openRefused = false
  fakeIdb.clearRecords()
  legacy.store.clear()
  resetStore()
  await flush()
})

afterEach(() => {
  vi.useRealTimers() // safety net: an aborted fake-timer test must not poison later hooks
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', originalFetch)
})

// ---------------- quota / private-mode write failures ----------------

describe('#192/#351: a failing medium write is caught, the action survives, degradation is LOUD', () => {
  it('offline dispatch under a hard quota never throws, still queues optimistically, and flips persistDegraded', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    resetStore({ online: false, outbox: [] })
    await flush()
    fakeIdb.quotaExceeded = true

    // Before #192 this rejected: persist floats storage.setItem inside
    // set(), so the QuotaExceededError broke the dispatch mid-flight.
    await expect(
      state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present'),
    ).resolves.toBe(true)
    await flush()

    expect(state().outbox).toHaveLength(1) // queued in memory (the source of truth)
    expect(state().outbox[0].syncStatus).toBe('pending')
    expect(state().data).not.toBeNull() // the optimistic write still applied
    expect(state().persistDegraded).toBe(true) // the banner's source flag
    expect(state().persistQueueOnly).toBe(false)
    // The failure is surfaced at the console seam too (never swallowed).
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('persistence write failed'), expect.any(Error))
    // And nothing new reached the medium — it is still the last good write.
    expect(persisted().state.outbox).toHaveLength(0)
  })

  it('the online-when-network-lies branch completes fully under quota (queued toast fires — the action ran to the end)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetStore({ online: true, outbox: [] })
    await flush()
    fakeIdb.quotaExceeded = true
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    await expect(
      state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'half_day' }, 'Mark half day'),
    ).resolves.toBe(true)
    await flush()

    expect(state().outbox).toHaveLength(1)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'field.savedQueued', { count: 1 }))
    expect(state().persistDegraded).toBe(true)
  })

  it('private-mode hard failure keeps the in-memory store fully functional across many writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeIdb.quotaExceeded = true

    for (let i = 0; i < 5; i++) {
      useMjengo.setState({ outbox: [...state().outbox, queuedItem(100 + i)] } as never)
    }
    await flush()
    expect(state().outbox).toHaveLength(7)
    expect(state().persistDegraded).toBe(true)
    expect(state().persistQueueOnly).toBe(false)
    // Nothing NEW reached the medium — the record still holds the LAST GOOD
    // snapshot (2 items from the pre-quota write), which is exactly what the
    // banner announces: work after that point is memory-only.
    expect(persisted().state.outbox).toHaveLength(2)
  })

  it('an unreadable medium (private-mode open refusal) surfaces as degradation — never a crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A fresh install whose medium refuses the open entirely: hydration
    // fails (the #192 onRehydrateStorage error arm) AND every write fails
    // (the guarded catch) — the app still boots and queues in memory.
    vi.resetModules()
    fakeIdb.clearRecords()
    fakeIdb.openRefused = true
    const { useMjengo: fresh } = await import('@/frontend/hooks/use-mjengo')
    await tick()
    await tick()

    expect(fresh.getState().persistDegraded).toBe(true)
    fresh.setState({ online: false, outbox: [] } as never)
    await expect(
      fresh.getState().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present'),
    ).resolves.toBe(true)
    await tick()
    expect(fresh.getState().outbox).toHaveLength(1) // the queue lives in memory
    fakeIdb.openRefused = false
  })
})

// ---------------- the queue-only fallback (the bounding decision's teeth) ----------------

describe('#192/#351: the queue-only fallback banks the irreplaceable part', () => {
  it('when the full write does not fit but a data-less one does, the queue reaches disk without data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Baseline: a successful full write so we can place the quota boundary
    // BETWEEN the full and the slimmed serialized sizes.
    resetStore({ outbox: [queuedItem(1)] })
    await flush()
    const full = fakeIdb.record(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY)!
    const slim = JSON.stringify({ ...JSON.parse(full), state: { ...JSON.parse(full).state, data: null } })
    expect(full.length).toBeGreaterThan(slim.length + 1_000) // data genuinely dominates
    fakeIdb.quotaBytes = slim.length + Math.floor((full.length - slim.length) / 2)

    // One more queued action under the boundary → full write throws, the
    // fallback (data dropped) fits.
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present')
    await flush()

    expect(state().outbox).toHaveLength(2)
    expect(state().persistQueueOnly).toBe(true)
    expect(state().persistDegraded).toBe(false)
    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(2) // the queue banked
    expect(onDisk.state.data).toBeNull() // the re-fetchable slice dropped
  })

  it('a later successful FULL write self-heals the flags (the banner clears)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeIdb.quotaExceeded = true
    useMjengo.setState({ online: true } as never)
    await flush()
    expect(state().persistDegraded).toBe(true)

    // Storage freed up (or the private window ended).
    fakeIdb.quotaExceeded = false
    fakeIdb.quotaBytes = Number.POSITIVE_INFINITY
    useMjengo.setState({ online: false } as never)
    await flush()

    expect(state().persistDegraded).toBe(false)
    expect(state().persistQueueOnly).toBe(false)
    expect(persisted().state.data).not.toBeNull() // the full payload is back on the medium
  })
})

// ---------------- the #351 medium: ordering + restart durability ----------------

describe('#351: the indexedDB record — ordering, restart durability, the size budget', () => {
  it('dispatches persist in queue order (FIFO — the drain replays them in the order they happened)', async () => {
    resetStore({ online: false, outbox: [] })
    await flush()
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present')
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'absent' }, 'Mark absent')
    await flush()

    expect(persisted().state.outbox.map((o) => o.payload.status)).toEqual(['present', 'absent'])
  })

  it('restart verification: offline-queued items are on the medium and a rehydrate restores them drainable', async () => {
    resetStore({ online: false, outbox: [] })
    await flush()
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present')
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'absent' }, 'Mark absent')
    await flush()

    // What a relaunch boots from (the "kill the app" step, at the storage level).
    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(2)
    expect(onDisk.version).toBe(2)
    expect(onDisk.state.data).not.toBeNull() // offline READS survive too (issue #78)

    // The relaunch: memory empty, record intact → rehydrate → queue restored.
    const bytes = fakeIdb.record(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY)!
    useMjengo.setState({ outbox: [], data: null } as never)
    await flush() // the memory-reset's own (empty) write settles FIRST…
    fakeIdb.setRecord(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY, bytes) // …then the app died AFTER this write
    await useMjengo.persist.rehydrate()

    expect(state().outbox).toHaveLength(2)
    expect(state().outbox.every((o) => o.syncStatus === 'pending')).toBe(true)
    expect(state().data).not.toBeNull()
  })

  it('the persisted payload for a representative large project + 100 queued actions stays under the documented budget', async () => {
    // DOCUMENTED BUDGET (#192, unchanged by the #351 medium move —
    // indexedDB origin quotas are far larger, but the budget is a payload
    // bound, not a medium bound): 4 MB for the mjengo-os-store record, so
    // the record stays in the honest upper-middle of what a low-storage
    // device can hydrate quickly. The sample below measures ~2 MB; the
    // floor assertion keeps the sample honest (a generator that silently
    // shrinks cannot keep the budget vacuous).
    const MJENGO_PERSIST_BUDGET_BYTES = 4_000_000
    const SAMPLE_FLOOR_BYTES = 1_000_000

    resetStore({
      data: largeProjectPayload() as never,
      outbox: Array.from({ length: 100 }, (_, i) => queuedItem(i + 1)),
    })
    await flush()

    const raw = fakeIdb.record(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY)!
    expect(raw).not.toBeNull()
    const bytes = Buffer.byteLength(raw, 'utf8')
    expect(bytes, `persisted payload ${bytes} bytes must stay under the 4 MB budget`).toBeLessThan(MJENGO_PERSIST_BUDGET_BYTES)
    expect(bytes, `the large-project sample (${bytes} bytes) must stay genuinely large`).toBeGreaterThan(SAMPLE_FLOOR_BYTES)
    // The offline-boot invariant (the bounding decision): data rides along.
    expect(persisted().state.data).not.toBeNull()
  })

  it('partialize keeps `data` in the persisted record — the documented bounding decision (offline boot serves it)', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(src).toContain("export const MJENGO_STORE_KEY = 'mjengo-os-store'")
    expect(src).toContain('storage: createJSONStorage(')
    // The decision pin: removing `data` from persistence (a tempting "fix")
    // would break every offline read (issue #78 shouldOfflineBoot) — this
    // pin fails loudly if that ever happens without a new decision.
    expect(src).toMatch(/partialize: \(s\) => \(\{[^]*data: s\.data,/)
  })
})

// ---------------- the #351 legacy adoption (localStorage → indexedDB) ----------------

describe('#351: legacy localStorage adoption — read-through, migrate, clear only after the write lands', () => {
  /** A pre-#351 (v1) localStorage snapshot: 2 queued items, version 1. */
  const legacySnapshot = () => JSON.stringify({
    state: {
      online: false,
      outbox: [queuedItem(1), { ...queuedItem(2), syncStatus: undefined as unknown as OutboxItem['syncStatus'] }],
      syncHistory: [],
      data: null,
      lastSyncAt: 123,
      activeProjectId: 'pl-1',
      shareToken: null,
      dataMode: 'normal',
    },
    version: 1,
  })

  it('first run with a legacy key and an empty kv: the snapshot is adopted, migrated to v2, and the legacy key cleared', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.resetModules()
    fakeIdb.clearRecords()
    legacy.store.set(MJENGO_STORE_KEY, legacySnapshot())

    const { useMjengo: fresh } = await import('@/frontend/hooks/use-mjengo')
    await tick()
    await tick()

    // The queue survived the upgrade — migrated to the v2 §40 lifecycle.
    expect(fresh.getState().outbox).toHaveLength(2)
    expect(fresh.getState().outbox.every((o) => o.syncStatus === 'pending')).toBe(true)
    // The record on the NEW medium is the migrated v2 snapshot.
    const onDisk = persisted()
    expect(onDisk.version).toBe(2)
    expect(onDisk.state.outbox).toHaveLength(2)
    // The legacy key did its job and is gone (cleared only AFTER the write).
    expect(legacy.getItem(MJENGO_STORE_KEY)).toBeNull()
    // Both adoption steps are logged (never silent).
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('adopting the legacy localStorage outbox snapshot'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('legacy localStorage key cleared'))
  })

  it('a failed adoption write keeps the legacy key — the on-disk fallback survives (no silent data loss)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.resetModules()
    fakeIdb.clearRecords()
    legacy.store.set(MJENGO_STORE_KEY, legacySnapshot())
    fakeIdb.quotaExceeded = true // even the slimmed write will not fit

    const { useMjengo: fresh } = await import('@/frontend/hooks/use-mjengo')
    await tick()
    await tick()

    // The session still runs on the adopted state (in-memory)…
    expect(fresh.getState().outbox).toHaveLength(2)
    expect(fresh.getState().persistDegraded).toBe(true) // …and says so loudly
    // …but nothing reached the new medium, so the legacy key STAYS as the
    // on-disk record — the next launch can adopt again.
    expect(fakeIdb.record(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY)).toBeNull()
    expect(legacy.getItem(MJENGO_STORE_KEY)).not.toBeNull()
  })

  it('a kv record that already exists is never re-adopted (the legacy key is inert, not resurrected)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    // Steady state: the kv holds a v2 record (written by a previous run)…
    resetStore({ outbox: [queuedItem(7)] })
    await flush()
    expect(persisted().state.outbox).toHaveLength(1)
    // …while a stale legacy key lingers (e.g. its removal was refused once).
    legacy.store.set(MJENGO_STORE_KEY, legacySnapshot())

    vi.resetModules()
    const { useMjengo: fresh } = await import('@/frontend/hooks/use-mjengo')
    await tick()
    await tick()

    // Hydration read the KV record, not the legacy snapshot…
    expect(fresh.getState().outbox.map((o) => o.id)).toEqual(['q-7'])
    // …and the legacy key was neither cleared nor adopted.
    expect(legacy.getItem(MJENGO_STORE_KEY)).not.toBeNull()
    expect(persisted().state.outbox).toHaveLength(1)
  })
})

// ---------------- multi-surface coordination (the #351 foreground re-read) ----------------

describe('#192/#351: cross-tab rehydration (debounced foreground re-read)', () => {
  it('shouldRehydrateFromForeground: only a return to visibility re-reads (a background surface has nothing to re-read for)', () => {
    expect(shouldRehydrateFromForeground('visible')).toBe(true)
    expect(shouldRehydrateFromForeground('hidden')).toBe(false)
    expect(shouldRehydrateFromForeground('prerender')).toBe(false)
    expect(shouldRehydrateFromForeground('unloaded')).toBe(false)
  })

  it('a foreground signal rehydrates after the debounce — the peer snapshot becomes ours', async () => {
    const rehydrateSpy = vi.spyOn(useMjengo.persist, 'rehydrate')
    resetStore({ outbox: [queuedItem(1)] })
    await flush()
    const before = state().outbox.length

    // The OTHER surface (PWA window vs browser tab) writes a newer
    // snapshot: one extra queued item. Direct record write — same-surface
    // writes never trigger their own foreground signal.
    fakeIdb.setRecord(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY, JSON.stringify({
      state: {
        online: true, outbox: [queuedItem(1), queuedItem(2)], syncHistory: [],
        data: null, lastSyncAt: 456, activeProjectId: 'pl-1', shareToken: null, dataMode: 'normal',
      },
      version: 2,
    }))

    handleCrossTabForegroundSignal()
    expect(state().outbox).toHaveLength(before) // debounced: not yet
    await sleep(CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)
    expect(rehydrateSpy).toHaveBeenCalledTimes(1)
    expect(state().outbox).toHaveLength(before + 1) // the peer's newer queue is ours now
    rehydrateSpy.mockRestore()
  })

  it('bursts of foreground signals coalesce into ONE rehydrate', async () => {
    const rehydrateSpy = vi.spyOn(useMjengo.persist, 'rehydrate')
    resetStore({ outbox: [queuedItem(1)] })
    await flush()

    handleCrossTabForegroundSignal()
    handleCrossTabForegroundSignal()
    handleCrossTabForegroundSignal()
    await sleep(CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)

    expect(rehydrateSpy).toHaveBeenCalledTimes(1)
    rehydrateSpy.mockRestore()
  })

  it('an orphaned syncing item from a peer mid-drain snapshot returns to pending (un-stranded, drainable)', async () => {
    resetStore({ outbox: [queuedItem(1)] })
    await flush()
    // A snapshot written while the OTHER surface was mid-drain: the item
    // is 'syncing' on disk, but no drain owns it here. Before #192 this
    // item stranded forever — syncNow only drains 'pending'. (The same
    // rule covers a service-worker HEADLESS drain that lands while this
    // surface rehydrates — the orphan normalization runs after every
    // rehydrate.)
    fakeIdb.setRecord(OUTBOX_DB_NAME, OUTBOX_DB_STORE, MJENGO_STORE_KEY, JSON.stringify({
      state: {
        online: true,
        outbox: [queuedItem(1), { ...queuedItem(9), syncStatus: 'syncing' }],
        syncHistory: [], data: null, lastSyncAt: 789, activeProjectId: 'pl-1', shareToken: null, dataMode: 'normal',
      },
      version: 2,
    }))

    handleCrossTabForegroundSignal()
    // The debounce (250ms) plus the deferred orphan-normalization tick
    // (0ms after the merge) both settle well inside this sleep — the
    // assertion is the OUTCOME: the orphan is back to drainable 'pending'.
    await sleep(CROSS_TAB_REHYDRATE_DEBOUNCE_MS + 60)

    expect(state().outbox).toHaveLength(2)
    expect(state().outbox.find((o) => o.id === 'q-9')?.syncStatus).toBe('pending')
  })
})

// ---------------- wiring + copy (source pins, house style) ----------------

describe('#192/#351: wiring — the degradation is reachable end to end', () => {
  it('app.tsx renders the persistence banner from the health flags', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('persistDegraded, persistQueueOnly,')
    expect(src).toContain('(persistDegraded || persistQueueOnly) && !isClientSurface')
    expect(src).toContain("t('app.persist.degraded')")
    expect(src).toContain("t('app.persist.queueOnly')")
    expect(src).toContain("role={persistDegraded ? 'alert' : 'status'}")
  })

  it('app.tsx holds the boot skeleton until the async indexedDB hydration finishes (never flashes login)', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    // #388: the gate is the extracted useStoreHydrationGate hook — the
    // THREE ordering contracts (finished-before-render / the race window /
    // finished-after-effect) are behaviorally pinned by
    // tests/dom/store-hydration-gate.test.ts; these source pins assert the
    // APP'S wiring: the gate consumes the store's persist API and the boot
    // hold consults it.
    expect(src).toContain('useStoreHydrationGate((useMjengo as unknown as { persist?: MjengoPersistApi }).persist)')
    expect(src).toContain('export function useStoreHydrationGate(persistApi: MjengoPersistApi | undefined): boolean')
    // The #388 race fix itself: the gate reads the persist API through
    // useSyncExternalStore — subscribe = onFinishHydration, snapshot =
    // hasHydrated, SSR = inert-true. The three orderings are pinned
    // behaviorally by tests/dom/store-hydration-gate.test.ts.
    expect(src).toContain('useSyncExternalStore(')
    expect(src).toContain('persistApi.onFinishHydration(onChange) ?? (() => {})')
    expect(src).toContain('() => (persistApi ? persistApi.hasHydrated() : true)')
    expect(src).toContain("if ((status === 'loading' || !storeHydrated) && !offlineBoot)")
  })

  it('the outbox sheet states the device-local honesty line', () => {
    const src = readSrc('src/frontend/mjengo/sync-outbox-panel.tsx')
    expect(src).toContain("t('outbox.deviceLocal')")
  })

  it('use-mjengo wires the guarded adapter on the indexedDB medium and the foreground re-read listeners', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    // The guarded seam (quota caught at the zustand storage adapter) on the
    // #351 medium, with the re-fetchable slice as the fallback's drop.
    expect(src).toContain('const guardedOutboxIdbStorage = createGuardedStorage({')
    expect(src).toContain('storage: createIndexedDbStateStorage(createIndexedDbKvStore())')
    expect(src).toContain("droppableSlice: 'data'")
    // The medium guard keeps node/SSR inert (no phantom indexedDB).
    expect(src).toContain("if (typeof indexedDB === 'undefined') throw new Error('indexedDB unavailable')")
    // The persist version moved to 2 (the medium migration).
    expect(src).toContain('version: 2')
    // Multi-surface: the foreground re-read rehydrates (debounced).
    expect(src).toContain("window.addEventListener('focus', handleCrossTabForegroundSignal)")
    expect(src).toContain("document.addEventListener('visibilitychange'")
    expect(src).toContain('void useMjengo.persist.rehydrate()')
    // The orphan normalization is wired at the rehydrate seam.
    expect(src).toMatch(/orphaned[^]*syncStatus === 'syncing' \? \{ \.\.\.o, syncStatus: 'pending' as const \} : o/)
  })

  it('every new user-facing key exists in BOTH dictionaries with real copy', () => {
    const keys = [
      'app.persist.degraded',
      'app.persist.queueOnly',
      'outbox.deviceLocal',
    ]
    const enKeys = new Set(Object.keys(enDict))
    const swKeys = new Set(Object.keys(swDict))
    for (const key of keys) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
    // The banner copy renders real sentences in both languages (not the
    // key-fallback a missing entry would produce).
    expect(translate(enDict, 'app.persist.degraded'))
      .toBe("Can't save your offline changes — this device's storage is full. Keep this app open; your work will sync when you're back online.")
    expect(translate(swDict, 'app.persist.degraded'))
      .toBe('Mabadiliko yako ya nje ya mtandao hayawezi kuhifadhiwa — hifadhi ya kifaa hiki imejaa. Baki na programu wazi; kazi yako itasawazishwa ukirudi mtandaoni.')
    expect(translate(enDict, 'app.persist.queueOnly')).toContain('queued actions are still saved')
    expect(translate(swDict, 'outbox.deviceLocal')).toContain('kifaa hiki pekee')
  })
})
