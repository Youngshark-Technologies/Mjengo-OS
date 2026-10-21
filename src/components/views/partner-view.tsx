'use client'

// MJG-035 — Partner portal. Sessions belonging to SUPPLIER or LOGISTICS
// organizations land here instead of the constructor operating system:
//   - SUPPLIER orgs: a read-only inbox of purchase orders addressed to them
//     (only POs a constructor actually sent — DRAFTs never leave their org).
//   - LOGISTICS orgs: registration confirmation + an honest roadmap note
//     (delivery-task assignment ships in a later release — MJG-036).
// The portal is intentionally read-only: constructor workflows (delivery
// verification, payment approval) remain human-gated on the constructor side.

import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  CalendarDays,
  ClipboardCheck,
  Boxes,
  HardHat,
  LogOut,
  MapPin,
  Package,
  RefreshCw,
  Truck,
  Wallet,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { formatMoney } from '@/lib/types'
import type { PartnerPurchaseOrderDTO, SessionUser } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const PROOF_POINTS = [
  { icon: ClipboardCheck, label: 'Human-verified site evidence' },
  { icon: Boxes, label: 'Live materials & stock' },
  { icon: Wallet, label: 'Owner-approved payments' },
]

const PO_STATUS_CLASS: Record<PartnerPurchaseOrderDTO['status'], string> = {
  DRAFT: 'border-stone-300 bg-stone-100 text-stone-700',
  SENT: 'border-transparent bg-amber-500 text-stone-950',
  RECEIVED: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  CANCELLED: 'border-red-300 bg-red-50 text-red-700',
}

function humanize(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function PartnerBrandPanel({ user }: { user: SessionUser }) {
  const TypeIcon = user.organizationType === 'LOGISTICS' ? Truck : Package
  return (
    <aside className="relative hidden w-1/3 flex-col justify-between overflow-hidden bg-stone-950 p-10 lg:flex">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245, 158, 11, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(245, 158, 11, 0.05) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 22% 18%, rgba(245, 158, 11, 0.15), transparent 70%)',
        }}
      />
      <div className="relative z-10 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-amber-500">
          <HardHat className="size-5 text-stone-950" aria-hidden />
        </div>
        <span className="text-2xl font-semibold tracking-tight text-white">
          Mjengo<span className="text-amber-500">OS</span>
        </span>
      </div>
      <div className="relative z-10 space-y-6">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-lg border border-stone-800 bg-stone-900">
            <TypeIcon className="size-5 text-amber-500" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-white">{user.organizationName}</p>
            <p className="text-xs uppercase tracking-wider text-stone-400">
              {humanize(user.organizationType)} partner
            </p>
          </div>
        </div>
        <p className="max-w-sm text-xl leading-snug font-medium text-white">
          Your window into every constructor you supply.
        </p>
        <ul className="flex flex-col gap-4">
          {PROOF_POINTS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-800 bg-stone-900">
                <Icon className="size-4 text-amber-500" aria-hidden />
              </span>
              <span className="text-sm text-stone-200">{label}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative z-10 text-xs text-stone-500">
        Signed in as {user.name} · {user.role}
      </p>
    </aside>
  )
}

