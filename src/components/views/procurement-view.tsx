'use client'

// MJG-009a — Procurement view: purchase orders (draft → sent → received) and suppliers.

import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Mail,
  Package,
  Phone,
  Plus,
  Send,
  Store,
  Trash2,
  Truck,
  XCircle,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import {
  formatMoney,
  PO_STATUS_VALUES,
  type MaterialDTO,
  type POStatus,
  type PurchaseOrderDTO,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

const CONTROL = 'h-11'

const PO_BADGE_CLASS: Record<POStatus, string> = {
  DRAFT: 'border-stone-300 bg-stone-100 text-stone-700',
  SENT: 'border-amber-300 bg-amber-100 text-amber-800',
  RECEIVED: 'border-emerald-200 bg-emerald-100 text-emerald-800',
  CANCELLED: 'border-red-200 bg-red-100 text-red-700',
}

function PoStatusBadge({ status }: { status: POStatus }) {
  return (
    <Badge variant="outline" className={PO_BADGE_CLASS[status]}>
      {status}
    </Badge>
  )
}

function shortId(id: string) {
  return `#${id.slice(0, 8)}`
}

function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-3 border-red-200 bg-red-50 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium text-red-800">Could not load data</p>
        <p className="mt-1 text-sm text-red-700">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry} className={cn('border-red-300 text-red-700 hover:bg-red-100', CONTROL)}>
        Retry
      </Button>
    </Card>
  )
}

interface PoItemDraft {
  materialId: string
  quantity: string
  unitCost: string
}

const EMPTY_ITEM: PoItemDraft = { materialId: '', quantity: '', unitCost: '' }

export function ProcurementView() {
  return (
    <Tabs defaultValue="orders" className="gap-4">
      <TabsList className="h-11 w-full rounded-lg bg-stone-100 p-1 sm:w-auto">
        <TabsTrigger value="orders" className="px-4">
          Purchase orders
        </TabsTrigger>
        <TabsTrigger value="suppliers" className="px-4">
          Suppliers
        </TabsTrigger>
      </TabsList>
      <TabsContent value="orders" className="flex flex-col gap-4">
        <PurchaseOrdersTab />
      </TabsContent>
      <TabsContent value="suppliers" className="flex flex-col gap-4">
        <SuppliersTab />
      </TabsContent>
    </Tabs>
  )
}

function PurchaseOrdersTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [siteFilter, setSiteFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [createOpen, setCreateOpen] = useState(false)

  const [form, setForm] = useState({ siteId: '', supplierId: '', expectedDate: '', notes: '' })
  const [items, setItems] = useState<PoItemDraft[]>([{ ...EMPTY_ITEM }])

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<SiteDTO[]>('/api/sites') })
  const materials = useQuery({
    queryKey: ['materials'],
    queryFn: () => api.get<MaterialDTO[]>('/api/materials'),
  })
  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SupplierDTO[]>('/api/suppliers'),
  })

  const orders = useQuery({
    queryKey: ['purchase-orders', siteFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (siteFilter !== 'ALL') params.set('siteId', siteFilter)
      if (statusFilter !== 'ALL') params.set('status', statusFilter)
      const qs = params.toString()
      return api.get<PurchaseOrderDTO[]>(`/api/purchase-orders${qs ? `?${qs}` : ''}`)
    },
    placeholderData: keepPreviousData,
  })

  const transition = useMutation({
    mutationFn: (vars: { id: string; status: POStatus }) =>
      api.patch<PurchaseOrderDTO>(`/api/purchase-orders/${vars.id}`, { status: vars.status }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Purchase order updated', description: `Status set to ${vars.status}.` })
    },
    onError: (e: Error) =>
      toast({
        variant: 'destructive',
        title: 'Could not update purchase order',
        description: e.message,
      }),
  })

  const createPo = useMutation({
    mutationFn: (payload: {
      siteId: string
      supplierId: string
      expectedDate?: string
      notes?: string
      items: { materialId: string; quantity: number; unitCost: number }[]
    }) => api.post<PurchaseOrderDTO>('/api/purchase-orders', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Purchase order created', description: 'It starts as a draft — send it to the supplier when ready.' })
      setCreateOpen(false)
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not create purchase order', description: e.message }),
  })

  function resetForm() {
    setForm({ siteId: '', supplierId: '', expectedDate: '', notes: '' })
    setItems([{ ...EMPTY_ITEM }])
  }

  function updateItem(index: number, patch: Partial<PoItemDraft>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  function submitOrder() {
    if (!form.siteId || !form.supplierId) {
      toast({
        variant: 'destructive',
        title: 'Missing details',
        description: 'Select a site and a supplier for this order.',
      })
      return
    }
    const cleaned = items
      .map((it) => ({
        materialId: it.materialId,
        quantity: Number(it.quantity),
        unitCost: Number(it.unitCost),
      }))
      .filter(
        (it) =>
          it.materialId !== '' &&
          Number.isFinite(it.quantity) &&
          it.quantity > 0 &&
          Number.isFinite(it.unitCost) &&
          it.unitCost >= 0,
      )
    if (cleaned.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Add line items',
        description: 'Every item needs a material, a quantity above zero and a unit cost.',
      })
      return
    }
    createPo.mutate({
      siteId: form.siteId,
      supplierId: form.supplierId,
      expectedDate: form.expectedDate || undefined,
      notes: form.notes.trim() || undefined,
      items: cleaned,
    })
  }

  const liveTotal = items.reduce(
    (sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unitCost) || 0),
    0,
  )

  const orderList = orders.data ?? []

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
            {PO_STATUS_VALUES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="sm:ml-auto">
          <Button
            className={cn('w-full bg-amber-500 text-white hover:bg-amber-600 sm:w-auto', CONTROL)}
            onClick={() => {
              resetForm()
              setCreateOpen(true)
            }}
          >
            <Plus />
            Create purchase order
          </Button>
        </div>
      </div>

      {orders.isLoading ? (
        <ListSkeleton rows={4} />
      ) : orders.isError ? (
        <ErrorState message={orders.error.message} onRetry={() => orders.refetch()} />
      ) : orderList.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed border-stone-300 bg-white p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-stone-100">
            <ClipboardList className="size-6 text-stone-400" />
          </div>
          <div>
            <p className="font-medium text-stone-900">No purchase orders yet</p>
            <p className="mt-1 text-sm text-stone-500">
              Create your first order to start tracking material supply against a site.
            </p>
          </div>
          <Button
            className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
            onClick={() => {
              resetForm()
              setCreateOpen(true)
            }}
          >
            <Plus />
            Create purchase order
          </Button>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-stone-200 bg-white md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-stone-50">
                  <TableHead>PO</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ordered</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orderList.map((po) => (
                  <TableRow key={po.id}>
                    <TableCell className="font-mono text-xs text-stone-500">{shortId(po.id)}</TableCell>
                    <TableCell className="font-medium text-stone-900">{po.supplierName}</TableCell>
                    <TableCell className="text-stone-600">{po.siteName}</TableCell>
                    <TableCell className="text-right text-stone-600">{po.items.length}</TableCell>
                    <TableCell className="text-right font-medium text-stone-900">
                      {formatMoney(po.total)}
                    </TableCell>
                    <TableCell>
                      <PoStatusBadge status={po.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-stone-600">
                      {format(new Date(po.orderDate), 'd MMM yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      <PoRowActions
                        po={po}
                        busy={transition.isPending}
                        onTransition={(status) => transition.mutate({ id: po.id, status })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {orderList.map((po) => (
              <Card key={po.id} className="border-stone-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-stone-900">{po.supplierName}</p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {po.siteName} · {po.items.length} item{po.items.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <PoStatusBadge status={po.status} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-600">
                  <span className="font-semibold text-stone-900">{formatMoney(po.total)}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <CalendarDays className="size-3.5 text-stone-400" />
                    Ordered {format(new Date(po.orderDate), 'd MMM yyyy')}
                  </span>
                  {po.expectedDate && (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <Truck className="size-3.5 text-stone-400" />
                      Expected {format(new Date(po.expectedDate), 'd MMM yyyy')}
                    </span>
                  )}
                  <span className="font-mono text-xs text-stone-400">{shortId(po.id)}</span>
                </div>
                {po.status !== 'RECEIVED' && po.status !== 'CANCELLED' && (
                  <>
                    <Separator className="my-3" />
                    <PoRowActions
                      po={po}
                      busy={transition.isPending}
                      onTransition={(status) => transition.mutate({ id: po.id, status })}
                      stacked
                    />
                  </>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Create purchase order dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetForm()
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create purchase order</DialogTitle>
            <DialogDescription>
              Order materials from a supplier. The order starts as a draft you can send when ready.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="po-site">Site *</Label>
                <Select value={form.siteId} onValueChange={(siteId) => setForm((f) => ({ ...f, siteId }))}>
                  <SelectTrigger id="po-site" className={cn('w-full bg-white', CONTROL)}>
                    <SelectValue placeholder="Select site" />
                  </SelectTrigger>
                  <SelectContent>
                    {(sites.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-supplier">Supplier *</Label>
                <Select
                  value={form.supplierId}
                  onValueChange={(supplierId) => setForm((f) => ({ ...f, supplierId }))}
                >
                  <SelectTrigger id="po-supplier" className={cn('w-full bg-white', CONTROL)}>
                    <SelectValue placeholder="Select supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    {(suppliers.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-expected">Expected date</Label>
                <Input
                  id="po-expected"
                  type="date"
                  className={CONTROL}
                  value={form.expectedDate}
                  onChange={(e) => setForm((f) => ({ ...f, expectedDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-notes">Notes</Label>
                <Textarea
                  id="po-notes"
                  rows={1}
                  placeholder="Delivery instructions, references…"
                  className="min-h-11"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label>Line items</Label>
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
                    onValueChange={(materialId) => {
                      const material = (materials.data ?? []).find((m) => m.id === materialId)
                      updateItem(i, {
                        materialId,
                        unitCost:
                          it.unitCost === '' && material ? String(material.unitCost) : it.unitCost,
                      })
                    }}
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
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-stone-500">Quantity</Label>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        placeholder="0"
                        className={CONTROL}
                        value={it.quantity}
                        onChange={(e) => updateItem(i, { quantity: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-stone-500">Unit cost (KES)</Label>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        placeholder="0"
                        className={CONTROL}
                        value={it.unitCost}
                        onChange={(e) => updateItem(i, { unitCost: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className={cn('w-full border-dashed border-stone-300', CONTROL)}
                onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
              >
                <Plus />
                Add item
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-stone-50 px-4 py-3">
            <span className="text-sm text-stone-500">Order total</span>
            <span className="text-base font-semibold text-stone-900">{formatMoney(liveTotal)}</span>
          </div>
          <DialogFooter>
            <Button variant="outline" className={CONTROL} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
              disabled={createPo.isPending}
              onClick={submitOrder}
            >
              {createPo.isPending ? 'Creating…' : 'Create order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PoRowActions({
  po,
  busy,
  onTransition,
  stacked = false,
}: {
  po: PurchaseOrderDTO
  busy: boolean
  onTransition: (status: POStatus) => void
  stacked?: boolean
}) {
  if (po.status !== 'DRAFT' && po.status !== 'SENT') {
    return <span className="text-xs text-stone-400">No actions</span>
  }
  return (
    <div className={cn('flex gap-2', stacked ? 'flex-wrap' : 'flex-wrap justify-end')}>
      {po.status === 'DRAFT' && (
        <Button
          size="sm"
          className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
          disabled={busy}
          onClick={() => onTransition('SENT')}
        >
          <Send />
          Send for supply
        </Button>
      )}
      {po.status === 'SENT' && (
        <Button
          size="sm"
          className={cn('bg-emerald-600 text-white hover:bg-emerald-700', CONTROL)}
          disabled={busy}
          onClick={() => onTransition('RECEIVED')}
        >
          <CheckCircle2 />
          Mark received
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className={cn('border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700', CONTROL)}
        disabled={busy}
        onClick={() => onTransition('CANCELLED')}
      >
        <XCircle />
        Cancel
      </Button>
    </div>
  )
}

function SuppliersTab() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', phone: '', email: '', category: '' })

  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SupplierDTO[]>('/api/suppliers'),
  })

  const addSupplier = useMutation({
    mutationFn: (payload: { name: string; phone?: string; email?: string; category?: string }) =>
      api.post<SupplierDTO>('/api/suppliers', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      toast({ title: 'Supplier added' })
      setAddOpen(false)
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not add supplier', description: e.message }),
  })

  function submitSupplier() {
    if (!form.name.trim()) {
      toast({
        variant: 'destructive',
        title: 'Name required',
        description: 'Give the supplier a name to add them.',
      })
      return
    }
    addSupplier.mutate({
      name: form.name.trim(),
      phone: form.phone.trim() || undefined,
      email: form.email.trim() || undefined,
      category: form.category.trim() || undefined,
    })
  }

  function resetForm() {
    setForm({ name: '', phone: '', email: '', category: '' })
  }

  const supplierList = suppliers.data ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-stone-500">
          {suppliers.isLoading
            ? 'Loading suppliers…'
            : `${supplierList.length} supplier${supplierList.length === 1 ? '' : 's'}`}
        </p>
        <Button
          className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
          onClick={() => {
            resetForm()
            setAddOpen(true)
          }}
        >
          <Plus />
          Add supplier
        </Button>
      </div>

      {suppliers.isLoading ? (
        <ListSkeleton rows={4} />
      ) : suppliers.isError ? (
        <ErrorState message={suppliers.error.message} onRetry={() => suppliers.refetch()} />
      ) : supplierList.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed border-stone-300 bg-white p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-stone-100">
            <Store className="size-6 text-stone-400" />
          </div>
          <div>
            <p className="font-medium text-stone-900">No suppliers yet</p>
            <p className="mt-1 text-sm text-stone-500">
              Add your first supplier so you can raise purchase orders against them.
            </p>
          </div>
          <Button
            className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
            onClick={() => {
              resetForm()
              setAddOpen(true)
            }}
          >
            <Plus />
            Add supplier
          </Button>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-stone-200 bg-white md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-stone-50">
                  <TableHead>Supplier</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {supplierList.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium text-stone-900">{s.name}</TableCell>
                    <TableCell className="text-stone-600">{s.category || '—'}</TableCell>
                    <TableCell className="text-stone-600">{s.phone || '—'}</TableCell>
                    <TableCell className="text-stone-600">{s.email || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {supplierList.map((s) => (
              <Card key={s.id} className="border-stone-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-stone-900">{s.name}</p>
                  {s.category && (
                    <Badge variant="outline" className="border-stone-300 bg-stone-100 text-stone-700">
                      {s.category}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 flex flex-col gap-1 text-sm text-stone-600">
                  {s.phone && (
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="size-3.5 text-stone-400" />
                      {s.phone}
                    </span>
                  )}
                  {s.email && (
                    <span className="inline-flex items-center gap-1.5 break-all">
                      <Mail className="size-3.5 text-stone-400" />
                      {s.email}
                    </span>
                  )}
                  {!s.phone && !s.email && <span className="text-xs text-stone-400">No contact details</span>}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Add supplier dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open)
          if (!open) resetForm()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add supplier</DialogTitle>
            <DialogDescription>
              Suppliers are shared across your organization and used when raising purchase orders.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="supplier-name">Name *</Label>
              <Input
                id="supplier-name"
                placeholder="e.g. Bamburi Cement Dealers"
                className={CONTROL}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="supplier-phone">Phone</Label>
                <Input
                  id="supplier-phone"
                  type="tel"
                  placeholder="07xx xxx xxx"
                  className={CONTROL}
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="supplier-email">Email</Label>
                <Input
                  id="supplier-email"
                  type="email"
                  placeholder="name@company.com"
                  className={CONTROL}
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="supplier-category">Category</Label>
              <Input
                id="supplier-category"
                placeholder="e.g. Cement, Steel, Hardware"
                className={CONTROL}
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className={CONTROL}
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
              disabled={addSupplier.isPending}
              onClick={submitSupplier}
            >
              {addSupplier.isPending ? 'Saving…' : 'Add supplier'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
