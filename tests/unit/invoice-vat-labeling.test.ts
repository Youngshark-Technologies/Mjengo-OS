/**
 * #363 / audit MD-8 — the zero-VAT invoice labeling, pinned three ways:
 *
 *   · BEHAVIORAL (the posture seam — finder/sections/invoices/vat-posture.ts,
 *     the #123 wallet-posture.ts design): the note renders only while the
 *     platform posture is 'not-applied' AND the tax line is zero — a manually
 *     taxed invoice states its own tax, and the future 'configured' flip
 *     retires the note everywhere at once (a zero-rated supply is then a tax
 *     fact, not a missing feature).
 *
 *   · BEHAVIORAL (the CSV surface — export-utils.invoicesCSV): the export
 *     carries the SAME shared note as a trailing row whenever a zero-tax
 *     invoice is exported, never per-row, never for a fully taxed export, and
 *     honors the active locale (the #125 artifact discipline).
 *
 *   · SOURCE PINS (the repo's no-DOM frontend convention — cf. i18n.test.ts /
 *     wallet-posture-banner.test.ts): every invoice surface that shows totals
 *     (detail dialog, printable record = the print/PDF surface, tab list,
 *     decision-queue card, pay dialog, create dialog, supplier portal list)
 *     renders the ONE shared key through the ONE shared seam — no surface
 *     re-implements the condition, no stale copy survives (the old
 *     "demo data — tax line is zero" wording claimed a VAT-inclusive
 *     rationale the platform does not have), and the tab wires the CSV
 *     export button to the same builder.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INVOICE_VAT_POSTURE,
  anyZeroTaxInvoice,
  shouldShowZeroVatNote,
} from '@/frontend/mjengo/finder/sections/invoices/vat-posture'
import { invoicesCSV } from '@/frontend/mjengo/export-utils'
import { translate } from '@/frontend/i18n/provider'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import type { InvoiceWithLines } from '@/backend/modules/invoices/types'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

const t = (key: string, vars?: Record<string, string | number>): string =>
  translate(enDict, key, vars)
const tSw = (key: string, vars?: Record<string, string | number>): string =>
  translate(swDict, key, vars)

/** Minimal honest InvoiceWithLines fixture (KSh numbers, one line). */
function inv(tax: number, overrides: Partial<InvoiceWithLines> = {}): InvoiceWithLines {
  const subtotal = 10_000
  return {
    id: 'inv_1', invoiceCode: 'INV-2026-000031', projectId: 'p1',
    orderId: null, supplierId: null, status: 'submitted', createdBy: 'Amani',
    subtotal, tax, total: subtotal + tax,
    dueDate: new Date('2026-03-01T00:00:00Z'), issuedAt: new Date('2026-02-01T00:00:00Z'),
    submittedAt: new Date('2026-02-02T00:00:00Z'), decidedAt: null, decidedBy: null,
    paidAt: null, paidByRole: null, paymentMethod: null, paymentReference: null,
    note: null, createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z'),
    lines: [{ id: 'l1', invoiceId: 'inv_1', name: 'Cement (32.5N)', qty: 20, unitPrice: 500, lineTotal: subtotal }],
    supplierName: 'Kisumu Builders', orderCode: 'PO-2026-000101',
    ...overrides,
  }
}

const csvRows = (csv: string): string[][] =>
  csv.split('\r\n').map((line) => line.slice(1, -1).split('","'))

// ---------------- behavioral · the posture seam ----------------

describe('#363 posture seam: shouldShowZeroVatNote / anyZeroTaxInvoice', () => {
  it('the current posture is not-applied (flipping it is the deliberate VAT-modeling act)', () => {
    expect(INVOICE_VAT_POSTURE).toBe('not-applied')
  })

  it('zero tax + not-applied posture → the note renders (the MD-8 default)', () => {
    expect(shouldShowZeroVatNote(0)).toBe(true)
  })

  it('a manually taxed invoice states its own tax — no note', () => {
    expect(shouldShowZeroVatNote(1)).toBe(false)
    expect(shouldShowZeroVatNote(1_600)).toBe(false)
  })

  it('a configured posture retires the note everywhere, even for zero-tax rows', () => {
    expect(shouldShowZeroVatNote(0, 'configured')).toBe(false)
    expect(shouldShowZeroVatNote(1_600, 'configured')).toBe(false)
    expect(shouldShowZeroVatNote(0, 'not-applied')).toBe(true)
  })

  it('strict zero only — negative or non-numeric tax never earns the clean label', () => {
    expect(shouldShowZeroVatNote(-1)).toBe(false)
    expect(shouldShowZeroVatNote(NaN)).toBe(false)
  })

  it('anyZeroTaxInvoice is the list form: true when any row would show the note', () => {
    expect(anyZeroTaxInvoice([])).toBe(false)
    expect(anyZeroTaxInvoice([0])).toBe(true)
    expect(anyZeroTaxInvoice([500, 0, 250])).toBe(true)
    expect(anyZeroTaxInvoice([500, 250])).toBe(false)
    expect(anyZeroTaxInvoice([0], 'configured')).toBe(false)
  })
})

