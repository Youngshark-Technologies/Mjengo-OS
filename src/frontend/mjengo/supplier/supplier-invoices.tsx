'use client'

// The supplier's invoices (W5-3) — read-only list: the buyer decides and
// pays (invoice.decide / invoice.pay are buyer-side actions; the supplier
// watches the honest statuses). Reuses the Finder invoices status badge +
// money formatters (finder/sections/invoices/invoice-bits.tsx) and the
// #363/MD-8 zero-VAT note (vat-posture.ts — one shared posture seam).

import { Badge } from '@/frontend/ui/badge'
import { useT } from '@/frontend/i18n/provider'
import { dateShort } from '@/frontend/lib/format'
import { anyZeroTaxInvoice } from '@/frontend/mjengo/finder/sections/invoices/vat-posture'
import { InvoiceStatusBadge, formatKes } from '@/frontend/mjengo/finder/sections/invoices/invoice-bits'
import type { SupplierInvoiceRow } from '@/backend/api/supplier'

export function SupplierInvoices({ invoices }: { invoices: SupplierInvoiceRow[] }) {
  const t = useT()
  return (
    <>
    <div className="overflow-x-auto rounded-md border border-stone-200">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="sr-only">{t('supplier.invoices.title')}</caption>
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
            <th scope="col" className="px-3 py-2 font-medium">Invoice</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('supplier.invoices.project')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('supplier.invoices.status')}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t('supplier.invoices.total')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('supplier.invoices.when')}</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} className="border-b border-stone-100 last:border-0">
              <td className="px-3 py-2 font-mono text-xs font-bold text-stone-800">
                {inv.invoiceCode}
                {inv.orderCode && (
                  <span className="block font-sans font-normal text-[10px] text-stone-400">for {inv.orderCode}</span>
                )}
              </td>
              <td className="px-3 py-2 text-stone-700 text-xs">{inv.projectName}</td>
              <td className="px-3 py-2">
                <InvoiceStatusBadge status={inv.status} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-medium text-stone-900">
                {formatKes(inv.total)}
                <span className="block text-[10px] font-normal text-stone-400">
                  {t('supplier.invoices.lineCount', { count: inv.lines.length })}
                </span>
              </td>
              <td className="px-3 py-2 text-xs text-stone-500">
                {inv.status === 'paid' && inv.paidAt
                  ? t('supplier.invoices.paid', { date: dateShort(inv.paidAt), method: inv.paymentMethod ?? '' })
                  : inv.dueDate
                    ? t('supplier.invoices.due', { date: dateShort(inv.dueDate) })
                    : dateShort(inv.createdAt)}
                {inv.status === 'submitted' && (
                  <span className="block text-[10px] text-amber-700">{t('supplier.invoices.awaiting')}</span>
                )}
                {inv.status === 'disputed' && (
                  <Badge variant="outline" className="ml-1 text-[9px] border-orange-300 text-orange-700">
                    {t('supplier.invoices.disputed')}
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {/* #363 / MD-8 — the supplier's own totals carry the same posture note */}
    {anyZeroTaxInvoice(invoices.map((inv) => inv.tax)) && (
      <p className="pt-2 text-[11px] text-stone-400">{t('finder.inv.vatNote')}</p>
    )}
    </>
  )
}
