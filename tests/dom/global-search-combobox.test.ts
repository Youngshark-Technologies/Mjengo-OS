// @vitest-environment jsdom
/**
 * #137 (audit FE-8, pins FE-7 in tests/unit/frontend-a11y.test.ts) — RUNTIME
 * GlobalSearch combobox wiring: the desktop search box on the REAL Header
 * must keep aria-expanded / aria-controls / aria-activedescendant coherent
 * with the actually-rendered listbox and options.
 *
 * The static pins prove the attributes exist in the source; this suite
 * drives the real component: type a query → the debounced /api/search fetch
 * (stubbed) returns groups → the listbox MOUNTS, aria-expanded flips, the
 * aria-controls id RESOLVES to it, aria-activedescendant RESOLVES to the
 * active option, ArrowDown moves the active option, Escape tears it all
 * down. A refactor that keeps the pinned strings but stops rendering the
 * listbox (or breaks the id prefix) fails here.
 *
 * Real Header + real GlobalSearch logic + real i18n; doubles: the next-auth
 * session (authenticated contractor), the seeded owner store
 * (_helpers/app-fixture), and the /api/search fetch response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SESSION = vi.hoisted(() => ({
  data: {
    user: { id: 'u1', email: 'qa@mjengo.os', name: 'QA Supervisor', role: 'contractor' },
    expires: '9999-01-01',
  },
  status: 'authenticated' as const,
}))
vi.mock('next-auth/react', () => ({
  useSession: () => SESSION,
  signOut: async () => undefined,
}))

import { Header } from '@/frontend/mjengo/header'
import { I18nProvider } from '@/frontend/i18n/provider'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { seedOwnerStore } from './_helpers/app-fixture'
import { actSleep, byId, fireInput, fireKeydown, h, render } from './_helpers/react-render'

/** Two groups × two items → flat option ids gs-desktop-opt-0…3. */
const SEARCH_GROUPS = [
  {
    group: 'Materials',
    items: [
      { id: 'm1', title: 'Dubai cement', sub: '12 bags', project: 'QA Bungalow', target: 'catalog' },
      { id: 'm2', title: 'Dumba ballast', sub: '7 tonnes', project: 'QA Bungalow', target: 'catalog' },
    ],
  },
  {
    group: 'Fundis',
    items: [
      { id: 'w1', title: 'Dube the mason', sub: 'masonry', project: 'QA Bungalow', target: 'worker' },
      { id: 'w2', title: 'Dube the fundi', sub: 'plumbing', project: 'QA Bungalow', target: 'worker' },
    ],
  },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  useLocalePrefs.setState({ language: 'en' })
  seedOwnerStore()
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, groups: SEARCH_GROUPS }) }))
  vi.stubGlobal('fetch', fetchMock)
  render(
    h(I18nProvider, null,
      h(Header, { tab: 'overview', onTabChange: () => {}, onCreateProject: () => {}, onShare: () => {} })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The desktop combobox input (the mobile one only mounts when expanded). */
const combobox = (): HTMLInputElement => {
  const el = document.querySelector('input[role="combobox"]')
  expect(el, 'desktop GlobalSearch renders an input[role=combobox]').toBeTruthy()
  return el as HTMLInputElement
}

describe('#137 runtime combobox: GlobalSearch aria wiring (desktop box)', () => {
  it('closed state: collapsed, and NO aria-controls / activedescendant pointing at nothing', () => {
    const input = combobox()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    // Collapsed must not dangle references — undefined renders no attribute.
    expect(input.getAttribute('aria-controls')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(byId('gs-desktop-results')).toBeNull()
  })

  it('typing a query expands the results: expanded/controls/activedescendant all set and all RESOLVE', async () => {
    const input = combobox()
    await fireInput(input, 'dub')
    // Debounce is 250ms (min 2 chars) — let the fetch + state land inside act.
    await actSleep(450)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/search?q=dub')

    expect(input.getAttribute('aria-expanded')).toBe('true')
    // aria-controls RESOLVES to the mounted listbox (the static-pin blind spot).
    const listboxId = input.getAttribute('aria-controls')
    expect(listboxId).toBe('gs-desktop-results')
    const listbox = byId(listboxId as string)
    expect(listbox?.getAttribute('role')).toBe('listbox')
    expect(listbox?.getAttribute('aria-label')).toBeTruthy()

    // First result is active by default → activedescendant resolves to it.
    const activeId = input.getAttribute('aria-activedescendant')
    expect(activeId).toBe('gs-desktop-opt-0')
    const activeOption = byId(activeId as string)
    expect(activeOption?.getAttribute('role')).toBe('option')
    expect(activeOption?.getAttribute('aria-selected')).toBe('true')

    // Every rendered option carries a unique resolvable id.
    const optionIds = Array.from(listbox?.querySelectorAll('[role="option"]') ?? []).map(
      (o) => o.id,
    )
    expect(optionIds).toEqual([
      'gs-desktop-opt-0', 'gs-desktop-opt-1', 'gs-desktop-opt-2', 'gs-desktop-opt-3',
    ])
    expect(new Set(optionIds).size).toBe(4)
  })

  it('ArrowDown moves the active option — activedescendant follows and the newly active option is aria-selected', async () => {
    const input = combobox()
    await fireInput(input, 'dub')
    await actSleep(450)

    await fireKeydown(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe('gs-desktop-opt-1')
    expect(byId('gs-desktop-opt-1')?.getAttribute('aria-selected')).toBe('true')
    expect(byId('gs-desktop-opt-0')?.getAttribute('aria-selected')).toBe('false')

    await fireKeydown(input, 'ArrowDown')
    await fireKeydown(input, 'ArrowDown')
    // Clamped at the last option (never past the list).
    expect(input.getAttribute('aria-activedescendant')).toBe('gs-desktop-opt-3')
  })

  it('Escape collapses the popup: expanded false, controls/activedescendant gone, listbox unmounted', async () => {
    const input = combobox()
    await fireInput(input, 'dub')
    await actSleep(450)
    expect(byId('gs-desktop-results')).toBeTruthy()

    await fireKeydown(input, 'Escape')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-controls')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(byId('gs-desktop-results')).toBeNull()
  })
})
