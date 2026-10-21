'use client'

// MJG-009a — Payments view: record payments, owner approves, owner marks paid.

import { useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  Banknote,
  CheckCircle2,
  Clock,
  Plus,
  ReceiptText,
  ShieldCheck,
  XCircle,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import {
  formatMoney,
  PAYMENT_CATEGORY_VALUES,
  PAYMENT_METHOD_VALUES,
  type MilestoneDTO,
  type PaymentCategory,
  type PaymentDTO,
  type PaymentMethod,
  type PaymentStatus,
  type PurchaseOrderDTO,
  type SessionUser,
  type SiteDTO,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const CONTROL = 'h-11'

type PayTab = 'ALL' | 'PENDING' | 'APPROVED' | 'PAID'

const PAY_TABS: { value: PayTab; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PAID', label: 'Paid' },
]

const PAYMENT_BADGE_CLASS: Record<PaymentStatus, string> = {
  PENDING: 'border-amber-300 bg-amber-50 text-amber-800',
  APPROVED: 'border-emerald-200 bg-emerald-100 text-emerald-800',
  PAID: 'border-emerald-600 bg-emerald-600 text-white',
  REJECTED: 'border-red-200 bg-red-100 text-red-700',
}

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <Badge variant="outline" className={PAYMENT_BADGE_CLASS[status]}>
      {status}
    </Badge>
  )
}

function CategoryBadge({ category }: { category: PaymentCategory }) {
  return (
    <Badge variant="outline" className="border-stone-300 bg-stone-100 text-stone-700">
      {category}
    </Badge>
  )
}

function MethodBadge({ method }: { method: PaymentMethod }) {
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
      {method}
    </Badge>
  )
}

/** Wraps the actions of users who cannot approve, explaining why they are disabled. */
function OwnerGuard({ locked, children }: { locked: boolean; children: ReactNode }) {
  if (!locked) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>Owner approval required</TooltipContent>
    </Tooltip>
  )
}

