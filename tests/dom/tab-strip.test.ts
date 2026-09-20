// @vitest-environment jsdom
/**
 * #137 (audit FE-8) — RUNTIME tab-strip a11y: the tablist/tab/tabpanel
 * pattern on the real MjengoApp, in a real DOM.
 *
 * This is the contract tests/unit/frontend-a11y.test.ts could only pin as
 * source strings: id PAIRING (a tab's aria-controls actually resolving to
 * the mounted panel, the panel's aria-labelledby resolving back to real tab
 * elements) and the roving-tabindex keyboard behavior of
 * nav/use-tablist.ts. A refactor that keeps the pinned template strings but
 * breaks the rendered semantics now fails HERE.
 *
 * What runs real: MjengoApp (banners, panel wrapper, gates), Header (the
 * desktop strip + its GlobalSearch/switcher/bells), MobileBottomNav (the
 * mobile primary strip + More sheet), the zustand stores, i18n.
 * What is doubled: the next-auth session (contractor) and the TAB CONTENT
 * components (13 tab bodies + palette/dialogs/screens) — replaced with null
 * stubs so the suite mounts the app shell without recharts/cmdk weight.
 * The a11y surface under test (strip + panel + bottom nav) is 100% real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---- doubles (hoisted with the test file, before any app import) ----------

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

// Tab bodies + heavy app children → null stubs (the shell is the subject).
vi.mock('@/frontend/mjengo/overview-tab', () => ({ OverviewTab: () => null }))
vi.mock('@/frontend/mjengo/site-plan-tab', () => ({ SitePlanTab: () => null }))
vi.mock('@/frontend/mjengo/materials-tab', () => ({ MaterialsTab: () => null }))
vi.mock('@/frontend/mjengo/fundis-tab', () => ({ FundisTab: () => null }))
vi.mock('@/frontend/mjengo/money-tab', () => ({ MoneyTab: () => null }))
vi.mock('@/frontend/mjengo/evidence-tab', () => ({ EvidenceTab: () => null }))
vi.mock('@/frontend/mjengo/copilot-tab', () => ({ CopilotTab: () => null }))
vi.mock('@/frontend/mjengo/land-tab', () => ({ LandTab: () => null }))
vi.mock('@/frontend/mjengo/finder-tab', () => ({ FinderTab: () => null }))
vi.mock('@/frontend/mjengo/intel-tab', () => ({ IntelTab: () => null }))
vi.mock('@/frontend/mjengo/ussd-tab', () => ({ UssdTab: () => null }))
vi.mock('@/frontend/mjengo/audit-tab', () => ({ AuditTab: () => null }))
vi.mock('@/frontend/mjengo/settings-tab', () => ({ SettingsTab: () => null }))
vi.mock('@/frontend/mjengo/cmdk/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/frontend/mjengo/welcome-screen', () => ({ WelcomeScreen: () => null }))
vi.mock('@/frontend/auth/login-screen', () => ({ LoginScreen: () => null }))
vi.mock('@/frontend/mjengo/supplier/supplier-portal', () => ({ SupplierPortal: () => null }))
vi.mock('@/frontend/mjengo/create-project-dialog', () => ({ CreateProjectDialog: () => null }))
vi.mock('@/frontend/mjengo/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/frontend/mjengo/diaspora-banner', () => ({ DiasporaBanner: () => null }))

import { MjengoApp } from '@/frontend/mjengo/app'
import { I18nProvider } from '@/frontend/i18n/provider'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { seedOwnerStore } from './_helpers/app-fixture'
import { allByRole, byId, byRole, fireClick, fireKeydown, h, render, type Rendered } from './_helpers/react-render'

/** Contractor tab set = ALL_TABS minus audit/supplier (permissions.ts). */
const CONTRACTOR_TABS = [
  'overview', 'site', 'materials', 'finder', 'fundis', 'money',
  'land', 'evidence', 'intel', 'copilot', 'ussd', 'settings',
] as const

