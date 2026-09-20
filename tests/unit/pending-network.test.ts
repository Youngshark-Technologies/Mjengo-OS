/**
 * #150 — the "Waiting for network" worklist, pinned behaviorally on the REAL
 * use-mjengo store (outbox-persistence conventions: sonner mocked, a FAKE
 * localStorage stubbed BEFORE the dynamic import so the #192 guarded adapter
 * engages and persistence is testable at the storage level; in plain node the
 * typeof guard keeps the adapter inert).
 *
 * The remind-only decision under test, end to end:
 *   · every enqueue seam records an intent (kind + labelKey + context + tab,
 *     stamped id/createdAt) WITHOUT touching the outbox — reminders are not
 *     queued mutations, and the two persisted lists never mix;
 *   · one entry per INTENT (kind + context): a repeated offline attempt
 *     refreshes the reminder instead of stacking duplicates; the list is
 *     capped (newest kept);
 *   · reconnect surfaces the waiting toast (mirroring the outbox's
 *     backOnlineDraining pattern, alongside it — not instead of it) but NEVER
 *     consumes the entries: nothing auto-executes, the human retry/discard is
 *     the only lifecycle;
 *   · the reminders PERSIST (the documented partialize decision — a reload is
 *     exactly the "user must remember" failure #150 exists to fix) and a
 *     rehydrate restores them;
 *   · the labelKey + context shape renders a real sentence in BOTH locales
 *     (locale follows the UI at display time, never the enqueue moment);
 *   · wiring source pins (house style): every online-only guard that refuses
 *     (money pay + AI review, payroll, copilot analyze/voice/parse/scan,
 *     document extract/decide, trust digest generate/audio) enqueues next to
 *     its honest toast; the panel navigates + consumes on retry, disables
 *     retry offline, hides when empty; the header mounts it.
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

// ---------------- the fake localStorage (the #192 adapter engages) ----------------

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

const fake = new FakeLocalStorage()
vi.stubGlobal('localStorage', fake)

const {
  useMjengo,
  MJENGO_STORE_KEY,
  PENDING_NETWORK_CAP,
} = await import('@/frontend/hooks/use-mjengo')
import type { PendingNetworkItem, OutboxItem } from '@/frontend/hooks/use-mjengo'

// ---------------- helpers (outbox-persistence conventions) ----------------

/** A queued outbox item in the §40 'pending' state (the draining-toast arm). */
function queuedItem(): OutboxItem {
  return {
    id: 'q-1',
    type: 'attendance.checkin',
    payload: { workerId: 'w-1' },
    label: 'Check in worker',
    createdAt: Date.now(),
    projectId: 'pl-1',
    syncStatus: 'pending',
    retryCount: 0,
  }
}

function resetStore(overrides: Record<string, unknown> = {}) {
  useMjengo.setState({
    online: true,
    syncing: false,
    outbox: [],
    syncHistory: [],
    lastSyncAt: null,
    viewMode: 'owner',
    shareToken: null,
    clientRole: false,
    data: null,
    persistDegraded: false,
    persistQueueOnly: false,
    pendingNetwork: [],
    ...overrides,
  } as never)
}

const state = () => useMjengo.getState()
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const persisted = () => JSON.parse(fake.getItem(MJENGO_STORE_KEY)!) as {
  state: { pendingNetwork: PendingNetworkItem[]; outbox: OutboxItem[] } & Record<string, unknown>
  version?: number
}

// Captured BEFORE any test stubs it — afterEach restores fetch to THIS so
// per-test fetch doubles never leak (the localStorage stub must stay: the
// store module was created against it).
const originalFetch = globalThis.fetch