function PurchaseOrderCard({ po }: { po: PartnerPurchaseOrderDTO }) {
  return (
    <li className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            <Building2 className="size-4 shrink-0 text-stone-400" aria-hidden />
            {po.organizationName}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-stone-500">
            <MapPin className="size-3" aria-hidden /> {po.siteName}
          </p>
        </div>
        <Badge className={cn('shrink-0', PO_STATUS_CLASS[po.status])}>{humanize(po.status)}</Badge>
      </div>

      <ul className="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-100">
        {po.items.map((item) => (
          <li key={item.materialId} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate text-sm text-stone-700">{item.materialName}</span>
            <span className="shrink-0 text-sm text-stone-600">
              {item.quantity} {item.unit} × {formatMoney(item.unitCost)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
        <span className="flex items-center gap-1.5">
          <CalendarDays className="size-3" aria-hidden />
          Ordered {formatDate(po.orderDate)}
          {po.expectedDate ? ` · Expected ${formatDate(po.expectedDate)}` : ''}
        </span>
        <span className="text-sm font-semibold text-stone-900">{formatMoney(po.total)}</span>
      </div>
      {po.notes ? <p className="mt-2 text-xs text-stone-500">Note: {po.notes}</p> : null}
    </li>
  )
}

function SupplierInbox() {
  const pos = useQuery({
    queryKey: ['partner-purchase-orders'],
    queryFn: () => api.get<PartnerPurchaseOrderDTO[]>('/api/partner/purchase-orders'),
  })

  if (pos.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading purchase orders">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (pos.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center" role="alert">
        <p className="text-sm font-medium text-red-700">Could not load your purchase orders.</p>
        <p className="mt-1 text-xs text-red-600">{pos.error.message}</p>
        <Button
          variant="outline"
          className="mt-4 h-11 border-red-300 text-red-700"
          onClick={() => pos.refetch()}
        >
          <RefreshCw className="size-4" aria-hidden /> Retry
        </Button>
      </div>
    )
  }

  const list = pos.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-stone-900">Purchase orders</h2>
          <p className="text-sm text-stone-500">
            Orders constructors addressed to your organization. Drafts stay private to the
            constructor until they are sent.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 border-stone-300 bg-stone-100 text-stone-700">
          {list.length} {list.length === 1 ? 'order' : 'orders'}
        </Badge>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-8 text-center">
          <Package className="mx-auto size-8 text-stone-300" aria-hidden />
          <p className="mt-3 text-sm font-medium text-stone-900">No purchase orders yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-stone-500">
            Once a constructor links your organization to one of their supplier records and sends a
            purchase order, it appears here automatically.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((po) => (
            <PurchaseOrderCard key={po.id} po={po} />
          ))}
        </ul>
      )}
      {pos.isFetching ? (
        <p className="text-center text-xs text-stone-400">Refreshing…</p>
      ) : null}
    </div>
  )
}

function LogisticsNotice({ user }: { user: SessionUser }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-stone-900">Delivery tasks</h2>
        <p className="text-sm text-stone-500">
          Transport assignments from constructors you partner with.
        </p>
      </div>
      <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-8 text-center">
        <Truck className="mx-auto size-8 text-stone-300" aria-hidden />
        <p className="mt-3 text-sm font-medium text-stone-900">
          Delivery-task assignment arrives in a later release
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-stone-500">
          Your organization {user.organizationName ? `(${user.organizationName}) ` : ''}is fully
          registered as a logistics partner. Constructors will be able to assign and track delivery
          tasks with you from an upcoming release.
        </p>
      </div>
    </div>
  )
}

export function PartnerView({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      // clearing local state matters more than the network result
    }
    onLogout()
  }

  return (
    <div className="flex min-h-screen bg-stone-50 text-stone-900 antialiased">
      <PartnerBrandPanel user={user} />

      <main className="flex flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-stone-200 bg-white/95 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-2.5 md:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500">
              <HardHat className="size-4 text-stone-950" aria-hidden />
            </div>
            <span className="text-base font-semibold tracking-tight text-stone-900">
              Mjengo<span className="text-amber-600">OS</span>
            </span>
          </div>
          <div className="hidden min-w-0 md:block">
            <p className="truncate text-sm font-semibold text-stone-900">
              {user.organizationName}
            </p>
            <p className="text-xs text-stone-500">Partner portal</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-sm text-stone-600 sm:block">{user.name}</span>
            <Badge
              variant="outline"
              className="hidden border-amber-500/40 bg-amber-500/10 text-amber-600 sm:inline-flex"
            >
              {user.role}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="h-11 gap-2 border-stone-300 text-stone-700"
              onClick={() => logout()}
              aria-label="Log out"
            >
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Log out</span>
            </Button>
          </div>
        </header>

        <div className="mx-auto w-full max-w-4xl flex-1 p-4 pb-16 sm:p-6 lg:p-8">
          {user.organizationType === 'SUPPLIER' ? <SupplierInbox /> : <LogisticsNotice user={user} />}
        </div>
      </main>
    </div>
  )
}
