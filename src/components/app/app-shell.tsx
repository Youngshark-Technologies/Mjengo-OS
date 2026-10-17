'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  Boxes,
  Building2,
  ClipboardCheck,
  HardHat,
  LayoutDashboard,
  LogOut,
  Menu,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { useAppStore, type ViewKey } from '@/lib/store'
import type { SessionUser } from '@/lib/types'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { DashboardView } from '@/components/views/dashboard-view'
import { SitesView } from '@/components/views/sites-view'
import { InventoryView } from '@/components/views/inventory-view'
// Views owned by MJG-009 — imported by the exact names/paths agreed in the registry.
import { ProcurementView } from '@/components/views/procurement-view'
import { DeliveriesView } from '@/components/views/deliveries-view'
import { WorkforceView } from '@/components/views/workforce-view'
import { EvidenceView } from '@/components/views/evidence-view'
import { PaymentsView } from '@/components/views/payments-view'

interface NavItem {
  key: ViewKey
  label: string
  short?: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'sites', label: 'Sites', icon: Building2 },
  { key: 'inventory', label: 'Inventory', icon: Boxes },
  { key: 'procurement', label: 'Procurement', icon: ShoppingCart },
  { key: 'deliveries', label: 'Deliveries', icon: Truck },
  { key: 'workforce', label: 'Workforce', icon: Users },
  { key: 'evidence', label: 'Site evidence', short: 'Evidence', icon: ClipboardCheck },
  { key: 'payments', label: 'Payments', icon: Wallet },
]

// Primary tabs shown in the mobile bottom bar; the rest live in the "More" drawer.
const MOBILE_PRIMARY: ViewKey[] = ['dashboard', 'sites', 'inventory', 'deliveries', 'evidence']

function NavLink({
  item,
  active,
  onSelect,
}: {
  item: NavItem
  active: boolean
  onSelect: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-11 w-full items-center gap-3 rounded-r-md border-l-2 px-3 text-sm font-medium transition-colors',
        active
          ? 'border-amber-500 bg-amber-500/10 text-amber-500'
          : 'border-transparent text-stone-300 hover:bg-white/5 hover:text-white'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  )
}

function BrandMark() {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-amber-500">
      <HardHat className="size-4 text-stone-950" />
    </div>
  )
}

export function AppShell({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const { toast } = useToast()
  const [menuOpen, setMenuOpen] = useState(false)

  const logout = useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSuccess: () => onLogout(),
    onError: (e: Error) =>
      toast({ title: 'Could not log out', description: e.message, variant: 'destructive' }),
  })

  const go = (key: ViewKey) => {
    setView(key)
    setMenuOpen(false)
  }

  const current = NAV_ITEMS.find((n) => n.key === view) ?? NAV_ITEMS[0]

  // Each view receives exactly the props it declares; gated views (human
  // verification/approval) receive the session user for role-aware UI.
  const renderView = () => {
    switch (view) {
      case 'dashboard':
        return <DashboardView />
      case 'sites':
        return <SitesView />
      case 'inventory':
        return <InventoryView />
      case 'procurement':
        return <ProcurementView />
      case 'deliveries':
        return <DeliveriesView user={user} />
      case 'workforce':
        return <WorkforceView />
      case 'evidence':
        return <EvidenceView user={user} />
      case 'payments':
        return <PaymentsView user={user} />
      default:
        return null
    }
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 antialiased">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col bg-stone-950 text-stone-100 md:flex">
        <div className="flex items-center gap-3 px-5 py-5">
          <BrandMark />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight text-white">MjengoOS</p>
            <p className="truncate text-xs text-stone-400">Construction OS</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.key}
              item={item}
              active={view === item.key}
              onSelect={() => go(item.key)}
            />
          ))}
        </nav>
        <div className="border-t border-white/10 p-4">
          <p className="truncate text-xs font-medium uppercase tracking-wider text-stone-500">
            {user.organizationName}
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium text-white">{user.name}</p>
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-500"
            >
              {user.role}
            </Badge>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 bg-stone-950 px-3 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 text-stone-200 hover:bg-white/10 hover:text-white"
              aria-label="All views"
            >
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-72 gap-0 border-stone-800 bg-stone-950 p-0 text-stone-100"
          >
            <SheetHeader className="p-5 pb-4 text-left">
              <SheetTitle className="flex items-center gap-2 text-white">
                <BrandMark />
                MjengoOS
              </SheetTitle>
              <SheetDescription className="text-stone-400">{user.organizationName}</SheetDescription>
            </SheetHeader>
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="All views">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.key}
                  item={item}
                  active={view === item.key}
                  onSelect={() => go(item.key)}
                />
              ))}
            </nav>
            <div className="border-t border-white/10 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-white">{user.name}</p>
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-500"
                >
                  {user.role}
                </Badge>
              </div>
              <div className="mt-2">
                <Button
                  variant="ghost"
                  className="h-11 w-full justify-start gap-3 px-3 text-stone-300 hover:bg-white/10 hover:text-white"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                >
                  <LogOut className="size-4" />
                  Log out
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="text-sm font-semibold text-white">MjengoOS</span>
        </div>
      </header>

      {/* Content */}
      <div className="md:pl-60">
        <main className="mx-auto w-full max-w-7xl p-4 pb-24 md:p-8">
          <div className="flex items-center justify-between gap-3 pb-4 md:pb-6">
            <h1 className="truncate text-xl font-semibold tracking-tight text-stone-900 md:text-2xl">
              {current.label}
            </h1>
            <div className="flex shrink-0 items-center gap-2 md:gap-3">
              <span className="hidden text-xs text-stone-500 sm:block">
                {user.organizationName}
              </span>
              <span className="hidden text-sm font-medium text-stone-700 lg:block">{user.name}</span>
              <Badge
                variant="outline"
                className="hidden border-stone-300 bg-stone-100 text-stone-700 md:inline-flex"
              >
                {user.role}
              </Badge>
              <Button
                variant="outline"
                size="icon"
                className="size-11"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
                aria-label="Log out"
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>
          {renderView()}
        </main>
      </div>

      {/* Mobile bottom tab nav */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 backdrop-blur md:hidden"
        aria-label="Primary"
      >
        <div className="grid grid-cols-5">
          {MOBILE_PRIMARY.map((key) => {
            const item = NAV_ITEMS.find((n) => n.key === key)
            if (!item) return null
            const Icon = item.icon
            const active = view === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors',
                  active
                    ? 'text-amber-600 shadow-[inset_0_2px_0_0_#f59e0b]'
                    : 'text-stone-500 hover:text-stone-900'
                )}
              >
                <Icon className="size-5" />
                <span className="max-w-full truncate px-0.5">{item.short ?? item.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