// ---------------- behavioral · the CSV surface ----------------

describe('#363 invoicesCSV: the export carries the zero-VAT note', () => {
  it('zero-tax export: header + data rows + ONE trailing note row (rounded KSh, ISO date-only)', () => {
    const csv = invoicesCSV(t, [inv(0)])
    const rows = csvRows(csv)
    expect(rows[0]).toEqual(['Invoice', 'Supplier', 'PO', 'Status', 'Subtotal', 'Tax', 'Total', 'Due'])
    expect(rows[1]).toEqual(['INV-2026-000031', 'Kisumu Builders', 'PO-2026-000101', 'submitted', '10000', '0', '10000', '2026-03-01'])
    expect(rows[2]).toEqual([enDict['finder.inv.vatNote'], '', '', '', '', '', '', ''])
    expect(rows).toHaveLength(3)
  })

  it('a mixed export: the note follows ANY zero-tax row (one note, not one per row)', () => {
    const csv = invoicesCSV(t, [
      inv(0),
      inv(1_600, { id: 'inv_2', invoiceCode: 'INV-2026-000032', supplierName: null, orderCode: null, dueDate: null }),
    ])
    const rows = csvRows(csv)
    expect(rows[2]).toEqual(['INV-2026-000032', '—', '—', 'submitted', '10000', '1600', '11600', '—'])
    expect(rows[3][0]).toBe(enDict['finder.inv.vatNote'])
    expect(rows.filter((r) => r[0] === enDict['finder.inv.vatNote'])).toHaveLength(1)
  })

  it('a fully taxed export renders NO note (those rows state their own tax)', () => {
    const csv = invoicesCSV(t, [inv(1_600)])
    expect(csv).not.toContain('VAT is not applied')
    expect(csvRows(csv)).toHaveLength(2)
  })

  it('an empty export is just the header — no note about invoices that do not exist', () => {
    expect(csvRows(invoicesCSV(t, []))).toEqual([['Invoice', 'Supplier', 'PO', 'Status', 'Subtotal', 'Tax', 'Total', 'Due']])
  })

  it('the note and headers honor the active locale (#125 artifact discipline)', () => {
    const rows = csvRows(invoicesCSV(tSw, [inv(0)]))
    expect(rows[0]).toEqual(['Invoisi', 'Msambazaji', 'PO', 'Hali', 'Jumla ndogo', 'Kodi', 'Jumla', 'Inapaswa kulipwa'])
    expect(rows[2][0]).toBe(swDict['finder.inv.vatNote'])
    expect(rows[2][0]).toContain('VAT haijatumika')
  })
})

// ---------------- the shared note · dictionaries ----------------

describe('#363 the shared note: one key, both languages, honest wording', () => {
  it('finder.inv.vatNote carries the exact audited copy in both dictionaries', () => {
    expect(enDict['finder.inv.vatNote']).toBe('VAT is not applied — tax configuration is pending (MD-8); totals include no VAT.')
    expect(swDict['finder.inv.vatNote']).toBe('VAT haijatumika — mpangilio wa kodi bado unasubiri (MD-8); jumla hazijumuishi VAT.')
  })

  it('the stale det-scoped copy is gone (it claimed a VAT-inclusive demo rationale the platform does not have)', () => {
    expect(enDict).not.toHaveProperty('finder.inv.det.vatNote')
    expect(swDict).not.toHaveProperty('finder.inv.det.vatNote')
    // the invoice families carry no surviving stale wording (scoped — the
    // welcome screen's legitimate "Explore demo data" key is out of scope)
    for (const [k, v] of Object.entries(enDict)) {
      if (k.startsWith('finder.inv.')) expect(v, `en.${k}`).not.toContain('demo data')
    }
    for (const [k, v] of Object.entries(swDict)) {
      if (k.startsWith('finder.inv.')) expect(v, `sw.${k}`).not.toContain('data ya mfano')
    }
  })

  it('the export keys + csv.inv.* header family exist in both dictionaries', () => {
    for (const key of [
      'finder.inv.exportCsv', 'finder.inv.exportCsvAria',
      'csv.inv.invoice', 'csv.inv.supplier', 'csv.inv.po', 'csv.inv.status',
      'csv.inv.subtotal', 'csv.inv.tax', 'csv.inv.total', 'csv.inv.due',
    ]) {
      expect(enDict, `en.ts is missing "${key}"`).toHaveProperty(key)
      expect(swDict, `sw.ts is missing "${key}"`).toHaveProperty(key)
    }
  })
})