/** The payment.pay enqueue shape (the issue's own evidence flow). */
function enqueuePay(code = 'PR-1001') {
  state().enqueuePendingNetwork({
    kind: 'payment.pay',
    labelKey: 'netlist.kind.moneyPay',
    context: { code },
    tab: 'money',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  fake.store.clear()
  resetStore()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', originalFetch)
})

// ---------------- enqueue: the refusal gets a memory ----------------

describe('#150: enqueue — the online-only refusal gets a memory', () => {
  it('stamps id/createdAt and preserves the intent (kind, labelKey, context, tab)', () => {
    const before = Date.now()
    enqueuePay('PR-42')
    const list = state().pendingNetwork
    expect(list).toHaveLength(1)
    const item = list[0]
    expect(typeof item.id).toBe('string')
    expect(item.id.length).toBeGreaterThan(0)
    expect(item.createdAt).toBeGreaterThanOrEqual(before)
    expect(item.kind).toBe('payment.pay')
    expect(item.labelKey).toBe('netlist.kind.moneyPay')
    expect(item.context).toEqual({ code: 'PR-42' })
    expect(item.tab).toBe('money')
  })

  it('never touches the outbox — reminders are not queued mutations', () => {
    enqueuePay()
    expect(state().pendingNetwork).toHaveLength(1)
    expect(state().outbox).toEqual([])
    // And at the storage level: the persisted outbox stays empty while the
    // reminder reaches disk in its OWN slice.
    const onDisk = persisted()
    expect(onDisk.state.outbox).toHaveLength(0)
    expect(onDisk.state.pendingNetwork).toHaveLength(1)
  })

  it('the stored labelKey renders a real sentence in BOTH locales with the context vars', () => {
    enqueuePay('PR-1001')
    const item = state().pendingNetwork[0]
    // Locale follows the UI at DISPLAY time — the stored shape is key + vars.
    expect(translate(enDict, item.labelKey, item.context)).toBe('Pay payment request PR-1001')
    expect(translate(swDict, item.labelKey, item.context)).toBe('Lipa ombi la malipo PR-1001')
  })

  it('a repeated attempt at the SAME intent refreshes the reminder instead of stacking', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T08:00:00Z'))
    try {
      enqueuePay('PR-7')
      const first = state().pendingNetwork[0]
      vi.setSystemTime(new Date('2026-09-28T10:30:00Z'))
      enqueuePay('PR-7')
      expect(state().pendingNetwork).toHaveLength(1)
      expect(state().pendingNetwork[0].id).toBe(first.id)
      expect(state().pendingNetwork[0].createdAt).toBe(new Date('2026-09-28T10:30:00Z').getTime())
    } finally {
      vi.useRealTimers()
    }
  })

  it('a different intent (different context) is a separate entry', () => {
    enqueuePay('PR-1')
    enqueuePay('PR-2')
    expect(state().pendingNetwork).toHaveLength(2)
    expect(state().pendingNetwork.map((i) => i.context?.code)).toEqual(['PR-1', 'PR-2'])
  })

  it('a different kind with the same context is a separate entry', () => {
    enqueuePay('PR-1')
    state().enqueuePendingNetwork({
      kind: 'ai.drawReview',
      labelKey: 'netlist.kind.aiReview',
      context: { title: 'Foundation' },
      tab: 'money',
    })
    expect(state().pendingNetwork).toHaveLength(2)
  })

  it(`caps the list at PENDING_NETWORK_CAP (${PENDING_NETWORK_CAP}) — newest kept, oldest dropped`, () => {
    for (let i = 0; i < PENDING_NETWORK_CAP + 5; i++) {
      enqueuePay(`PR-${i}`)
    }
    const list = state().pendingNetwork
    expect(list).toHaveLength(PENDING_NETWORK_CAP)
    // The 5 oldest intents (PR-0..PR-4) fell off; the freshest survived.
    expect(list[0].context?.code).toBe('PR-5')
    expect(list[list.length - 1].context?.code).toBe(`PR-${PENDING_NETWORK_CAP + 4}`)
  })
})

// ---------------- discard ----------------

describe('#150: discard — the human-only lifecycle', () => {
  it('removes exactly that entry', () => {
    enqueuePay('PR-1')
    enqueuePay('PR-2')
    const id = state().pendingNetwork[0].id
    state().discardPendingNetwork(id)
    expect(state().pendingNetwork).toHaveLength(1)
    expect(state().pendingNetwork[0].context?.code).toBe('PR-2')
  })

  it('discarding an unknown id is a no-op', () => {
    enqueuePay()
    state().discardPendingNetwork('no-such-reminder')
    expect(state().pendingNetwork).toHaveLength(1)
  })
})

// ---------------- reconnect surfaces the worklist ----------------

