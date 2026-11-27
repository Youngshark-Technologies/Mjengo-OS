'use client'

// MJG-035/MJG-036 — Partner portal. Sessions belonging to SUPPLIER or
// LOGISTICS organizations land here instead of the constructor operating
// system:
//   - SUPPLIER orgs: an inbox of purchase orders addressed to them (only POs a
//     constructor actually sent — DRAFTs never leave their org) with an
//     acknowledge action and a simple shipment log on SENT orders.
//   - LOGISTICS orgs: delivery tasks constructors assigned to them as carrier,
//     each acknowledging its receipt in transit.
// The portal stays out of constructor workflows: delivery verification / stock
// and payment approval remain human-gated on the constructor side.

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Building2,
  CalendarDays,
  CheckCircle2,
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
import type {
  PartnerDeliveryTaskDTO,
  PartnerPurchaseOrderDTO,
  SessionUser,
  ShipmentDTO,
} from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

const DELIVERY_STATUS_CLASS: Record<PartnerDeliveryTaskDTO['status'], string> = {
  PENDING: 'border-transparent bg-amber-500 text-stone-950',
  VERIFIED: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  REJECTED: 'border-red-300 bg-red-50 text-red-700',
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

function PartnerErrorPanel({
  message,
  onRetry,
  label,
}: {
  message: string
  onRetry: () => void
  label: string
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center" role="alert">
      <p className="text-sm font-medium text-red-700">Could not load {label}.</p>
      <p className="mt-1 text-xs text-red-600">{message}</p>
      <Button variant="outline" className="mt-4 h-11 border-red-300 text-red-700" onClick={onRetry}>
        <RefreshCw className="size-4" aria-hidden /> Retry
      </Button>
    </div>
  )
}

// ─── SUPPLIER — purchase orders ───────────────────────────────────────────────

function SentPoActions({ po }: { po: PartnerPurchaseOrderDTO }) {
  const qc = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [carrierName, setCarrierName] = useState('')
  const [trackingNo, setTrackingNo] = useState('')
  const [estimatedArrival, setEstimatedArrival] = useState('')
  const [notes, setNotes] = useState('')

  const acknowledge = useMutation({
    mutationFn: () =>
      api.post<{ id: string; acknowledgedAt: string }>(
        `/api/partner/purchase-orders/${po.id}/acknowledge`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-purchase-orders'] }),
    // A 409 means the order was acknowledged from another session — refetch
    // reconciles the card instead of leaving a stale button.
    onError: () => qc.invalidateQueries({ queryKey: ['partner-purchase-orders'] }),
  })

  const logShipment = useMutation({
    mutationFn: (body: {
      carrierName: string
      trackingNo: string | null
      estimatedArrival: string | null
      notes: string | null
    }) => api.post<ShipmentDTO>(`/api/partner/purchase-orders/${po.id}/shipments`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partner-purchase-orders'] })
      setFormOpen(false)
      setCarrierName('')
      setTrackingNo('')
      setEstimatedArrival('')
      setNotes('')
    },
  })

  const submitShipment = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (carrierName.trim() === '') return
    logShipment.mutate({
      carrierName: carrierName.trim(),
      trackingNo: trackingNo.trim() === '' ? null : trackingNo.trim(),
      estimatedArrival: estimatedArrival === '' ? null : estimatedArrival,
      notes: notes.trim() === '' ? null : notes.trim(),
    })
  }

  return (
    <div className="mt-3 border-t border-stone-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {po.acknowledgedAt ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="size-4" aria-hidden />
            Acknowledged {formatDate(po.acknowledgedAt)}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-9 border-stone-300 text-stone-700"
            onClick={() => acknowledge.mutate()}
            disabled={acknowledge.isPending}
          >
            <CheckCircle2 className="size-4" aria-hidden />
            {acknowledge.isPending ? 'Acknowledging…' : 'Acknowledge order'}
          </Button>
        )}
        {acknowledge.isError && !po.acknowledgedAt ? (
          <span className="text-xs text-red-600">{acknowledge.error.message}</span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-9 border-stone-300 text-stone-700"
          onClick={() => setFormOpen((open) => !open)}
          aria-expanded={formOpen}
        >
          <Truck className="size-4" aria-hidden /> {formOpen ? 'Hide shipment form' : 'Log shipment'}
        </Button>
      </div>

      {formOpen ? (
        <form onSubmit={submitShipment} className="mt-3 space-y-3 rounded-lg bg-stone-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`shipment-carrier-${po.id}`}>Carrier *</Label>
              <Input
                id={`shipment-carrier-${po.id}`}
                value={carrierName}
                onChange={(e) => setCarrierName(e.target.value)}
                placeholder="e.g. Suite Haulage Ltd"
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`shipment-tracking-${po.id}`}>Tracking no.</Label>
              <Input
                id={`shipment-tracking-${po.id}`}
                value={trackingNo}
                onChange={(e) => setTrackingNo(e.target.value)}
                placeholder="optional"
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`shipment-eta-${po.id}`}>Estimated arrival</Label>
              <Input
                id={`shipment-eta-${po.id}`}
                type="date"
                value={estimatedArrival}
                onChange={(e) => setEstimatedArrival(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`shipment-notes-${po.id}`}>Notes</Label>
              <Input
                id={`shipment-notes-${po.id}`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="optional"
                className="h-11"
              />
            </div>
          </div>
          {logShipment.isError ? (
            <p className="text-xs text-red-600" role="alert">
              {logShipment.error.message}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              className="h-9 bg-stone-900 text-white hover:bg-stone-800"
              disabled={logShipment.isPending || carrierName.trim() === ''}
            >
              {logShipment.isPending ? 'Logging…' : 'Log shipment'}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
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

      {/* MJG-036 — partner actions live on SENT orders; the acknowledgment
          stamp itself shows on any order once recorded. */}
      {po.status === 'SENT' || po.acknowledgedAt ? <SentPoActions po={po} /> : null}
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
      <PartnerErrorPanel
        label="your purchase orders"
        message={pos.error.message}
        onRetry={() => pos.refetch()}
      />
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

// ─── LOGISTICS — delivery tasks ───────────────────────────────────────────────

function DeliveryTaskCard({ task }: { task: PartnerDeliveryTaskDTO }) {
  const qc = useQueryClient()

  const acknowledge = useMutation({
    mutationFn: () => api.post<PartnerDeliveryTaskDTO>(`/api/deliveries/${task.id}/acknowledge`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-delivery-tasks'] }),
    // A 409 means the task was acknowledged from another session — refetch
    // reconciles the card instead of leaving a stale button.
    onError: () => qc.invalidateQueries({ queryKey: ['partner-delivery-tasks'] }),
  })

  return (
    <li className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            <Building2 className="size-4 shrink-0 text-stone-400" aria-hidden />
            {task.constructorName}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-stone-500">
            <MapPin className="size-3" aria-hidden /> {task.siteName}
            {task.purchaseOrderId ? (
              <> · PO #{task.purchaseOrderId.slice(0, 8)}</>
            ) : null}
          </p>
        </div>
        <Badge className={cn('shrink-0', DELIVERY_STATUS_CLASS[task.status])}>
          {humanize(task.status)}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
        <span className="flex items-center gap-1.5">
          <CalendarDays className="size-3" aria-hidden />
          Delivered {formatDate(task.deliveredAt)}
        </span>
        {task.acknowledgedAt ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="size-4" aria-hidden />
            Acknowledged {formatDate(task.acknowledgedAt)}
          </span>
        ) : null}
      </div>
      {task.notes ? <p className="mt-2 text-xs text-stone-500">Note: {task.notes}</p> : null}

      {!task.acknowledgedAt ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
          <Button
            size="sm"
            className="h-9 bg-stone-900 text-white hover:bg-stone-800"
            onClick={() => acknowledge.mutate()}
            disabled={acknowledge.isPending}
          >
            <CheckCircle2 className="size-4" aria-hidden />
            {acknowledge.isPending ? 'Acknowledging…' : 'Acknowledge pickup'}
          </Button>
          {acknowledge.isError ? (
            <span className="text-xs text-red-600" role="alert">
              {acknowledge.error.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function LogisticsDeliveryTasks() {
  const tasks = useQuery({
    queryKey: ['partner-delivery-tasks'],
    queryFn: () => api.get<PartnerDeliveryTaskDTO[]>('/api/partner/delivery-tasks'),
  })

  if (tasks.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading delivery tasks">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (tasks.isError) {
    return (
      <PartnerErrorPanel
        label="your delivery tasks"
        message={tasks.error.message}
        onRetry={() => tasks.refetch()}
      />
    )
  }

  const list = tasks.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-stone-900">Delivery tasks</h2>
          <p className="text-sm text-stone-500">
            Deliveries constructors assigned to your organization as carrier. Acknowledging a task
            confirms your pickup — the constructor still verifies the delivery on site.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 border-stone-300 bg-stone-100 text-stone-700">
          {list.length} {list.length === 1 ? 'task' : 'tasks'}
        </Badge>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-8 text-center">
          <Truck className="mx-auto size-8 text-stone-300" aria-hidden />
          <p className="mt-3 text-sm font-medium text-stone-900">No delivery tasks yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-stone-500">
            When a constructor assigns one of its deliveries to your organization as the carrier, it
            appears here for acknowledgment.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((task) => (
            <DeliveryTaskCard key={task.id} task={task} />
          ))}
        </ul>
      )}
      {tasks.isFetching ? (
        <p className="text-center text-xs text-stone-400">Refreshing…</p>
      ) : null}
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
          {user.organizationType === 'SUPPLIER' ? <SupplierInbox /> : <LogisticsDeliveryTasks />}
        </div>
      </main>
    </div>
  )
}
