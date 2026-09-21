'use client'

// Printable invoice — a clean, print-only record of a platform transaction.
// Rendered in a hidden container; window.print() prints ONLY this block via
// the visibility technique (no shared-file changes needed). Explicitly NOT a
// tax document — the totals carry the zero-VAT note (issue #363 / MD-8) and
// the footer says so.

import { dateShort } from '@/frontend/lib/format'
import { useI18n, useT } from '@/frontend/i18n/provider'
import type { InvoiceWithLines } from '@/backend/modules/invoices/types'
import { shouldShowZeroVatNote } from './vat-posture'
import { fmtQty } from './invoice-bits'

interface Props {
  invoice: InvoiceWithLines
  projectName: string
  clientName: string
  location: string | null
}

function money(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

export function PrintableInvoice({ invoice, projectName, clientName, location }: Props) {
  const t = useT()
  const { locale } = useI18n()
  const printedAt = new Date().toLocaleDateString(locale === 'sw' ? 'sw-KE' : 'en-KE', { day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <div id="mjengo-print-root" className="hidden print:block fixed inset-0 z-[999] bg-white p-8 text-stone-900">
      {/* header */}
      <div className="flex items-start justify-between border-b-2 border-stone-800 pb-4">
        <div>
          <p className="text-2xl font-black tracking-tight">Mjengo<span className="text-amber-700">OS</span></p>
          <p className="text-xs text-stone-500">{t('finder.inv.print.tagline')}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-widest text-stone-400">{t('finder.inv.print.recordTitle')}</p>
          <p className="font-mono text-lg font-bold">{invoice.invoiceCode}</p>
          <p className="text-xs text-stone-500">{invoice.status.toUpperCase()}</p>
        </div>
      </div>

      {/* parties */}
      <div className="grid grid-cols-2 gap-6 pt-4 text-xs">
        <div>
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('finder.inv.print.supplier')}</p>
          <p className="font-medium">{invoice.supplierName ?? t('finder.inv.print.notRecorded')}</p>
          {invoice.createdBy && <p className="text-stone-500">{t('finder.inv.print.issuedBy', { by: invoice.createdBy })}</p>}
        </div>
        <div className="text-right">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('finder.inv.print.projectClient')}</p>
          <p className="font-medium">{projectName}</p>
          <p className="text-stone-500">{clientName}{location ? ` · ${location}` : ''}</p>
        </div>
      </div>

      {/* meta */}
      <div className="grid grid-cols-3 gap-4 pt-4 text-xs">
        <div><span className="text-stone-400">{t('finder.inv.print.issued')}</span><span className="font-medium">{invoice.issuedAt ? dateShort(invoice.issuedAt) : '—'}</span></div>
        <div><span className="text-stone-400">{t('finder.inv.print.due')}</span><span className="font-medium">{invoice.dueDate ? dateShort(invoice.dueDate) : '—'}</span></div>
        <div><span className="text-stone-400">{t('finder.inv.print.po')}</span><span className="font-mono font-medium">{invoice.orderCode ?? t('finder.inv.print.none')}</span></div>
      </div>

      {/* lines */}
      <table className="mt-6 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-stone-300 text-left uppercase tracking-wide text-stone-400">
            <th className="py-2 font-medium">{t('finder.inv.print.col.item')}</th>
            <th className="py-2 text-right font-medium">{t('finder.inv.print.col.qty')}</th>
            <th className="py-2 text-right font-medium">{t('finder.inv.print.col.unitPrice')}</th>
            <th className="py-2 text-right font-medium">{t('finder.inv.print.col.lineTotal')}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id} className="border-b border-stone-100">
              <td className="py-2">{l.name}</td>
              <td className="py-2 text-right tabular-nums">{fmtQty(l.qty)}</td>
              <td className="py-2 text-right tabular-nums">{money(l.unitPrice)}</td>
              <td className="py-2 text-right tabular-nums">{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* totals */}
      <div className="mt-4 ml-auto w-56 text-xs">
        <div className="flex justify-between py-1"><span className="text-stone-500">{t('finder.inv.print.subtotal')}</span><span className="tabular-nums">{money(invoice.subtotal)}</span></div>
        <div className="flex justify-between py-1"><span className="text-stone-500">{t('finder.inv.print.tax')}</span><span className="tabular-nums">{money(invoice.tax)}</span></div>
        <div className="flex justify-between border-t border-stone-800 py-2 text-sm font-bold"><span>{t('finder.inv.print.total')}</span><span className="tabular-nums">{money(invoice.total)}</span></div>
      </div>
      {/* #363 / MD-8 — the zero-VAT posture travels onto paper (and "Save as
          PDF"), right under the tax line it explains; one shared note */}
      {shouldShowZeroVatNote(invoice.tax) && (
        <p className="mt-1 ml-auto w-56 text-right text-[10px] leading-snug text-stone-400">{t('finder.inv.vatNote')}</p>
      )}

      {/* payment record */}
      {invoice.status === 'paid' && (
        <div className="mt-6 border border-stone-200 p-3 text-xs">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('finder.inv.print.paymentRecord')}</p>
          <p>
            {t('finder.inv.print.paidVia', { date: invoice.paidAt ? dateShort(invoice.paidAt) : '', method: (invoice.paymentMethod ?? '').toUpperCase() })}
            {invoice.paymentReference ? t('finder.inv.print.ref', { reference: invoice.paymentReference }) : ''}
            {invoice.paidByRole ? t('finder.inv.print.by', { role: invoice.paidByRole }) : ''}{t('finder.inv.print.ledgered')}
          </p>
        </div>
      )}
      {invoice.status !== 'paid' && (
        <div className="mt-6 border border-stone-200 p-3 text-xs text-stone-500">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">{t('finder.inv.print.paymentRecord')}</p>
          <p>{t('finder.inv.print.notPaid', { status: invoice.status.toUpperCase() })}</p>
        </div>
      )}

      {invoice.note && <p className="mt-4 text-xs text-stone-500">{t('finder.inv.print.note', { note: invoice.note })}</p>}

      {/* footer */}
      <p className="mt-8 border-t border-stone-200 pt-3 text-center text-[10px] text-stone-400">
        {t('finder.inv.print.footer', { date: printedAt })}
      </p>
    </div>
  )
}
