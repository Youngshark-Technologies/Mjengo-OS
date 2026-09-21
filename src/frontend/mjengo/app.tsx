'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { metaFor } from '@/frontend/mjengo/nav/tab-meta'
import { Header } from '@/frontend/mjengo/header'
import { OverviewTab } from '@/frontend/mjengo/overview-tab'
import { SitePlanTab } from '@/frontend/mjengo/site-plan-tab'
import { MaterialsTab } from '@/frontend/mjengo/materials-tab'
import { FundisTab } from '@/frontend/mjengo/fundis-tab'
import { MoneyTab } from '@/frontend/mjengo/money-tab'
import { EvidenceTab } from '@/frontend/mjengo/evidence-tab'
import { CopilotTab } from '@/frontend/mjengo/copilot-tab'
import { LandTab } from '@/frontend/mjengo/land-tab'
import { FinderTab } from '@/frontend/mjengo/finder-tab'
import { IntelTab } from '@/frontend/mjengo/intel-tab'
import { UssdTab } from '@/frontend/mjengo/ussd-tab'
import { AuditTab } from '@/frontend/mjengo/audit-tab'
import { ErrorBoundary } from '@/frontend/mjengo/uikit/error-boundary'
import { SettingsTab } from '@/frontend/mjengo/settings-tab'
import { CommandPalette } from '@/frontend/mjengo/cmdk/command-palette'
import { WelcomeScreen } from '@/frontend/mjengo/welcome-screen'
import { CreateProjectDialog, type CreateProjectPayload } from '@/frontend/mjengo/create-project-dialog'
import { ShareDialog } from '@/frontend/mjengo/share-dialog'
import { DiasporaBanner } from '@/frontend/mjengo/diaspora-banner'
import { LoginScreen } from '@/frontend/auth/login-screen'
import { SupplierPortal } from '@/frontend/mjengo/supplier/supplier-portal'
import { MobileBottomNav } from '@/mobile/nav/mobile-bottom-nav'
import { Skeleton } from '@/frontend/ui/skeleton'
import { Card, CardContent } from '@/frontend/ui/card'
import { CloudOff, RefreshCw, HardHat, Link2Off, TriangleAlert } from 'lucide-react'
import { Button } from '@/frontend/ui/button'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { AUTH_LOADING_TIMEOUT_MS, shouldOfflineBoot } from '@/frontend/mjengo/offline-boot'
// #193: the SW's Background Sync drain ask lands on the service-worker
// container — this guard is the canonical, unit-tested shape check.
import { isDrainRequestMessage } from '@/frontend/sw-handlers'
import { usePermissions, tabsForRole, landingForRole } from '@/shared/permissions'
import { tabsVisibleForFlags } from '@/frontend/mjengo/nav/tab-meta'

export type TabKey =
  | 'overview' | 'site' | 'materials' | 'finder' | 'fundis' | 'money'
  | 'land' | 'evidence' | 'intel' | 'copilot' | 'ussd' | 'audit' | 'settings'
  | 'supplier'

/** The zustand persist API surface the hydration gate consumes (structural, #388). */
export interface MjengoPersistApi {
  hasHydrated(): boolean
  onFinishHydration(cb: () => void): (() => void) | void
}

/**
 * Store-hydration gate (#351, race fixed in #388): resolves to true only
 * when the async (indexedDB-backed) rehydrate has finished — in ALL THREE
 * orderings, BY CONSTRUCTION (no effect, no setState, no window):
 *
 *   1. finished BEFORE render — getSnapshot reads true immediately;
 *   2. finished INSIDE any window — React re-checks the snapshot right
 *      after subscribing and re-renders if it changed (the #388 bug was
 *      exactly this window: an effect observed hasHydrated() already true
 *      and early-returned without flipping its own state — the app stuck
 *      on the boot skeleton forever; 6/7 E2E personas failed on fast
 *      sign-ins);
 *   3. finished AFTER subscribe — zustand's onFinishHydration fires the
 *      subscription callback → re-render with the fresh snapshot.
 *
 * Inert media (node/SSR/no storage → no persist object) count as hydrated
 * (getServerSnapshot true — there is nothing to wait for). Extracted as a
 * hook so the runtime-DOM tier pins the ordering contract against the REAL
 * gate logic (tests/dom/store-hydration-gate.test.ts).
 */
