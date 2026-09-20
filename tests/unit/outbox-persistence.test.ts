/**
 * #192 — outbox persistence hardening, pinned behaviorally on the REAL
 * use-mjengo store running against a FAKE localStorage (the zustand
 * `createJSONStorage` seam is what production uses — the store module is
 * imported dynamically AFTER the global is stubbed so the #192 guarded
 * adapter actually engages; in plain node the same typeof guard keeps the
 * adapter inert, byte-identical to the pre-#192 default storage).
 *
 * The scenarios, end to end:
 *   · a QuotaExceededError on setItem used to propagate straight out of
 *     set() (persist calls storage.setItem synchronously inside every
 *     setState): the running action broke, the in-memory store kept
 *     queueing, and every mutation was silently one tab-close from loss.
 *     Pinned now: the adapter CATCHES it, the action completes fully, and
 *     the persistDegraded flag flips (the app.tsx banner's source);
 *   · the queue-only fallback: when the full write does not fit but a
 *     data-less one does, the irreplaceable part (the mutation queue)
 *     still banks — `data` is re-fetchable, the queue is not;
 *   · recovery: a later successful full write self-heals the flags;
 *   · multi-tab: a storage event from another surface rehydrates this one
 *     (debounced last-writer-wins — a CRDT is deliberately NOT wanted, see
 *     the use-mjengo.ts section comment), and an orphaned 'syncing' item
 *     from a mid-drain snapshot returns to 'pending' instead of stranding
 *     forever;
 *   · restart: offline-queued items are on disk and a rehydrate restores
 *     them drainable;
 *   · the #192 bounding decision is pinned, not faked: `data` STAYS
 *     persisted (the offline boot serves it — issue #78), the payload is
 *     measured against a documented budget, and the outbox stays unbounded
 *     by design (spec §52: the live queue is never pruned);
 *   · wiring source pins (app.tsx banner, panel device-local note, the
 *     adapter + storage listener) + EN/SW dictionary parity for every new
 *     user-facing key.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'
import type { OutboxItem } from '@/frontend/hooks/use-mjengo'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'

// ---------------- the fake localStorage (quota-aware) ----------------

/** What the browser gives us: getItem/removeItem + a setItem that can throw. */
class FakeLocalStorage {
  store = new Map<string, string>()
  /** Hard quota / private mode: every write throws. */
  quotaExceeded = false
  /** Soft quota boundary: writes LONGER than this throw (bytes ≈ chars). */
  quotaBytes = Number.POSITIVE_INFINITY

  getItem(k: string): string | null {
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

// The store must be created AFTER the stub exists: the #192 adapter's
// typeof guard decides at persist() creation whether storage is real.
vi.stubGlobal('localStorage', fake)

const {
  useMjengo,
  MJENGO_STORE_KEY,
  shouldRehydrateFromStorageEvent,
  handleCrossTabStorageEvent,
  CROSS_TAB_REHYDRATE_DEBOUNCE_MS,
} = await import('@/frontend/hooks/use-mjengo')

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
 * biggest shape the key can honestly carry; the budget assertion below
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
const persisted = () => JSON.parse(fake.getItem(MJENGO_STORE_KEY)!) as {
  state: { outbox: OutboxItem[]; data: unknown } & Record<string, unknown>
  version?: number
}
// Captured BEFORE any test stubs it — afterEach restores fetch to THIS, so
// per-test fetch doubles never leak (vi.unstubAllGlobals is NOT an option
// here: it would also remove the module-scoped localStorage stub the store
// was created against).
const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  // A clean device before every scenario: quota off, boundary at infinity.
  fake.quotaExceeded = false
  fake.quotaBytes = Number.POSITIVE_INFINITY
  fake.store.clear()
  resetStore()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', originalFetch)
})

// ---------------- quota / private-mode write failures ----------------

