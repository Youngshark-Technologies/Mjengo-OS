'use client'

// Invoice detail dialog — full lines, tax and totals, decision/payment
// history, the 3-way match matrix (PO qty | invoice qty | delivered qty) and
// the printable view. Actions are role-honest: the client decides and pays,
// the site team submits drafts; the server enforces both.

import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { AlertTriangle, Check, FileText, Printer, ScanSearch, Send, Banknote, ShieldCheck, X } from 'lucide-react'
import { dateShort } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import type { InvoiceWithLines, ThreeWayReport } from '@/backend/modules/invoices/types'
import { shouldShowZeroVatNote } from './vat-posture'
import { InvoiceStatusBadge, paymentMethodLabels, ThreeWayChip, formatKes, fmtQty } from './invoice-bits'

interface Props {
  invoice: InvoiceWithLines | null
  report: ThreeWayReport | null
  showMatch: boolean
  isDecider: boolean
  isSiteTeam: boolean
  busy: boolean
  onClose: () => void
  onRunCheck: (invoice: InvoiceWithLines) => void
  onSubmit: (invoice: InvoiceWithLines) => void
  onApprove: (invoice: InvoiceWithLines) => void
  onReject: (invoice: InvoiceWithLines) => void
  onDispute: (invoice: InvoiceWithLines) => void
  onPay: (invoice: InvoiceWithLines) => void
  onPrint: (invoice: InvoiceWithLines) => void
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-xs text-stone-400">{label}</span>
      <span className="truncate text-right text-xs font-medium text-stone-700">{value}</span>
    </div>
  )
}

