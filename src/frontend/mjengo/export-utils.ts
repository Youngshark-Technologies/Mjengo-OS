import type { ProjectPayload } from '@/backend/lib/mjengo'
import type { InvoiceWithLines } from '@/backend/modules/invoices/types'
import type { TranslateFn } from '@/frontend/i18n/types'
import { anyZeroTaxInvoice } from '@/frontend/mjengo/finder/sections/invoices/vat-posture'

/**
 * Pure CSV export helpers for MjengoOS.
 * KSh amounts are plain rounded numbers (no "KSh" prefix) so Excel can sum them.
 * Dates are ISO date-only strings (YYYY-MM-DD).
 *
 * ISSUE #125: header/label rows flow through the caller's t() (csv.* dict
 * family, en + sw) so exports honor the active locale. Data rows stay verbatim
 * (names, notes, DB enum values); filenames stay ASCII for download
 * portability. Fundi attendance statuses reuse the fundis.status.* labels.
 */

export type CSVRow = Record<string, string | number | null>

/** Serialize rows (first row = header) to CSV with RFC-4180 quote escaping. */
export function toCSV(rows: Array<Record<string, string | number | null>>): string {
  const escapeCell = (cell: string | number | null): string => {
    const raw = cell === null || cell === undefined ? '' : String(cell)
    return `"${raw.replace(/"/g, '""')}"`
  }
  return rows.map((row) => Object.values(row).map(escapeCell).join(',')).join('\r\n')
}

/** Trigger a browser download of `csv` as `filename` (UTF-8 BOM so Excel reads KSh text correctly). */
export function downloadCSV(filename: string, csv: string): void {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function isoDateOnly(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

/** Materials inventory ledger: delivered vs consumed vs on-site stock value. */
export function materialsLedgerCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = [
    {
      Material: t('csv.mat.material'), Unit: t('csv.mat.unit'), 'Unit Price': t('csv.mat.unitPrice'),
      'Delivered Qty': t('csv.mat.deliveredQty'), 'Delivered Cost': t('csv.mat.deliveredCost'),
      'Consumed Qty': t('csv.mat.consumedQty'), 'On-site Qty': t('csv.mat.onSiteQty'), 'Stock Value': t('csv.mat.stockValue'),
    },
    ...p.materials.map((m) => ({
      Material: m.name,
      Unit: m.unit,
      'Unit Price': Math.round(m.unitPrice),
      'Delivered Qty': m.deliveredQty,
      'Delivered Cost': Math.round(m.deliveredCost),
      'Consumed Qty': m.consumedQty,
      'On-site Qty': m.onSiteQty,
      'Stock Value': Math.round(m.stockValue),
    })),
  ]
  return toCSV(rows)
}

/**
 * Stock reconciliation history (issue #194): every counted line of every
 * count session — what the system expected, what the site counted, the
 * signed variance (expected − counted) and the adjustment posted from the
 * line. Uncounted inventory lines are listed with their expected qty at
 * count time and a '—' counted value (same style as materialsLedgerCSV:
 * header row first, KSh-free quantities, ISO date-only).
 */
export function reconciliationCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = [
    {
      'Count ID': t('csv.rec.countId'), 'Counted At': t('csv.rec.countedAt'), 'Counted By': t('csv.rec.countedBy'),
      Status: t('csv.rec.status'), Material: t('csv.rec.material'), Location: t('csv.rec.location'), Unit: t('csv.rec.unit'),
      'Expected Qty': t('csv.rec.expectedQty'), 'Counted Qty': t('csv.rec.countedQty'),
      'Variance (Expected − Counted)': t('csv.rec.variance'),
      'Posted Adjustment': t('csv.rec.postedAdjustment'),
    },
    ...p.inventory.counts.flatMap((c) => [
      ...c.items.map((line) => ({
        'Count ID': c.id,
        'Counted At': isoDateOnly(c.countedAt),
        'Counted By': c.countedBy,
        Status: c.status,
        Material: line.materialName,
        Location: line.location,
        Unit: line.unit,
        'Expected Qty': line.expectedQty,
        'Counted Qty': line.countedQty,
        'Variance (Expected − Counted)': line.variance,
        'Posted Adjustment': line.postedQty,
      })),
      ...c.uncounted.map((line) => ({
        'Count ID': c.id,
        'Counted At': isoDateOnly(c.countedAt),
        'Counted By': c.countedBy,
        Status: c.status,
        Material: line.materialName,
        Location: line.location,
        Unit: line.unit,
        'Expected Qty': line.expectedQty,
        'Counted Qty': '—',
        'Variance (Expected − Counted)': '—',
        'Posted Adjustment': '—',
      })),
    ]),
  ]
  return toCSV(rows)
}

