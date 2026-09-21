'use client'

// Record-payment dialog (only APPROVED invoices, only the payer surface).
// Money mutations get deliberate confirmations (money-tab house style):
//   step 1 "form"   — method, reference (auto-suggested), mismatch banner +
//                     the reviewed-discrepancy checkbox (the human decision)
//   step 2 "confirm"— one deliberate click; the payment writes a permanent
//                     Transaction ledger entry (type 'invoice', never mutated)
// The 3-way check also runs SERVER-side on invoice.pay; a mismatched payment
// only lands when acknowledgeMismatch was set — the checkbox is that decision.

import { useMemo, useState } from 'react'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Checkbox } from '@/frontend/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { RadioGroup, RadioGroupItem } from '@/frontend/ui/radio-group'
import { AlertTriangle, Banknote, BookOpen, Check, ShieldCheck } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'
import type { InvoiceWithLines, ThreeWayReport } from '@/backend/modules/invoices/types'
import { autoPaymentReference } from '@/shared/ids'
import { shouldShowZeroVatNote } from './vat-posture'
import { paymentMethodLabels, formatKes } from './invoice-bits'

interface Props {
  invoice: InvoiceWithLines | null
  report: ThreeWayReport | null
  walletBalance: number
  busy: boolean
  onConfirm: (payload: { method: string; reference: string; costCode: string | null; acknowledgeMismatch: boolean }) => void
  onClose: () => void
}

