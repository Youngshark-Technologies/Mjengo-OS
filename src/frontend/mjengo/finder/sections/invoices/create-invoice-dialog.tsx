'use client'

// Create-invoice dialog — drafts a supplier invoice, optionally linked to a
// purchase order (supplier + lines pre-filled from the PO, including its
// delivery fee as a line). Totals shown live are advisory only: the server
// recomputes every lineTotal/subtotal/tax/total (client sums never trusted).
// Result is a DRAFT — submit moves it into the client decision queue.

import { useMemo, useState } from 'react'
import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Textarea } from '@/frontend/ui/textarea'
import { Plus, ReceiptText, Trash2 } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'
import type { ProjectPayload } from '@/backend/lib/mjengo'
import { shouldShowZeroVatNote } from './vat-posture'
import { formatKes } from './invoice-bits'

type OrderRow = ProjectPayload['supply']['orders'][number]
type SupplierRow = ProjectPayload['supply']['suppliers'][number]

interface DraftLine {
  name: string
  qty: string
  unitPrice: string
}

interface Props {
  open: boolean
  orders: OrderRow[]
  suppliers: SupplierRow[]
  busy: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (payload: {
    orderId?: string
    supplierId?: string
    lines: { name: string; qty: number; unitPrice: number }[]
    tax?: number
    dueDate?: string
    note?: string
  }) => void
}

/** Billable POs — anything not cancelled (POs may rest at any supply-flow stage). */
const BILLABLE_ORDER_STATUSES = ['approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed']