// ---------------- source pins · every surface renders the note ----------------

describe('#363 surface wiring: every invoice surface renders the shared note', () => {
  const SURFACES: Record<string, string> = {
    'detail dialog': 'src/frontend/mjengo/finder/sections/invoices/invoice-detail-dialog.tsx',
    'printable record (PDF)': 'src/frontend/mjengo/finder/sections/invoices/printable-invoice.tsx',
    'decision-queue card': 'src/frontend/mjengo/finder/sections/invoices/decision-queue-card.tsx',
    'pay dialog': 'src/frontend/mjengo/finder/sections/invoices/pay-invoice-dialog.tsx',
    'create dialog': 'src/frontend/mjengo/finder/sections/invoices/create-invoice-dialog.tsx',
    'invoices tab list': 'src/frontend/mjengo/finder/sections/invoices-section.tsx',
    'supplier portal list': 'src/frontend/mjengo/supplier/supplier-invoices.tsx',
  }

  it.each(Object.entries(SURFACES))('%s renders the shared key through the posture seam', (_name, file) => {
    const src = readSrc(file)
    expect(src, `${file} lost the shared note`).toContain("t('finder.inv.vatNote')")
    expect(src, `${file} must gate on the shared seam, not a local condition`).toMatch(
      /shouldShowZeroVatNote|anyZeroTaxInvoice/,
    )
  })

  it('no invoice surface re-implements the condition as a raw tax === 0 check (the seam is the only definer)', () => {
    for (const file of [...Object.values(SURFACES), 'src/frontend/mjengo/export-utils.ts']) {
      expect(readSrc(file), `${file} re-implements the zero-tax condition`).not.toMatch(/tax === 0/)
    }
    // the seam itself IS the definer
    expect(readSrc('src/frontend/mjengo/finder/sections/invoices/vat-posture.ts')).toContain('tax === 0')
  })

  it('the per-invoice surfaces gate on the invoice\'s own tax; the lists gate once via anyZeroTaxInvoice', () => {
    for (const file of [
      'src/frontend/mjengo/finder/sections/invoices/invoice-detail-dialog.tsx',
      'src/frontend/mjengo/finder/sections/invoices/printable-invoice.tsx',
      'src/frontend/mjengo/finder/sections/invoices/decision-queue-card.tsx',
      'src/frontend/mjengo/finder/sections/invoices/pay-invoice-dialog.tsx',
    ]) {
      expect(readSrc(file)).toContain('shouldShowZeroVatNote(invoice.tax)')
    }
    // the create dialog gates on the DRAFT's tax (the note steps aside the
    // moment a manual tax is entered — the posture is per-invoice)
    expect(readSrc('src/frontend/mjengo/finder/sections/invoices/create-invoice-dialog.tsx'))
      .toContain('shouldShowZeroVatNote(Number(tax) || 0)')
    for (const file of [
      'src/frontend/mjengo/finder/sections/invoices-section.tsx',
      'src/frontend/mjengo/supplier/supplier-invoices.tsx',
    ]) {
      expect(readSrc(file)).toContain('anyZeroTaxInvoice(')
    }
  })

  it('the printable record places the note under the totals block (the paper/PDF surface)', () => {
    const src = readSrc('src/frontend/mjengo/finder/sections/invoices/printable-invoice.tsx')
    expect(src.indexOf("t('finder.inv.vatNote')")).toBeGreaterThan(src.indexOf("t('finder.inv.print.total')"))
    // the footer keeps its "not a tax document" line — the two disclosures stack
    expect(src).toContain("t('finder.inv.print.footer'")
  })

  it('the tab wires the CSV export (the materials-tab idiom: downloadCSV + builder + prefix + toast)', () => {
    const src = readSrc('src/frontend/mjengo/finder/sections/invoices-section.tsx')
    expect(src).toContain('import { downloadCSV, invoicesCSV, projectFilePrefix }')
    expect(src).toContain('invoicesCSV(t, invoices)')
    expect(src).toContain('}-invoices.csv')
    expect(src).toContain("t('finder.inv.exportCsv')")
    expect(src).toContain("t('finder.inv.exportCsvAria')")
    expect(src).toContain("t('field.exported', { file: filename })")
  })

  it('export-utils takes t() and reads the shared seam (the #125 artifact convention)', () => {
    const src = readSrc('src/frontend/mjengo/export-utils.ts')
    expect(src).toContain('invoicesCSV(t: TranslateFn')
    expect(src).toContain('anyZeroTaxInvoice(invoices.map((inv) => inv.tax))')
    expect(src).toContain("t('finder.inv.vatNote')")
  })
})