/** The desktop strip (nav[role=tablist] in header.tsx). */
const desktopStrip = (r: Rendered): HTMLElement => {
  const strip = r.container.querySelector('nav[role="tablist"]')
  expect(strip, 'header.tsx renders nav[role="tablist"]').toBeTruthy()
  return strip as HTMLElement
}

/** The mobile bottom-nav primary strip (ul[role=tablist] in mobile-bottom-nav.tsx). */
const mobileStrip = (r: Rendered): HTMLElement => {
  const strip = r.container.querySelector('ul[role="tablist"]')
  expect(strip, 'mobile-bottom-nav.tsx renders ul[role="tablist"]').toBeTruthy()
  return strip as HTMLElement
}

const desktopTab = (key: string): HTMLElement => {
  const el = byId(`mjengo-tab-${key}`)
  expect(el, `desktop tab mjengo-tab-${key} is mounted`).toBeTruthy()
  return el as HTMLElement
}

let app: Rendered

beforeEach(() => {
  useLocalePrefs.setState({ language: 'en' })
  seedOwnerStore()
  app = render(h(I18nProvider, null, h(MjengoApp)))
})

// ---------------- roles + id pairing (the static-pin blind spot) -----------

describe('#137 runtime tab strip: tablist/tab/tabpanel roles + id pairing', () => {
  it('the desktop strip is a labelled tablist of role=tab buttons with unique ids + aria-controls', () => {
    const strip = desktopStrip(app)
    expect(strip.getAttribute('aria-label')).toBeTruthy()
    const tabs = allByRole(strip, 'tab')
    expect(tabs.map((t) => t.id)).toEqual(CONTRACTOR_TABS.map((key) => `mjengo-tab-${key}`))
    // Every tab points at its would-be panel id (unique per key).
    for (const tab of tabs) {
      const key = tab.id.replace('mjengo-tab-', '')
      expect(tab.getAttribute('aria-controls')).toBe(`mjengo-panel-${key}`)
    }
    expect(new Set(tabs.map((t) => t.getAttribute('aria-controls'))).size).toBe(tabs.length)
  })

  it('the ACTIVE tab\'s aria-controls RESOLVES to the mounted role=tabpanel (not just a string)', () => {
    const strip = desktopStrip(app)
    const panels = allByRole(app.container, 'tabpanel')
    expect(panels).toHaveLength(1) // only the active tab's panel is mounted
    const panel = panels[0]
    const active = strip.querySelector('[aria-selected="true"]') as HTMLElement
    expect(active.id).toBe('mjengo-tab-overview')
    // THE static-pin blind spot: the referenced node must exist in the DOM.
    expect(byId(active.getAttribute('aria-controls') as string)).toBe(panel)
    expect(panel.id).toBe('mjengo-panel-overview')
  })

  it('the panel\'s aria-labelledby ids resolve to real tab elements on BOTH strips (owner surface)', () => {
    const panel = byRole(app.container, 'tabpanel') as HTMLElement
    expect(panel.getAttribute('aria-labelledby')).toBe('mjengo-tab-overview mjengo-mtab-overview')
    // Desktop half of the label resolves to the selected desktop tab.
    const desktop = byId('mjengo-tab-overview') as HTMLElement
    expect(desktop.getAttribute('role')).toBe('tab')
    expect(desktop.getAttribute('aria-selected')).toBe('true')
    // Mobile half resolves to the bottom-nav tab (overview is a PRIMARY tab).
    const mobile = byId('mjengo-mtab-overview') as HTMLElement
    expect(mobile.getAttribute('role')).toBe('tab')
    expect(mobile.getAttribute('aria-selected')).toBe('true')
  })

  it('clicking a desktop tab switches the panel and re-pairs ids in BOTH directions', async () => {
    await fireClick(desktopTab('money'))
    const panel = byRole(app.container, 'tabpanel') as HTMLElement
    expect(panel.id).toBe('mjengo-panel-money')
    // New active tab ↔ new panel, both directions.
    expect(desktopTab('money').getAttribute('aria-selected')).toBe('true')
    expect(desktopTab('overview').getAttribute('aria-selected')).toBe('false')
    expect(byId(desktopTab('money').getAttribute('aria-controls') as string)).toBe(panel)
    // Panel → desktop tab still resolves after the switch.
    const labelledBy = (panel.getAttribute('aria-labelledby') as string).split(' ')
    expect(byId(labelledBy[0])).toBe(desktopTab('money'))
    // KNOWN LIMITATION (filed as #344, PR body "Known limitations"): the
    // second id (`mjengo-mtab-money`) does NOT resolve — 'money' lives in the
    // bottom-nav "More" sheet for this role, whose buttons carry no tab ids.
    // We deliberately do NOT pin the dangling ref as correct; the desktop id
    // (first in the list, always mounted) is the load-bearing one.
    expect(byId('mjengo-mtab-money')).toBeNull()
  })

  it('the mobile bottom-nav is its own tablist with a distinct id namespace', () => {
    const strip = mobileStrip(app)
    const tabs = allByRole(strip, 'tab')
    // ≤5 primary tabs for the role (contractor has copilot → camera cell → 4).
    expect(tabs.length).toBe(4)
    expect(tabs.map((t) => t.id)).toEqual(
      ['overview', 'site', 'materials', 'finder'].map((key) => `mjengo-mtab-${key}`),
    )
    // The ACTIVE mobile tab's aria-controls resolves to the same mounted panel
    // as the desktop strip's — the two strips share the panel id namespace.
    const active = strip.querySelector('[aria-selected="true"]') as HTMLElement
    expect(byId(active.getAttribute('aria-controls') as string)?.getAttribute('role')).toBe('tabpanel')
  })
})

