'use client'

// W5-3 Supplier-side portal — the scoped supplier surface (closes the
// marketplace promise gap: suppliers were rows, now they are users).
//
// Rendered INSTEAD of the owner app for supplier-role sessions (app.tsx): the
// portal owns its whole lifecycle —
//   · READ    GET /api/supplier  (their catalog, quotes/RFQs, orders +
//             deliveries, invoices — every row pinned server-side to the
//             session's supplier link)
//   · MUTATE  POST /api/actions  with SUPPLIER_ACTIONS only (quote.receive,
//             quote.decline, order.confirm, order.dispatch, catalog.upsert);
//             the server re-pins every id to their own rows
//   · OFFLINE #128 — the supplier outbox: dispatch queues in the persisted
//             use-supplier-outbox store when the radio is down (or drops
//             mid-send) and drains via the supplier-scoped /api/sync on
//             reconnect; the header's SupplierSyncControl is the
//             pending/syncing indicator + per-item sheet (owner parity).
//
// Sections reuse the Finder's proven bits (badges, money/qty formatters,
// delivery-photo rendering, the invoice status badge) — the buyer cards
// themselves are wired to the owner store's project payload, so the supplier
// cards here mirror their markup with scoped data.
//
// Internal navigation mirrors the permission matrix row (permissions.ts
// ROLE_TABS.supplier): 'supplier' (this portal) + 'settings' (per-user prefs).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { HardHat, LogOut, MessageSquareQuote, RefreshCw, Truck, ReceiptText, Boxes, Settings, TriangleAlert } from 'lucide-react'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Skeleton } from '@/frontend/ui/skeleton'
import { useT } from '@/frontend/i18n/provider'
import type { ActionType } from '@/backend/lib/mjengo'
import type { SupplierPortalPayload } from '@/backend/api/supplier'
import { useSupplierOutbox } from '@/frontend/hooks/use-supplier-outbox'
import { SettingsTab } from '@/frontend/mjengo/settings-tab'
import { SupplierQuoteCard } from './supplier-quote-card'
import { SupplierOrderCard } from './supplier-order-card'
import { SupplierInvoices } from './supplier-invoices'
import { SupplierCatalog } from './supplier-catalog'
import { SupplierSyncControl } from './supplier-sync-control'

/** The portal's dispatch signature (scoped: names the buyer project the row
 *  lives in — catalog rows are network-global, so their project context is
 *  optional and the server falls back to the default project).
 *
 *  #141 / audit FE-10 — the DECISION, recorded with the type that owns it:
 *  KEEP the `label`. It is the human-readable action context (owner dispatch
 *  parity): every supplier card passes one, the portal threads it into the
 *  store, and when the radio is down it rides the queued outbox item and
 *  renders per-item in the sync sheet (`SupplierSyncControl`). Online it is
 *  deliberately NOT sent to the server — the server writes its own audit
 *  events — so the label is purely client-side context, never wire payload. */
export type SupplierDispatch = (
  type: ActionType,
  payload: Record<string, unknown>,
  projectId: string | undefined,
  label: string,
) => Promise<boolean>

// #141 — the keep-decision, COMPILE-PINNED (the i18n dicts/check.ts Assert
// idiom; tests/ sits outside tsc's include, so signature pins live in src):
// dropping or retyping the label param on EITHER seam below fails
// `bunx tsc --noEmit` — the "remove honestly" path is a reviewed change,
// never silent drift back to the pre-#128 dropped-label posture.
type Assert<T extends true> = T
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false
/** The store-side dispatch seam (use-supplier-outbox) — must take the SAME 4-tuple. */
type SupplierStoreDispatch = ReturnType<typeof useSupplierOutbox.getState>['dispatch']
const _supplierDispatchKeepsLabel: Assert<Equal<
  Parameters<SupplierDispatch>,
  [type: ActionType, payload: Record<string, unknown>, projectId: string | undefined, label: string]
>> = true
const _storeDispatchSeamMatchesThePortal: Assert<Equal<
  Parameters<SupplierStoreDispatch>,
  Parameters<SupplierDispatch>