/** Fundi attendance & wages for the current day + week. */
export function attendanceCSV(t: TranslateFn, p: ProjectPayload): string {
  const statusLabel = (s: string | null): string => (s ? t(`fundis.status.${s}`) : '—')
  const rows: CSVRow[] = [
    {
      Worker: t('csv.att.worker'), Role: t('csv.att.role'), 'Daily Rate': t('csv.att.dailyRate'),
      'Today Status': t('csv.att.todayStatus'), 'Today Wage': t('csv.att.todayWage'),
      Paid: t('csv.att.paid'), 'Week Earnings': t('csv.att.weekEarnings'),
    },
    ...p.workers.map((w) => ({
      Worker: w.name,
      Role: w.role,
      'Daily Rate': Math.round(w.dailyRate),
      'Today Status': statusLabel(w.todayStatus.status),
      'Today Wage': Math.round(w.todayStatus.wage),
      Paid: w.todayStatus.paid ? t('csv.yes') : t('csv.no'),
      'Week Earnings': Math.round(w.weekEarnings),
    })),
  ]
  return toCSV(rows)
}

/** Money trail: every transaction on the project. */
export function transactionsCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = [
    { Date: t('csv.tx.date'), Type: t('csv.tx.type'), Amount: t('csv.tx.amount'), Method: t('csv.tx.method'), Reference: t('csv.tx.reference'), Note: t('csv.tx.note') },
    ...p.transactions.map((tr) => ({
      Date: isoDateOnly(tr.date),
      Type: tr.type,
      Amount: Math.round(tr.amount),
      Method: tr.method,
      Reference: tr.reference ?? '—',
      Note: tr.note ?? '',
    })),
  ]
  return toCSV(rows)
}

/**
 * Invoices list (issue #363 / MD-8): the Finder invoices tab's CSV face —
 * every invoice with its subtotal/tax/total, plus the shared zero-VAT
 * posture note as a trailing row while any exported invoice is zero-tax,
 * so the export can never render unlabeled zero-tax totals. Same
 * conventions as the tab: KSh plain rounded numbers, ISO date-only,
 * DB enum statuses verbatim.
 */
export function invoicesCSV(t: TranslateFn, invoices: InvoiceWithLines[]): string {
  const rows: CSVRow[] = [
    {
      Invoice: t('csv.inv.invoice'), Supplier: t('csv.inv.supplier'), PO: t('csv.inv.po'),
      Status: t('csv.inv.status'), Subtotal: t('csv.inv.subtotal'), Tax: t('csv.inv.tax'),
      Total: t('csv.inv.total'), Due: t('csv.inv.due'),
    },
    ...invoices.map((inv) => ({
      Invoice: inv.invoiceCode,
      Supplier: inv.supplierName ?? '—',
      PO: inv.orderCode ?? '—',
      Status: inv.status,
      Subtotal: Math.round(inv.subtotal),
      Tax: Math.round(inv.tax),
      Total: Math.round(inv.total),
      Due: inv.dueDate ? isoDateOnly(inv.dueDate) : '—',
    })),
  ]
  if (anyZeroTaxInvoice(invoices.map((inv) => inv.tax))) {
    rows.push({
      Invoice: t('finder.inv.vatNote'), Supplier: '', PO: '', Status: '',
      Subtotal: '', Tax: '', Total: '', Due: '',
    })
  }
  return toCSV(rows)
}

/** One-page project snapshot as key,value rows. */
export function projectSummaryCSV(t: TranslateFn, p: ProjectPayload): string {
  const s = p.summary
  const rows: Array<{ key: string; value: string | number }> = [
    { key: t('csv.sum.key'), value: t('csv.sum.value') },
    { key: t('csv.sum.project'), value: p.project.name },
    { key: t('csv.sum.client'), value: p.project.client || '—' },
    { key: t('csv.sum.location'), value: p.project.location || '—' },
    { key: t('csv.sum.status'), value: p.project.status },
    { key: t('csv.sum.dayCount'), value: s.dayCount },
    { key: t('csv.sum.progress'), value: s.progressPct },
    { key: t('csv.sum.budgetTotal'), value: Math.round(s.budgetTotal) },
    { key: t('csv.sum.budgetSpent'), value: Math.round(s.budgetSpent) },
    { key: t('csv.sum.spendDelta'), value: s.spendVsPlanDelta },
    { key: t('csv.sum.fundisToday'), value: s.fundisToday },
    { key: t('csv.sum.unackedAlerts'), value: s.unackedAlerts },
  ]
  return toCSV(rows)
}

/** Convenience: suggested filename prefix for a project. */
export function projectFilePrefix(p: ProjectPayload): string {
  return `mjengo-${slug(p.project.name)}`
}
