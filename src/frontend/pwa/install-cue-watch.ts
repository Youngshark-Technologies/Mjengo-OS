// PWA install cue watch (issue #357 / audit FE-11 residual) — the install
// half, browser wiring.
//
// Mirrors the #148 staleness-cue structure (sw-update-watch.ts): the
// DECISIONS are the pure functions in src/frontend/sw-handlers.ts (the #357
// section — shouldShowInstallCue, shouldShowIosInstallHint, isStandaloneDisplay,
// looksLikeIOS); this module owns only the browser wiring, and everything
// browser-global is a constructor argument, so tests/unit/install-cue.test.ts
// drives the whole thing with fake windows and storages in plain node.
//
// What it owns:
//  · EVENT CAPTURE — beforeinstallprompt arrives on window (Chromium family,
//    when the browser's own install heuristics pass); the listener calls
//    preventDefault() so the browser's mini-infobar stands down and OUR cue
//    owns the moment, and hands the deferred event to the UI. appinstalled
//    (any install path, ours or the browser chrome's) reports "installed" so
//    every cue variant stands down permanently.
//  · THE CLICK ACTION — promptInstall runs the browser's NATIVE install
//    dialog (the captured event's prompt()) and resolves whether the user
//    accepted. Never a look-alike flow, never a re-used event.
//  · DISMISS MEMORY — one guarded localStorage read/write pair (the #192
//    discipline: a storage refusal — private mode, quota, security software —
//    must never break the click; a failed write degrades honestly to a
//    session-only dismissal, and the module says so instead of claiming the
//    preference was saved).
//
// KNOWN HONEST LIMIT: beforeinstallprompt can fire before hydration finishes
// (it is a window event; a late-hydrating tab on a slow field network can
// miss it). There is no getPastEvents() API. A missed event simply means NO
// cue that session — an honest no-op; the browser re-fires it on later
// eligibility (next visit), and the appinstalled/standalone checks keep the
// cue silent once installed either way.

import {
  INSTALL_CUE_DISMISS_KEY,
} from '@/frontend/sw-handlers'

/**
 * The beforeinstallprompt event, structurally (lib.dom does not know the
 * non-standard type). The captured event is a DEFERRED install: prompt()
 * shows the browser's native dialog; userChoice reports the outcome. An
 * event can be prompted exactly once.
 */
export interface InstallPromptEvent {
  preventDefault(): void
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * The event target the watch arms on — window satisfies it structurally, and
 * tests supply minimal fakes with exactly this shape.
 */
export interface InstallCueTarget {
  addEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void
  removeEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void
}

/** The storage seam the dismiss memory uses — localStorage satisfies it. */
export interface InstallCueStorage {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
}

export interface InstallCueHandlers {
  /** The browser offered the install (beforeinstallprompt captured + defused). */
  onInstallable(event: InstallPromptEvent): void
  /** The app got installed — by our cue, the browser chrome, or any path. */
  onInstalled(): void
}

/**
 * Arm the install-event watch. Returns the dispose function (listener
 * removal — the component's unmount path).
 */
export function armInstallCue(target: InstallCueTarget, handlers: InstallCueHandlers): () => void {
  const onBeforeInstallPrompt = (event: Event) => {
    // Stand the browser's own mini-infobar down: OUR cue owns the moment
    // (the #357 acceptance criterion — a dismissible cue, not two cues).
    const deferred = event as unknown as InstallPromptEvent
    deferred.preventDefault?.()
    handlers.onInstallable(deferred)
  }
  const onAppInstalled = () => handlers.onInstalled()
  target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  target.addEventListener('appinstalled', onAppInstalled)
  return () => {
    target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    target.removeEventListener('appinstalled', onAppInstalled)
  }
}

/**
 * The Install click (#357): run the browser's NATIVE install dialog on the
 * captured event and resolve whether the user accepted. The event is spent
 * after this either way (the browser spec) — the caller drops its reference
 * regardless of the outcome. NEVER throws: a refused/failed prompt resolves
 * false (not installed via this click), because a click that crashes the
 * page or fakes success would be a lie.
 */
export async function promptInstall(event: InstallPromptEvent): Promise<boolean> {
  try {
    await event.prompt()
    const choice = await event.userChoice
    return choice?.outcome === 'accepted'
  } catch {
    return false
  }
}

/**
 * Was the install cue dismissed on a previous visit? A storage READ failure
 * (private mode, disabled storage) resolves false — not dismissed: showing
 * the cue is the honest default when the memory cannot be read, and the
 * dismissal is one click away.
 */
export function readInstallDismissed(storage: InstallCueStorage): boolean {
  try {
    return storage.getItem(INSTALL_CUE_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Remember a dismissal (#357 AC: "dismiss remembered in storage honoring
 * guarded persistence"). Guarded like the #192 adapter — a write failure
 * (quota / private mode) is swallowed and REPORTED: false means the
 * dismissal is session-only (the cue returns next visit), which the caller
 * never pretends otherwise. Returns true when the memory actually landed.
 */
export function writeInstallDismissed(storage: InstallCueStorage): boolean {
  try {
    storage.setItem(INSTALL_CUE_DISMISS_KEY, '1')
    return true
  } catch (e) {
    console.warn('[install-cue] dismissal not persisted — storage refused the write (session-only)', e)
    return false
  }
}
