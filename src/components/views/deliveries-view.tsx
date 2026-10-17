'use client'

// MJG-009a — Deliveries view: record deliveries against sites and verify them into stock.

import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Plus,
  ShieldCheck,
  Trash2,
  Truck,
  XCircle,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import {
  DELIVERY_STATUS_VALUES,
  formatMoney,
  type DeliveryDTO,
  type DeliveryStatus,
  type MaterialDTO,
  type PurchaseOrderDTO,
  type SessionUser,
  type SiteDTO,
  type SupplierDTO,
} from '@/lib/types'
import { useToast } from '@/hooks/use-toast'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

const CONTROL = 'h-11'

const DELIVERY_BADGE_CLASS: Record<DeliveryStatus, string> = {
  PENDING: 'border-amber-300 bg-amber-50 text-amber-800',
  VERIFIED: 'border-emerald-200 bg-emerald-100 text-emerald-800',
  REJECTED: 'border-red-200 bg-red-100 text-red-700',
}

function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  return (
    <Badge variant="outline" className={DELIVERY_BADGE_CLASS[status]}>
      {status}
    </Badge>
  )
}

interface DeliveryItemDraft {
  materialId: string
  quantityDelivered: string
}

const EMPTY_DELIVERY_ITEM: DeliveryItemDraft = { materialId: '', quantityDelivered: '' }

