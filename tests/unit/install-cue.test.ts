/**
 * PWA install cue (issue #357 / audit FE-11 residual) — the dismissible
 * "Install app" cue, the install half of FE-11 (#148 landed the staleness
 * half: tests/unit/sw-update-prompt.test.ts is the template this file
 * follows).
 *
 * Covers the three layers of the cue:
 *   · the PURE decisions in src/frontend/sw-handlers.ts (#357 section): the
 *     standalone-display check (already installed → no cue, ever), the
 *     cue rule (browser offered + not dismissed + not installed), the
 *     honest iOS heuristic, and the instructions-only iOS hint rule (which
 *     stands down the moment a REAL install event exists);
 *   · the WATCH in src/frontend/pwa/install-cue-watch.ts — driven
 *     BEHAVIORALLY with fake windows, deferred events and storages: event
 *     capture (with preventDefault so our cue owns the moment), appinstalled,
 *     the dispose contract, the Install click's native prompt() ladder, and
 *     the GUARDED dismiss memory (a refusing storage never breaks the click
 *     and never claims the write landed);
 *   · SOURCE pins in the house style (readFileSync): the root layout mounts
 *     the cue inside I18nProvider ahead of the app shell, the component
 *     calls the canonical helpers instead of re-deriving them, the iOS
 *     variant renders NO install button (no fake flow where the browser
 *     never offered one), and the install.* keys exist in BOTH dictionaries.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  INSTALL_CUE_DISMISS_KEY,
  isStandaloneDisplay,
  looksLikeIOS,
  shouldShowInstallCue,
  shouldShowIosInstallHint,
} from '@/frontend/sw-handlers'
import {
  armInstallCue,
  promptInstall,
  readInstallDismissed,
  writeInstallDismissed,
  type InstallCueStorage,
  type InstallCueTarget,
  type InstallPromptEvent,
} from '@/frontend/pwa/install-cue-watch'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

const CUE_SRC = readFileSync(
  fileURLToPath(new URL('../../src/frontend/pwa/install-cue.tsx', import.meta.url)),
  'utf8',
)
const WATCH_SRC = readFileSync(
  fileURLToPath(new URL('../../src/frontend/pwa/install-cue-watch.ts', import.meta.url)),
  'utf8',
)
const LAYOUT_SRC = readFileSync(fileURLToPath(new URL('../../src/app/layout.tsx', import.meta.url)), 'utf8')

// ------------------------------------------------ pure decisions (sw-handlers)

describe('isStandaloneDisplay — already installed → no cue, ever', () => {
  it('either signal alone counts (W3C display-mode, or iOS navigator.standalone)', () => {
    expect(isStandaloneDisplay(true, undefined)).toBe(true)
    expect(isStandaloneDisplay(undefined, true)).toBe(true)
    expect(isStandaloneDisplay(true, false)).toBe(true)
    expect(isStandaloneDisplay(false, true)).toBe(true)
  })

  it('absent/false signals → a browser tab, the cue may arm', () => {
    expect(isStandaloneDisplay(false, false)).toBe(false)
    expect(isStandaloneDisplay(undefined, undefined)).toBe(false)
  })
})

describe('shouldShowInstallCue — only when the browser itself offered', () => {
  it('captured event + not dismissed + not installed → the cue shows', () => {
    expect(shouldShowInstallCue(true, false, false)).toBe(true)
  })

  it('NO event → NEVER the cue, whatever the other flags (no fake install flow)', () => {
    expect(shouldShowInstallCue(false, false, false)).toBe(false)
    expect(shouldShowInstallCue(false, true, false)).toBe(false)
    expect(shouldShowInstallCue(false, false, true)).toBe(false)
  })

  it('dismissed or installed → silent', () => {
    expect(shouldShowInstallCue(true, true, false)).toBe(false)
    expect(shouldShowInstallCue(true, false, true)).toBe(false)
  })
})

describe('looksLikeIOS — the honest iOS heuristic', () => {
  it('iPhone / iPad / iPod UAs match', () => {
    expect(
      looksLikeIOS(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        5,
      ),
    ).toBe(true)
    expect(looksLikeIOS('Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', 5)).toBe(true)
    expect(looksLikeIOS('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) Safari/604.1', 5)).toBe(true)
  })

  it('iPadOS 13+ masquerading as Macintosh with multi-touch matches (the documented compromise)', () => {
    expect(
      looksLikeIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 5),
    ).toBe(true)
  })

  it('a real desktop Mac (no touch), Android and Windows do NOT match', () => {
    expect(
      looksLikeIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 0),
    ).toBe(false)
    expect(looksLikeIOS('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', 5)).toBe(false)
    expect(looksLikeIOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 10)).toBe(false)
  })
})

describe('shouldShowIosInstallHint — instructions-only, and only where the event never fires', () => {
  it('an iOS-class device, not installed, not dismissed, NO event → the hint shows', () => {
    expect(shouldShowIosInstallHint(true, false, false, false, false)).toBe(true)
  })

  it('a REAL install event always wins — the hint stands down (future-proof honesty)', () => {
    expect(shouldShowIosInstallHint(true, false, false, false, true)).toBe(false)
  })

  it('not iOS, already standalone, dismissed, or installed → silent', () => {
    expect(shouldShowIosInstallHint(false, false, false, false, false)).toBe(false)
    expect(shouldShowIosInstallHint(true, true, false, false, false)).toBe(false)
    expect(shouldShowIosInstallHint(true, false, true, false, false)).toBe(false)
    expect(shouldShowIosInstallHint(true, false, false, true, false)).toBe(false)
  })
})

// ------------------------------------------------------ fakes (fake window etc.)

/** Minimal event target: capture listeners by type, fire them like the browser. */
class FakeWindow implements InstallCueTarget {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()
  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((l) => l !== listener)
    this.listeners.set(type, list)
  }
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length
  }
  fire(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

/** A deferred install event: preventDefault + prompt()/userChoice recording. */
class FakeDeferredEvent extends Event implements InstallPromptEvent {
  preventDefaultCalls = 0
  promptCalls = 0
  constructor(readonly outcome: 'accepted' | 'dismissed' | 'throws' = 'dismissed') {
    super('beforeinstallprompt')
  }
  preventDefault(): void {
    this.preventDefaultCalls += 1
  }
  prompt(): Promise<void> {
    this.promptCalls += 1
    if (this.outcome === 'throws') return Promise.reject(new Error('not allowed'))
    return Promise.resolve()
  }
  get userChoice(): Promise<{ outcome: 'accepted' | 'dismissed' }> {
    if (this.outcome === 'throws') return Promise.reject(new Error('no choice'))
    return Promise.resolve({ outcome: this.outcome })
  }
}

/** An in-memory storage (the localStorage shape). */
function memoryStorage(initial: Record<string, string> = {}): InstallCueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => {
      data.set(name, value)
    },
  }
}