export function useStoreHydrationGate(persistApi: MjengoPersistApi | undefined): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!persistApi) return () => {}
      // zustand persist's onFinishHydration IS the subscribe contract:
      // it returns the unsubscribe function.
      return persistApi.onFinishHydration(onChange) ?? (() => {})
    },
    () => (persistApi ? persistApi.hasHydrated() : true),
    () => true,
  )
}

function BootSkeleton() {
  return (
    <div className="min-h-screen flex flex-col bg-stone-100">
      <div className="h-16 bg-stone-950 flex items-center px-6 gap-3">
        <div className="w-9 h-9 bg-amber-500 rounded-lg flex items-center justify-center">
          <HardHat className="w-5 h-5 text-stone-950" />
        </div>
        <div className="h-6 w-40 bg-stone-800 rounded animate-pulse" />
      </div>
      <div className="flex-1 p-4 sm:p-6 space-y-4 max-w-7xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </div>
  )
}

export function MjengoApp() {
  const {
    data, loading, load, online, outbox, syncing,
    projects, activeProjectId, viewMode, setViewMode, createProject, dispatch,
    shareToken, shareError, bootFromShare, clientRole,
    persistDegraded, persistQueueOnly,
  } = useMjengo()
  const { data: session, status } = useSession()
  const { role: sessionRole, knownRole, tabs: roleTabs } = usePermissions()
  const t = useT()
  const [tab, setTab] = useState<TabKey>('overview')
  const [createOpen, setCreateOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [origin, setOrigin] = useState('')
  const [shareBooting, setShareBooting] = useState(false)
  // Offline session short-circuit (issue #78 / FE-1) — armed while the auth
  // gate has sat in next-auth's 'loading' state past the timeout (see the
  // offline-boot.ts contract for the full honesty rules).
  const [authTimedOut, setAuthTimedOut] = useState(false)

  // ---------------- Surface + permission-derived tab visibility (W1-PERM) ----------------
  // The client surface (share link or logged-in client) keeps its existing
  // tab set regardless of session; owner roles are filtered by permissions.ts
  // (fail closed for unknown roles → Overview only).
  // Feature flags (spec §81, task 9-a): a flag OFF additionally hides its
  // gated tab (money / finder) for NON-ADMIN sessions on every surface —
  // admins bypass so they can toggle & test (same rule the server routes
  // enforce via requireFlagOn; flags arrive on the payload's intel slice).
  const isShareClient = viewMode === 'client' && Boolean(shareToken)
  // Client surface = share-link client (no login) OR a logged-in client-role user
  const isClientSurface = viewMode === 'client' && (Boolean(shareToken) || clientRole)
  // FE-4 (issue #108): the tab STRIP follows the client set whenever the app
  // is in client view — a real share client, a logged-in client, AND the
  // owner's read-only "Preview as client" mode. Preview has neither
  // shareToken nor clientRole, so the old `isClientSurface` test kept the
  // OWNER strip (incl. AI Copilot/Audit) alive in preview; the strip now
  // renders exactly tabsForRole('client') (permissions.ts — all tabs except
  // copilot/audit/supplier).
  const clientStrip = viewMode === 'client'
  const surfaceTabs: readonly TabKey[] = useMemo(
    () => tabsVisibleForFlags(
      clientStrip ? tabsForRole('client') : roleTabs,
      data?.intel?.flags,
      sessionRole,
    ),
    // Stable identity across renders (the mjengo:tab listener effect keys on
    // this array) — recompute only when the role tab set, the flags or the
    // session role actually change.
    [clientStrip, roleTabs, data?.intel?.flags, sessionRole],
  )

  // Boot: while signed OUT, a ?share=<token> link (or a previously used token)
  // opens the public client "Virtual Site Visit" with NO login. Signed-in users
  // are routed by the session effect below instead.
  useEffect(() => {
    if (status === 'loading' || status === 'authenticated') return
    const param = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('share')
      : null
    const token = param || useMjengo.getState().shareToken
    if (token) {
      setShareBooting(true)
      void bootFromShare(token, Boolean(param)).finally(() => setShareBooting(false))
    }
    // Signed-out owner app → the login gate; /api/projects is 401 now, no load() needed
  }, [status, bootFromShare])

  // Post-login routing by role:
  //  · client        → client view for THEIR project (no exit link — they belong there)
  //  · contractor/admin → owner app; never get stuck in a persisted client/share view
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.email) return
    const role = session.user.role
    const pid = session.user.projectId
    const store = useMjengo.getState()
    if (role === 'client') {
      const already = store.clientRole && store.viewMode === 'client' && !store.shareToken
        && Boolean(store.data) && (!pid || store.data?.project?.id === pid)
      if (!already) {
        useMjengo.setState({
          clientRole: true,
          viewMode: 'client',
          shareToken: null,
          shareError: null,
          activeProjectId: pid ?? store.activeProjectId,
        })
        setTab('overview')
        void useMjengo.getState().load()
      }
    } else if (role === 'supplier') {
      // W5-3: supplier sessions boot the SupplierPortal (its own scoped read
      // of /api/supplier — NEVER the owner app's project payload, which is
      // buyer data and 403s for this role). Clear any stale share/client
      // surface from a previous login in this browser; no load() — the portal
      // fetches its own payload.
      if (store.shareToken || store.viewMode === 'client' || store.clientRole || store.shareError) {
        useMjengo.setState({ shareToken: null, shareError: null, viewMode: 'owner', clientRole: false })
      }
    } else if (store.shareToken || store.viewMode === 'client' || store.clientRole || store.shareError) {
      useMjengo.setState({ shareToken: null, shareError: null, viewMode: 'owner', clientRole: false })
      void useMjengo.getState().load()
    } else if (!store.data || store.projects.length === 0) {
      // Warm session + persisted data still needs load(): the projects list is
      // NOT persisted, so without this the switcher shows "Projects · 0"
      void useMjengo.getState().load()
    }
  }, [status, session])

  // ---------------- Role landing tab (W1-PERM, spec §75 role dashboards) ----------------
  // On login or role change, land on the role's landing tab: finance → Money,
  // procurement → Finder, qs → Materials, everyone else → Overview (the
  // contractor's behavior is unchanged). Unknown roles fail closed to
  // Overview. The client surface boots 'overview' via the effect above.
  const landedFor = useRef<string | null>(null)
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.email) return
    const role = String(session.user.role ?? 'contractor')
    if (landedFor.current === role) return
    landedFor.current = role
    if (role === 'client' || role === 'supplier') return
    setTab(landingForRole(role))
  }, [status, session])

  // ---------------- Store hydration gate (issue #351) ----------------
  // The owner store now rehydrates from indexedDB (async): for the few
  // milliseconds between first paint and the hydration merge, `data` is
  // still null — without this gate, an offline relaunch whose session
  // fetch fails fast would flash the LOGIN screen before the persisted
  // snapshot lands and the offline boot (issue #78) arms. Honest rule: we
  // do not KNOW there is no offline snapshot until hydration says so, so
  // the auth gates hold the boot skeleton until then. Inert media (node /
  // SSR / no storage → zustand persist never engages) count as hydrated —
  // there is nothing to wait for.
  const storeHydrated = useStoreHydrationGate((useMjengo as unknown as { persist?: MjengoPersistApi }).persist)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  // ---------------- Post-auth outbox drain (issue #191) ----------------
  // A reconnect drain that hits an EXPIRED session marks the queue
  // auth-blocked (failed + honest lastError — use-mjengo syncNow) and next-auth
  // swaps the app for the login screen, hiding the outbox UI. After re-login
  // nothing drains the queue by itself: no offline→online transition fires
  // (the store flag is already true) and the mount path raw-sets `online`. So
  // once a session authenticates with the browser online, drainAfterAuth()
  // re-queues the auth-blocked items and flushes once. Keyed on next-auth's
  // `expires` (a fresh value per login) so an expiry + re-login RE-ARMS the
  // drain instead of firing once ever; repeated fires are also harmless
  // (syncNow no-ops without pending work).
  const authDrainedFor = useRef<string | null>(null)
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.email || !online) return
    const sessionKey = String(session.expires ?? session.user.email)
    if (authDrainedFor.current === sessionKey) return
    authDrainedFor.current = sessionKey
    void useMjengo.getState().drainAfterAuth()
  }, [status, session, online])

  // ---------------- Real connectivity (F-INSIGHT, spec §50/§74) ----------------
  // The store's `online` flag starts persisted (possibly stale from a previous
  // session). On mount we re-sync it with the browser's real connectivity and
  // keep following the window online/offline events: going offline is silent
  // (the amber banner appears), coming back online drains the outbox via
  // setOnline → toast "Back online — syncing queued actions" + auto-syncNow.
  useEffect(() => {
    useMjengo.setState({ online: navigator.onLine })
    const onOffline = () => useMjengo.getState().setOnline(false)
    const onOnline = () => {
      useMjengo.getState().setOnline(true)
      // Connectivity recovery after an offline boot (issue #78): next-auth
      // never refetches the session on the 'online' event by itself — it only
      // refetches on visibilitychange. Nudge it down its own documented path
      // (the handler checks document.visibilityState === 'visible', which a
      // foregrounded PWA is) so a still-valid session resolves immediately
      // instead of stranding a signed-in user on the login screen until they
      // switch tabs. Harmless when the session is already resolved.
      document.dispatchEvent(new Event('visibilitychange'))
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  // ---------------- SW drain requests (issue #193 — Background Sync) ------
  // When Chromium fires the one-shot 'mjengoos-outbox' sync tag (registered
  // at outbox-enqueue time; the browser re-launches the SW when connectivity
  // returns), sw.js posts { type: 'mjengoos:drain' } at its window clients
  // and this container listener turns the ask into a syncNow() drain. The
  // store's own guards make it safe: a drain already in flight returns
  // immediately, an empty queue is a no-op, and a flapped-again network
  // re-queues everything (nothing is ever dropped). Browsers without
  // Background Sync never receive the ask and keep today's behavior.
  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
    if (!sw) return
    const onMessage = (e: MessageEvent) => {
      if (!isDrainRequestMessage(e.data)) return
      void useMjengo.getState().syncNow()
    }
    sw.addEventListener('message', onMessage)
    return () => sw.removeEventListener('message', onMessage)
  }, [])

  // ---------------- Auth-gate timeout (issue #78 / FE-1) ----------------
  // While the session check hangs (lie-fi: request neither resolves nor
  // rejects), arm the offline boot after a short timeout; disarm the moment
  // status leaves 'loading' (resolved authenticated/unauthenticated gates
  // take over honestly).
  useEffect(() => {
    if (status !== 'loading') {
      setAuthTimedOut(false)
      return
    }
    const timer = setTimeout(() => setAuthTimedOut(true), AUTH_LOADING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [status])

  // ---------------- Cross-component tab navigation (F-INSIGHT, spec §80) ----------------
  // Global-search result clicks dispatch 'mjengo:tab' (detail: { tab }) from
  // anywhere in the tree; the app owner switches tabs here. Unknown tabs —
  // or tabs the current role cannot see (W1-PERM, fail closed) — are ignored
  // rather than guessed.
  useEffect(() => {
    const onTab = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab
      if (tab && surfaceTabs.includes(tab as TabKey)) setTab(tab as TabKey)
    }
    window.addEventListener('mjengo:tab', onTab)
    return () => window.removeEventListener('mjengo:tab', onTab)
  }, [surfaceTabs])

  async function handleCreateProject(payload: CreateProjectPayload): Promise<boolean> {
    setCreating(true)
    try {
      return await createProject(payload)
    } finally {
      setCreating(false)
    }
  }

  async function handleRegenerateShareLink() {
    if (!data?.project) return
    const ok = await dispatch('share.regenerate', { id: data.project.id }, t('app.share.regenerateAudit'))
    if (ok) toast.success(t('app.share.regenerated'))
    else toast.error(t('app.share.regenerateFailed'))
  }

  function handlePreviewingChange(previewing: boolean) {
    setViewMode(previewing ? 'client' : 'owner')
    if (previewing) setShareOpen(false)
  }

  /** Leave the share-link client view (same browser) and open the site-team app. */
  function exitShareView() {
    useMjengo.setState({ shareToken: null, shareError: null, viewMode: 'owner' })
    setTab('overview')
    void load()
  }

  // (isShareClient / isClientSurface / surfaceTabs are derived near the top,
  //  before the effects that depend on them — see “Surface + permission-derived”.)

  // Dead share link — full-screen card, no access to any project data
  if (shareError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-100 p-6">
        <Card className="max-w-md w-full border-stone-200 shadow-sm">
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-stone-200 flex items-center justify-center" aria-hidden>
              <Link2Off className="w-7 h-7 text-stone-500" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg font-bold text-stone-900">{t('app.deadLink.title')}</h1>
              <p className="text-sm text-stone-500 leading-relaxed">
                {t('app.deadLink.body', { error: shareError })}
              </p>
            </div>
            <Button
              variant="outline"
              className="min-h-11 gap-1.5"
              onClick={() => {
                useMjengo.setState({ shareError: null, shareToken: null })
                void load()
              }}
            >
              <HardHat className="w-4 h-4" aria-hidden /> {t('app.deadLink.open')}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ---------------- Auth gate (login is an app state, not a route) ----------------
  // Session still resolving → boot skeleton (prevents a login flash on share links:
  // shareBooting covers the gap while the share token is being fetched).
  //
  // OFFLINE SHORT-CIRCUIT (issue #78 / FE-1 — shouldOfflineBoot): next-auth's
  // session check needs the network, so a PWA reopened offline either hangs in
  // 'loading' (dead radio) or fails fast into a FALSE 'unauthenticated' (valid
  // cookie, unreachable server) — either way the old gates stranded a field
  // supervisor on a skeleton/login screen while their data + outbox sat in the
  // persisted store. When the gate is provably stuck AND persisted data exists,
  // boot the app shell from the cached store instead — "continue offline":
  //   · the amber offline banner is up (store `online` false) and mutations keep
  //     queueing to the outbox exactly as they already do offline — the app
  //     NEVER pretends to be online;
  //   · the role is genuinely UNKNOWN offline (no client-side session copy), so
  //     the permission system fail-closes to the Overview tab + outbox panel —
  //     the same honest rule as an unknown role online;
  //   · when the session resolves later (network back — the online handler
  //     above nudges a refetch), the gates take over again and the routing
  //     effect re-loads fresh server data.
  const offlineBoot =
    !isClientSurface &&
    !shareBooting &&
    shouldOfflineBoot({ status, authTimedOut, online, hasData: Boolean(data) })

  // Store-hydration hold (#351): while the indexedDB rehydrate is still in
  // flight we cannot know whether an offline snapshot exists — hold the boot
  // skeleton (never flash the login screen) until hydration finishes.
  if ((status === 'loading' || !storeHydrated) && !offlineBoot) {
    return <BootSkeleton />
  }
  if (status === 'unauthenticated' && !isClientSurface && !shareBooting && !offlineBoot) {
    return <LoginScreen />
  }

  // W5-3 supplier surface: a supplier session NEVER boots the owner app (its
  // data is buyer-side; the server 403s the project payload for this role).
  // The portal owns its own fetch (/api/supplier) + dispatch (/api/actions).
  if (status === 'authenticated' && session?.user?.role === 'supplier') {
    return <SupplierPortal />
  }

  // Welcome / onboarding screen — fresh install with no projects at all (owner app only)
  if (status === 'authenticated' && session?.user?.role !== 'client'
      && !loading && !data && projects.length === 0 && !shareToken) {
    return (
      <>
        <WelcomeScreen onCreate={() => setCreateOpen(true)} />
        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={handleCreateProject}
          submitting={creating}
        />
      </>
    )
  }

  if (loading && !data) {
    return <BootSkeleton />
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-100 flex-col gap-4 p-6 text-center">
        <HardHat className="w-12 h-12 text-amber-600" />
        <p className="text-stone-600">{t('app.serverUnreachable')}</p>
        <Button onClick={() => void load()} variant="outline">
          <RefreshCw className="w-4 h-4 mr-2" /> {t('app.retry')}
        </Button>
      </div>
    )
  }

  const projectShareToken = data.project.shareToken
  const shareUrl = projectShareToken ? `${origin || ''}/?share=${projectShareToken}` : null
  // Stale/disallowed tab keys snap to the surface landing tab: clients (and
  // the owner's client PREVIEW, FE-4 issue #108) never keep a site-team tab
  // such as AI Copilot — they snap to Overview exactly like a real client
  // boot; role changes land on the role's landing tab (W1-PERM — unknown
  // roles fail closed to Overview).
  const activeTab: TabKey = surfaceTabs.includes(tab)
    ? tab
    : viewMode === 'client' ? 'overview' : landingForRole(sessionRole)

  // Honest fail-closed notice for roles the platform does not know (spec §56:
  // never silently pretend the role is fine).
  const showUnknownRoleNotice = !isClientSurface && Boolean(sessionRole) && !knownRole

  return (
    <div className="min-h-screen flex flex-col bg-stone-100">
      {/* FE-3 (issue #80) — shell boundary around the header: a render crash
          in the 1000-line header (search, notifications, flags, tab strip)
          swaps in the friendly boundary card instead of white-screening the
          whole app — banners, the active tab and the offline queue stay
          usable. Layered with the per-tab boundary below and the route-level
          src/app/error.tsx (which catches banners/dialogs/footer). */}
      <ErrorBoundary context="shell:header">
        <Header
          tab={activeTab}
          onTabChange={setTab}
          onCreateProject={() => setCreateOpen(true)}
          onShare={() => setShareOpen(true)}
        />
      </ErrorBoundary>

      {/* ⌘K command palette (W3-F3) — mounted at the app root so the shortcut
          works on every surface below the auth/boot gates. */}
      <CommandPalette />

      {showUnknownRoleNotice && (
        <div
          className="bg-amber-100 text-amber-950 px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-medium border-b border-amber-200"
          role="alert"
        >
          <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden />
          <span className="text-center">
            {t('app.unknownRole', { role: sessionRole ?? '' })}
          </span>
        </div>
      )}

      {viewMode === 'client' && (
        isClientSurface ? (
          <DiasporaBanner label={t('banner.client')} />
        ) : (
          <DiasporaBanner onExit={() => setViewMode('owner')} />
        )
      )}

      {/* #192 (outbox persistence hardening) — the localStorage layer is
          degraded: writes are failing (device storage full / private mode).
          LOUDER than the offline banner below: while degraded, offline work
          still queues in memory but is one tab-close from loss; queue-only
          means the adapter's fallback banked the queue by dropping the
          re-fetchable data slice (offline WRITES survive a restart, offline
          READS do not). Owner surfaces only — the client surfaces re-read
          their view from the server/share token, and the queue is
          owner-side. */}
      {(persistDegraded || persistQueueOnly) && !isClientSurface && (
        <div
          className={`px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium ${
            persistDegraded ? 'bg-red-600 text-white' : 'bg-amber-600 text-stone-950'
          }`}
          role={persistDegraded ? 'alert' : 'status'}
        >
          <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden />
          <span className="text-center">
            {persistDegraded ? t('app.persist.degraded') : t('app.persist.queueOnly')}
          </span>
        </div>
      )}

      {!online && !isClientSurface && (
        <div className="bg-amber-500 text-stone-950 px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium" role="status">
          <CloudOff className="w-4 h-4 shrink-0" aria-hidden />
          <span className="text-center">
            {t('app.offline.banner')}
            {outbox.length > 0 && ` ${t('app.offline.pending', { count: outbox.length })}`}. {t('app.offline.aiOffline')}
          </span>
          {syncing && <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />}
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6" data-active-project={activeProjectId ?? data.project.id}>
        {/* FE-7 (issue #80): the active tab PANEL — role="tabpanel" pairs with
            the header strip's role="tab" buttons (id `mjengo-tab-<key>` +
            aria-controls → this id). aria-labelledby names the panel from the
            visible strip: the desktop tab (hidden below md, ignored by AT) or
            the mobile bottom-nav tab (`mjengo-mtab-<key>`, hidden md+); the
            client surface has no bottom nav — the header strip is its only
            strip, so the first id always resolves.
            #344: the labelledby idrefs can BOTH be unresolvable — on a mobile
            viewport an overflow tab (bottom-nav "More" sheet) has no primary
            `mjengo-mtab-<key>` element (the sheet's buttons only mount while
            open, and the desktop tab is display:none) — so the panel ALSO
            carries its own aria-label (the active tab's translated full
            label). Accname prefers labelledby when it resolves; aria-label is
            the spec's fallback when it cannot — either way the panel is
            named on every surface/viewport intersection. */}
        <div
          role="tabpanel"
          id={`mjengo-panel-${activeTab}`}
          aria-labelledby={`mjengo-tab-${activeTab} mjengo-mtab-${activeTab}`}
          aria-label={t(metaFor(activeTab).label)}
        >
        {/* One error boundary around the ACTIVE tab panel (W3-F2): a render
            crash in any tab swaps in the friendly boundary card instead of
            blanking the whole app. key={activeTab} remounts the boundary on
            tab switch so a crashed tab never shadows a healthy one. */}
        <ErrorBoundary context={`tab:${activeTab}`} key={activeTab}>
          {activeTab === 'overview' && <OverviewTab onOpenCopilot={() => setTab('copilot')} />}
          {activeTab === 'site' && <SitePlanTab />}
          {activeTab === 'materials' && <MaterialsTab />}
          {activeTab === 'finder' && <FinderTab />}
          {activeTab === 'fundis' && <FundisTab />}
          {activeTab === 'money' && <MoneyTab />}
          {activeTab === 'land' && <LandTab />}
          {activeTab === 'evidence' && <EvidenceTab />}
          {activeTab === 'intel' && <IntelTab />}
          {activeTab === 'copilot' && <CopilotTab />}
          {activeTab === 'ussd' && <UssdTab />}
          {/* Audit log — admin only (W3-F1 · spec §44); the tab itself renders
              an access-denied panel if a non-admin somehow reaches it. */}
          {activeTab === 'audit' && <AuditTab />}
          {/* Settings (W3-F3) — every role: profile, local prefs, notification prefs. */}
          {activeTab === 'settings' && <SettingsTab />}
        </ErrorBoundary>
        </div>
      </main>

      {/* Mobile owner navigation — fixed bottom bar, hidden on md+ where the
          header's desktop tab strip takes over (W1-PERM, Doc B §53/§54).
          FE-4 (issue #108): hidden in client view too — a real client has NO
          bottom nav (the header strip is their only strip), so the preview
          mirrors exactly what the client sees on mobile. */}
      {viewMode !== 'client' && <MobileBottomNav tab={activeTab} onTabChange={setTab} />}

      <footer
        className={`mt-auto bg-stone-950 text-stone-400 ${
          isClientSurface
            ? 'pb-[env(safe-area-inset-bottom)]'
            : 'pb-[calc(env(safe-area-inset-bottom)+5rem)] md:pb-[env(safe-area-inset-bottom)]'
        }`}
      >
        {isClientSurface ? (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <HardHat className="w-4 h-4 text-amber-500" aria-hidden />
              <span className="font-semibold text-stone-200">MjengoOS</span>
              <span className="hidden sm:inline">{t('footer.client.tagline')}</span>
            </div>
            {/* Share-link visitors may be site team; logged-in client-role
                users belong here. FE-4 (issue #80): stone-300 on stone-950
                (7.35:1) — the old stone-500 was 3.65:1 at 11px, unreadable
                in field light. */}
            {isShareClient && !clientRole && (
              <button
                type="button"
                onClick={exitShareView}
                className="text-[11px] text-stone-300 hover:text-stone-100 underline underline-offset-2 min-h-11 px-2 transition-colors"
                aria-label={t('footer.client.siteTeamAria')}
              >
                {t('footer.client.siteTeam')}
              </button>
            )}
          </div>
        ) : (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <HardHat className="w-4 h-4 text-amber-500" aria-hidden />
              <span className="font-semibold text-stone-200">MjengoOS</span>
              <span className="hidden sm:inline">{t('footer.owner.tagline')}</span>
            </div>
            <div className="flex items-center gap-3 text-stone-500">
              <span>{t('footer.owner.copilot')}</span>
              <span className="hidden sm:inline">{t('footer.owner.payments')}</span>
              <span>{t('footer.owner.location')}</span>
            </div>
          </div>
        )}
      </footer>

      {/* App-level dialogs (owner app only) */}
      {!isClientSurface && (
        <>
          <CreateProjectDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreate={handleCreateProject}
            submitting={creating}
          />
          <ShareDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            shareUrl={shareUrl}
            previewing={viewMode === 'client'}
            onPreviewingChange={handlePreviewingChange}
            onRegenerate={() => void handleRegenerateShareLink()}
          />
        </>
      )}
    </div>
  )
}
