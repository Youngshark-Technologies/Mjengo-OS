'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useSession, signOut } from 'next-auth/react'
import { toast } from 'sonner'
import { useMjengo, type DataMode } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import { Switch } from '@/frontend/ui/switch'
import { Avatar, AvatarFallback } from '@/frontend/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/frontend/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/frontend/ui/sheet'
import { ProjectSwitcher } from '@/frontend/mjengo/project-switcher'
import { SyncOutboxPanel } from '@/frontend/mjengo/sync-outbox-panel'
import { PendingNetworkPanel } from '@/frontend/mjengo/pending-network-panel'
import { SHOW_CONNECTIVITY_SIM } from '@/frontend/lib/dev-affordances'
import {
  Wifi, CloudOff, HardHat, RefreshCw, CheckCheck, Share2, Bell, LogOut,
  Landmark, FileDiff, MessageSquare, TriangleAlert, BellRing,
  Flag, Truck, Package, UserCheck, ClipboardCheck, FileText, ReceiptText, TrendingUp, Newspaper, ShieldAlert,
  Search, ChevronDown, Settings, Check, Loader2, X, Command, Volume2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Notification } from '@prisma/client'
import type { TabKey } from '@/frontend/mjengo/app'
import { formatKES } from '@/frontend/lib/format'
import { usePermissions, tabsForRole } from '@/shared/permissions'
import { metaForAll, tabsVisibleForFlags } from '@/frontend/mjengo/nav/tab-meta'
import { useTablistKeyboard } from '@/frontend/mjengo/nav/use-tablist'
import { useCommandPalette } from '@/frontend/mjengo/cmdk/palette-store'
import { useT } from '@/frontend/i18n/provider'

/** Noop external-store subscription — lets us read a client-only value via
 *  useSyncExternalStore without hydration mismatches or setState-in-effect. */
const subscribeNoop = () => () => {}

/** Icon + label per notification kind (falls back to a bell). */
const NOTIFICATION_KINDS: Record<string, { label: string; Icon: LucideIcon; tint: string }> = {
  milestone: { label: 'Milestone', Icon: Flag, tint: 'text-amber-600' },
  variation: { label: 'Variation', Icon: FileDiff, tint: 'text-amber-600' },
  comment: { label: 'Comment', Icon: MessageSquare, tint: 'text-stone-500' },
  anomaly: { label: 'Anomaly', Icon: TriangleAlert, tint: 'text-red-600' },
  recap: { label: 'Recap', Icon: BellRing, tint: 'text-emerald-600' },
  attendance: { label: 'Attendance', Icon: UserCheck, tint: 'text-stone-500' },
  share: { label: 'Share link', Icon: Share2, tint: 'text-stone-500' },
  system: { label: 'System', Icon: Bell, tint: 'text-stone-400' },
  'approval.requested': { label: 'Approval', Icon: ClipboardCheck, tint: 'text-amber-600' },
  'approval.decided': { label: 'Approval', Icon: ClipboardCheck, tint: 'text-amber-600' },
  'quote.received': { label: 'Quote', Icon: FileText, tint: 'text-stone-500' },
  'order.sent': { label: 'Order', Icon: Package, tint: 'text-stone-500' },
  'order.confirmed': { label: 'Order', Icon: Package, tint: 'text-stone-500' },
  'order.cancelled': { label: 'Order', Icon: X, tint: 'text-rose-600' }, // #206 — PO cancelled (truck turned around / order pulled)
  'delivery.dispatched': { label: 'Delivery', Icon: Truck, tint: 'text-stone-500' },
  'delivery.discrepancy': { label: 'Delivery', Icon: TriangleAlert, tint: 'text-red-600' },
  'delivery.voided': { label: 'Delivery', Icon: X, tint: 'text-stone-500' }, // #206 — mistaken dispatch voided
  'request.cancelled': { label: 'Request', Icon: X, tint: 'text-stone-500' }, // #206 — request withdrawn
  'invoice.submitted': { label: 'Invoice', Icon: ReceiptText, tint: 'text-amber-600' },
  'invoice.decided': { label: 'Invoice', Icon: ReceiptText, tint: 'text-amber-600' },
  'invoice.disputed': { label: 'Invoice', Icon: TriangleAlert, tint: 'text-red-600' },
  'invoice.paid': { label: 'Invoice', Icon: ReceiptText, tint: 'text-emerald-600' },
  'land': { label: 'Land', Icon: Landmark, tint: 'text-stone-500' },
  'price.alert': { label: 'Price', Icon: TrendingUp, tint: 'text-amber-600' },
  'digest.weekly': { label: 'Digest', Icon: Newspaper, tint: 'text-stone-500' },
  'risk.flagged': { label: 'Risk', Icon: ShieldAlert, tint: 'text-red-600' },
  'trust.digest': { label: 'Trust digest', Icon: Volume2, tint: 'text-emerald-600' }, // W6-2
  'payment.orphaned': { label: 'Unmatched payment', Icon: TriangleAlert, tint: 'text-red-600' }, // issue #211 — operator action needed
  'escrow.drift': { label: 'Escrow drift', Icon: TriangleAlert, tint: 'text-red-600' }, // issue #212 — projection ≠ ledger, operator action needed
}