/** A storage whose every call throws (private mode / quota / security software). */
function refusingStorage(): InstallCueStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
}

// ------------------------------------------- armInstallCue (behavioral)

describe('armInstallCue — event capture', () => {
  it('beforeinstallprompt → onInstallable WITH the browser infobar defused (preventDefault)', () => {
    const target = new FakeWindow()
    const seen: InstallPromptEvent[] = []
    armInstallCue(target, { onInstallable: (e) => seen.push(e), onInstalled: () => {} })
    const event = new FakeDeferredEvent()
    target.fire('beforeinstallprompt', event)
    expect(seen).toEqual([event])
    expect(event.preventDefaultCalls).toBe(1)
  })

  it('appinstalled → onInstalled (any install path stands the cue down)', () => {
    const target = new FakeWindow()
    let installed = 0
    armInstallCue(target, { onInstallable: () => {}, onInstalled: () => (installed += 1) })
    target.fire('appinstalled', new Event('appinstalled'))
    expect(installed).toBe(1)
  })

  it('dispose removes BOTH listeners — a remount never double-fires', () => {
    const target = new FakeWindow()
    const dispose = armInstallCue(target, { onInstallable: () => {}, onInstalled: () => {} })
    expect(target.listenerCount('beforeinstallprompt')).toBe(1)
    expect(target.listenerCount('appinstalled')).toBe(1)
    dispose()
    expect(target.listenerCount('beforeinstallprompt')).toBe(0)
    expect(target.listenerCount('appinstalled')).toBe(0)
    // Firing after dispose reaches nobody (and does not throw).
    const event = new FakeDeferredEvent()
    target.fire('beforeinstallprompt', event)
    expect(event.preventDefaultCalls).toBe(0)
  })
})

// ------------------------------------------- promptInstall (the Install click)

describe('promptInstall — the browser\'s NATIVE dialog, never a look-alike', () => {
  it('an accepted userChoice resolves true; a dismissed one resolves false', async () => {
    await expect(promptInstall(new FakeDeferredEvent('accepted'))).resolves.toBe(true)
    await expect(promptInstall(new FakeDeferredEvent('dismissed'))).resolves.toBe(false)
  })

  it('a refused prompt() or a missing userChoice resolves false — NEVER throws', async () => {
    await expect(promptInstall(new FakeDeferredEvent('throws'))).resolves.toBe(false)
  })
})

// ------------------------------------------- the guarded dismiss memory