describe('#192: a failing setItem is caught, the action survives, degradation is LOUD', () => {
  it('offline dispatch under a hard quota never throws, still queues optimistically, and flips persistDegraded', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    resetStore({ online: false, outbox: [] })
    fake.quotaExceeded = true

    // Before #192 this rejected: persist calls storage.setItem synchronously
    // inside set(), so the QuotaExceededError broke the dispatch mid-flight.
    await expect(
      state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present'),
    ).resolves.toBe(true)

    expect(state().outbox).toHaveLength(1) // queued in memory (the source of truth)
    expect(state().outbox[0].syncStatus).toBe('pending')
    expect(state().data).not.toBeNull() // the optimistic write still applied
    expect(state().persistDegraded).toBe(true) // the banner's source flag
    expect(state().persistQueueOnly).toBe(false)
    // The failure is surfaced at the console seam too (never swallowed).
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('persistence write failed'), expect.any(Error))
  })

  it('the online-when-network-lies branch completes fully under quota (queued toast fires — the action ran to the end)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetStore({ online: true, outbox: [] })
    fake.quotaExceeded = true
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))

    await expect(
      state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'half_day' }, 'Mark half day'),
    ).resolves.toBe(true)

    expect(state().outbox).toHaveLength(1)
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'field.savedQueued', { count: 1 }))
    expect(state().persistDegraded).toBe(true)
  })

  it('private-mode hard failure keeps the in-memory store fully functional across many writes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.quotaExceeded = true

    for (let i = 0; i < 5; i++) {
      useMjengo.setState({ outbox: [...state().outbox, queuedItem(100 + i)] } as never)
    }
    expect(state().outbox).toHaveLength(7)
    expect(state().persistDegraded).toBe(true)
    expect(state().persistQueueOnly).toBe(false)
    // Nothing NEW reached disk — the key still holds the LAST GOOD snapshot
    // (2 items from the pre-quota write), which is exactly what the banner
    // announces: work after that point is memory-only.
    expect(persisted().state.outbox).toHaveLength(2)
  })
})

// ---------------- the queue-only fallback (the bounding decision's teeth) ----------------

describe('#192: the queue-only fallback banks the irreplaceable part', () => {
  it('when the full write does not fit but a data-less one does, the queue reaches disk without data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Baseline: a successful full write so we can place the quota boundary
    // BETWEEN the full and the slimmed serialized sizes.
    resetStore({ outbox: [queuedItem(1)] })
    const full = fake.getItem(MJENGO_STORE_KEY)!
    const slim = JSON.stringify({ ...JSON.parse(full), state: { ...JSON.parse(full).state, data: null } })
    expect(full.length).toBeGreaterThan(slim.length + 1_000) // data genuinely dominates
    fake.quotaBytes = slim.length + Math.floor((full.length - slim.length) / 2)

    // One more queued action under the boundary → full write throws, the
    // fallback (data dropped) fits.
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present')

    expect(state().outbox).toHaveLength(2)
    expect(state().persistQueueOnly).toBe(true)
    expect(state().persistDegraded).toBe(false)
    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(2) // the queue banked
    expect(onDisk.state.data).toBeNull() // the re-fetchable slice dropped
  })

  it('a later successful FULL write self-heals the flags (the banner clears)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.quotaExceeded = true
    useMjengo.setState({ online: true } as never)
    expect(state().persistDegraded).toBe(true)

    // Storage freed up (or the private window ended).
    fake.quotaExceeded = false
    fake.quotaBytes = Number.POSITIVE_INFINITY
    useMjengo.setState({ online: false } as never)

    expect(state().persistDegraded).toBe(false)
    expect(state().persistQueueOnly).toBe(false)
    expect(persisted().state.data).not.toBeNull() // the full payload is back on disk
  })
})

// ---------------- multi-tab coordination (storage events) ----------------