>> = true
void _supplierDispatchKeepsLabel
void _storeDispatchSeamMatchesThePortal

export function SupplierPortal() {
  const { data: session, status } = useSession()
  const t = useT()
  const [payload, setPayload] = useState<SupplierPortalPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'portal' | 'settings'>('portal')
  // #128 — the supplier outbox store: online flag (drives queue-vs-send),
  // dataVersion (drives the post-drain portal refresh). The STORE owns the
  // queue + drain; this component only wires connectivity + refreshes.
  const online = useSupplierOutbox((s) => s.online)
  const dataVersion = useSupplierOutbox((s) => s.dataVersion)
  // #352 — persistence health (the guarded adapter's flags): the supplier
  // twin of app.tsx's #192/#337 banner. `degraded` = writes failing
  // outright (device storage full / private mode) — offline work still
  // queues in memory but is one tab-close from loss; `queueOnly` = the
  // fallback banked the queue by dropping the inspection-only syncHistory.
  const persistDegraded = useSupplierOutbox((s) => s.persistDegraded)
  const persistQueueOnly = useSupplierOutbox((s) => s.persistQueueOnly)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/supplier', { cache: 'no-store' })
      if (res.status === 403) {
        setError(t('supplier.error.unlinked'))
        setPayload(null)
        return
      }
      if (!res.ok) {
        setError(t('supplier.load.error'))
        return
      }
      const json = (await res.json()) as { ok?: boolean } & SupplierPortalPayload
      if (!json.ok) {
        setError(t('supplier.load.error'))
        return
      }
      setPayload(json)
    } catch {
      setError(t('supplier.load.error'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  // ---------------- #128 — supplier outbox wiring (owner app parity) ----------------

  // Real connectivity: mirror app.tsx's owner wiring against the SUPPLIER
  // store — going offline is silent (the queued badge appears on the next
  // action), coming back online drains the outbox via setOnline → toast
  // "Back online — syncing queued actions" + auto-syncNow.
  useEffect(() => {
    useSupplierOutbox.setState({ online: navigator.onLine })
    const onOffline = () => useSupplierOutbox.getState().setOnline(false)
    const onOnline = () => useSupplierOutbox.getState().setOnline(true)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  // Post-auth drain (#191 parity): a drain that hit an EXPIRED session left
  // the supplier queue auth-blocked; once a session authenticates again
  // (keyed on next-auth's `expires` so expiry + re-login re-arms it) the
  // auth-blocked items re-queue and the pending queue flushes once when
  // online. Repeated fires are harmless (syncNow no-ops without pending work).
  const authDrainedFor = useRef<string | null>(null)
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.email || !online) return
    const sessionKey = String(session.expires ?? session.user.email)
    if (authDrainedFor.current === sessionKey) return
    authDrainedFor.current = sessionKey
    void useSupplierOutbox.getState().drainAfterAuth()
  }, [status, session, online])

  // Post-drain refresh: this store owns NO payload of its own — when a drain
  // synced ≥ 1 server-side row (dataVersion bumped), re-read /api/supplier so
  // the cards reflect what actually landed. dataVersion starts at 0 and is
  // not persisted, so a fresh mount never fires a spurious load.
  useEffect(() => {
    if (dataVersion > 0) void load()
  }, [dataVersion, load])

  /** Scoped mutation, offline-first (#128): the SUPPLIER outbox store owns
   *  the send-or-queue decision — online it POSTs /api/actions exactly as
   *  before; offline (or when the network drops mid-send) the action queues
   *  in the persisted outbox and drains on reconnect. 'applied' → re-read the
   *  whole portal payload (source of truth); 'queued' → true (the sync sheet
   *  owns the pending state); 'refused' → false (the honest server message
   *  was already toasted by the store). The label rides the queued item
   *  (#141 — the sync sheet renders it per item). */
  const dispatch: SupplierDispatch = useCallback(
    async (type, actionPayload, projectId, label) => {
      setBusy(true)
      try {
        const result = await useSupplierOutbox
          .getState()
          .dispatch(type, actionPayload, projectId, label)
        if (result === 'applied') {
          await load()
          return true
        }
        return result === 'queued'
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const quotes = payload?.quotes ?? []
  const orders = payload?.orders ?? []
  const invoices = payload?.invoices ?? []
  const catalog = payload?.catalog ?? []
  const quotesToAnswer = quotes.filter((q) => q.status === 'requested')
  const ordersToConfirm = orders.filter((o) => o.status === 'sent')
  const ordersToDispatch = orders.filter((o) => o.status === 'confirmed')

  return (
    <div className="min-h-screen flex flex-col bg-stone-100">
      {/* Header — the supplier's own light bar (the owner Header is buyer data). */}
      <header className="bg-stone-950 text-stone-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 bg-amber-500 rounded-lg flex items-center justify-center shrink-0" aria-hidden>
              <HardHat className="w-5 h-5 text-stone-950" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight truncate">
                MjengoOS · {t('supplier.portal.title')}
              </p>
              <p className="text-[11px] text-stone-400 truncate">
                {payload?.supplier.businessName ?? session?.user?.name ?? t('nav.supplier')}
              </p>
            </div>
            <Badge className="border-0 bg-amber-500 text-stone-950 hover:bg-amber-500 text-[10px] font-bold shrink-0">
              {t('supplier.portal.badge')}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5">
            {/* #128 — pending/syncing indicator + per-item outbox sheet (only
                renders while there is outbox work). */}
            <SupplierSyncControl />
            <Button
              size="sm"
              variant="ghost"
              className="h-11 min-h-11 text-xs text-stone-300 hover:text-stone-100 gap-1.5"
              onClick={() => void load()}
              disabled={busy || loading}
              aria-label={t('supplier.load.retry')}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
              <span className="hidden sm:inline">{t('supplier.load.retry')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-11 min-h-11 text-xs text-stone-300 hover:text-stone-100 gap-1.5"
              onClick={() => setView(view === 'portal' ? 'settings' : 'portal')}
              aria-label={t('supplier.tab.settings')}
            >
              <Settings className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{t('supplier.tab.settings')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-11 min-h-11 text-xs text-stone-300 hover:text-stone-100 gap-1.5"
              onClick={() => void signOut({ callbackUrl: '/' })}
              aria-label={t('supplier.signout')}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{t('supplier.signout')}</span>
            </Button>
          </div>
        </div>
      </header>

      {/* #352 — the persistence-degradation banner (the owner app.tsx
          banner's supplier twin): red when writes are failing outright
          (device storage full / private mode), amber when the queue-only
          fallback banked the queue by dropping the inspection-only
          syncHistory. LOUDER than the offline state: while degraded,
          offline work still queues in memory but is one tab-close from
          loss. */}
      {(persistDegraded || persistQueueOnly) && (
        <div
          className={`px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium ${
            persistDegraded ? 'bg-red-600 text-white' : 'bg-amber-600 text-stone-950'
          }`}
          role={persistDegraded ? 'alert' : 'status'}
        >
          <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden />
          <span className="text-center">
            {persistDegraded ? t('supplier.persist.degraded') : t('supplier.persist.queueOnly')}
          </span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3 text-center text-sm text-red-800" role="alert">
          {error}
          <button
            type="button"
            className="ml-3 underline underline-offset-2 font-medium"
            onClick={() => void load()}
          >
            {t('supplier.load.retry')}
          </button>
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {view === 'settings' ? (
          <SettingsTab />
        ) : loading && !payload ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : payload ? (
          <>
            {/* ---- needs your action ---- */}
            <section aria-label={t('supplier.stats.aria')} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <ActionStat
                icon={<MessageSquareQuote className="h-5 w-5" aria-hidden />}
                label={t('supplier.stats.quotes')}
                count={quotesToAnswer.length}
                tone="amber"
              />
              <ActionStat
                icon={<Truck className="h-5 w-5" aria-hidden />}
                label={t('supplier.stats.confirm')}
                count={ordersToConfirm.length}
                tone="sky"
              />
              <ActionStat
                icon={<Boxes className="h-5 w-5" aria-hidden />}
                label={t('supplier.stats.dispatch')}
                count={ordersToDispatch.length}
                tone="teal"
              />
            </section>
            {quotesToAnswer.length + ordersToConfirm.length + ordersToDispatch.length === 0 && (
              <p className="text-sm text-stone-500 text-center py-2">{t('supplier.stats.none')}</p>
            )}

            <Card className="border-stone-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
                  <MessageSquareQuote className="h-5 w-5 text-amber-600" aria-hidden />
                  {t('supplier.quotes.title')}
                  <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{quotes.length}</Badge>
                </CardTitle>
                <CardDescription>{t('supplier.quotes.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {quotes.length === 0 ? (
                  <EmptyNote text={t('supplier.quotes.empty')} />
                ) : (
                  <div className="space-y-4">
                    {quotes.map((quote) => (
                      <SupplierQuoteCard key={quote.id} quote={quote} dispatch={dispatch} busy={busy} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-stone-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
                  <Truck className="h-5 w-5 text-amber-600" aria-hidden />
                  {t('supplier.orders.title')}
                  <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{orders.length}</Badge>
                </CardTitle>
                <CardDescription>{t('supplier.orders.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {orders.length === 0 ? (
                  <EmptyNote text={t('supplier.orders.empty')} />
                ) : (
                  <div className="space-y-4">
                    {orders.map((order) => (
                      <SupplierOrderCard key={order.id} order={order} dispatch={dispatch} busy={busy} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-stone-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
                  <ReceiptText className="h-5 w-5 text-amber-600" aria-hidden />
                  {t('supplier.invoices.title')}
                  <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{invoices.length}</Badge>
                </CardTitle>
                <CardDescription>{t('supplier.invoices.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {invoices.length === 0 ? <EmptyNote text={t('supplier.invoices.empty')} /> : (
                  <SupplierInvoices invoices={invoices} />
                )}
              </CardContent>
            </Card>

            <Card className="border-stone-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
                  <Boxes className="h-5 w-5 text-amber-600" aria-hidden />
                  {t('supplier.catalog.title')}
                  <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{catalog.length}</Badge>
                </CardTitle>
                <CardDescription>{t('supplier.catalog.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {catalog.length === 0 ? <EmptyNote text={t('supplier.catalog.empty')} /> : (
                  <SupplierCatalog
                    catalog={catalog}
                    dispatch={dispatch}
                    busy={busy}
                    supplierId={payload.supplier.id}
                    projectId={payload.projects[0]?.id}
                  />
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </main>

      <footer className="mt-auto bg-stone-950 text-stone-400 pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <HardHat className="w-4 h-4 text-amber-500" aria-hidden />
            <span className="font-semibold text-stone-200">MjengoOS</span>
            <span className="hidden sm:inline">· Supplier portal · scoped to your account</span>
          </div>
          <p className="text-stone-500">{t('supplier.footer')}</p>
        </div>
      </footer>
    </div>
  )
}

/** One "needs your action" stat tile. */
function ActionStat({
  icon, label, count, tone,
}: { icon: React.ReactNode; label: string; count: number; tone: 'amber' | 'sky' | 'teal' }) {
  const tones: Record<string, string> = {
    amber: 'bg-amber-100 text-amber-900',
    sky: 'bg-sky-100 text-sky-800',
    teal: 'bg-teal-100 text-teal-800',
  }
  return (
    <div className={`rounded-xl border border-stone-200 p-4 flex items-center gap-3 ${count > 0 ? tones[tone] : 'bg-white'}`}>
      <span className="shrink-0" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums leading-none">{count}</p>
        <p className="text-xs mt-1 leading-snug">{label}</p>
      </div>
    </div>
  )
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 p-6 text-center">
      <p className="text-sm text-stone-500">{text}</p>
    </div>
  )
}
