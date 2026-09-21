// @vitest-environment jsdom
/**
 * #356 (session-2 register: "WhatsApp panel server-fed content") — RUNTIME
 * render contract: the WhatsApp simulation panel renders EXACTLY the content
 * the server serves, and keeps no canned client-side copy of the conversation.
 *
 * The unit tier (tests/unit/whatsapp-route.test.ts, "#356 server-fed panel
 * content") pins the SERVER side — GET /api/whatsapp?view=simulation returns
 * the greeting/keywords/helpText, with the helpText pinned verbatim to the
 * reply a HELP text gets. THIS suite pins the CLIENT side at the #345
 * runtime-DOM tier: mount the REAL WhatsAppPanel (real i18n dict, real zustand
 * store) with fetch doubled to serve a DISTINCTIVE payload — if any string of
 * the conversation were still hardcoded in the panel, these assertions fail
 * because the served strings deliberately differ from anything the panel could
 * invent.
 *
 * Pinned per acceptance criterion:
 *   · the panel fetches the seam URL (?view=simulation) on mount;
 *   · the greeting bubble, the keyword chips, the composer placeholder's
 *     keyword list and the keywords reference render the SERVED values;
 *   · a load failure shows the honest contentUnavailable note and renders NO
 *     chips, NO greeting bubble and NO keyword list — a client-side stand-in
 *     would betray every one of these assertions;
 *   · the panel source carries none of the line's canned content (the grammar
 *     lives in the route, the only source).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WhatsAppPanel } from '@/frontend/mjengo/whatsapp-panel'
import { I18nProvider } from '@/frontend/i18n/provider'
import { enDict } from '@/frontend/i18n/dicts/en'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { seedOwnerStore } from './_helpers/app-fixture'
import { actAsync, fireClick, h, render } from './_helpers/react-render'
import { WHATSAPP_SIMULATION_VIEW } from '@/shared/whatsapp-simulation'

/** The seam URL the panel must call — the same view param the route serves. */
const SEAM_URL = `/api/whatsapp?view=${WHATSAPP_SIMULATION_VIEW}`

/**
 * DISTINCTIVE served content: nothing here matches anything the old canned
 * panel shipped ('MjengoOS line ready', PRESENT/ABSENT/HALF/BALANCE/HELP
 * chips), so a regression back to client-side copy cannot pass through.
 */
const SERVED = {
  greeting: 'QA line greeting — served by the route (pin)',
  keywords: ['KARIBU', 'POA', 'HERI'],
  helpText: 'QA HELP text line one\nQA HELP text line two — served',
} as const

/** Minimal Response double — the panel reads ok/status/json/text only. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  } as unknown as Response
}

/** The keyword chips are plain buttons; collect every button's text. */
const buttonTexts = (): string[] =>
  Array.from(document.querySelectorAll('button')).map((b) => b.textContent ?? '')

/** The chat log (role=log) — where bubbles land. */
const chatLog = (): HTMLElement => {
  const log = document.querySelector('[role="log"]')
  expect(log, 'the chat log region is mounted').toBeTruthy()
  return log as HTMLElement
}

/** The message composer input (stable aria-label, no server content). */
const composer = (): HTMLInputElement => {
  const el = document.querySelector(`input[aria-label="${enDict['wa.chat.composerLabel']}"]`)
  expect(el, 'the composer input is mounted').toBeTruthy()
  return el as HTMLInputElement
}