describe('the dismiss memory — guarded persistence (#192 discipline)', () => {
  it('reads the remembered dismissal from the install cue key', () => {
    expect(readInstallDismissed(memoryStorage({ [INSTALL_CUE_DISMISS_KEY]: '1' }))).toBe(true)
    expect(readInstallDismissed(memoryStorage({}))).toBe(false)
    expect(INSTALL_CUE_DISMISS_KEY).toBe('mjengo-os-install-cue-dismissed')
  })

  it('a write lands the marker and reports true', () => {
    const storage = memoryStorage()
    expect(writeInstallDismissed(storage)).toBe(true)
    expect(storage.data.get(INSTALL_CUE_DISMISS_KEY)).toBe('1')
  })

  it('a REFUSING storage never breaks the click: read → not-dismissed (the honest default), write → false (session-only)', () => {
    expect(readInstallDismissed(refusingStorage())).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(writeInstallDismissed(refusingStorage())).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})

// ------------------------------------------- source pins (no silent drift)

describe('src/app/layout.tsx — the cue is mounted topmost inside I18nProvider', () => {
  it('mounts <InstallCue /> inside <I18nProvider>, BEFORE the app shell (never overlays the sticky header)', () => {
    expect(LAYOUT_SRC).toContain('<InstallCue />')
    const providerAt = LAYOUT_SRC.indexOf('<I18nProvider>')
    const cueAt = LAYOUT_SRC.indexOf('<InstallCue />')
    const providerEnd = LAYOUT_SRC.indexOf('</I18nProvider>')
    expect(cueAt).toBeGreaterThan(providerAt)
    expect(cueAt).toBeLessThan(providerEnd)
    // Ahead of the app shell in flow — the top-of-document placement.
    expect(cueAt).toBeLessThan(LAYOUT_SRC.indexOf('<AuthSessionProvider>'))
  })
})

describe('src/frontend/pwa/install-cue.tsx — the cue calls the canonical helpers, honest variants', () => {
  it('the show decisions come from sw-handlers, not re-derivations', () => {
    expect(CUE_SRC).toContain('shouldShowInstallCue(event !== null, dismissed, installed)')
    expect(CUE_SRC).toContain(
      'shouldShowIosInstallHint(iosDevice, standalone, dismissed, installed, event !== null)',
    )
    expect(CUE_SRC).toContain('isStandaloneDisplay(')
    expect(CUE_SRC).toContain('looksLikeIOS(')
  })

  it('the Install button exists ONLY on the browser-native branch — the iOS hint has no fake install flow', () => {
    // The native prompt() click is wired only inside the showNativeCue branch.
    expect(CUE_SRC).toContain('showNativeCue && (')
    expect(CUE_SRC).toContain('void install()')
    expect(CUE_SRC).toContain('promptInstall(event)')
    // The iOS variant renders instructions + Got it only: its sole button is
    // the dismiss, labelled with the ios.gotIt key when the hint is showing.
    expect(CUE_SRC).toContain("t('install.ios.body')")
    expect(CUE_SRC).toContain("t('install.ios.gotIt')")
  })

  it('dismissal runs through the guarded adapter pair, and already-installed sessions arm nothing', () => {
    expect(CUE_SRC).toContain('readInstallDismissed(window.localStorage)')
    expect(CUE_SRC).toContain('writeInstallDismissed(window.localStorage)')
    expect(CUE_SRC).toContain('if (standalone) return')
  })

  it('the client-only constants ride useSyncExternalStore with server-snapshot false (no setState-in-effect)', () => {
    expect(CUE_SRC).toContain('useSyncExternalStore(subscribeNoop, readStandalone, () => false)')
    expect(CUE_SRC).toContain('useSyncExternalStore(subscribeNoop, readIosDevice, () => false)')
    // The live halves are written only from callbacks/handlers.
    expect(CUE_SRC).toContain('onInstallable: setEvent')
    expect(CUE_SRC).toContain('onInstalled: () => setInstalled(true)')
  })

  it('the watch module never re-derives the storage key (the shared constant)', () => {
    expect(WATCH_SRC).toContain('INSTALL_CUE_DISMISS_KEY')
    expect(WATCH_SRC).not.toContain("'mjengo-os-install-cue-dismissed'")
  })
})

describe('install.* dictionaries — bilingual, every key the cue uses', () => {
  const INSTALL_KEYS = [
    'install.cue.aria',
    'install.cue.body',
    'install.cue.install',
    'install.cue.later',
    'install.ios.body',
    'install.ios.gotIt',
  ] as const

  it('every key exists in en + sw with a non-empty value', () => {
    for (const key of INSTALL_KEYS) {
      expect(typeof enDict[key] === 'string' && enDict[key].trim().length > 0, `en.${key}`).toBe(true)
      expect(typeof swDict[key] === 'string' && swDict[key].trim().length > 0, `sw.${key}`).toBe(true)
    }
  })

  it('the iOS instructions are real steps (Share → Add to Home Screen), not an install claim', () => {
    expect(enDict['install.ios.body']).toContain('Share')
    expect(enDict['install.ios.body']).toContain('Add to Home Screen')
    expect(swDict['install.ios.body']).toContain('Share')
    expect(swDict['install.ios.body']).toContain('Add to Home Screen')
  })

  it('every literal t(...) key the cue component uses resolves in both dictionaries', () => {
    const literalKeys = [...CUE_SRC.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1])
    expect(literalKeys.length).toBeGreaterThanOrEqual(INSTALL_KEYS.length)
    for (const key of new Set(literalKeys)) {
      expect(enDict[key], `en.ts is missing "${key}" (used by install-cue.tsx)`).toBeDefined()
      expect(swDict[key], `sw.ts is missing "${key}" (used by install-cue.tsx)`).toBeDefined()
    }
  })
})
