/**
 * #123 / audit FE-2 — the simulated-rails posture banner, pinned two ways:
 *
 *   · BEHAVIORAL (wallet-posture.ts — the pure storage seam): dismissal is
 *     remembered per project under a versioned per-posture localStorage key
 *     (house 'mjengo-os-*' convention), isolates per project, re-arms when
 *     the posture flips or the key version bumps, and fails VISIBLE (corrupt
 *     record / no window / storage refusal → banner shows, never hidden).
 *     The zustand-persist convention doesn't apply here — this is one-off
 *     per-project UI state, so the module reads localStorage directly.
 *
 *   · SOURCE PINS (the repo's no-DOM frontend convention — cf. i18n.test.ts
 *     / frontend-a11y.test.ts): the banner mounts at the TOP of the Money
 *     tab above the KPI row, renders copy only through the money.posture.*
 *     dict keys with role="status" semantics and a labelled dismiss button,
 *     gates itself on the WALLET_RAILS_POSTURE constant (#43), reads the
 *     dismissal only after mount (the i18n provider's no-hydration-mismatch
 *     rule), and the fundis payroll gate dialog reuses the SAME key family
 *     (no divergent copy) while the honest inline notes stay untouched.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  POSTURE_BANNER_STORAGE_VERSION,
  WALLET_RAILS_POSTURE,
  dismissPostureBanner,
  isPostureBannerDismissed,
  postureBannerKey,
} from '@/frontend/mjengo/wallet-posture'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

// ---------------- behavioral · the storage seam ----------------

/** Minimal Storage double (vitest runs node-only — no real localStorage). */
class FakeStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string): void { this.map.set(k, String(v)) }
  removeItem(k: string): void { this.map.delete(k) }
  clear(): void { this.map.clear() }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null }
  get length(): number { return this.map.size }
}

let storage: FakeStorage

function stubWindow() {
  storage = new FakeStorage()
  vi.stubGlobal('window', { localStorage: storage })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#123 storage seam: dismissal persistence + posture re-arm', () => {
  it('the key is per-project and versioned (house mjengo-os-* convention)', () => {
    expect(postureBannerKey('p1')).toBe(`mjengo-os-posture-banner.v${POSTURE_BANNER_STORAGE_VERSION}.p1`)
    expect(postureBannerKey('p1')).not.toBe(postureBannerKey('p2'))
  })

  it('the current posture is simulated (flipping it is the deliberate #43 act)', () => {
    expect(WALLET_RAILS_POSTURE).toBe('simulated')
  })

  it('not dismissed by default; no window (SSR) fails visible', () => {
    // No window stubbed — the module must treat that as "not dismissed".
    expect(isPostureBannerDismissed('p1')).toBe(false)
    stubWindow()
    expect(isPostureBannerDismissed('p1')).toBe(false)
  })

  it('dismiss() writes the posture + timestamp under the versioned per-project key', () => {
    stubWindow()
    dismissPostureBanner('p1')
    const raw = storage.getItem(postureBannerKey('p1'))
    expect(raw).not.toBeNull()
    const record = JSON.parse(raw!) as { posture: string; dismissedAt: string }
    expect(record.posture).toBe('simulated')
    expect(Number.isNaN(Date.parse(record.dismissedAt))).toBe(false)
    expect(isPostureBannerDismissed('p1')).toBe(true)
  })

  it('dismissal is remembered per project (switching projects does not nag… or leak)', () => {
    stubWindow()
    dismissPostureBanner('p1')
    expect(isPostureBannerDismissed('p1')).toBe(true)
    expect(isPostureBannerDismissed('p2')).toBe(false)
  })

  it('RE-ARMS when the posture changes (the #43 flip makes the banner reappear)', () => {
    stubWindow()
    dismissPostureBanner('p1', 'simulated')
    // #43 lands → the constant flips to 'production' → an old dismissal no
    // longer counts, and (for any future non-simulated posture that still
    // wants disclosure) the banner re-arms rather than staying hidden.
    expect(isPostureBannerDismissed('p1', 'production')).toBe(false)
    // …while the dismissal it was given under still holds.
    expect(isPostureBannerDismissed('p1', 'simulated')).toBe(true)
  })

  it('RE-ARMS when the storage-key VERSION bumps (old-version keys are ignored)', () => {
    stubWindow()
    // A dismissal written by an older build (version 0 of the key).
    storage.setItem('mjengo-os-posture-banner.v0.p1', JSON.stringify({ posture: 'simulated', dismissedAt: '2026-01-01T00:00:00.000Z' }))
    expect(isPostureBannerDismissed('p1')).toBe(false)
    // And the current-version write still works alongside it.
    dismissPostureBanner('p1')
    expect(isPostureBannerDismissed('p1')).toBe(true)
    expect(storage.getItem('mjengo-os-posture-banner.v0.p1')).not.toBeNull() // untouched, just shadowed
  })

  it('a corrupt or posture-mismatched record fails VISIBLE (banner shows)', () => {
    stubWindow()
    storage.setItem(postureBannerKey('p1'), '{not json')
    expect(isPostureBannerDismissed('p1')).toBe(false)
    storage.setItem(postureBannerKey('p1'), JSON.stringify({ posture: 'something-else', dismissedAt: '2026-01-01T00:00:00.000Z' }))
    expect(isPostureBannerDismissed('p1')).toBe(false)
    storage.setItem(postureBannerKey('p1'), JSON.stringify({}))
    expect(isPostureBannerDismissed('p1')).toBe(false)
  })

  it('a storage refusal never throws (fail-visible: the banner just stays)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('SecurityError') },
        setItem: () => { throw new Error('QuotaExceededError') },
      },
    })
    expect(() => dismissPostureBanner('p1')).not.toThrow()
    expect(isPostureBannerDismissed('p1')).toBe(false)
  })
})

