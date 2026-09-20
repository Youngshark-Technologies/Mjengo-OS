/**
 * Minimal React DOM render harness for the tests/dom runtime suites
 * (issue #137 / audit FE-8).
 *
 * WHY HAND-ROLLED, NOT @testing-library/react: the repo prizes minimal deps,
 * and the contracts under test are four focused a11y wirings — createRoot +
 * `act` (React 19 exports it directly) plus four one-line fire helpers cover
 * everything the suites need. The ONLY new dev dependency is jsdom itself
 * (the environment, per-file `// @vitest-environment jsdom` pragma — the
 * node-only default for every other suite is untouched).
 *
 * Conventions (learned the honest way, pinned here so no suite relearns them):
 *  · every event goes through ASYNC act — React 19 defers discrete-event
 *    dispatch (keydown/click) to a microtask that only async act awaits;
 *    a sync act around the same dispatchEvent silently never reaches the
 *    handler;
 *  · every render is registered for auto-cleanup (afterEach unmount): the
 *    suites use document.getElementById for the id-pairing contracts, and a
 *    stale container from a previous test would shadow them (duplicate ids,
 *    first-match wins — exactly the DOM ambiguity the suite exists to catch);
 *  · queries are the plain DOM API — small, honest, and exactly what the
 *    a11y contracts are about.
 */
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach } from 'vitest'

// React's act() contract (React 19): opt the environment in so updates that
// escape act() are surfaced instead of silently interleaving.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Rendered {
  /** The mount point (appended to document.body). */
  container: HTMLElement
  root: Root
  rerender: (element: ReactElement) => void
  unmount: () => void
}

// ---- auto-cleanup (the RTL pattern, three lines instead of a dependency) --

const mounted: Rendered[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

/** Mount a React element into a fresh container, flushing effects via act. */
export function render(element: ReactElement): Rendered {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  const rendered: Rendered = {
    container,
    root,
    rerender: (el) => {
      act(() => {
        root.render(el)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
  mounted.push(rendered)
  return rendered
}

/** Click through React's delegated root listener (bubbling MouseEvent). */
export async function fireClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }))
  })
}

/** keydown through React's delegated root listener (bubbling KeyboardEvent). */
export async function fireKeydown(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/**
 * Set a controlled input's value the way a real browser does — the native
 * value setter, then an `input` event — so React's onChange observes it
 * (dispatching input with a directly-assigned .value is invisible to React).
 */
export async function fireInput(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('HTMLInputElement.prototype.value setter unavailable')
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Drive a non-React state change (zustand store writes, dispatches) through
 * async act so the subscriber re-render + its effects flush before the
 * next assertion.
 */
export async function actAsync(fn: () => void): Promise<void> {
  await act(async () => {
    fn()
  })
}

/** Wait for real-time asynchronous work (debounces, promises) inside act. */
export async function actSleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

// ---- tiny query aliases (kept local — no @testing-library/dom) -------------

export const byId = (id: string): HTMLElement | null => document.getElementById(id)

export const byRole = (root: ParentNode, role: string): HTMLElement | null =>
  root.querySelector(`[role="${role}"]`)

export const allByRole = (root: ParentNode, role: string): HTMLElement[] =>
  Array.from(root.querySelectorAll(`[role="${role}"]`))

/** createElement alias so .ts test files read close to JSX. */
export const h = createElement