function kindMeta(kind: string) {
  return NOTIFICATION_KINDS[kind] ?? { label: 'Notice', Icon: Bell, tint: 'text-stone-400' }
}

/** Filter groups for the notification center (unknown kinds fall into "Site"). */
const KIND_GROUPS: Array<{ key: string; labelKey: string; kinds: string[] }> = [
  { key: 'all', labelKey: 'notif.group.all', kinds: [] },
  { key: 'approvals', labelKey: 'notif.group.approvals', kinds: ['approval.requested', 'approval.decided'] },
  { key: 'orders', labelKey: 'notif.group.orders', kinds: ['order.sent', 'order.confirmed', 'order.cancelled', 'quote.received'] },
  { key: 'deliveries', labelKey: 'notif.group.deliveries', kinds: ['delivery.dispatched', 'delivery.discrepancy', 'delivery.voided'] },
  { key: 'invoices', labelKey: 'notif.group.invoices', kinds: ['invoice.submitted', 'invoice.decided', 'invoice.disputed', 'invoice.paid'] },
  { key: 'intel', labelKey: 'notif.group.intel', kinds: ['price.alert', 'digest.weekly', 'risk.flagged', 'trust.digest'] },
  { key: 'money', labelKey: 'notif.group.money', kinds: ['milestone', 'variation', 'payment.orphaned', 'escrow.drift'] },
  { key: 'site', labelKey: 'notif.group.site', kinds: ['recap', 'comment', 'attendance', 'anomaly', 'share', 'system', 'request.cancelled'] },
]

function groupOf(kind: string): string {
  const g = KIND_GROUPS.find((x) => x.key !== 'all' && x.kinds.includes(kind))
  return g?.key ?? 'site'
}

/** Signed-in identity chip + sign out (hidden for share-token clients — they never log in). */
function UserChip() {
  const { data: session } = useSession()
  const t = useT()
  const user = session?.user
  if (!user?.email) return null

  const initials = (user.name || user.email)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || 'U'
  const role = String(user.role ?? 'contractor')
  const roleBadge =
    role === 'admin'
      ? 'bg-stone-800 text-stone-100'
      : role === 'client'
        ? 'bg-emerald-100 text-emerald-800'
        : 'bg-amber-100 text-amber-900'

  function handleSignOut() {
    // Reset view flags so no stale client/share surface survives the reload
    useMjengo.setState({ shareToken: null, shareError: null, clientRole: false, viewMode: 'owner' })
    void signOut({ redirect: false }).finally(() => window.location.reload())
  }

  return (
    <div className="flex items-center gap-1.5 sm:gap-2" aria-label={t('header.aria.signedInAs', { name: user.name ?? '', role })}>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar className="w-8 h-8 border border-stone-700">
          <AvatarFallback className="bg-amber-500 text-stone-950 text-xs font-bold">
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="hidden lg:flex flex-col leading-tight min-w-0">
          <span className="text-xs font-semibold text-stone-100 truncate max-w-28">{user.name}</span>
          <span
            className={`text-[9px] font-bold uppercase tracking-wide px-1.5 rounded w-fit ${roleBadge}`}
          >
            {role}
          </span>
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleSignOut}
        aria-label={t('header.signOut')}
        className="h-11 w-11 p-0 border-stone-700 bg-stone-900 text-stone-200 hover:bg-red-900/60 hover:text-white"
      >
        <LogOut className="w-4 h-4" aria-hidden />
      </Button>
    </div>
  )
}

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

// ---------------- Global search (spec §80, F-INSIGHT) ----------------

interface SearchItem {
  id: string
  title: string
  sub: string
  project: string | null
  target: 'project' | 'parcel' | 'worker' | 'supplier' | 'catalog' | 'request' | 'order' | 'invoice' | 'transaction' | 'notification'
}
interface SearchGroup { group: string; items: SearchItem[] }

/** Which tab a search target routes to (app.tsx listens on 'mjengo:tab'). */
const TARGET_TABS: Partial<Record<SearchItem['target'], string>> = {
  parcel: 'land',
  worker: 'fundis',
  supplier: 'finder',
  catalog: 'finder',
  request: 'finder',
  order: 'finder',
  invoice: 'finder',
  transaction: 'money',
}

