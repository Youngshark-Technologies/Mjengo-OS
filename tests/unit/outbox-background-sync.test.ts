/**
 * #193 — Background Sync registration at the outbox ENQUEUE seams, pinned
 * behaviorally on the REAL use-mjengo store (outbox-auto-retry conventions:
 * sonner mocked, global fetch stubbed, the zustand store imported real —
 * persist is inert in node). navigator.serviceWorker is stubbed per arm:
 *
 *   · a Chromium-style registration (sync.register present) → dispatching an
 *     action while OFFLINE, and an ONLINE dispatch whose fetch network-fails,
 *     both queue the item AND register the one-shot 'mjengoos-outbox' tag —
 *     once per enqueue, through the getRegistration() lookup; a second
 *     enqueue registers again (idempotent re-registration, the browser
 *     coalesces one-shot tags by name);
 *   · every feature-detect arm keeps enqueueing EXACTLY as before: no
 *     service-worker container, no registration, a registration without the
 *     sync API, a register REFUSAL (permission/quota). The queue is the
 *     source of truth; the tag is best-effort and must NEVER break the
 *     write it rides on (progressive enhancement — Safari/Firefox behavior
 *     unchanged);
 *   · the pure registration helper (registerOutboxSync / syncManagerOf /
 *     isDrainRequestMessage) and the sw.js + app.tsx wiring pins live in
 *     sw-offline-shell.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { OUTBOX_SYNC_TAG } from '@/frontend/sw-handlers'

// ---------------- test doubles (outbox-auto-retry conventions) ----------------

/** A Chromium-style registration: Background Sync present. */
function chromiumRegistration(): {
  registration: { sync: { register: (tag: string) => Promise<void> } }
  register: ReturnType<typeof vi.fn<(tag: string) => Promise<void>>>
} {
  const register = vi.fn(async () => undefined)
  return { registration: { sync: { register } }, register }
}

/**
 * Replace navigator.serviceWorker for one arm. `getRegistration` undefined →
 * no container (the node/no-SW shape).
 */
function stubServiceWorker(getRegistration?: () => Promise<unknown>): void {
  vi.stubGlobal('navigator', {
    serviceWorker: getRegistration ? { getRegistration } : undefined,
  })
}

function resetStore(overrides: Record<string, unknown> = {}): void {
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
    ...overrides,
  } as never)
}

const state = () => useMjengo.getState()

/** Let the fire-and-forget getRegistration().then(register) microtasks settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------- the enqueue seam registers the tag (Chromium) ----------------

describe('#193: queuing an outbox item registers the one-shot sync tag', () => {
  it('an OFFLINE dispatch queues the item AND registers mjengoos-outbox', async () => {
    resetStore({ online: false })
    const { registration, register } = chromiumRegistration()
    stubServiceWorker(async () => registration)

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(OUTBOX_SYNC_TAG)
  })

  it('an ONLINE dispatch whose fetch network-fails (the connectivity-lie path) registers too', async () => {
    resetStore({ online: true })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network vanished mid-flight')
    }))
    const { registration, register } = chromiumRegistration()
    stubServiceWorker(async () => registration)

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
    expect(register).toHaveBeenCalledWith(OUTBOX_SYNC_TAG)
  })

  it('a second enqueue registers again (idempotent one-shot tag re-registration)', async () => {
    resetStore({ online: false })
    const { registration, register } = chromiumRegistration()
    stubServiceWorker(async () => registration)

    await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in 1')
    await state().dispatch('attendance.checkin', { workerId: 'w2' }, 'Check in 2')
    await flush()

    expect(state().outbox).toHaveLength(2)
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenNthCalledWith(1, OUTBOX_SYNC_TAG)
    expect(register).toHaveBeenNthCalledWith(2, OUTBOX_SYNC_TAG)
  })
})

// ---------------- progressive enhancement: the write always lands ----------------

describe('#193: unsupported/refused registration never breaks enqueueing', () => {
  it('no service-worker container at all → item queues exactly as before', async () => {
    resetStore({ online: false })
    stubServiceWorker(undefined)

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
  })

  it('no registration (getRegistration → undefined) → enqueue unaffected', async () => {
    resetStore({ online: false })
    stubServiceWorker(async () => undefined)

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
  })

  it('a registration WITHOUT the sync API (Safari/Firefox shape) → enqueue unaffected', async () => {
    resetStore({ online: false })
    stubServiceWorker(async () => ({ active: {} }))

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
  })

  it('a register refusal (permission/quota) is swallowed — enqueue unaffected', async () => {
    resetStore({ online: false })
    const register = vi.fn(() => Promise.reject(new Error('NotAllowedError')))
    stubServiceWorker(async () => ({ sync: { register } }))

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(register).toHaveBeenCalledTimes(1) // the attempt WAS made, then honestly dropped
    expect(state().outbox).toHaveLength(1)
  })

  it('a rejected getRegistration lookup never ripples into dispatch', async () => {
    resetStore({ online: false })
    stubServiceWorker(() => Promise.reject(new Error('container unavailable')))

    const ok = await state().dispatch('attendance.checkin', { workerId: 'w1' }, 'Check in')
    await flush()

    expect(ok).toBe(true)
    expect(state().outbox).toHaveLength(1)
  })
})
