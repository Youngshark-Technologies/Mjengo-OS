// @vitest-environment jsdom
/**
 * #388 (QA-found, #351 regression) — the store-hydration gate must resolve
 * in ALL THREE hydration orderings, not two:
 *
 *   1. finished BEFORE render — gate true immediately;
 *   2. finished INSIDE the render→effect window — hasHydrated() flips
 *      false→true between the useState initializer and the effect; the
 *      effect must flip the gate ITSELF (the shipped bug: the bare
 *      early-return left the app on the boot skeleton forever — 6/7 E2E
 *      personas failed on fast sign-ins);
 *   3. finished AFTER the effect — the onFinishHydration listener flips it;
 *   4. inert media (no persist object) — hydrated by definition.
 *
 * This suite renders the REAL useStoreHydrationGate hook (extracted from
 * app.tsx for exactly this contract) through the #345 runtime-DOM harness.
 * The persist API is a scriptable double — the ordering is the test's
 * control variable; the gate logic under test is the real production code.
 */
import { describe, expect, it } from 'vitest'
import { useStoreHydrationGate, type MjengoPersistApi } from '@/frontend/mjengo/app'
import { actAsync, h, render } from './_helpers/react-render'

/** A persist double whose hasHydrated() the test flips at a chosen instant. */
function scriptablePersist() {
  let hydrated = false
  const listeners: Array<() => void> = []
  return {
    api: {
      hasHydrated: () => hydrated,
      onFinishHydration: (cb: () => void) => {
        listeners.push(cb)
        return () => {
          const i = listeners.indexOf(cb)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
    } satisfies MjengoPersistApi,
    /** Flip hasHydrated() WITHOUT notifying listeners (ordering 2: the race window). */
    flipSilent: () => {
      hydrated = true
    },
    /** Flip hasHydrated() AND notify listeners (ordering 3: normal async completion). */
    finish: () => {
      hydrated = true
      for (const cb of [...listeners]) cb()
    },
    listenerCount: () => listeners.length,
  }
}

/** Mount a probe that records the REAL gate's return into `probe.gate`. */
function mountGateProbe(persistApi: MjengoPersistApi | undefined, onRender?: () => void) {
  const probe: { gate?: boolean } = {}
  const rendered = render(
    h(() => {
      probe.gate = useStoreHydrationGate(persistApi)
      onRender?.()
      return null
    }),
  )
  return { probe, rendered }
}

describe('#388 store-hydration gate — the three orderings + inert media', () => {
  it('ordering 1: hydration finished BEFORE render → gate true on first read', () => {
    const p = scriptablePersist()
    p.flipSilent() // already hydrated before React runs
    const { probe } = mountGateProbe(p.api)
    expect(probe.gate).toBe(true)
  })

  it('ordering 2 (THE #388 RACE): hasHydrated() flips INSIDE a window → the subscription re-check flips the gate', () => {
    const p = scriptablePersist()
    let flipped = false
    const { probe } = mountGateProbe(p.api, () => {
      // Runs in the component body — AFTER the hook's initial snapshot read
      // (hasHydrated() → false), BEFORE React's post-subscribe re-check.
      // This is exactly the fast-sign-in window the E2E personas hit.
      if (!flipped) {
        flipped = true
        p.flipSilent()
      }
    })
    // useSyncExternalStore subscribed, then re-checked the snapshot — it
    // observed the flip and re-rendered with the fresh value. Pre-#388, the
    // effect-based gate early-returned without flipping its own state and
    // the app stuck on the boot skeleton here — the permanent skeleton.
    expect(probe.gate).toBe(true)
    // With useSyncExternalStore the subscription IS attached (React
    // subscribes before the re-check) — the re-check, not a bare listener,
    // is what catches this ordering. The listener stays for ordering 3.
    expect(p.listenerCount()).toBe(1)
  })

  it('ordering 3: hydration finishes AFTER the effect → the listener flips the gate', async () => {
    const p = scriptablePersist()
    const { probe } = mountGateProbe(p.api)
    // Effect ran with hydration still pending → listener attached, gate false.
    expect(p.listenerCount()).toBe(1)
    expect(probe.gate).toBe(false)
    await actAsync(() => p.finish())
    expect(probe.gate).toBe(true)
  })

  it('inert media (no persist object) → hydrated by definition', () => {
    const { probe } = mountGateProbe(undefined)
    expect(probe.gate).toBe(true)
  })
})