export function DeliveriesView({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient()
  const canVerify = user.role !== 'WORKER'

  const [siteFilter, setSiteFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [recordOpen, setRecordOpen] = useState(false)
  const [reviewing, setReviewing] = useState<DeliveryDTO | null>(null)

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<SiteDTO[]>('/api/sites') })

  const deliveries = useQuery({
    queryKey: ['deliveries', siteFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (siteFilter !== 'ALL') params.set('siteId', siteFilter)
      if (statusFilter !== 'ALL') params.set('status', statusFilter)
      const qs = params.toString()
      return api.get<DeliveryDTO[]>(`/api/deliveries${qs ? `?${qs}` : ''}`)
    },
    placeholderData: keepPreviousData,
  })

  const deliveryList = deliveries.data ?? []
  const pendingCount = deliveryList.filter((d) => d.status === 'PENDING').length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select value={siteFilter} onValueChange={setSiteFilter}>
          <SelectTrigger aria-label="Filter by site" className={cn('w-full bg-white sm:w-52', CONTROL)}>
            <SelectValue placeholder="All sites" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All sites</SelectItem>
            {(sites.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger aria-label="Filter by status" className={cn('w-full bg-white sm:w-44', CONTROL)}>
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {DELIVERY_STATUS_VALUES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="sm:ml-auto">
          <Button
            className={cn('w-full bg-amber-500 text-white hover:bg-amber-600 sm:w-auto', CONTROL)}
            onClick={() => setRecordOpen(true)}
          >
            <Plus />
            Record delivery
          </Button>
        </div>
      </div>

      {deliveries.isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : deliveries.isError ? (
        <Card className="flex flex-col items-start gap-3 border-red-200 bg-red-50 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-red-800">Could not load deliveries</p>
            <p className="mt-1 text-sm text-red-700">{deliveries.error.message}</p>
          </div>
          <Button
            variant="outline"
            onClick={() => deliveries.refetch()}
            className={cn('border-red-300 text-red-700 hover:bg-red-100', CONTROL)}
          >
            Retry
          </Button>
        </Card>
      ) : deliveryList.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed border-stone-300 bg-white p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-stone-100">
            <Truck className="size-6 text-stone-400" />
          </div>
          <div>
            <p className="font-medium text-stone-900">No deliveries recorded</p>
            <p className="mt-1 text-sm text-stone-500">
              Record a delivery when materials arrive on site — then verify it to add accepted
              quantities to stock.
            </p>
          </div>
          <Button
            className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
            onClick={() => setRecordOpen(true)}
          >
            <Plus />
            Record delivery
          </Button>
        </Card>
      ) : (
        <>
          <p className="text-sm text-stone-500">
            {deliveryList.length} delivery{deliveryList.length === 1 ? '' : 's'}
            {pendingCount > 0 && (
              <span className="text-amber-800">
                {' '}
                · {pendingCount} awaiting verification
              </span>
            )}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {deliveryList.map((d) => (
              <Card key={d.id} className="border-stone-200 bg-white p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="inline-flex items-center gap-2 font-semibold text-stone-900">
                      <Building2 className="size-4 text-stone-400" />
                      {d.siteName}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      Delivered {format(new Date(d.deliveredAt), 'd MMM yyyy, HH:mm')}
                    </p>
                  </div>
                  <DeliveryBadge status={d.status} />
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-600">
                  <span className="inline-flex items-center gap-1.5">
                    <Truck className="size-4 text-stone-400" />
                    {d.supplierName ?? 'No supplier recorded'}
                  </span>
                  {d.purchaseOrderId && (
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-stone-500">
                      PO #{d.purchaseOrderId.slice(0, 8)}
                    </span>
                  )}
                </div>

                <Separator className="my-3" />

                <ul className="space-y-1.5">
                  {d.items.map((it) => (
                    <li
                      key={it.materialId}
                      className="flex items-baseline justify-between gap-3 text-sm"
                    >
                      <span className="text-stone-700">{it.materialName}</span>
                      <span className="shrink-0 font-medium text-stone-900">
                        {it.quantityDelivered} {it.unit}
                        {d.status !== 'PENDING' && it.quantityAccepted !== it.quantityDelivered && (
                          <span className="ml-1 font-normal text-stone-500">
                            (accepted {it.quantityAccepted} {it.unit})
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>

                {d.notes && (
                  <p className="mt-3 rounded-md bg-stone-50 p-3 text-sm text-stone-600">{d.notes}</p>
                )}

                <Separator className="my-3" />

                {d.status === 'PENDING' ? (
                  canVerify ? (
                    <Button
                      variant="outline"
                      className={cn('w-full border-amber-300 text-amber-800 hover:bg-amber-50 sm:w-auto', CONTROL)}
                      onClick={() => setReviewing(d)}
                    >
                      <ClipboardCheck />
                      Review delivery
                    </Button>
                  ) : (
                    <p className="inline-flex items-center gap-1.5 text-xs text-stone-500">
                      <Clock className="size-3.5 text-stone-400" />
                      Awaiting verification by a supervisor or owner.
                    </p>
                  )
                ) : d.status === 'VERIFIED' ? (
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                    <ShieldCheck className="size-4" />
                    Verified by {d.verifiedByName ?? 'unknown'}
                    {d.verifiedAt ? ` · ${format(new Date(d.verifiedAt), 'd MMM yyyy, HH:mm')}` : ''}
                  </p>
                ) : (
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600">
                    <XCircle className="size-4" />
                    Rejected by {d.verifiedByName ?? 'unknown'}
                    {d.verifiedAt ? ` · ${format(new Date(d.verifiedAt), 'd MMM yyyy, HH:mm')}` : ''}
                  </p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {recordOpen && (
        <RecordDeliveryDialog
          sites={sites.data ?? []}
          onOpenChange={(open) => {
            if (!open) setRecordOpen(false)
          }}
        />
      )}

      {reviewing && canVerify && (
        <ReviewDeliveryDialog
          key={reviewing.id}
          delivery={reviewing}
          onOpenChange={(open) => {
            if (!open) setReviewing(null)
          }}
        />
      )}
    </div>
  )
}

function RecordDeliveryDialog({
  sites,
  onOpenChange,
}: {
  sites: SiteDTO[]
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [form, setForm] = useState({ siteId: '', purchaseOrderId: '', supplierId: '', notes: '' })
  const [items, setItems] = useState<DeliveryItemDraft[]>([{ ...EMPTY_DELIVERY_ITEM }])

  const materials = useQuery({
    queryKey: ['materials'],
    queryFn: () => api.get<MaterialDTO[]>('/api/materials'),
  })
  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SupplierDTO[]>('/api/suppliers'),
  })
  const siteOrders = useQuery({
    queryKey: ['purchase-orders', form.siteId || 'NONE', ''],
    queryFn: () => api.get<PurchaseOrderDTO[]>(`/api/purchase-orders?siteId=${form.siteId}`),
    enabled: form.siteId !== '',
  })

  const recordDelivery = useMutation({
    mutationFn: (payload: {
      siteId: string
      purchaseOrderId?: string
      supplierId?: string
      notes?: string
      items: { materialId: string; quantityDelivered: number }[]
    }) => api.post<DeliveryDTO>('/api/deliveries', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Delivery recorded', description: 'It is pending verification before entering stock.' })
      onOpenChange(false)
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not record delivery', description: e.message }),
  })

  function updateItem(index: number, patch: Partial<DeliveryItemDraft>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  function submitDelivery() {
    if (!form.siteId) {
      toast({
        variant: 'destructive',
        title: 'Missing site',
        description: 'Choose the site that received these materials.',
      })
      return
    }
    const cleaned = items
      .map((it) => ({ materialId: it.materialId, quantityDelivered: Number(it.quantityDelivered) }))
      .filter((it) => it.materialId !== '' && Number.isFinite(it.quantityDelivered) && it.quantityDelivered > 0)
    if (cleaned.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Add items',
        description: 'Every item needs a material and a delivered quantity above zero.',
      })
      return
    }
    recordDelivery.mutate({
      siteId: form.siteId,
      purchaseOrderId: form.purchaseOrderId || undefined,
      supplierId: form.supplierId || undefined,
      notes: form.notes.trim() || undefined,
      items: cleaned,
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Record delivery</DialogTitle>
          <DialogDescription>
            Log materials that arrived on site. Quantities enter stock once the delivery is verified.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="delivery-site">Site *</Label>
              <Select
                value={form.siteId}
                onValueChange={(siteId) =>
                  setForm((f) => ({ ...f, siteId, purchaseOrderId: '' }))
                }
              >
                <SelectTrigger id="delivery-site" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder="Select site" />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delivery-po">Purchase order (optional)</Label>
              <Select
                value={form.purchaseOrderId}
                onValueChange={(purchaseOrderId) => setForm((f) => ({ ...f, purchaseOrderId }))}
                disabled={form.siteId === ''}
              >
                <SelectTrigger id="delivery-po" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder={form.siteId === '' ? 'Select site first' : 'No purchase order'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No purchase order</SelectItem>
                  {(siteOrders.data ?? [])
                    .filter((po) => po.status !== 'CANCELLED')
                    .map((po) => (
                      <SelectItem key={po.id} value={po.id}>
                        #{po.id.slice(0, 8)} · {po.supplierName} ({po.status})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delivery-supplier">Supplier (optional)</Label>
              <Select
                value={form.supplierId}
                onValueChange={(supplierId) => setForm((f) => ({ ...f, supplierId }))}
              >
                <SelectTrigger id="delivery-supplier" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder="No supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No supplier</SelectItem>
                  {(suppliers.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delivery-notes">Notes</Label>
              <Textarea
                id="delivery-notes"
                rows={1}
                placeholder="Condition, discrepancies…"
                className="min-h-11"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Delivered items</Label>
            {items.map((it, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-stone-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-stone-400">
                    Item {i + 1}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove item ${i + 1}`}
                    disabled={items.length === 1}
                    className="size-11 text-stone-400 hover:text-red-600"
                    onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Select
                  value={it.materialId}
                  onValueChange={(materialId) => updateItem(i, { materialId })}
                >
                  <SelectTrigger aria-label={`Material for item ${i + 1}`} className={cn('w-full bg-white', CONTROL)}>
                    <SelectValue placeholder="Select material" />
                  </SelectTrigger>
                  <SelectContent>
                    {(materials.data ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name} · {m.unit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="space-y-1">
                  <Label className="text-xs text-stone-500">Quantity delivered</Label>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    placeholder="0"
                    className={CONTROL}
                    value={it.quantityDelivered}
                    onChange={(e) => updateItem(i, { quantityDelivered: e.target.value })}
                  />
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className={cn('w-full border-dashed border-stone-300', CONTROL)}
              onClick={() => setItems((prev) => [...prev, { ...EMPTY_DELIVERY_ITEM }])}
            >
              <Plus />
              Add item
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className={CONTROL} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
            disabled={recordDelivery.isPending}
            onClick={submitDelivery}
          >
            {recordDelivery.isPending ? 'Saving…' : 'Record delivery'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReviewDeliveryDialog({
  delivery,
  onOpenChange,
}: {
  delivery: DeliveryDTO
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [accepted, setAccepted] = useState<Record<string, string>>(() =>
    Object.fromEntries(delivery.items.map((it) => [it.materialId, String(it.quantityDelivered)])),
  )

  const materials = useQuery({
    queryKey: ['materials'],
    queryFn: () => api.get<MaterialDTO[]>('/api/materials'),
  })

  function unitCostOf(materialId: string) {
    return (materials.data ?? []).find((m) => m.id === materialId)?.unitCost ?? 0
  }

  function acceptedQty(materialId: string) {
    return Number(accepted[materialId]) || 0
  }

  const totalAcceptedValue = delivery.items.reduce(
    (sum, it) => sum + acceptedQty(it.materialId) * unitCostOf(it.materialId),
    0,
  )

  const verify = useMutation({
    mutationFn: (payload: {
      decision: 'VERIFIED' | 'REJECTED'
      accept?: { materialId: string; quantityAccepted: number }[]
    }) => api.post<DeliveryDTO>(`/api/deliveries/${delivery.id}/verify`, payload),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: updated.status === 'VERIFIED' ? 'Delivery verified' : 'Delivery rejected',
        description:
          updated.status === 'VERIFIED'
            ? 'Accepted quantities were added to site stock.'
            : 'The delivery was recorded as rejected.',
      })
      onOpenChange(false)
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not verify delivery', description: e.message }),
  })

  function onVerify() {
    const accept: { materialId: string; quantityAccepted: number }[] = []
    for (const it of delivery.items) {
      const qty = acceptedQty(it.materialId)
      if (qty < 0 || qty > it.quantityDelivered) {
        toast({
          variant: 'destructive',
          title: 'Check accepted quantities',
          description: `${it.materialName}: accepted must be between 0 and ${it.quantityDelivered} ${it.unit}.`,
        })
        return
      }
      if (qty !== it.quantityDelivered) {
        accept.push({ materialId: it.materialId, quantityAccepted: qty })
      }
    }
    verify.mutate(accept.length > 0 ? { decision: 'VERIFIED', accept } : { decision: 'VERIFIED' })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Review delivery</DialogTitle>
          <DialogDescription>
            {delivery.siteName} · delivered {format(new Date(delivery.deliveredAt), 'd MMM yyyy, HH:mm')}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {delivery.items.map((it) => (
            <div key={it.materialId} className="space-y-2 rounded-lg border border-stone-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-stone-900">{it.materialName}</span>
                <span className="text-xs text-stone-500">
                  Delivered {it.quantityDelivered} {it.unit}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor={`accepted-${it.materialId}`} className="text-xs text-stone-500">
                    Quantity accepted ({it.unit})
                  </Label>
                  <Input
                    id={`accepted-${it.materialId}`}
                    type="number"
                    min="0"
                    max={it.quantityDelivered}
                    step="any"
                    inputMode="decimal"
                    className={CONTROL}
                    value={accepted[it.materialId] ?? ''}
                    onChange={(e) =>
                      setAccepted((prev) => ({ ...prev, [it.materialId]: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-stone-500">Accepted value</Label>
                  <div className="flex items-center rounded-md border border-stone-200 bg-stone-50 px-3 text-sm font-medium text-stone-900">
                    {formatMoney(acceptedQty(it.materialId) * unitCostOf(it.materialId))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between rounded-lg bg-stone-50 px-4 py-3">
          <span className="text-sm text-stone-500">Total accepted value</span>
          <span className="text-base font-semibold text-stone-900">
            {formatMoney(totalAcceptedValue)}
          </span>
        </div>
        <p className="flex items-start gap-2 text-xs text-stone-500">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          Verified quantities are added to site stock and recorded under your name.
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            className={cn('border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700', CONTROL)}
            disabled={verify.isPending}
            onClick={() => verify.mutate({ decision: 'REJECTED' })}
          >
            <XCircle />
            Reject
          </Button>
          <Button
            className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
            disabled={verify.isPending}
            onClick={onVerify}
          >
            <CheckCircle2 />
            {verify.isPending ? 'Verifying…' : 'Verify & add to stock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