export function PayInvoiceDialog({ invoice, report, walletBalance, busy, onConfirm, onClose }: Props) {
  const t = useT()
  const methodLabels = paymentMethodLabels(t)
  const [method, setMethod] = useState('mpesa')
  const [reference, setReference] = useState('')
  const [useAutoRef, setUseAutoRef] = useState(true)
  const [costCode, setCostCode] = useState('')
  const [ack, setAck] = useState(false)
  const [step, setStep] = useState<'form' | 'confirm'>('form')

  // MD-4 (#350): the preview draws the SAME CSPRNG seam the server's
  // invoice.pay auto reference uses (src/shared/ids.ts) — one shape, one
  // source of truth (previously a drifting Math.random copy).
  const autoRef = useMemo(() => autoPaymentReference(method), [method])
  const mismatches = report?.mismatches ?? []
  const hasMismatch = mismatches.length > 0
  const walletShort = method === 'wallet' && invoice ? walletBalance < invoice.total : false
  const finalReference = useAutoRef || !reference.trim() ? autoRef : reference.trim()

  function reset() {
    setMethod('mpesa')
    setReference('')
    setUseAutoRef(true)
    setCostCode('')
    setAck(false)
    setStep('form')
  }

  const formValid = invoice
    ? (!hasMismatch || ack) && !walletShort && (useAutoRef || reference.trim().length > 0)
    : false

  return (
    <Dialog
      open={invoice !== null}
      onOpenChange={(open) => {
        if (!open) { onClose(); reset() }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-stone-900">{t('finder.inv.pay.title')}</DialogTitle>
          <DialogDescription>
            {invoice
              ? invoice.orderCode
                ? t('finder.inv.pay.descPo', { code: invoice.invoiceCode, amount: formatKes(invoice.total), supplier: invoice.supplierName ?? t('finder.inv.noSupplier'), po: invoice.orderCode })
                : t('finder.inv.pay.desc', { code: invoice.invoiceCode, amount: formatKes(invoice.total), supplier: invoice.supplierName ?? t('finder.inv.noSupplier') })
              : ''}
          </DialogDescription>
        </DialogHeader>

        {invoice && step === 'form' && (
          <div className="grid gap-4 py-1">
            {/* method */}
            <div className="space-y-2">
              <Label>{t('finder.inv.pay.method')}</Label>
              <RadioGroup value={method} onValueChange={setMethod} className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={t('finder.inv.pay.methodAria')}>
                {Object.entries(methodLabels).map(([value, meta]) => (
                  <label
                    key={value}
                    htmlFor={`pay-method-${value}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-3 text-sm text-stone-700 transition has-[[data-state=checked]]:border-amber-500 has-[[data-state=checked]]:bg-amber-50"
                  >
                    <RadioGroupItem value={value} id={`pay-method-${value}`} />
                    <span className="min-w-0">
                      <span className="block truncate">{meta.label}</span>
                      <span className="block text-[10px] text-stone-400">{meta.hint}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              {method === 'wallet' && (
                <p className={`rounded-md p-2.5 text-xs ${walletShort ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                  {t('finder.inv.pay.walletHolds', { balance: formatKes(walletBalance) })}
                  {walletShort ? t('finder.inv.pay.walletShort') : t('finder.inv.pay.walletOk', { amount: formatKes(invoice.total) })}
                </p>
              )}
            </div>

            {/* reference */}
            <div className="space-y-2">
              <Label htmlFor="pay-reference">{t('finder.inv.pay.reference')}</Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="pay-auto-ref"
                  checked={useAutoRef}
                  onCheckedChange={(v) => setUseAutoRef(Boolean(v))}
                  aria-label={t('finder.inv.pay.autoAria')}
                />
                <label htmlFor="pay-auto-ref" className="cursor-pointer text-sm text-stone-700">
                  {t('finder.inv.pay.auto')} <span className="font-mono text-xs text-stone-500">{autoRef}</span>
                </label>
              </div>
              {!useAutoRef && (
                <Input
                  id="pay-reference" value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder={t('finder.inv.pay.refPh')} className="font-mono"
                  aria-label={t('finder.inv.pay.refAria')}
                />
              )}
              <p className="text-[11px] text-stone-400">{t('finder.inv.pay.agnostic')}</p>
            </div>

            {/* cost code (optional, F-MONEY) — the finance dimension on the ledger row */}
            <div className="space-y-2">
              <Label htmlFor="pay-cost-code">{t('finder.inv.pay.costCode')}</Label>
              <Input
                id="pay-cost-code"
                value={costCode}
                onChange={(e) => setCostCode(e.target.value)}
                placeholder={t('finder.inv.pay.costCodePh')}
                aria-label={t('finder.inv.pay.costCodeAria')}
              />
              <p className="text-[11px] text-stone-400">{t('finder.inv.pay.costCodeNote')}</p>
            </div>

            {/* mismatch banner + reviewed-discrepancy checkbox — the human decision */}
            {hasMismatch && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  {t(mismatches.length === 1 ? 'finder.inv.pay.mismatchOne' : 'finder.inv.pay.mismatchMany', { count: mismatches.length })}
                </p>
                <ul className="space-y-1">
                  {mismatches.slice(0, 4).map((m, i) => (
                    <li key={i} className="text-[11px] leading-relaxed text-amber-800">• {m.name}: {m.issue}</li>
                  ))}
                  {mismatches.length > 4 && <li className="text-[11px] text-amber-700">{t('finder.inv.pay.more', { count: mismatches.length - 4 })}</li>}
                </ul>
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border border-amber-300 bg-white p-2.5">
                  <Checkbox
                    checked={ack}
                    onCheckedChange={(v) => setAck(Boolean(v))}
                    aria-label={t('finder.inv.pay.ackAria')}
                    className="mt-0.5"
                  />
                  <span className="text-xs leading-relaxed text-stone-700">
                    {t('finder.inv.pay.ack', { amount: formatKes(invoice.total) })}
                  </span>
                </label>
                <p className="text-[10px] leading-relaxed text-amber-700">{t('finder.inv.pay.recNote')}</p>
              </div>
            )}

            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              {t('finder.inv.pay.simNote')}
            </p>
          </div>
        )}

        {invoice && step === 'confirm' && (
          <div className="grid gap-4 py-1">
            <div className="space-y-1.5 rounded-md border border-stone-200 p-3 text-sm">
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">{t('finder.inv.pay.amount')}</span>
                <span className="font-bold tabular-nums text-stone-900">{formatKes(invoice.total)}</span>
              </p>
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">{t('finder.inv.pay.confirmMethod')}</span>
                <span className="font-medium text-stone-800">{methodLabels[method]?.label ?? method}</span>
              </p>
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">{t('finder.inv.pay.confirmReference')}</span>
                <span className="font-mono text-xs text-stone-800">{finalReference}</span>
              </p>
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">{t('finder.inv.pay.confirmCostCode')}</span>
                <span className="font-mono text-xs text-stone-800">{costCode.trim() || 'invoice'}</span>
              </p>
              {method === 'wallet' && (
                <p className="flex items-center justify-between gap-3">
                  <span className="text-stone-500">{t('finder.inv.pay.walletAfter')}</span>
                  <span className="font-medium tabular-nums text-stone-800">{formatKes(Math.max(0, walletBalance - invoice.total))}</span>
                </p>
              )}
              {hasMismatch && (
                <p className="flex items-center justify-between gap-3">
                  <span className="text-stone-500">{t('finder.inv.pay.threeWay')}</span>
                  <span className="font-medium text-amber-800">{t('finder.inv.pay.acked', { count: mismatches.length })}</span>
                </p>
              )}
            </div>
            {/* #363 / MD-8 — the payer sees the zero-VAT posture with the
                amount being confirmed (the invoice total is what gets paid) */}
            {shouldShowZeroVatNote(invoice.tax) && (
              <p className="text-[11px] text-stone-400">{t('finder.inv.vatNote')}</p>
            )}
            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              {t('finder.inv.pay.careful')}
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 'form' ? (
            <>
              <Button variant="outline" onClick={() => { onClose(); reset() }} disabled={busy}>{t('dialog.expense.cancel')}</Button>
              <Button
                onClick={() => setStep('confirm')}
                disabled={busy || !formValid}
                className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <Banknote className="h-4 w-4" aria-hidden /> {t('finder.inv.pay.continue')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep('form')} disabled={busy}>{t('finder.inv.pay.back')}</Button>
              <Button
                onClick={() => {
                  onConfirm({ method, reference: finalReference, costCode: costCode.trim() || null, acknowledgeMismatch: hasMismatch })
                  reset()
                }}
                disabled={busy}
                className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <Check className="h-4 w-4" aria-hidden /> {t('finder.inv.pay.confirm')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Paid-state chip shown in lists/details: method + reference (+ ledger ref). */
export function PaymentRecordBadge({ invoice, ledgerRef }: { invoice: InvoiceWithLines; ledgerRef?: string | null }) {
  const t = useT()
  if (invoice.status !== 'paid') return null
  return (
    <Badge variant="outline" className="gap-1 font-mono text-[10px] text-stone-600">
      <Banknote className="h-3 w-3" aria-hidden />
      {(invoice.paymentMethod ?? '').toUpperCase()}{invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}
      {ledgerRef && (
        <span className="flex items-center gap-0.5 text-stone-500" title={t('finder.inv.pay.ledgerTitle')}>
          <BookOpen className="h-3 w-3" aria-hidden /> {ledgerRef}
        </span>
      )}
    </Badge>
  )
}