// ---------------- roving tabindex (nav/use-tablist.ts at runtime) ----------

describe('#137 runtime tab strip: roving tabindex (arrow keys move focus, not selection)', () => {
  it('initially exactly ONE tab is tabbable — the active one (tabIndex 0, all others -1)', () => {
    const tabs = allByRole(desktopStrip(app), 'tab')
    const tabbable = tabs.filter((t) => t.tabIndex === 0)
    expect(tabbable.map((t) => t.id)).toEqual(['mjengo-tab-overview'])
  })

  it('ArrowRight moves focus to the next tab and moves the roving tabindex WITH it (manual activation: selection does NOT follow focus)', async () => {
    const overview = desktopTab('overview')
    overview.focus()
    expect(document.activeElement).toBe(overview)
    await fireKeydown(overview, 'ArrowRight')
    // Focus moved to the next tab…
    expect(document.activeElement).toBe(desktopTab('site'))
    // …the roving tabindex followed (site is now the single tab stop)…
    expect(desktopTab('site').tabIndex).toBe(0)
    expect(overview.tabIndex).toBe(-1)
    // …and the SELECTION stayed put (activation is click/Enter — manual).
    expect(overview.getAttribute('aria-selected')).toBe('true')
    expect(desktopTab('site').getAttribute('aria-selected')).toBe('false')
    expect(byRole(app.container, 'tabpanel')?.id).toBe('mjengo-panel-overview')
  })

  it('ArrowLeft wraps from the first tab to the last', async () => {
    const overview = desktopTab('overview')
    overview.focus()
    await fireKeydown(overview, 'ArrowLeft')
    expect(document.activeElement).toBe(desktopTab('settings'))
    expect(desktopTab('settings').tabIndex).toBe(0)
    expect(overview.tabIndex).toBe(-1)
  })

  it('Home jumps to the first tab, End to the last', async () => {
    const middle = desktopTab('fundis')
    middle.focus()
    await fireKeydown(middle, 'Home')
    expect(document.activeElement).toBe(desktopTab('overview'))
    await fireKeydown(desktopTab('overview'), 'End')
    expect(document.activeElement).toBe(desktopTab('settings'))
  })

  it('the mobile strip roves independently (its own tablist, same hook)', async () => {
    const mobile = byId('mjengo-mtab-overview') as HTMLElement
    mobile.focus()
    await fireKeydown(mobile, 'ArrowRight')
    expect(document.activeElement).toBe(byId('mjengo-mtab-site'))
    // The desktop strip's roving tabindex was NOT touched by the mobile one.
    expect(desktopTab('overview').tabIndex).toBe(0)
  })
})
