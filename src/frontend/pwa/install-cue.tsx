'use client'

// The PWA install cue UI (issue #357 / audit FE-11 residual) — the install
// half of FE-11; #148 landed the staleness half.
//
// A slim, dismissible bar at the very top of the document (normal flow — it
// never overlays the sticky app header, the mobile bottom nav, or any
// dialog; on scroll it rides away and the header sticks as always). Two
// variants, both honest:
//  · BROWSER-NATIVE (Chromium family): the beforeinstallprompt event was
//    captured (install-cue-watch.ts defuses the browser mini-infobar so this
//    cue owns the moment); "Install" runs the browser's NATIVE dialog via
//    promptInstall — never a look-alike flow.
//  · iOS/Safari (the event never fires there): INSTRUCTIONS-ONLY — one line,
//    "Share → Add to Home Screen", a "Got it" dismissal, and NO button that
//    pretends to install. Every other browser where the event never fires
//    (Firefox desktop, …) gets NO cue at all.
//
// Dismissal is remembered in localStorage through the GUARDED adapter pair
// (readInstallDismissed/writeInstallDismissed — the #192 discipline: a
// storage refusal degrades to a session-only dismissal, never a broken
// click). Already-installed sessions (display-mode standalone / iOS
// navigator.standalone) render nothing and arm nothing.
//
// State shape (the header.tsx idiom, no setState-in-effect): the three
// client-only CONSTANTS — standalone, iOS-class device, persisted dismissal
// — are read through useSyncExternalStore with noop subscriptions (server
// snapshots false → the server render and first hydration paint show
// nothing, so there is no hydration mismatch; the cue appears only once
// hydration can see the browser). The live halves — the captured install
// event, installed, this-session dismissal — are React state written ONLY
// from event-listener callbacks and click handlers, never synchronously in
// an effect body.
//
// Mounted ONCE from the root layout inside <I18nProvider> (it needs useT).

import { useEffect, useState, useSyncExternalStore } from 'react'
import { MonitorSmartphone } from 'lucide-react'
import { Button } from '@/frontend/ui/button'
import { useT } from '@/frontend/i18n/provider'
import {
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
  type InstallPromptEvent,
} from '@/frontend/pwa/install-cue-watch'

/** Noop subscription — the client-only reads below change only per session. */
const subscribeNoop = () => () => {}

/** Cached client-only reads (getSnapshot must be referentially stable). */
let cachedStandalone: boolean | null = null
let cachedIosDevice: boolean | null = null

/** Already an installed PWA? (display-mode standalone, or iOS standalone.) */
function readStandalone(): boolean {
  if (cachedStandalone === null) {
    cachedStandalone = isStandaloneDisplay(
      window.matchMedia?.('(display-mode: standalone)')?.matches,
      (navigator as Navigator & { standalone?: boolean }).standalone,
    )
  }
  return cachedStandalone
}

/** An iOS-class device (the honest heuristic — see looksLikeIOS). */
function readIosDevice(): boolean {
  if (cachedIosDevice === null) {
    cachedIosDevice = looksLikeIOS(navigator.userAgent, navigator.maxTouchPoints)
  }
  return cachedIosDevice
}

export function InstallCue() {
  const t = useT()
  // Client-only constants (server snapshot: false — nothing renders there).
  const standalone = useSyncExternalStore(subscribeNoop, readStandalone, () => false)
  const iosDevice = useSyncExternalStore(subscribeNoop, readIosDevice, () => false)
  const persistedDismissed = useSyncExternalStore(
    subscribeNoop,
    () => readInstallDismissed(window.localStorage),
    () => false,
  )
  // Live state — written only from callbacks/handlers, never in effect bodies.
  const [event, setEvent] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [sessionDismissed, setSessionDismissed] = useState(false)

  useEffect(() => {
    // ALREADY INSTALLED → arm nothing (the app IS the install; the standalone
    // read above also keeps the render silent).
    if (standalone) return
    return armInstallCue(window, {
      onInstallable: setEvent,
      onInstalled: () => setInstalled(true),
    })
  }, [standalone])

  const dismissed = persistedDismissed || sessionDismissed
  // The DECISIONS are the canonical pure helpers — this component never
  // re-derives them (the #148 source-pin idiom pins exactly these calls).
  const showNativeCue = shouldShowInstallCue(event !== null, dismissed, installed)
  const showIosHint = shouldShowIosInstallHint(iosDevice, standalone, dismissed, installed, event !== null)

  async function install() {
    if (!event) return
    const accepted = await promptInstall(event)
    // The deferred event is spent either way (the browser spec) — drop it so
    // the cue stands down; an accepted install also flips `installed`, which
    // keeps future sessions' appinstalled/standalone checks consistent.
    setEvent(null)
    if (accepted) setInstalled(true)
  }

  function dismiss() {
    setSessionDismissed(true)
    // Guarded: a refused write degrades to session-only — the cue returns
    // next visit, and nothing here ever claims otherwise.
    writeInstallDismissed(window.localStorage)
  }

  if (!showNativeCue && !showIosHint) return null

  return (
    <div
      role="status"
      aria-label={t('install.cue.aria')}
      className="bg-emerald-700 text-white px-4 py-1.5 flex items-center justify-center gap-2 text-[13px] font-medium"
    >
      <MonitorSmartphone className="w-4 h-4 shrink-0" aria-hidden />
      <span className="text-center">
        {showNativeCue ? t('install.cue.body') : t('install.ios.body')}
      </span>
      {showNativeCue && (
        <Button
          size="sm"
          onClick={() => void install()}
          aria-label={t('install.cue.install')}
          className="h-7 bg-white text-emerald-900 hover:bg-emerald-50 px-3"
        >
          {t('install.cue.install')}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={dismiss}
        aria-label={showNativeCue ? t('install.cue.later') : t('install.ios.gotIt')}
        className="h-7 text-white/90 hover:bg-emerald-800 hover:text-white px-3"
      >
        {showNativeCue ? t('install.cue.later') : t('install.ios.gotIt')}
      </Button>
    </div>
  )
}
