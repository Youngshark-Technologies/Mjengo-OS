/**
 * FE-3/4/5/7 (issue #80) — static source pins for the robustness & a11y pass.
 *
 * The repo's convention for frontend invariants (cf. client-actions.test.ts
 * / i18n.test.ts): read the component source and assert the pattern is
 * present (or the regression is absent). A behavioral suite for the FE-6
 * data flow lives in frontend-robustness.test.ts; this file pins the
 * MARKUP-level contracts:
 *
 *   · FE-3  route error files exist (error.tsx branded + reset;
 *           global-error.tsx owns <html><body>) + a shell boundary wraps
 *           the header in app.tsx;
 *   · FE-4  the audited light-bg muted text is stone-600 (not stone-400),
 *           the footer link is stone-300, amber-600-as-text is amber-700;
 *   · FE-5  ui/button.tsx default/sm/lg/icon sizes are 44/40/48/44px and the
 *           client mobile tab strip is min-h-11;
 *   · FE-7  tab↔panel aria linkage (tab ids + aria-controls → panel id,
 *           panel aria-labelledby), the combobox pattern on GlobalSearch,
 *           and NO role="listitem" on the login demo buttons;
 *   · FE-1/MD-1  the login demo quick-fill panel is gated on module-scope
 *           NODE_ENV !== 'production' (Next inlines NODE_ENV — build-time
 *           removal from production bundles; manual login stays ungated).
 *
 * #137 UPDATE — the "no DOM test env" half of this convention is HISTORY:
 * the runtime DOM tier now exists in tests/dom/ (jsdom via vitest's
 * per-file environment pragma — see any tests/dom suite's first line;
 * this file and every other suite stay node-only). The four highest-risk contracts from the pins below are
 * now enforced BEHAVIORALLY there — tab strip id pairing + roving tabindex
 * (tests/dom/tab-strip.test.ts), dialog error announcement
 * (tests/dom/dialog-error-announcement.test.ts), the GlobalSearch combobox
 * wiring (tests/dom/global-search-combobox.test.ts) and the <html lang>
 * provider sync (tests/dom/html-lang-runtime.test.ts). These source pins
 * STAY: they are the cheap wide net (every file above, plus contrast
 * tokens, 44px targets, gates the runtime tier deliberately does not mount);
 * the DOM suite is the deep net on the pairing/semantics a string match
 * cannot see.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

// ---------------- FE-3 · error boundary coverage ----------------

describe('FE-3: app-level error boundaries exist', () => {
  it('src/app/error.tsx exists, is a client route boundary, and resets', () => {
    const src = readSrc('src/app/error.tsx')
    expect(src).toContain("'use client'")
    expect(src).toContain('reset: () => void') // the App Router props seam
    expect(src).toContain('onClick={reset}')
    expect(src).toContain('Try again')
    // Branded, bilingual (EN/SW hardcoded — outside the I18nProvider tree).
    expect(src).toContain('Card')
    expect(src).toContain('Jaribu tena')
  })

  it('src/app/global-error.tsx exists and owns <html><body> (root-layout crashes)', () => {
    const src = readSrc('src/app/global-error.tsx')
    expect(src).toContain("'use client'")
    expect(src).toContain('<html')
    expect(src).toContain('<body')
    expect(src).toContain('onClick={reset}')
  })

  it('app.tsx wraps the header in a shell boundary (header crash ≠ white screen)', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('<ErrorBoundary context="shell:header">')
    // The pre-existing per-tab boundary (key={activeTab}) must survive.
    expect(src).toContain('<ErrorBoundary context={`tab:${activeTab}`} key={activeTab}>')
  })
})

// ---------------- FE-4 · contrast tokens ----------------

describe('FE-4: audited light-bg muted text is stone-600, not stone-400', () => {
  const LIGHT_BG_FILES = [
    'src/frontend/auth/login-screen.tsx',        // demo hints + share note
    'src/frontend/mjengo/share-dialog.tsx',      // share note
    'src/frontend/mjengo/sync-outbox-panel.tsx', // outbox meta/timestamps
    'src/frontend/mjengo/project-switcher.tsx',  // dropdown labels + progress line
  ]

  it.each(LIGHT_BG_FILES.slice(1))('%s renders no text-stone-400 (2.31:1 on light)', (file) => {
    expect(readSrc(file)).not.toContain('text-stone-400')
  })

  it('login-screen: the hint / note / link TEXT is stone-600 (icons stay stone-400 — decorative)', () => {
    const src = readSrc('src/frontend/auth/login-screen.tsx')
    // The three audited text usages (hint span, share note, website link).
    expect(src).not.toContain('text-stone-400 truncate')
    expect(src).not.toContain('text-xs text-stone-400')
    expect(src).toContain('text-[11px] text-stone-600 truncate')
    expect(src).toContain('text-xs text-stone-600 px-4')
    expect(src).toContain('text-stone-600 underline decoration-stone-400')
  })

  it('the footer link is stone-300 on stone-950 (was stone-500, 3.65:1 at 11px)', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('text-stone-300 hover:text-stone-100')
    expect(src).not.toContain('text-stone-500 hover:text-stone-300')
  })

  it('amber-600-as-TEXT is amber-700 (icon accents are out of scope by design)', () => {
    // reliability score text
    expect(readSrc('src/frontend/mjengo/intel/sections/reliability-section.tsx'))
      .toContain("return 'text-amber-700'")
    // printable invoice wordmark
    expect(readSrc('src/frontend/mjengo/finder/sections/invoices/printable-invoice.tsx'))
      .toContain('text-amber-700')
    // active-project badge in the switcher
    expect(readSrc('src/frontend/mjengo/project-switcher.tsx'))
      .toContain('bg-amber-500/10 text-amber-700')
  })
})

// ---------------- FE-5 · 44px touch targets ----------------

describe('FE-5: Button defaults meet the 44px field target', () => {
  const src = readSrc('src/frontend/ui/button.tsx')

  it('default/sm/lg/icon sizes are 44/40/48/44px', () => {
    expect(src).toContain('default: "h-11 ')
    expect(src).toContain('sm: "h-10 ')
    expect(src).toContain('lg: "h-12 ')
    expect(src).toContain('icon: "size-11"')
    expect(src).not.toContain('default: "h-9 ')
    expect(src).not.toContain('sm: "h-8 ')
  })

  it('the client mobile tab strip is min-h-11 (44px, bottom-nav parity)', () => {
    const header = readSrc('src/frontend/mjengo/header.tsx')
    expect(header).toContain('px-3 py-1.5 min-h-11 rounded-md')
    expect(header).not.toContain('px-3 py-1.5 min-h-9 rounded-md')
  })

  it('the header Share/Bell pills carry an explicit 44px target', () => {
    const header = readSrc('src/frontend/mjengo/header.tsx')
    expect(header).toContain('className="min-h-11 gap-1.5 border-stone-700') // Bell
    expect(header).toContain('className="min-h-11 gap-1.5 border-stone-700') // Share — same shape
    expect((header.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})

// ---------------- FE-7 · a11y patterns ----------------

describe('FE-7: the tabs pattern is completed end-to-end', () => {
  it('header tab buttons carry id + aria-controls for the panel', () => {
    const src = readSrc('src/frontend/mjengo/header.tsx')
    expect(src).toContain('id={`mjengo-tab-${key}`}')
    expect(src).toContain('aria-controls={`mjengo-panel-${key}`}')
  })

  it('mobile bottom-nav tab buttons carry their own id namespace + aria-controls', () => {
    const src = readSrc('src/mobile/nav/mobile-bottom-nav.tsx')
    expect(src).toContain('id={`mjengo-mtab-${key}`}')
    expect(src).toContain('aria-controls={`mjengo-panel-${key}`}')
  })

  it("app.tsx renders the active panel as role=tabpanel with id + aria-labelledby", () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('role="tabpanel"')
    expect(src).toContain('id={`mjengo-panel-${activeTab}`}')
    expect(src).toContain('aria-labelledby={`mjengo-tab-${activeTab} mjengo-mtab-${activeTab}`}')
  })

  it('GlobalSearch implements the combobox pattern (expanded/controls/activedescendant)', () => {
    const src = readSrc('src/frontend/mjengo/header.tsx')
    expect(src).toContain('role="combobox"')
    expect(src).toContain('aria-expanded={open}')
    expect(src).toContain('aria-controls={open ? `${idPrefix}-results` : undefined}')
    expect(src).toContain('aria-activedescendant=')
    // listbox + options carry DOM ids; the two instances never collide.
    expect(src).toContain('id={`${idPrefix}-results`}')
    expect(src).toContain('id={`${idPrefix}-opt-${idx}`}')
    expect(src).toContain("searchBox(inputRef, 'gs-desktop')")
    expect(src).toContain("searchBox(mobileInputRef, 'gs-mobile', true)")
  })

  it('login demo accounts keep native button semantics (no role="listitem")', () => {
    const src = readSrc('src/frontend/auth/login-screen.tsx')
    expect(src).not.toContain('role="listitem"')
    expect(src).toContain('role="list"') // container keeps the list semantics
  })
})

// ---------------- FE-1/MD-1 · demo quick-fill production gate ----------------

describe('FE-1/MD-1: the demo quick-fill panel is gated out of production', () => {
  it('login-screen gates the demo panel on module-scope NODE_ENV (inlined by Next at build time)', () => {
    const src = readSrc('src/frontend/auth/login-screen.tsx')
    // The gate itself — Next inlines NODE_ENV into client bundles, so a
    // production build folds this constant to `false` and dead-code-eliminates
    // the panel (and the DEMO_ACCOUNTS credentials it renders).
    expect(src).toContain("const SHOW_DEMO_QUICKFILL = process.env.NODE_ENV !== 'production'")
    // …and the panel (title + accounts list) is the ONLY thing it wraps.
    expect(src).toContain('{SHOW_DEMO_QUICKFILL && (')
    // The manual login form itself stays always-available (ungated).
    expect(src).toContain('<form onSubmit={handleSubmit}')
  })
})

// ---------------- regression guards from the audit's hold list ----------------

describe('audit 2-b regression holds (untouched by this wave on purpose)', () => {
  it('per-tab boundary remount keying survives (app.tsx key={activeTab})', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('key={activeTab}')
  })

  it('the offline boot gate (issue #78) is still wired in app.tsx', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain('shouldOfflineBoot')
    expect(src).toContain('AUTH_LOADING_TIMEOUT_MS')
    expect(src).toContain("window.addEventListener('online', onOnline)")
  })
})

// ---------------------------------------------------------------------------
// #108 XS polish bundle (audit FE-2..FE-6): source pins for the plural fix,
// the announced dialog errors, the client-preview strip and the supplier
// 44px targets. Same static-pin convention as the blocks above.
// ---------------------------------------------------------------------------

describe('FE-2 (issue #108): site-plan zone aria-labels pluralize the photo count', () => {
  it('the zone button aria-label uses the 1 photo / N photos ternary (#125: via the sitemap.zoneAria* dict pair)', () => {
    const src = readSrc('src/frontend/mjengo/site-map-card.tsx')
    expect(src).toContain("zonePhotoCount === 1")
    expect(src).toContain("t('sitemap.zoneAriaOne'")
    expect(src).toContain("t('sitemap.zoneAriaMany'")
    expect(src).not.toContain('} photos`') // the old always-plural label
  })
})

describe('FE-3 (issue #108): dialog validation errors are announced', () => {
  it('expense dialog links the amount error via aria-describedby + role=alert', () => {
    const src = readSrc('src/frontend/mjengo/expense-dialog.tsx')
    expect(src).toContain("aria-describedby={amountError ? 'exp-amount-error' : undefined}")
    expect(src).toContain('id="exp-amount-error" role="alert"')
  })

  it('create-project dialog links name/budget/dates errors via aria-describedby + role=alert', () => {
    const src = readSrc('src/frontend/mjengo/create-project-dialog.tsx')
    for (const id of ['pj-name-error', 'pj-budget-error', 'pj-dates-error']) {
      expect(src).toContain(`aria-describedby={`)
      expect(src).toContain(`id="${id}" role="alert"`)
    }
  })

  it('worker dialogs link the name error via aria-describedby + role=alert', () => {
    const src = readSrc('src/frontend/mjengo/worker-dialogs.tsx')
    expect(src).toContain("aria-describedby={nameError ? 'wk-name-error' : undefined}")
    expect(src).toContain('id="wk-name-error" role="alert"')
  })
})

describe('FE-4 (issue #108): client PREVIEW renders the client tab strip', () => {
  it('app.tsx keys the strip on viewMode === \'client\', not on shareToken/clientRole', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain("const clientStrip = viewMode === 'client'")
    // The owner's AI Copilot / Audit tabs must never survive into a preview.
    expect(src).not.toContain('isClientSurface ? tabsForRole')
  })

  it('header.tsx does the same for the desktop strip', () => {
    const src = readSrc('src/frontend/mjengo/header.tsx')
    expect(src).toContain("const clientStrip = viewMode === 'client'")
    expect(src).not.toContain('isShareClient ? tabsForRole')
  })

  it('the owner bottom nav is hidden in ANY client view (mirrors a real share client)', () => {
    const src = readSrc('src/frontend/mjengo/app.tsx')
    expect(src).toContain(`{viewMode !== 'client' && <MobileBottomNav`)
  })
})

describe('FE-5 (issue #108): supplier portal header buttons meet the 44px target', () => {
  it('the three header buttons are h-11 min-h-11 (was h-9 min-h-9)', () => {
    const src = readSrc('src/frontend/mjengo/supplier/supplier-portal.tsx')
    expect(src).not.toContain('h-9 min-h-9')
    expect((src.match(/h-11 min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