describe('#192: cross-tab rehydration (debounced last-writer-wins)', () => {
  it('shouldRehydrateFromStorageEvent: only our key rehydrates (null key = a clear — deliberately ignored)', () => {
    expect(shouldRehydrateFromStorageEvent({ key: MJENGO_STORE_KEY })).toBe(true)
    expect(shouldRehydrateFromStorageEvent({ key: 'mjengo-supplier-outbox' })).toBe(false)
    expect(shouldRehydrateFromStorageEvent({ key: 'unrelated-key' })).toBe(false)
    expect(shouldRehydrateFromStorageEvent({ key: null })).toBe(false)
  })

  it('a storage event on our key rehydrates after the debounce; foreign keys schedule nothing', async () => {
    vi.useFakeTimers()
    try {
      const rehydrateSpy = vi.spyOn(useMjengo.persist, 'rehydrate')
      resetStore({ outbox: [queuedItem(1)] })
      const before = state().outbox.length

      // The OTHER surface (PWA window vs browser tab) writes a newer
      // snapshot: one extra queued item. Direct map write — same-tab writes
      // never fire their own storage event.
      fake.store.set(MJENGO_STORE_KEY, JSON.stringify({
        state: {
          online: true, outbox: [queuedItem(1), queuedItem(2)], syncHistory: [],
          data: null, lastSyncAt: 456, activeProjectId: 'pl-1', shareToken: null, dataMode: 'normal',
        },
        version: 1,
      }))

      handleCrossTabStorageEvent({ key: 'unrelated-key' })
      handleCrossTabStorageEvent({ key: null })
      vi.advanceTimersByTime(CROSS_TAB_REHYDRATE_DEBOUNCE_MS)
      expect(state().outbox).toHaveLength(before) // foreign keys: still our snapshot
      expect(rehydrateSpy).not.toHaveBeenCalled()

      handleCrossTabStorageEvent({ key: MJENGO_STORE_KEY })
      expect(state().outbox).toHaveLength(before) // debounced: not yet
      vi.advanceTimersByTime(CROSS_TAB_REHYDRATE_DEBOUNCE_MS)
      await Promise.resolve()
      expect(rehydrateSpy).toHaveBeenCalledTimes(1)
      expect(state().outbox).toHaveLength(before + 1) // the peer's newer queue is ours now
      rehydrateSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bursts of writes from an active peer coalesce into ONE rehydrate', async () => {
    vi.useFakeTimers()
    try {
      const rehydrateSpy = vi.spyOn(useMjengo.persist, 'rehydrate')
      resetStore({ outbox: [queuedItem(1)] })

      handleCrossTabStorageEvent({ key: MJENGO_STORE_KEY })
      handleCrossTabStorageEvent({ key: MJENGO_STORE_KEY })
      handleCrossTabStorageEvent({ key: MJENGO_STORE_KEY })
      vi.advanceTimersByTime(CROSS_TAB_REHYDRATE_DEBOUNCE_MS)
      await Promise.resolve()

      expect(rehydrateSpy).toHaveBeenCalledTimes(1)
      rehydrateSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an orphaned syncing item from a peer mid-drain snapshot returns to pending (un-stranded, drainable)', async () => {
    vi.useFakeTimers()
    try {
      resetStore({ outbox: [queuedItem(1)] })
      // A snapshot written while the OTHER surface was mid-drain: the item
      // is 'syncing' on disk, but no drain owns it here. Before #192 this
      // item stranded forever — syncNow only drains 'pending'.
      fake.store.set(MJENGO_STORE_KEY, JSON.stringify({
        state: {
          online: true,
          outbox: [queuedItem(1), { ...queuedItem(9), syncStatus: 'syncing' }],
          syncHistory: [], data: null, lastSyncAt: 789, activeProjectId: 'pl-1', shareToken: null, dataMode: 'normal',
        },
        version: 1,
      }))

      handleCrossTabStorageEvent({ key: MJENGO_STORE_KEY })
      vi.advanceTimersByTime(CROSS_TAB_REHYDRATE_DEBOUNCE_MS)
      await Promise.resolve()
      expect(state().outbox).toHaveLength(2)
      expect(state().outbox.find((o) => o.id === 'q-9')?.syncStatus).toBe('syncing') // as rehydrated

      vi.advanceTimersByTime(1) // the deferred normalization tick
      await Promise.resolve()
      expect(state().outbox.find((o) => o.id === 'q-9')?.syncStatus).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------- restart + the documented size budget ----------------

describe('#192: restart durability + the bounding decision', () => {
  it('restart verification: offline-queued items are on disk and a rehydrate restores them drainable', async () => {
    resetStore({ online: false, outbox: [] })
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'present' }, 'Mark present')
    await state().dispatch('attendance.setStatus', { workerId: 'w-1', status: 'absent' }, 'Mark absent')

    // What a relaunch boots from (the "kill the app" step, at the storage level).
    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(2)
    expect(onDisk.version).toBe(1)
    expect(onDisk.state.data).not.toBeNull() // offline READS survive too (issue #78)

    // The relaunch: memory empty, key intact → rehydrate → queue restored.
    const bytes = fake.getItem(MJENGO_STORE_KEY)!
    useMjengo.setState({ outbox: [], data: null } as never)
    fake.store.set(MJENGO_STORE_KEY, bytes) // the app died AFTER this write
    await useMjengo.persist.rehydrate()

    expect(state().outbox).toHaveLength(2)
    expect(state().outbox.every((o) => o.syncStatus === 'pending')).toBe(true)
    expect(state().data).not.toBeNull()
  })

  it('the persisted payload for a representative large project + 100 queued actions stays under the documented budget', () => {
    // DOCUMENTED BUDGET (#192): 4 MB for the mjengo-os-store key — under
    // half of the 5-10 MB origin quota browsers grant localStorage (iOS
    // Safari ~5 MB, Chrome ~10 MB shared) so the key coexists with the
    // supplier outbox + prefs keys and leaves growth headroom. The sample
    // below measures ~2 MB; the floor assertion keeps the sample honest
    // (a generator that silently shrinks cannot keep the budget vacuous).
    const MJENGO_PERSIST_BUDGET_BYTES = 4_000_000
    const SAMPLE_FLOOR_BYTES = 1_000_000

    resetStore({
      data: largeProjectPayload() as never,
      outbox: Array.from({ length: 100 }, (_, i) => queuedItem(i + 1)),
    })

    const raw = fake.getItem(MJENGO_STORE_KEY)!
    expect(raw).not.toBeNull()
    const bytes = Buffer.byteLength(raw, 'utf8')
    expect(bytes, `persisted payload ${bytes} bytes must stay under the 4 MB budget`).toBeLessThan(MJENGO_PERSIST_BUDGET_BYTES)
    expect(bytes, `the large-project sample (${bytes} bytes) must stay genuinely large`).toBeGreaterThan(SAMPLE_FLOOR_BYTES)
    // The offline-boot invariant (the bounding decision): data rides along.
    expect(persisted().state.data).not.toBeNull()
  })

  it('partialize keeps `data` in the persisted key — the documented bounding decision (offline boot serves it)', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(src).toContain('export const MJENGO_STORE_KEY = \'mjengo-os-store\'')
    expect(src).toContain('storage: createJSONStorage(')
    // The decision pin: removing `data` from persistence (a tempting "fix")
    // would break every offline read (issue #78 shouldOfflineBoot) — this
    // pin fails loudly if that ever happens without a new decision.
    expect(src).toMatch(/partialize: \(s\) => \(\{[^]*data: s\.data,/)
  })
})

// ---------------- wiring + copy (source pins, house style) ----------------

describe('#192: wiring — the degradation is reachable end to end', () => {
  it('app.tsx renders the persistence banner from the health flags', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('persistDegraded, persistQueueOnly,')
    expect(src).toContain('(persistDegraded || persistQueueOnly) && !isClientSurface')
    expect(src).toContain("t('app.persist.degraded')")
    expect(src).toContain("t('app.persist.queueOnly')")
    expect(src).toContain("role={persistDegraded ? 'alert' : 'status'}")
  })

  it('the outbox sheet states the device-local honesty line', () => {
    const src = readSrc('src/frontend/mjengo/sync-outbox-panel.tsx')
    expect(src).toContain("t('outbox.deviceLocal')")
  })

  it('use-mjengo wires the guarded adapter and the storage-event listener', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    // The guarded seam (quota caught at the zustand storage adapter).
    expect(src).toContain('const guardedLocalStorage: StateStorage = {')
    // The queue-only fallback drops the re-fetchable slice.
    expect(src).toContain("state: { ...parsed.state, data: null }")
    // Multi-tab: the storage event rehydrates (debounced).
    expect(src).toContain('window.addEventListener(\'storage\', handleCrossTabStorageEvent)')
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