describe('#150: reconnect surfaces the waiting worklist (mirrors the outbox toast)', () => {
  it('fires the backOnlineWaiting toast with the count — and never consumes the entries (REMIND-ONLY)', () => {
    state().setOnline(false)
    enqueuePay('PR-1')
    state().enqueuePendingNetwork({
      kind: 'wages.pay',
      labelKey: 'netlist.kind.payroll',
      context: { period: '2026-09-28' },
      tab: 'fundis',
    })
    expect(toast.info).not.toHaveBeenCalled() // offline alone says nothing

    state().setOnline(true)
    expect(toast.info).toHaveBeenCalledWith(translate(enDict, 'sync.backOnlineWaiting', { count: 2 }))
    // Remind-only: reconnect SURFACES, it does not execute or consume —
    // the panel's retry/discard stays the only lifecycle.
    expect(state().pendingNetwork).toHaveLength(2)
  })

  it('reconnect with an empty worklist fires no waiting toast', () => {
    state().setOnline(false)
    state().setOnline(true)
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.backOnline'))
  })

  it('reconnect with a pending outbox AND waiting entries fires BOTH toasts (draining + waiting)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, results: [] }),
    })))
    resetStore({ online: true, outbox: [queuedItem()] })
    state().setOnline(false)
    enqueuePay()
    state().setOnline(true)

    expect(toast.success).toHaveBeenCalledWith(translate(enDict, 'sync.backOnlineDraining'))
    expect(toast.info).toHaveBeenCalledWith(translate(enDict, 'sync.backOnlineWaiting', { count: 1 }))
    await Promise.resolve() // let the fire-and-forget syncNow() settle
  })
})

// ---------------- persistence: the documented partialize decision ----------------