export function PaymentsView({ user }: { user: SessionUser }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const isOwner = user.role === 'OWNER'
  const canRecord = user.role !== 'WORKER'

  const [tab, setTab] = useState<PayTab>('ALL')
  const [recordOpen, setRecordOpen] = useState(false)

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<SiteDTO[]>('/api/sites') })

  const payments = useQuery({
    queryKey: ['payments', tab],
    queryFn: () => {
      const qs = tab === 'ALL' ? '' : `?status=${tab}`
      return api.get<PaymentDTO[]>(`/api/payments${qs}`)
    },
    placeholderData: keepPreviousData,
  })

  const approve = useMutation({
    mutationFn: (vars: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      api.post<PaymentDTO>(`/api/payments/${vars.id}/approve`, { decision: vars.decision }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['payments'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: updated.status === 'APPROVED' ? 'Payment approved' : 'Payment rejected',
        description: 'The decision was recorded with your name and a timestamp.',
      })
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not update payment', description: e.message }),
  })

  const markPaid = useMutation({
    mutationFn: (vars: { id: string }) =>
      api.post<PaymentDTO>(`/api/payments/${vars.id}/mark-paid`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ title: 'Payment marked as paid' })
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not mark payment as paid', description: e.message }),
  })

  const paymentList = payments.data ?? []
  const pendingValue = paymentList
    .filter((p) => p.status === 'PENDING')
    .reduce((sum, p) => sum + p.amount, 0)
  const paidValue = paymentList
    .filter((p) => p.status === 'PAID')
    .reduce((sum, p) => sum + p.amount, 0)

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as PayTab)} className="gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <TabsList className="h-11 w-full rounded-lg bg-stone-100 p-1 lg:w-auto">
            {PAY_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="px-4">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {canRecord && (
            <Button
              className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
              onClick={() => setRecordOpen(true)}
            >
              <Plus />
              Record payment
            </Button>
          )}
        </div>

        {/* Summary strip — computed from the fetched list */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="border-stone-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-stone-500">
              <Clock className="size-3.5 text-amber-500" />
              Pending value
            </div>
            <p className="mt-1.5 text-xl font-bold text-stone-900">{formatMoney(pendingValue)}</p>
          </Card>
          <Card className="border-stone-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-stone-500">
              <CheckCircle2 className="size-3.5 text-emerald-600" />
              Paid (this list)
            </div>
            <p className="mt-1.5 text-xl font-bold text-stone-900">{formatMoney(paidValue)}</p>
          </Card>
          <Card className="border-stone-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-stone-500">
              <ReceiptText className="size-3.5 text-stone-400" />
              Records in view
            </div>
            <p className="mt-1.5 text-xl font-bold text-stone-900">{paymentList.length}</p>
          </Card>
        </div>

        {payments.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : payments.isError ? (
          <Card className="flex flex-col items-start gap-3 border-red-200 bg-red-50 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-red-800">Could not load payments</p>
              <p className="mt-1 text-sm text-red-700">{payments.error.message}</p>
            </div>
            <Button
              variant="outline"
              onClick={() => payments.refetch()}
              className={cn('border-red-300 text-red-700 hover:bg-red-100', CONTROL)}
            >
              Retry
            </Button>
          </Card>
        ) : paymentList.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 border-dashed border-stone-300 bg-white p-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-stone-100">
              <ReceiptText className="size-6 text-stone-400" />
            </div>
            <div>
              <p className="font-medium text-stone-900">No payments in this view</p>
              <p className="mt-1 text-sm text-stone-500">
                {canRecord
                  ? 'Record a payment to track spend against a site, purchase order or milestone.'
                  : 'Payments recorded by your team will appear here.'}
              </p>
            </div>
            {canRecord && (
              <Button
                className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
                onClick={() => setRecordOpen(true)}
              >
                <Plus />
                Record payment
              </Button>
            )}
          </Card>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-xl border border-stone-200 bg-white md:block">
              <Table>
                <TableHeader>
                  <TableRow className="bg-stone-50">
                    <TableHead>Amount</TableHead>
                    <TableHead>Category / method</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Milestone</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Recorded by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paymentList.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap font-bold text-stone-900">
                        {formatMoney(p.amount)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <CategoryBadge category={p.category} />
                          <MethodBadge method={p.method} />
                        </div>
                      </TableCell>
                      <TableCell className="text-stone-600">{p.siteName}</TableCell>
                      <TableCell className="text-stone-600">{p.milestoneName ?? '—'}</TableCell>
                      <TableCell className="text-stone-600">{p.reference || '—'}</TableCell>
                      <TableCell className="text-stone-600">{p.recordedByName}</TableCell>
                      <TableCell>
                        <PaymentStatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-stone-600">
                        {format(new Date(p.createdAt), 'd MMM yyyy')}
                      </TableCell>
                      <TableCell className="text-right">
                        <PaymentRowActions
                          payment={p}
                          isOwner={isOwner}
                          busy={approve.isPending || markPaid.isPending}
                          onApprove={() => approve.mutate({ id: p.id, decision: 'APPROVED' })}
                          onReject={() => approve.mutate({ id: p.id, decision: 'REJECTED' })}
                          onMarkPaid={() => markPaid.mutate({ id: p.id })}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <div className="flex flex-col gap-3 md:hidden">
              {paymentList.map((p) => (
                <Card key={p.id} className="border-stone-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5">
                        <CategoryBadge category={p.category} />
                        <MethodBadge method={p.method} />
                      </div>
                      <p className="mt-1.5 truncate text-sm text-stone-600">
                        {p.siteName}
                        {p.milestoneName ? ` · ${p.milestoneName}` : ''}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-stone-500">
                        {p.recordedByName} · {format(new Date(p.createdAt), 'd MMM yyyy')}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-bold text-stone-900">{formatMoney(p.amount)}</p>
                      <div className="mt-1 flex justify-end">
                        <PaymentStatusBadge status={p.status} />
                      </div>
                    </div>
                  </div>
                  {(p.reference || p.approvedByName || p.paidAt) && (
                    <>
                      <Separator className="my-3" />
                      <div className="flex flex-col gap-1 text-xs text-stone-500">
                        {p.reference && <span>Reference: {p.reference}</span>}
                        {p.approvedByName && (
                          <span>
                            Approved by {p.approvedByName}
                            {p.approvedAt ? ` · ${format(new Date(p.approvedAt), 'd MMM yyyy')}` : ''}
                          </span>
                        )}
                        {p.paidAt && <span>Paid {format(new Date(p.paidAt), 'd MMM yyyy')}</span>}
                      </div>
                    </>
                  )}
                  {(p.status === 'PENDING' || p.status === 'APPROVED') && (
                    <>
                      <Separator className="my-3" />
                      <PaymentRowActions
                        payment={p}
                        isOwner={isOwner}
                        busy={approve.isPending || markPaid.isPending}
                        onApprove={() => approve.mutate({ id: p.id, decision: 'APPROVED' })}
                        onReject={() => approve.mutate({ id: p.id, decision: 'REJECTED' })}
                        onMarkPaid={() => markPaid.mutate({ id: p.id })}
                        stacked
                      />
                    </>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}
      </Tabs>

      <p className="flex items-center gap-1.5 text-xs text-stone-500">
        <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" />
        Approvals are human decisions recorded with name and timestamp.
      </p>

      {recordOpen && canRecord && (
        <RecordPaymentDialog
          sites={sites.data ?? []}
          onOpenChange={(open) => {
            if (!open) setRecordOpen(false)
          }}
        />
      )}
    </div>
  )
}

function PaymentRowActions({
  payment,
  isOwner,
  busy,
  onApprove,
  onReject,
  onMarkPaid,
  stacked = false,
}: {
  payment: PaymentDTO
  isOwner: boolean
  busy: boolean
  onApprove: () => void
  onReject: () => void
  onMarkPaid: () => void
  stacked?: boolean
}) {
  if (payment.status === 'PENDING') {
    return (
      <div className={cn('flex flex-wrap gap-2', !stacked && 'justify-end')}>
        <OwnerGuard locked={!isOwner}>
          <Button
            size="sm"
            className={cn('bg-emerald-600 text-white hover:bg-emerald-700', CONTROL)}
            disabled={!isOwner || busy}
            onClick={onApprove}
          >
            <CheckCircle2 />
            Approve
          </Button>
        </OwnerGuard>
        <OwnerGuard locked={!isOwner}>
          <Button
            size="sm"
            variant="outline"
            className={cn('border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700', CONTROL)}
            disabled={!isOwner || busy}
            onClick={onReject}
          >
            <XCircle />
            Reject
          </Button>
        </OwnerGuard>
      </div>
    )
  }
  if (payment.status === 'APPROVED') {
    return (
      <div className={cn('flex flex-wrap gap-2', !stacked && 'justify-end')}>
        <OwnerGuard locked={!isOwner}>
          <Button
            size="sm"
            className={cn('bg-emerald-600 text-white hover:bg-emerald-700', CONTROL)}
            disabled={!isOwner || busy}
            onClick={onMarkPaid}
          >
            <Banknote />
            Mark paid
          </Button>
        </OwnerGuard>
      </div>
    )
  }
  return <span className="text-xs text-stone-400">No actions</span>
}

function RecordPaymentDialog({
  sites,
  onOpenChange,
}: {
  sites: SiteDTO[]
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [form, setForm] = useState({
    siteId: '',
    milestoneId: '',
    purchaseOrderId: '',
    category: '' as PaymentCategory | '',
    method: '' as PaymentMethod | '',
    amount: '',
    reference: '',
    notes: '',
  })

  const milestones = useQuery({
    queryKey: ['milestones', form.siteId || 'NONE'],
    queryFn: () => api.get<MilestoneDTO[]>(`/api/milestones?siteId=${form.siteId}`),
    enabled: form.siteId !== '',
  })
  const siteOrders = useQuery({
    queryKey: ['purchase-orders', form.siteId || 'NONE', ''],
    queryFn: () => api.get<PurchaseOrderDTO[]>(`/api/purchase-orders?siteId=${form.siteId}`),
    enabled: form.siteId !== '',
  })

  const recordPayment = useMutation({
    mutationFn: (payload: {
      siteId: string
      purchaseOrderId?: string
      milestoneId?: string
      category: PaymentCategory
      method: PaymentMethod
      amount: number
      reference?: string
      notes?: string
    }) => api.post<PaymentDTO>('/api/payments', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast({
        title: 'Payment recorded',
        description: 'It is pending owner approval before being marked as paid.',
      })
      onOpenChange(false)
    },
    onError: (e: Error) =>
      toast({ variant: 'destructive', title: 'Could not record payment', description: e.message }),
  })

  function submitPayment() {
    if (!form.siteId || !form.category || !form.method) {
      toast({
        variant: 'destructive',
        title: 'Missing details',
        description: 'Select a site, a category and a payment method.',
      })
      return
    }
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({
        variant: 'destructive',
        title: 'Invalid amount',
        description: 'Enter an amount above zero.',
      })
      return
    }
    recordPayment.mutate({
      siteId: form.siteId,
      purchaseOrderId: form.purchaseOrderId || undefined,
      milestoneId: form.milestoneId || undefined,
      category: form.category,
      method: form.method,
      amount,
      reference: form.reference.trim() || undefined,
      notes: form.notes.trim() || undefined,
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            Payments are recorded first, then approved and settled by the owner.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="payment-site">Site *</Label>
              <Select
                value={form.siteId}
                onValueChange={(siteId) =>
                  setForm((f) => ({ ...f, siteId, milestoneId: '', purchaseOrderId: '' }))
                }
              >
                <SelectTrigger id="payment-site" className={cn('w-full bg-white', CONTROL)}>
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
              <Label htmlFor="payment-category">Category *</Label>
              <Select
                value={form.category}
                onValueChange={(category) => setForm((f) => ({ ...f, category: category as PaymentCategory }))}
              >
                <SelectTrigger id="payment-category" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_CATEGORY_VALUES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-method">Method *</Label>
              <Select
                value={form.method}
                onValueChange={(method) => setForm((f) => ({ ...f, method: method as PaymentMethod }))}
              >
                <SelectTrigger id="payment-method" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHOD_VALUES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-amount">Amount (KES) *</Label>
              <Input
                id="payment-amount"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="0"
                className={CONTROL}
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-milestone">Milestone (optional)</Label>
              <Select
                value={form.milestoneId}
                onValueChange={(milestoneId) => setForm((f) => ({ ...f, milestoneId }))}
                disabled={form.siteId === ''}
              >
                <SelectTrigger id="payment-milestone" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder={form.siteId === '' ? 'Select site first' : 'No milestone'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No milestone</SelectItem>
                  {(milestones.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-po">Purchase order (optional)</Label>
              <Select
                value={form.purchaseOrderId}
                onValueChange={(purchaseOrderId) => setForm((f) => ({ ...f, purchaseOrderId }))}
                disabled={form.siteId === ''}
              >
                <SelectTrigger id="payment-po" className={cn('w-full bg-white', CONTROL)}>
                  <SelectValue placeholder={form.siteId === '' ? 'Select site first' : 'No purchase order'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No purchase order</SelectItem>
                  {(siteOrders.data ?? [])
                    .filter((po) => po.status !== 'CANCELLED')
                    .map((po) => (
                      <SelectItem key={po.id} value={po.id}>
                        #{po.id.slice(0, 8)} · {po.supplierName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="payment-reference">Reference</Label>
              <Input
                id="payment-reference"
                placeholder="M-PESA code, cheque number…"
                className={CONTROL}
                value={form.reference}
                onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="payment-notes">Notes</Label>
              <Textarea
                id="payment-notes"
                rows={2}
                placeholder="What is this payment for?"
                className="min-h-11"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className={CONTROL} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className={cn('bg-amber-500 text-white hover:bg-amber-600', CONTROL)}
            disabled={recordPayment.isPending}
            onClick={submitPayment}
          >
            {recordPayment.isPending ? 'Saving…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