export function InvoiceDetailDialog({
  invoice, report, showMatch, isDecider, isSiteTeam, busy,
  onClose, onRunCheck, onSubmit, onApprove, onReject, onDispute, onPay, onPrint,
}: Props) {
  const t = useT()
  const methodLabels = paymentMethodLabels(t)
  return (
    <Dialog open={invoice !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {invoice && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2 pr-6">
                <DialogTitle className="font-mono text-stone-900">{invoice.invoiceCode}</DialogTitle>
                <InvoiceStatusBadge status={invoice.status} />
                {report && <ThreeWayChip report={report} />}
              </div>
              <DialogDescription>
                {invoice.supplierName ?? t('finder.inv.noSupplier')}
                {invoice.orderCode ? ` · ${invoice.orderCode}` : ` · ${t('finder.inv.det.noPo')}`}
                {' '}· {formatKes(invoice.total)}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-1">
              {/* meta */}
              <div className="grid gap-x-6 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 sm:grid-cols-2">
                <MetaRow label={t('finder.inv.det.issued')} value={invoice.issuedAt ? dateShort(invoice.issuedAt) : '—'} />
                <MetaRow label={t('finder.inv.det.submitted')} value={invoice.submittedAt ? dateShort(invoice.submittedAt) : null} />
                <MetaRow label={t('finder.inv.det.decided')} value={invoice.decidedAt && invoice.decidedBy ? `${dateShort(invoice.decidedAt)} · ${invoice.decidedBy}` : null} />
                <MetaRow label={t('finder.inv.det.due')} value={invoice.dueDate ? dateShort(invoice.dueDate) : '—'} />
                <MetaRow label={t('finder.inv.det.payment')} value={invoice.status === 'paid'
                  ? `${methodLabels[invoice.paymentMethod ?? '']?.label ?? invoice.paymentMethod ?? '—'}${invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}${invoice.paidAt ? ` · ${dateShort(invoice.paidAt)}` : ''}${invoice.paidByRole ? ` · ${invoice.paidByRole}` : ''}`
                  : null} />
                <MetaRow label={t('finder.inv.det.createdBy')} value={invoice.createdBy} />
              </div>

              {/* lines */}
              <div>
                <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">{t('finder.inv.det.lines', { count: invoice.lines.length })}</p>
                <div className="overflow-x-auto rounded-md border border-stone-200">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                        <th scope="col" className="px-3 py-2 font-medium">{t('finder.inv.det.col.item')}</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.inv.det.col.qty')}</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.inv.det.col.unit')}</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">{t('finder.inv.det.col.total')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.lines.map((l) => (
                        <tr key={l.id} className="border-b border-stone-100 last:border-0">
                          <td className="max-w-[220px] truncate px-3 py-2 text-stone-700">{l.name}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-stone-600">{fmtQty(l.qty)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-stone-500">{formatKes(l.unitPrice)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-stone-800">{formatKes(l.lineTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-stone-50 text-sm">
                      <tr className="border-t border-stone-200">
                        <td colSpan={3} className="px-3 py-1.5 text-right text-xs text-stone-500">{t('finder.inv.det.subtotal')}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-stone-700">{formatKes(invoice.subtotal)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="px-3 py-1.5 text-right text-xs text-stone-500">{t('finder.inv.det.tax')}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-stone-700">{formatKes(invoice.tax)}</td>
                      </tr>
                      <tr className="border-t border-stone-200">
                        <td colSpan={3} className="px-3 py-2 text-right text-xs font-semibold text-stone-700">{t('finder.inv.det.total')}</td>
                        <td className="px-3 py-2 text-right text-base font-bold tabular-nums text-stone-900">{formatKes(invoice.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {shouldShowZeroVatNote(invoice.tax) && (
                  <p className="pt-1 text-[11px] text-stone-400">{t('finder.inv.vatNote')}</p>
                )}
              </div>

              {/* decision/payment history */}
              {invoice.note && (
                <p className="rounded-md bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-500">{t('finder.inv.det.note', { note: invoice.note })}</p>
              )}

              {/* 3-way match matrix */}
              {report && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{t('finder.inv.det.matchTitle')}</p>
                    <Button
                      size="sm" variant="outline" className="h-8 min-h-8 gap-1 text-xs"
                      onClick={() => onRunCheck(invoice)}
                      disabled={busy}
                      aria-label={t('finder.inv.det.runMatchAria')}
                    >
                      <ScanSearch className="h-3.5 w-3.5" aria-hidden /> {t('finder.inv.det.runMatch')}
                    </Button>
                  </div>
                  {showMatch ? (
                    <>
                      <div className="overflow-x-auto rounded-md border border-stone-200">
                        <table className="w-full min-w-[460px] text-sm">
                          <thead>
                            <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                              <th scope="col" className="px-3 py-2 font-medium">{t('finder.inv.det.col.line')}</th>
                              <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.inv.det.col.poQty')}</th>
                              <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.inv.det.col.invQty')}</th>
                              <th scope="col" className="px-3 py-2 text-right font-medium">{t('finder.inv.det.col.delivered')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.lines.map((l, i) => {
                              const flagged = report.mismatches.some((m) => m.name === l.name)
                              return (
                                <tr key={i} className={`border-b border-stone-100 last:border-0 ${flagged ? 'bg-amber-50' : ''}`}>
                                  <td className="max-w-[220px] truncate px-3 py-2 text-stone-700">
                                    {l.name}{l.feeLine && <span className="text-stone-400">{t('finder.inv.det.feeLine')}</span>}
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums text-stone-600">{fmtQty(l.poQty)}</td>
                                  <td className="px-2 py-2 text-right tabular-nums text-stone-600">{fmtQty(l.invQty)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums ${flagged ? 'font-semibold text-amber-800' : 'text-stone-600'}`}>{fmtQty(l.deliveredQty)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      {report.mismatches.length > 0 ? (
                        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2.5">
                          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {t(report.mismatches.length === 1 ? 'finder.inv.det.openOne' : 'finder.inv.det.openMany', { count: report.mismatches.length })}
                          </p>
                          {report.mismatches.map((m, i) => (
                            <p key={i} className="text-[11px] leading-relaxed text-amber-800">• {m.name}: {m.issue}</p>
                          ))}
                          <p className="pt-0.5 text-[10px] text-amber-700">{t('finder.inv.det.recNote')}</p>
                        </div>
                      ) : (
                        <p className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-800">
                          <Check className="h-3.5 w-3.5" aria-hidden /> {t('finder.inv.det.allReconciled')}
                        </p>
                      )}
                      <p className="text-[10px] text-stone-400">{report.note}</p>
                    </>
                  ) : (
                    <p className="rounded-md bg-stone-50 px-3 py-2 text-xs text-stone-500">
                      {t('finder.inv.det.runHint')}
                    </p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              <Button
                variant="outline" onClick={() => onPrint(invoice)}
                aria-label={t('finder.inv.det.printAria', { code: invoice.invoiceCode })}
              >
                <Printer className="h-4 w-4" aria-hidden /> {t('finder.inv.det.print')}
              </Button>
              <div className="flex flex-wrap gap-2">
                {isSiteTeam && invoice.status === 'draft' && (
                  <Button
                    onClick={() => onSubmit(invoice)} disabled={busy}
                    className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
                    aria-label={t('finder.inv.det.submitAria', { code: invoice.invoiceCode })}
                  >
                    <Send className="h-4 w-4" aria-hidden /> {t('finder.inv.det.submitToClient')}
                  </Button>
                )}
                {isDecider && invoice.status === 'submitted' && (
                  <>
                    <Button
                      onClick={() => onApprove(invoice)} disabled={busy}
                      className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                      aria-label={t('finder.inv.dq.approveAria', { code: invoice.invoiceCode })}
                    >
                      <Check className="h-4 w-4" aria-hidden /> {t('finder.inv.dq.approve')}
                    </Button>
                    <Button
                      variant="outline" onClick={() => onReject(invoice)} disabled={busy}
                      className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      aria-label={t('finder.inv.dq.rejectAria', { code: invoice.invoiceCode })}
                    >
                      <X className="h-4 w-4" aria-hidden /> {t('finder.inv.reject.btn')}
                    </Button>
                    <Button
                      variant="outline" onClick={() => onDispute(invoice)} disabled={busy}
                      className="min-h-11 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50 hover:text-orange-800"
                      aria-label={t('finder.inv.dq.disputeAria', { code: invoice.invoiceCode })}
                    >
                      <AlertTriangle className="h-4 w-4" aria-hidden /> {t('finder.inv.dq.dispute')}
                    </Button>
                  </>
                )}
                {isDecider && invoice.status === 'disputed' && (
                  <Button
                    onClick={() => onApprove(invoice)} disabled={busy}
                    className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                    aria-label={t('finder.inv.det.reapproveAria', { code: invoice.invoiceCode })}
                  >
                    <Check className="h-4 w-4" aria-hidden /> {t('finder.inv.dq.reapprove')}
                  </Button>
                )}
                {isDecider && invoice.status === 'approved' && (
                  <Button
                    onClick={() => onPay(invoice)} disabled={busy}
                    className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                    aria-label={t('finder.inv.payAria', { code: invoice.invoiceCode })}
                  >
                    <Banknote className="h-4 w-4" aria-hidden /> {t('finder.inv.det.recordPayment')}
                  </Button>
                )}
                {invoice.status === 'approved' && !isDecider && (
                  <p className="flex items-center gap-1.5 text-xs text-stone-500">
                    <ShieldCheck className="h-3.5 w-3.5 text-stone-400" aria-hidden /> {t('finder.inv.det.awaitingPayment')}
                  </p>
                )}
                {invoice.status === 'draft' && !isSiteTeam && (
                  <p className="flex items-center gap-1.5 text-xs text-stone-500">
                    <FileText className="h-3.5 w-3.5 text-stone-400" aria-hidden /> {t('finder.inv.det.draftNote')}
                  </p>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