describe('#150: persistence — the reminder survives a reload', () => {
  it('entries are on disk and a rehydrate restores them (the "user must remember" failure mode stays dead)', async () => {
    enqueuePay('PR-42')
    state().enqueuePendingNetwork({
      kind: 'ai.trustDigest',
      labelKey: 'netlist.kind.trustDigest',
      tab: 'intel',
    })
    const onDisk = persisted()
    expect(onDisk.state.pendingNetwork).toHaveLength(2)
    expect(onDisk.version).toBe(1)

    // The relaunch: memory empty, key intact → rehydrate → reminders restored.
    const bytes = fake.getItem(MJENGO_STORE_KEY)!
    useMjengo.setState({ pendingNetwork: [] } as never)
    expect(state().pendingNetwork).toHaveLength(0)
    fake.store.set(MJENGO_STORE_KEY, bytes) // the app died AFTER this write
    await useMjengo.persist.rehydrate()

    expect(state().pendingNetwork).toHaveLength(2)
    expect(state().pendingNetwork.some((i) => i.kind === 'payment.pay' && i.context?.code === 'PR-42')).toBe(true)
    expect(state().pendingNetwork.some((i) => i.kind === 'ai.trustDigest')).toBe(true)
  })

  it('partialize keeps pendingNetwork — the decision pin (dropping it would resurrect issue #150)', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(src).toContain('export const PENDING_NETWORK_CAP = 20')
    expect(src).toMatch(/partialize: \(s\) => \(\{[^]*pendingNetwork: s\.pendingNetwork,/)
    // The remind-only decision is documented, not implied.
    expect(src).toContain('REMIND-ONLY, BY DELIBERATE DECISION')
  })
})

// ---------------- wiring: every guard that refuses records the intent ----------------

describe('#150: enqueue seams — every online-only guard records the intent', () => {
  it('money-tab: the payRequest and AI review guards enqueue next to their honest toasts', () => {
    const src = readSrc('src/frontend/mjengo/money-tab.tsx')
    expect(src).toContain("toast.error(t('money.payNeedsOnline'))")
    expect(src).toMatch(/payNeedsOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'payment\.pay'/)
    expect(src).toMatch(/aiReview\.needsOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'ai\.drawReview'/)
  })

  it('fundis-tab: the runPayroll guard enqueues wages.pay with the EAT period', () => {
    const src = readSrc('src/frontend/mjengo/fundis-tab.tsx')
    expect(src).toContain("toast.error(t('fundis.payrollNeedsOnline'))")
    expect(src).toMatch(/payrollNeedsOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'wages\.pay', labelKey: 'netlist\.kind\.payroll', context: \{ period: todayEAT\(\) \}, tab: 'fundis' \}/)
  })

  it('copilot-tab: analyze / voice (+ sample) / typed-parse / scan guards all enqueue', () => {
    const src = readSrc('src/frontend/mjengo/copilot-tab.tsx')
    expect(src).toMatch(/copilot\.toast\.needOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.analyze'/)
    expect(src).toMatch(/copilot\.voice\.toast\.needOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.voice'/)
    expect(src).toMatch(/needOnlineShort'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.voice'/)
    expect(src).toMatch(/parseOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.voiceParse'/)
    expect(src).toMatch(/copilot\.scan\.toast\.needOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.scan'/)
  })

  it('documents-panel: extract and decide guards enqueue with the file context', () => {
    const src = readSrc('src/frontend/mjengo/copilot/documents-panel.tsx')
    expect(src).toMatch(/needOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.docs',/)
    expect(src).toMatch(/needOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'copilot\.docsReview',/)
  })

  it('trust-digest-section: generate and render-audio guards enqueue (the client-reachable flow)', () => {
    const src = readSrc('src/frontend/mjengo/intel/sections/trust-digest-section.tsx')
    expect(src).toMatch(/trustDigest\.needsOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'ai\.trustDigest',/)
    expect(src).toMatch(/trustDigest\.needsOnline'\)\)[^]*enqueuePendingNetwork\(\{ kind: 'ai\.trustAudio',/)
  })

  it('every seam labelKey exists in BOTH dictionaries (the i18n parity gate, belt and braces)', () => {
    const labelKeys = [
      'netlist.kind.moneyPay',
      'netlist.kind.aiReview',
      'netlist.kind.payroll',
      'netlist.kind.analyze',
      'netlist.kind.voice',
      'netlist.kind.voiceParse',
      'netlist.kind.scan',
      'netlist.kind.docs',
      'netlist.kind.docsReview',
      'netlist.kind.trustDigest',
      'netlist.kind.trustAudio',
    ]
    const enKeys = new Set(Object.keys(enDict))
    const swKeys = new Set(Object.keys(swDict))
    for (const key of labelKeys) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })
})

// ---------------- the panel + wiring (source pins, house style) ----------------

describe('#150: the waiting panel + header wiring', () => {
  it('retry navigates to the stored tab and consumes the reminder; retry is disabled offline', () => {
    const src = readSrc('src/frontend/mjengo/pending-network-panel.tsx')
    // Remind-only retry: navigate (the app's role-filtered tab event) + discard.
    expect(src).toContain("window.dispatchEvent(new CustomEvent('mjengo:tab', { detail: { tab: item.tab } }))")
    expect(src).toContain('discardPendingNetwork(item.id)')
    // The honest affordance while offline: visible but disabled.
    expect(src).toContain('disabled={!online}')
    // Acceptance: the surface is hidden when empty (mid-view excepted).
    expect(src).toContain('if (!hasWaiting && !open) return null')
    // Labels render from the stored key + context at display time.
    expect(src).toContain('t(item.labelKey, item.context)')
  })

  it('the header mounts the panel on BOTH surfaces (the client-visible intel flow can enqueue)', () => {
    const header = readSrc('src/frontend/mjengo/header.tsx')
    expect(header).toContain("import { PendingNetworkPanel } from '@/frontend/mjengo/pending-network-panel'")
    // Mounted next to the notification bell — OUTSIDE the !isShareClient
    // block — so share-client surfaces see their reminders too.
    expect(header).toMatch(/<NotificationBell \/>[^]*\{\/\* #150[^]*\*\/\}\n\s*<PendingNetworkPanel \/>/)
  })

  it('every new user-facing key exists in BOTH dictionaries with real copy', () => {
    const keys = [
      'sync.backOnlineWaiting',
      'netlist.trigger',
      'netlist.aria.trigger',
      'netlist.title',
      'netlist.meta',
      'netlist.listAria',
      'netlist.queuedAgo',
      'netlist.hint',
      'netlist.retryNow',
      'netlist.retryOfflineNote',
      'netlist.discard',
      'netlist.allCleared',
    ]
    const enKeys = new Set(Object.keys(enDict))
    const swKeys = new Set(Object.keys(swDict))
    for (const key of keys) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
    // Real sentences in both languages (not the key-fallback a missing entry
    // would render), and the {count} var interpolates.
    expect(translate(enDict, 'sync.backOnlineWaiting', { count: 2 }))
      .toBe('Back online — 2 action(s) are waiting for a connection')
    expect(translate(swDict, 'sync.backOnlineWaiting', { count: 2 }))
      .toBe('Tumerudi mtandaoni — vitendo 2 bado vinasubiri muunganisho')
    expect(translate(enDict, 'netlist.hint')).toContain('reminders, not a queue')
    expect(translate(swDict, 'netlist.hint')).toContain('vikumbusho')
  })
})