/**
 * Header search — always visible on desktop, icon-expand on mobile. Results
 * are grouped (max 5 per group) and keyboard navigable: '/' focuses the input,
 * ArrowUp/Down move, Enter opens, Escape closes. Click behavior per target:
 * project → switch project; others → their tab via the 'mjengo:tab' event;
 * notification → opens the bell sheet via 'mjengo:notifications'.
 */
function GlobalSearch() {
  const { status } = useSession()
  const t = useT()
  const switchProject = useMjengo((s) => s.switchProject)
  const inputRef = useRef<HTMLInputElement>(null)
  const mobileInputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1)

  const flat = useMemo(
    () => groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group }))),
    [groups],
  )

  // Debounced query — min 2 characters, abortable.
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) {
      setGroups([])
      setOpen(false)
      setActive(-1)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
          const json = await res.json()
          if (json.ok) {
            setGroups((json.groups ?? []) as SearchGroup[])
            setOpen(true)
            setActive(json.groups?.length ? 0 : -1)
          } else {
            toast.error(json.error ?? 'Search failed')
          }
        } catch (e) {
          if ((e as Error).name !== 'AbortError') toast.error('Search unreachable — check connectivity')
        } finally {
          setLoading(false)
        }
      })()
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [q])

  // '/' focuses search (when not already typing); Escape closes; click-outside closes.
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !typing(e.target)) {
        e.preventDefault()
        if (window.innerWidth < 768) {
          setMobileOpen(true)
          setTimeout(() => mobileInputRef.current?.focus(), 30)
        } else {
          inputRef.current?.focus()
        }
      }
      if (e.key === 'Escape') {
        setOpen(false)
        setMobileOpen(false)
      }
    }
    const onDown = (e: MouseEvent) => {
      if (open && wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  function handleTarget(item: SearchItem) {
    setOpen(false)
    setMobileOpen(false)
    if (item.target === 'project') {
      void switchProject(item.id)
      return
    }
    if (item.target === 'notification') {
      window.dispatchEvent(new CustomEvent('mjengo:notifications'))
      return
    }
    const tab = TARGET_TABS[item.target]
    if (tab) window.dispatchEvent(new CustomEvent('mjengo:tab', { detail: { tab } }))
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || flat.length === 0) {
      if (e.key === 'Escape') { setOpen(false); setMobileOpen(false) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[active >= 0 ? active : 0]
      if (item) handleTarget(item)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  function searchBox(inputRefLocal: React.RefObject<HTMLInputElement | null>, idPrefix: string, autoFocus = false) {
    return (
      <div className="relative">
        <div className="flex items-center gap-2 rounded-lg border border-stone-700 bg-stone-900 px-2.5 h-9 focus-within:border-amber-500">
          <Search className="w-4 h-4 text-stone-500 shrink-0" aria-hidden />
          <input
            ref={inputRefLocal}
            type="search"
            value={q}
            autoFocus={autoFocus}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKeyDown}
            onFocus={() => { if (q.trim().length >= 2 && flat.length) setOpen(true) }}
            placeholder={t('header.search.placeholder')}
            aria-label={t('header.aria.search')}
            // FE-7 (issue #80): combobox pattern — aria-expanded tells AT the
            // popup is open, aria-controls points at the listbox, and
            // aria-activedescendant tracks the Arrow-key-active option (ids
            // are instance-prefixed: the desktop and mobile boxes never share
            // DOM ids).
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? `${idPrefix}-results` : undefined}
            aria-activedescendant={
              open && active >= 0 && active < flat.length ? `${idPrefix}-opt-${active}` : undefined
            }
            className="bg-transparent text-sm text-stone-100 placeholder:text-stone-500 outline-none w-full min-w-0 [&::-webkit-search-cancel-button]:hidden"
          />
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 text-stone-500 animate-spin shrink-0" aria-label={t('header.aria.searching')} />
          ) : (
            <kbd className="hidden lg:inline text-[10px] text-stone-500 border border-stone-700 rounded px-1 shrink-0" aria-hidden>/</kbd>
          )}
          {q && (
            <button
              type="button"
              onClick={() => { setQ(''); setGroups([]); setOpen(false) }}
              aria-label={t('header.aria.clearSearch')}
              className="text-stone-500 hover:text-stone-200 shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          )}
        </div>

        {open && (
          <div
            id={`${idPrefix}-results`}
            className={`absolute left-0 right-0 top-full mt-2 rounded-lg border border-stone-200 bg-white shadow-xl z-50 max-h-96 overflow-y-auto ${SCROLLBAR}`}
            role="listbox"
            aria-label={t('header.aria.results')}
          >
            {flat.length === 0 ? (
              <p className="px-4 py-6 text-sm text-stone-500 text-center">
                {q.trim().length < 2 ? t('header.search.minChars') : t('header.search.noMatches', { q: q.trim() })}
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.group}>
                  <p className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-stone-600 sticky top-0 bg-white">
                    {g.group}
                  </p>
                  {g.items.map((item) => {
                    const idx = flat.findIndex((f) => f.id === item.id && f.group === g.group)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        id={`${idPrefix}-opt-${idx}`}
                        aria-selected={idx === active}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => handleTarget(item)}
                        className={`w-full text-left px-3 py-2 min-h-11 flex items-start gap-2.5 ${
                          idx === active ? 'bg-amber-50' : 'hover:bg-stone-50'
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-stone-900 truncate">{item.title}</span>
                          <span className="block text-xs text-stone-500 truncate">{item.sub}</span>
                          {item.project && (
                            <span className="block text-[10px] text-stone-600 truncate">{item.project}</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  // Share-link visitors have no session — the search API is sign-in guarded.
  if (status !== 'authenticated') return null

  return (
    <>
      {/* Mobile: icon button that expands a fixed search panel */}
      <button
        type="button"
        onClick={() => {
          setMobileOpen((v) => !v)
          setTimeout(() => mobileInputRef.current?.focus(), 30)
        }}
        aria-label={t('header.aria.openSearch')}
        aria-expanded={mobileOpen}
        className="md:hidden flex items-center justify-center w-11 h-11 rounded-md border border-stone-700 bg-stone-900 text-stone-300 hover:text-white"
      >
        <Search className="w-4 h-4" aria-hidden />
      </button>

      {/* Desktop: always-visible inline search */}
      <div ref={wrapRef} className="hidden md:block w-56 lg:w-72 shrink-0">
        {searchBox(inputRef, 'gs-desktop')}
      </div>

      {/* Mobile expanded panel */}
      {mobileOpen && (
        <div className="md:hidden fixed left-3 right-3 top-[72px] z-50">
          {searchBox(mobileInputRef, 'gs-mobile', true)}
        </div>
      )}
    </>
  )
}

// ---------------- ⌘K command palette trigger (W3-F3) ----------------

/**
 * Header button that opens the ⌘K command palette (cmdk/command-palette.tsx
 * owns the shortcut itself). Uses the Command glyph rather than a Search
 * glyph to stay distinct from the GlobalSearch trigger next to it; the
 * platform-aware kbd hint mirrors GlobalSearch's `/` hint styling.
 */
function CommandPaletteButton() {
  const setOpen = useCommandPalette((s) => s.setOpen)
  const t = useT()
  // Platform hint: the hydration snapshot is false (Ctrl K) and the real
  // client value applies right after — the canonical useSyncExternalStore
  // pattern for read-once browser values.
  const isMac = useSyncExternalStore(
    subscribeNoop,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent),
    () => false,
  )
  const hint = isMac ? '⌘K' : 'Ctrl K'
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('header.aria.palette')}
        title={t('header.paletteTitle', { keys: isMac ? '⌘K' : 'Ctrl+K' })}
        className="flex items-center justify-center w-11 h-11 rounded-md border border-stone-700 bg-stone-900 text-stone-300 hover:text-white hover:bg-stone-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <Command className="w-4 h-4" aria-hidden />
      </button>
      <kbd className="hidden lg:inline text-[10px] text-stone-500 border border-stone-700 rounded px-1 shrink-0" aria-hidden>
        {hint}
      </kbd>
    </div>
  )
}

// ---------------- Feature flags popover (spec §81, admin only) ----------------

// Mirrors FLAG_KEYS/FLAG_LABELS in src/backend/modules/intel/flags.ts — the
// server module can't be imported here (it pulls the Prisma client), so the
// list is duplicated; keep the two in sync. low_data was removed (task 9-a
// decision — see flags.ts header). `ai` was added DEFAULT OFF (task 8-f —
// the Wave-6 AI provider seam; the row ships unchecked until an admin
// opts in).
const FLAG_ROWS: Array<{ key: string; label: string }> = [
  { key: 'ai_progress', label: 'AI progress (photo analysis)' },
  { key: 'ai_voice', label: 'AI voice logging' },
  { key: 'wallet', label: 'Wallet & payment requests' },
  { key: 'marketplace', label: 'Supplier marketplace (Finder)' },
  { key: 'land_verification', label: 'Land verification ladder' },
  { key: 'ai', label: 'AI features (chat, vision, voice)' },
]

/**
 * Admin-only feature-flag popover (Settings icon). Toggles persist through
 * POST /api/flags and update the payload's intel.flags in place so gated UI
 * reacts immediately. Every flag gates its feature server-side (task 9-a):
 * OFF closes the feature's API routes with 403 for non-admin sessions and
 * hides its UI entry; admins bypass both so they can toggle & test.
 */
function FlagsPopover() {
  const { data: session } = useSession()
  const { can } = usePermissions()
  const t = useT()
  const data = useMjengo((s) => s.data)
  const [busy, setBusy] = useState<string | null>(null)

  if (!session?.user?.email || !can('flags.manage')) return null
  const flags = (data?.intel as { flags?: Record<string, boolean> } | undefined)?.flags ?? {}

  async function toggle(key: string, enabled: boolean) {
    setBusy(key)
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, enabled }),
      })
      const json = await res.json()
      if (json.ok && json.flags) {
        const d = useMjengo.getState().data
        if (d) useMjengo.setState({ data: { ...d, intel: { ...d.intel, flags: json.flags } } })
        toast.success(`Feature flag ${key} ${enabled ? 'enabled' : 'disabled'}`)
      } else {
        toast.error(json.error ?? 'Could not save flag')
      }
    } catch {
      toast.error('Network error — flag not saved')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          aria-label={t('header.aria.flags')}
          title={t('header.flags.title')}
          className="h-11 w-11 p-0 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white"
        >
          <Settings className="w-4 h-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t('header.flags.title')}</p>
        <p className="mt-1 text-[11px] text-stone-500 leading-snug">
          Controlled rollout (spec §81). Every flag gates its feature server-side: OFF closes the
          feature&apos;s API (403 for non-admin sessions) and hides its UI entry. Admins keep access
          while a flag is off, so they can toggle &amp; test.
        </p>
        <div className="mt-3 space-y-2.5">
          {FLAG_ROWS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-3 min-h-11">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-800 leading-tight">{label}</p>
                <p className="text-[10px] font-mono text-stone-400">{key}</p>
              </div>
              <Switch
                checked={flags[key] !== false}
                disabled={busy === key}
                onCheckedChange={(v) => void toggle(key, v)}
                aria-label={`Toggle ${label}`}
                className="data-[state=checked]:bg-emerald-500"
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------- Data mode selector (spec §74 low-data) ----------------

/**
 * Compact Wifi-icon selector with two modes. Data Saver: copilot photos are
 * downscaled client-side before upload (max 1024px JPEG q0.72) and the recap
 * button is labeled text-only. Choice persists in the store (reload-safe).
 */
function DataModeSelector() {
  const dataMode = useMjengo((s) => s.dataMode)
  const setDataMode = useMjengo((s) => s.setDataMode)
  const t = useT()
  const saver = dataMode === 'data_saver'

  const options: Array<{ value: DataMode; label: string; hint: string }> = [
    { value: 'normal', label: t('header.dataMode.normal'), hint: t('header.dataMode.normalHint') },
    { value: 'data_saver', label: t('header.dataMode.saver'), hint: t('header.dataMode.saverHint') },
  ]

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('header.aria.dataMode', { mode: saver ? t('header.dataMode.saver') : t('header.dataMode.normal') })}
          title={t('header.aria.dataMode', { mode: saver ? t('header.dataMode.saver') : t('header.dataMode.normal') })}
          className="flex items-center gap-1.5 h-11 px-2.5 rounded-full bg-stone-900 border border-stone-800 text-stone-200 hover:text-white"
        >
          <Wifi className={`w-4 h-4 ${saver ? 'text-emerald-400' : 'text-stone-400'}`} aria-hidden />
          <span className="hidden sm:inline text-xs font-medium">{saver ? t('header.dataMode.saver') : t('header.dataMode.normal')}</span>
          <ChevronDown className="w-3 h-3 text-stone-400" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t('header.dataMode.title')}</p>
        <div className="mt-2 space-y-1.5">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={dataMode === o.value}
              onClick={() => { if (dataMode !== o.value) setDataMode(o.value) }}
              className={`w-full text-left rounded-lg border px-3 py-2.5 min-h-11 transition-colors ${
                dataMode === o.value ? 'border-amber-400 bg-amber-50' : 'border-stone-200 hover:bg-stone-50'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-stone-800">{o.label}</span>
                {dataMode === o.value && <Check className="w-3.5 h-3.5 text-amber-600" aria-label="Selected" />}
              </span>
              <span className="block text-xs text-stone-500 mt-0.5">{o.hint}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-stone-400 leading-snug">
          {t('header.dataMode.note')}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Notification center bell — works for the owner and for a client on their
 * share link. Signed-in users mark read via POST /api/notifications (a client
 * convenience route — see that file for the reasoning); share-link clients
 * and offline sessions fall back to the client-allowlisted
 * notification.read / readAll actions.
 */
function NotificationBell() {
  const { data, dispatch, actionBusy, notificationsSeenAt, online } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [marking, setMarking] = useState(false)

  const notifications = data?.notifications ?? []
  const unread = useMemo(() => notifications.filter((n) => !n.read), [notifications])
  const filtered = useMemo(
    () => (filter === 'all' ? notifications : notifications.filter((n) => groupOf(n.kind) === filter)),
    [notifications, filter],
  )
  const busy = marking || actionBusy !== null

  // Global-search notification results open this sheet (header dispatches
  // 'mjengo:notifications'). Stamps seen like a manual open.
  useEffect(() => {
    const openBell = () => {
      setOpen(true)
      useMjengo.setState({ notificationsSeenAt: Date.now() })
    }
    window.addEventListener('mjengo:notifications', openBell)
    return () => window.removeEventListener('mjengo:notifications', openBell)
  }, [])

  function markSeen() {
    if (Date.now() - (notificationsSeenAt ?? 0) > 2000) {
      useMjengo.setState({ notificationsSeenAt: Date.now() })
    }
  }

  async function markRead(ids: string[] | 'all') {
    const projectId = data?.project.id
    if (!projectId || busy) return
    if (session?.user && online) {
      // Signed-in + online: the dedicated mark-read route refreshes the store
      // via load() afterwards.
      setMarking(true)
      try {
        const res = await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, ids }),
        })
        if (res.ok) {
          await useMjengo.getState().load()
        } else {
          const json = await res.json().catch(() => null)
          toast.error(json?.error ?? 'Could not mark notifications read')
        }
      } catch {
        toast.error('Network error — try again when back online')
      } finally {
        setMarking(false)
      }
      return
    }
    // Share-link clients (no session) and offline users: the allowlisted
    // legacy actions — they route through /api/share and queue when offline.
    if (ids === 'all') {
      void dispatch('notification.readAll', {}, 'Mark all notifications read')
    } else {
      void dispatch('notification.read', { id: ids[0] }, 'Mark notification read')
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) markSeen()
      }}
    >
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          aria-label={unread.length > 0 ? t('header.aria.notifications', { count: unread.length }) : t('header.aria.notificationsPlain')}
          className="relative min-h-11 gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white"
        >
          <Bell className="w-4 h-4" aria-hidden />
          <span className="hidden md:inline">{t('header.alerts')}</span>
          {unread.length > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 bg-amber-500 text-stone-950 text-[10px] font-bold rounded-full min-w-5 h-5 px-1 flex items-center justify-center"
              aria-label={t('header.aria.unreadCount', { count: unread.length })}
            >
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md w-full p-0 gap-0">
        <SheetHeader className="p-4 pb-3 border-b border-stone-100">
          <SheetTitle className="text-base text-stone-900">{t('header.notifications.title')}</SheetTitle>
          <SheetDescription className="text-xs text-stone-600">
            {unread.length > 0 ? t('header.notifications.unread', { count: unread.length }) : t('header.notifications.caughtUp')} · {data?.project.name ?? 'project'}
          </SheetDescription>
        </SheetHeader>

        <div
          className="px-3 py-2.5 border-b border-stone-100 flex flex-wrap gap-1.5"
          role="group"
          aria-label={t('header.aria.filterNotifications')}
        >
          {KIND_GROUPS.map((g) => {
            const count = g.key === 'all' ? notifications.length : notifications.filter((n) => groupOf(n.kind) === g.key).length
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => setFilter(g.key)}
                aria-pressed={filter === g.key}
                className={`min-h-8 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                  filter === g.key
                    ? 'bg-stone-900 text-stone-50'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {t(g.labelKey)}
                {count > 0 && <span className="ml-1 text-[10px] font-normal opacity-70">{count}</span>}
              </button>
            )
          })}
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center flex-1" role="status">
            <Bell className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">{t('header.notifications.emptyTitle')}</p>
            <p className="mt-1 text-xs text-stone-600">{t('header.notifications.emptySub')}</p>
          </div>
        ) : (
          <ul className={`flex-1 min-h-0 max-h-[64vh] overflow-y-auto ${SCROLLBAR}`} aria-label={t('header.aria.notificationsPlain')}>
            {filtered.map((n: Notification) => {
              const meta = kindMeta(n.kind)
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!n.read) void markRead([n.id])
                    }}
                    aria-label={n.read ? n.title : `${n.title} — mark as read`}
                    className={`w-full text-left flex items-start gap-2.5 px-4 py-3 border-b border-stone-100 last:border-b-0 min-h-11 transition-colors ${
                      n.read ? 'hover:bg-stone-50' : 'bg-amber-50/60 hover:bg-amber-50'
                    }`}
                  >
                    <span className="mt-0.5 relative shrink-0">
                      <meta.Icon className={`w-4 h-4 ${meta.tint}`} aria-hidden />
                      {!n.read && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500" aria-label="Unread" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-stone-600">{meta.label}</span>
                      <span className={`block text-sm leading-snug ${n.read ? 'text-stone-600' : 'font-medium text-stone-900'}`}>{n.title}</span>
                      <span className="block text-xs text-stone-500 mt-0.5 line-clamp-2" title={n.body}>{n.body}</span>
                      <span className="block text-[11px] text-stone-600 mt-0.5">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {unread.length > 0 && (
          <SheetFooter className="border-t border-stone-100 p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full min-h-11 gap-1.5 text-stone-600 hover:text-stone-900"
              disabled={busy}
              onClick={() => void markRead('all')}
            >
              <CheckCheck className="w-4 h-4" aria-hidden /> {t('header.notifications.markAllRead')}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function Header({
  tab,
  onTabChange,
  onCreateProject,
  onShare,
}: {
  tab: TabKey
  onTabChange: (t: TabKey) => void
  onCreateProject: () => void
  onShare: () => void
}) {
  const {
    data, projects, activeProjectId, switchProject, viewMode, shareToken, clientRole,
    online, setOnline, outbox, lastSyncAt,
  } = useMjengo()
  const { tabs: roleTabs, role: sessionRole } = usePermissions()
  const t = useT()
  const { listRef, onKeyDown } = useTablistKeyboard<HTMLElement>()
  const summary = data?.summary
  // Client surface: a real client on a share link (no login) OR a logged-in
  // client-role user — owner controls hidden, read-mostly header.
  // Share-link visitors have no session, so the client tab set is applied
  // explicitly (permissions would otherwise fail closed to Overview only).
  const isShareClient = viewMode === 'client' && (Boolean(shareToken) || clientRole)
  // W1-PERM: role-filtered tab strip (src/shared/permissions.ts mirrors guard.ts).
  // Client surface keeps its existing set (all tabs except AI Copilot).
  // Feature flags (spec §81, task 9-a): a flag OFF additionally hides its
  // gated tab (money / finder) for NON-ADMIN sessions — the same rule the
  // server routes enforce via requireFlagOn; flags ride on the payload's
  // intel slice (undefined while booting → unfiltered, the ai_progress
  // pattern). Share-link visitors have no session → non-admins → filtered.
  // FE-4 (issue #108): the strip follows the client set in ANY client view —
  // including the owner's "Preview as client" mode (no shareToken/clientRole
  // there, so the old isShareClient test kept the owner strip in preview).
  const clientStrip = viewMode === 'client'
  const tabs = metaForAll(
    tabsVisibleForFlags(
      clientStrip ? tabsForRole('client') : roleTabs,
      data?.intel?.flags,
      sessionRole,
    ),
  )
  return (
    <header className="bg-stone-950 text-stone-100 sticky top-0 z-40 shadow-lg">
      <div className="h-1 bg-amber-500" aria-hidden />
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="h-14 flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 bg-amber-500 rounded-lg flex items-center justify-center shrink-0" aria-hidden>
              <HardHat className="w-5 h-5 text-stone-950" />
            </div>
            <div className="min-w-0 hidden sm:block">
              <div className="font-bold tracking-tight leading-none">MjengoOS</div>
              <div className="text-[10px] text-stone-400 leading-tight">
                {isShareClient ? t('app.shareTagline') : t('app.tagline')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 min-w-0 flex-1 justify-center">
            {isShareClient ? (
              <div className="min-w-0 text-center">
                <p className="text-sm font-bold tracking-tight truncate" aria-label={t('header.aria.projectName')}>{data?.project.name}</p>
                <p className="text-[10px] text-stone-400 leading-tight truncate">
                  {data?.project.client} · {data?.project.location}
                </p>
              </div>
            ) : (
              <>
                <ProjectSwitcher
                  projects={projects}
                  activeId={activeProjectId ?? data?.project.id ?? null}
                  onSelect={(id) => void switchProject(id)}
                  onCreate={onCreateProject}
                />
                <span className="hidden lg:flex items-center gap-2 text-sm text-stone-400 whitespace-nowrap min-w-0" aria-label={t('header.aria.summary')}>
                  <span className="text-stone-600" aria-hidden>|</span>
                  {summary && t('header.summary', {
                    day: summary.dayCount,
                    pct: summary.progressPct,
                    spent: formatKES(summary.budgetSpent, true),
                    total: formatKES(summary.budgetTotal, true),
                  })}
                </span>
              </>
            )}

            {/* Global search — desktop inline here, mobile icon in this row too */}
            <GlobalSearch />

            {/* ⌘K command palette (W3-F3) — works on every surface */}
            <CommandPaletteButton />
          </div>

          {/* gap-1 below sm: keeps the 7 control pills inside a 390px viewport
              (was gap-2 → 12px page-level horizontal overflow at <sm). */}
          <div className="flex items-center gap-1 sm:gap-3">
            {/* Signed-in identity (hidden for share-link clients — no session) */}
            <UserChip />

            {/* Feature flags (admin only) */}
            {!isShareClient && <FlagsPopover />}

            {/* Low-data mode selector (spec §74) */}
            {!isShareClient && <DataModeSelector />}

            {/* Share with client (owner only) — FE-5: min-h-11 keeps the
                header's icon+label pill at a 44px target on mobile. */}
            {!isShareClient && viewMode === 'owner' && (
              <Button
                size="sm"
                variant="outline"
                onClick={onShare}
                aria-label={t('header.aria.share')}
                className="min-h-11 gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white"
              >
                <Share2 className="w-4 h-4" aria-hidden />
                <span className="hidden md:inline">{t('header.share')}</span>
              </Button>
            )}

            {/* Notification center — owner and client */}
            <NotificationBell />

            {/* #150 — "Waiting for network" reminders for online-only flows
                refused offline (money pay/payroll, AI review, copilot,
                trust digest). Renders NOTHING while the list is empty; on
                BOTH surfaces (owner + client) because the trust-digest
                generate guard is reachable from the client-visible intel
                tab. Retry-now navigates back to the flow — remind-only. */}
            <PendingNetworkPanel />

            {!isShareClient && (
              <>
                {/* Connectivity SIMULATION pill — a dev/QA affordance,
                    gated out of production builds (issue #136 / audit FE-7):
                    a production user flipping it would queue real outbox
                    items for no reason and blur "really offline" (the amber
                    banner + outbox panel keep surfacing real state) vs
                    "simulated offline". SHOW_CONNECTIVITY_SIM is a
                    module-scope build-time constant (Next inlines NODE_ENV),
                    so a production build folds it to false and
                    dead-code-eliminates the pill — the SHOW_DEMO_QUICKFILL
                    pattern from the login screen. The store's setOnline is
                    NOT gated: it stays the browser online/offline event path
                    (app.tsx) and the unit suites' offline-flow harness.
                    Hidden below sm: at 375px the 7-pill row measured 398px
                    and this demo affordance is the widest non-essential pill
                    (re-enable from a wider viewport). */}
                {SHOW_CONNECTIVITY_SIM && (
                  <div
                    className="hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-stone-900 border border-stone-800"
                    title={t('header.simNote')}
                  >
                    {online ? (
                      <Wifi className="w-4 h-4 text-emerald-400" aria-label={t('header.aria.online')} />
                    ) : (
                      <CloudOff className="w-4 h-4 text-amber-500" aria-label={t('header.aria.offline')} />
                    )}
                    <Switch
                      checked={online}
                      onCheckedChange={setOnline}
                      aria-label={t('header.aria.toggleConnectivity')}
                      className="scale-90 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-amber-600"
                    />
                    <span className="text-xs font-medium w-12 hidden sm:inline">{online ? t('header.online') : t('header.offlineSim')}</span>
                  </div>
                )}

                {/* Sync control + per-item outbox sheet (issue "Outbox
                    conflict metadata + entity versions"): the historical flush
                    button, now opening the queue with conflict resolution. */}
                <SyncOutboxPanel />
                {lastSyncAt && online && outbox.length === 0 && (
                  <span className="hidden md:flex items-center gap-1 text-[11px] text-stone-500">
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-500" aria-hidden /> {t('header.synced')}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Tab navigation — desktop top strip (W1-PERM: role-filtered via
            permissions.ts; on mobile the bottom bar in mobile/nav/mobile-bottom-nav.tsx
            takes over for the owner app — the client surface keeps this strip).
            role="tablist" pairs with the role="tab" buttons below (W3-F2 a11y —
            the mobile strip already had it on its <ul>), and FE-7 (issue #80)
            completes the pattern: each tab carries id + aria-controls pointing
            at the app shell's role="tabpanel" (app.tsx `mjengo-panel-<key>`),
            the active one is referenced back via the panel's aria-labelledby.
            FE-5: min-h-11 — the client surface's mobile tab strip gets 44px
            targets (bottom-nav parity; it stays flex-scrollable at 375px). */}
        <nav
          ref={listRef}
          onKeyDown={onKeyDown}
          aria-label={t('nav.aria.main')}
          role="tablist"
          className={`${isShareClient ? 'flex' : 'hidden md:flex'} items-center gap-1 overflow-x-auto -mx-1 px-1 pb-2`}
        >
          {tabs.map(({ key, label, icon: Icon }) => {
            const active = tab === key
            return (
              <button
                key={key}
                role="tab"
                id={`mjengo-tab-${key}`}
                aria-controls={`mjengo-panel-${key}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onTabChange(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 min-h-11 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-amber-500 text-stone-950'
                    : 'text-stone-400 hover:text-stone-100 hover:bg-stone-800'
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden />
                {t(label)}
              </button>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
