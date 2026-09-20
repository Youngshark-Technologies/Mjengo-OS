// @vitest-environment jsdom
/**
 * #137 (audit FE-8) — RUNTIME <html lang> sync: the real I18nProvider
 * mounted in a real document.
 *
 * Overlap note: tests/unit/html-lang.test.ts already pins (a) the
 * syncHtmlLang WRITER behaviorally against a stubbed document and (b) the
 * provider/layout WIRING via source pins. What only a runtime DOM test can
 * pin is the composition: provider + useEffect + real documentElement —
 * i.e. mounting the provider actually flips document.documentElement.lang,
 * and a live locale switch (the zustand persist store, exactly what the
 * Settings tab drives) re-runs the effect with no reload.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider, syncHtmlLang } from '@/frontend/i18n/provider'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { actAsync, h, render } from './_helpers/react-render'

beforeEach(() => {
  // Both the persisted locale store and the document start English.
  useLocalePrefs.setState({ language: 'en' })
  document.documentElement.lang = 'en'
})

describe('#137 runtime <html lang>: the mounted I18nProvider owns the document element', () => {
  it('mounting the provider syncs <html lang> to the default locale (en) via the [locale] effect', () => {
    // A stale non-en value (e.g. a hard-coded markup drift) is corrected on
    // mount — the effect runs for the initial locale too.
    document.documentElement.lang = 'fr'
    const app = render(h(I18nProvider, null, h('div', null, 'probe')))
    expect(document.documentElement.lang).toBe('en')
    app.unmount()
  })

  it('a live locale switch updates documentElement.lang immediately — en → sw → en, no reload', async () => {
    const app = render(h(I18nProvider, null, h('div', null, 'probe')))
    await actAsync(() => {
      useLocalePrefs.getState().setLanguage('sw')
    })
    expect(document.documentElement.lang).toBe('sw')

    await actAsync(() => {
      useLocalePrefs.getState().setLanguage('en')
    })
    expect(document.documentElement.lang).toBe('en')
    app.unmount()
  })

  it('unmounting the provider leaves the last-synced lang in place (the layout script owns first paint, not the unmount)', async () => {
    const app = render(h(I18nProvider, null, h('div', null, 'probe')))
    await actAsync(() => {
      useLocalePrefs.getState().setLanguage('sw')
    })
    app.unmount()
    expect(document.documentElement.lang).toBe('sw')
    // The writer stays callable outside React (the exported seam the node
    // suite tests) — same real document here.
    syncHtmlLang('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