beforeEach(() => {
  useLocalePrefs.setState({ language: 'en' })
  seedOwnerStore()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === SEAM_URL) {
        return fakeResponse({ ok: true, simulation: SERVED })
      }
      // Any other call (a send) gets an honest plain-text reply.
      return fakeResponse('QA reply — MjengoOS sim')
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#356 runtime: the panel renders what the route serves', () => {
  it('fetches the simulation seam on mount', async () => {
    render(h(I18nProvider, null, h(WhatsAppPanel)))
    await actAsync(() => {})
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls).toContain(SEAM_URL)
  })

  it('the greeting bubble renders the SERVED greeting verbatim (no canned line copy)', async () => {
    render(h(I18nProvider, null, h(WhatsAppPanel)))
    await actAsync(() => {})
    const log = chatLog().textContent ?? ''
    expect(log).toContain(SERVED.greeting)
    // The OLD canned greeting must NOT appear anywhere (it is the route's to
    // serve, and this fixture deliberately served something else).
    expect(document.body.textContent ?? '').not.toContain('MjengoOS line ready')
  })

  it('the keyword chips render the SERVED grammar, not the hardcoded one', async () => {
    render(h(I18nProvider, null, h(WhatsAppPanel)))
    await actAsync(() => {})
    const texts = buttonTexts()
    for (const kw of SERVED.keywords) {
      expect(texts, `chip "${kw}" renders`).toContain(kw)
    }
    // The shipped grammar belongs to the SERVER: none of it may render as a
    // chip when the server served a different list.
    for (const kw of ['PRESENT', 'ABSENT', 'HALF', 'BALANCE']) {
      expect(texts, `canned keyword "${kw}" must not render as a chip`).not.toContain(kw)
    }
  })

  it('the composer placeholder interpolates the served keywords; the reference shows the served HELP text', async () => {
    render(h(I18nProvider, null, h(WhatsAppPanel)))
    await actAsync(() => {})
    expect(composer().getAttribute('placeholder')).toBe(
      `Type a message — ${SERVED.keywords.join(' · ')} or free text`,
    )
    // The keywords reference (details block) carries the served helpText.
    expect(document.body.textContent ?? '').toContain(SERVED.helpText.split('\n')[0] as string)
    expect(document.body.textContent ?? '').toContain(SERVED.helpText.split('\n')[1] as string)
  })

  it('a chip click loads the served keyword into the composer', async () => {
    render(h(I18nProvider, null, h(WhatsAppPanel)))
    await actAsync(() => {})
    const chip = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === SERVED.keywords[0],
    )
    expect(chip, 'the first served chip is rendered').toBeTruthy()
    await fireClick(chip as Element)
    expect(composer().value).toBe(SERVED.keywords[0])
  })
})

describe('#356 runtime: a load failure is honest — no client-side stand-in', () => {
  beforeEach(() => {
    // Overwrite the happy-path stub from the outer beforeEach: the seam 503s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === SEAM_URL) return fakeResponse({ error: 'unavailable' }, 503)
        return fakeResponse('QA reply — MjengoOS sim')
      }),
    )
  })

  it('shows the honest contentUnavailable note and renders NO chips, NO greeting, NO keyword list', async () => {
    render(h(I18nProvider, null, h(WhatsAppPanel)))
    await actAsync(() => {})
    expect(document.body.textContent ?? '').toContain(enDict['wa.chat.contentUnavailable'])
    // No greeting bubble at all — the log is empty (nothing served, nothing
    // rendered; a canned fallback would land here and fail).
    expect(chatLog().textContent ?? '').not.toContain('MjengoOS')
    // No chips of ANY grammar — served or canned.
    const texts = buttonTexts()
    for (const kw of [...SERVED.keywords, 'PRESENT', 'ABSENT', 'HALF', 'BALANCE', 'HELP']) {
      expect(texts, `no chip "${kw}" on failure`).not.toContain(kw)
    }
    // The placeholder falls back to the plain label, not a keyword list.
    expect(composer().getAttribute('placeholder')).toBe(enDict['wa.chat.placeholderPlain'])
  })
})

describe('#356 static pin: the panel source carries no canned conversation content', () => {
  it('whatsapp-panel.tsx holds no copy of the line\'s grammar or greeting', () => {
    // process.cwd() is the repo root under vitest (import.meta.url is an
    // http URL in the jsdom environment, so no fileURLToPath here).
    const source = readFileSync(
      resolve(process.cwd(), 'src/frontend/mjengo/whatsapp-panel.tsx'),
      'utf8',
    )
    expect(source).not.toContain('MjengoOS line ready')
    expect(source).not.toContain('Reply HELP for keywords')
    // The grammar keywords appear only as dict-free UI chrome if at all —
    // assert none of the line's keywords is listed in the component source.
    for (const kw of ['PRESENT', 'ABSENT', 'HALF', 'BALANCE']) {
      expect(source, `panel source must not list "${kw}"`).not.toContain(`'${kw}'`)
    }
    // The seam view param is the SHARED constant, not a duplicated string.
    expect(source).toContain('WHATSAPP_SIMULATION_VIEW')
  })
})