export function CreateInvoiceDialog({ open, orders, suppliers, busy, onOpenChange, onCreate }: Props) {
  const t = useT()
  const billable = useMemo(() => orders.filter((o) => BILLABLE_ORDER_STATUSES.includes(o.status)), [orders])
  const [orderId, setOrderId] = useState<string>('none')
  const [supplierId, setSupplierId] = useState<string>('none')
  const [lines, setLines] = useState<DraftLine[]>([{ name: '', qty: '', unitPrice: '' }])
  const [tax, setTax] = useState('0')
  const [dueDate, setDueDate] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selectedOrder = orderId === 'none' ? null : billable.find((o) => o.id === orderId) ?? null

  /** Pre-fill lines from a PO: material lines + its delivery fee as a line. */
  function prefillLines(value: string): DraftLine[] {
    const po = value === 'none' ? null : billable.find((o) => o.id === value) ?? null
    if (!po) return [{ name: '', qty: '', unitPrice: '' }]
    const pre: DraftLine[] = po.lines.map((l) => ({
      name: l.name,
      qty: String(l.qty),
      unitPrice: String(l.unitPrice),
    }))
    if (po.deliveryFee > 0) {
      pre.push({ name: t('finder.inv.create.deliveryLine', { supplier: po.supplierName }), qty: '1', unitPrice: String(po.deliveryFee) })
    }
    return pre.length ? pre : [{ name: '', qty: '', unitPrice: '' }]
  }

  function handleOrderChange(value: string) {
    setOrderId(value)
    setLines(prefillLines(value))
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setOrderId('none'); setSupplierId('none'); setTax('0'); setDueDate(''); setNote(''); setError(null)
      setLines([{ name: '', qty: '', unitPrice: '' }])
    }
  }

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0)
  const total = subtotal + (Number(tax) || 0)

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  function submit() {
    setError(null)
    const payloadLines: { name: string; qty: number; unitPrice: number }[] = []
    for (const l of lines) {
      const name = l.name.trim()
      const qty = Number(l.qty)
      const price = Number(l.unitPrice)
      if (!name && !l.qty && !l.unitPrice) continue // skip fully-blank rows
      if (!name) { setError(t('finder.inv.create.error.name')); return }
      if (!Number.isFinite(qty) || qty <= 0) { setError(t('finder.inv.create.error.qty', { name })); return }
      if (!Number.isFinite(price) || price < 0) { setError(t('finder.inv.create.error.price', { name })); return }
      payloadLines.push({ name, qty, unitPrice: price })
    }
    if (!payloadLines.length) { setError(t('finder.inv.create.error.lines')); return }
    const taxNum = Number(tax) || 0
    if (taxNum < 0) { setError(t('finder.inv.create.error.tax')); return }

    onCreate({
      orderId: selectedOrder?.id,
      supplierId: selectedOrder ? undefined : supplierId === 'none' ? undefined : supplierId,
      lines: payloadLines,
      tax: taxNum || undefined,
      dueDate: dueDate || undefined,
      note: note.trim() || undefined,
    })
    // reset for the next open (the parent closes the dialog on success)
    setOrderId('none'); setSupplierId('none'); setTax('0'); setDueDate(''); setNote('')
    setLines([{ name: '', qty: '', unitPrice: '' }])
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { handleOpenChange(o) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-stone-900">{t('finder.inv.create.title')}</DialogTitle>
          <DialogDescription>
            {t('finder.inv.create.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('finder.inv.create.fromPo')}</Label>
              <Select value={orderId} onValueChange={handleOrderChange}>
                <SelectTrigger aria-label={t('finder.inv.create.poAria')}><SelectValue placeholder={t('finder.inv.create.poPh')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('finder.inv.create.standalone')}</SelectItem>
                  {billable.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.orderCode} · {o.supplierName} · {formatKes(o.total)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-stone-400">
                {selectedOrder
                  ? t('finder.inv.create.prefilled', { code: selectedOrder.orderCode, status: selectedOrder.status.replace(/_/g, ' ') })
                  : t('finder.inv.create.noPoNote')}
              </p>
            </div>

            {!selectedOrder && (
              <div className="space-y-2">
                <Label>{t('finder.inv.col.supplier')}</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger aria-label={t('finder.inv.col.supplier')}><SelectValue placeholder={t('finder.inv.create.optional')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('finder.inv.create.notRecorded')}</SelectItem>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.businessName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-stone-400">{t('finder.inv.create.supplierNote')}</p>
              </div>
            )}

            {selectedOrder && (
              <div className="space-y-2">
                <Label>{t('finder.inv.create.supplierFromPo')}</Label>
                <p className="min-h-11 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm text-stone-700">
                  {selectedOrder.supplierName}
                </p>
              </div>
            )}
          </div>

          {/* lines editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Lines</Label>
              <Button
                size="sm" variant="outline" className="h-8 min-h-8 gap-1 text-xs"
                onClick={() => setLines((prev) => [...prev, { name: '', qty: '', unitPrice: '' }])}
                aria-label="Add a line"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
              </Button>
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1" role="region" aria-label="Invoice lines, scrollable">
              {lines.map((l, i) => {
                const lineTotal = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0)
                return (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_76px_100px_84px] items-center gap-2">
                    <Input
                      value={l.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      placeholder={t('finder.inv.create.namePh')}
                      aria-label={t('finder.inv.create.lineNameAria', { n: i + 1 })}
                      className="text-sm"
                    />
                    <Input
                      type="number" min="0" value={l.qty}
                      onChange={(e) => updateLine(i, { qty: e.target.value })}
                      placeholder={t('finder.inv.det.col.qty')} inputMode="decimal"
                      aria-label={t('finder.inv.create.lineQtyAria', { n: i + 1 })}
                      className="text-sm"
                    />
                    <Input
                      type="number" min="0" value={l.unitPrice}
                      onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                      placeholder={t('finder.inv.create.unitKsh')} inputMode="numeric"
                      aria-label={t('finder.inv.create.linePriceAria', { n: i + 1 })}
                      className="text-sm"
                    />
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-xs tabular-nums text-stone-500">{formatKes(lineTotal)}</span>
                      <Button
                        size="sm" variant="ghost" className="h-8 w-8 min-h-8 min-w-8 p-0 text-stone-400 hover:text-rose-600"
                        onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}
                        aria-label={t('finder.inv.create.removeLineAria', { n: i + 1 })}
                        disabled={lines.length <= 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="inv-tax">{t('finder.inv.create.taxVat')}</Label>
              <Input id="inv-tax" type="number" min="0" value={tax} onChange={(e) => setTax(e.target.value)} inputMode="numeric" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-due">{t('finder.inv.create.dueDate')}</Label>
              <Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('finder.inv.create.totals')}</Label>
              <p className="min-h-11 rounded-md bg-stone-50 px-3 py-2.5 text-sm tabular-nums text-stone-700">
                {formatKes(subtotal)} + {formatKes(Number(tax) || 0)} = <span className="font-semibold text-stone-900">{formatKes(total)}</span>
              </p>
            </div>
          </div>
          {/* #363 / MD-8 — the live totals preview states the platform posture
              while the draft is zero-tax (entering a tax amount replaces the
              note with the draft's own numbers — the posture is per-invoice) */}
          {shouldShowZeroVatNote(Number(tax) || 0) && (
            <p className="text-[11px] text-stone-400">{t('finder.inv.vatNote')}</p>
          )}

          <div className="space-y-2">
            <Label htmlFor="inv-note">{t('finder.inv.create.noteLabel')}</Label>
            <Textarea id="inv-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('finder.inv.create.notePh')} />
          </div>

          {error && <p className="rounded-md bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>{t('dialog.expense.cancel')}</Button>
          <Button
            onClick={() => submit()}
            disabled={busy}
            className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
          >
            <ReceiptText className="h-4 w-4" aria-hidden /> {t('finder.inv.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