// ---------------- source pins · the banner wiring ----------------

describe('#123 banner wiring: Money tab surface + fundis gate reuse', () => {
  const bannerSrc = readSrc('src/frontend/mjengo/wallet-posture-banner.tsx')
  const moneySrc = readSrc('src/frontend/mjengo/money-tab.tsx')
  const fundisSrc = readSrc('src/frontend/mjengo/fundis-tab.tsx')

  it('money-tab mounts the banner at the TOP, above the KPI row', () => {
    expect(moneySrc).toContain('import { WalletPostureBanner }')
    expect(moneySrc).toContain('<WalletPostureBanner projectId={data.project.id} />')
    expect(moneySrc.indexOf('<WalletPostureBanner')).toBeGreaterThan(-1)
    expect(moneySrc.indexOf('<WalletPostureBanner')).toBeLessThan(moneySrc.indexOf("t('money.kpiAria')"))
  })

  it('the banner renders only dict copy, with status semantics + labelled dismiss', () => {
    expect(bannerSrc).toContain("t('money.posture.title')")
    expect(bannerSrc).toContain("t('money.posture.note')")
    expect(bannerSrc).toContain("t('money.posture.dismissAria')")
    expect(bannerSrc).toContain("t('money.posture.dismiss')")
    expect(bannerSrc).toContain('role="status"')
    expect(bannerSrc).not.toContain('role="alert"') // informational, not an error
  })

  it('the banner gates on the #43 posture constant and reads dismissal only after mount', () => {
    expect(bannerSrc).toContain("WALLET_RAILS_POSTURE !== 'simulated'")
    expect(bannerSrc).toContain('isPostureBannerDismissed(projectId)')
    expect(bannerSrc).toContain('dismissPostureBanner(projectId)')
    // The i18n provider's no-hydration-mismatch convention: SSR + hydration
    // pass render the honest default; localStorage is a post-mount read.
    expect(bannerSrc).toContain('useEffect')
    expect(bannerSrc).not.toContain('useState(() =>')
  })

  it('the fundis payroll gate reuses the SAME posture key family (no divergent copy)', () => {
    expect(fundisSrc).toContain("t('money.posture.title')")
    expect(fundisSrc).toContain("t('money.posture.note')")
    // the shared line lives in the payroll GATE dialog region, after the gate copy
    expect(fundisSrc.indexOf("t('money.posture.note')")).toBeGreaterThan(fundisSrc.indexOf("t('fundis.gate.resolve')"))
  })

  it('the honest inline notes are untouched (the banner is additive)', () => {
    expect(moneySrc).toContain("t('money.topup.note'")
    expect(moneySrc).toContain("t('money.pr.simulatedNote'")
    // MD-4 (#350): the top-up reference preview still exists — it now draws
    // the shared CSPRNG seam instead of a local Math.random copy (was
    // `function previewReference(`; pinned further in csprng-ids.test.ts).
    expect(moneySrc).toContain('autoPaymentReference(tMethod)')
    expect(fundisSrc).toContain("t('fundis.payrollPaid'")
  })
})
