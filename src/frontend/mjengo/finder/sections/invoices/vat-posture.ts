/**
 * Invoice VAT posture (issue #363 / audit MD-8) — PURE, unit-tested.
 *
 * Kenya VAT handling is deliberately deferred (a business decision —
 * audit register MD-8): the platform models no
 * VAT. An invoice can still carry a manually entered flat tax amount (the
 * create dialog's "Tax / VAT (KSh)" field — stored verbatim by the service,
 * never recomputed), but zero is the default and the honest rule. The
 * register's finding was that this posture lived in docs only — the invoice
 * surface itself said nothing while rendering a zero tax line.
 *
 * This module is the SINGLE seam every invoice surface reads (the #123
 * wallet-posture.ts design): the detail dialog, the printable record (PDF),
 * the invoices tab list + decision queue + pay/create dialogs, the supplier
 * portal list, and the CSV export all render ONE shared note
 * (`finder.inv.vatNote`, en + sw) under ONE shared condition.
 *
 * POSTURE-CHANGE RETIREMENT (the WALLET_RAILS_POSTURE discipline): the note
 * is gated on this constant, so when real tax/VAT modeling lands the flip to
 * 'configured' retires the note everywhere at once — including for invoices
 * that remain legitimately zero-tax (a zero-rated supply is then a tax fact,
 * not a missing feature, and deserves different copy).
 */

/** What the VAT milestone tracks. 'not-applied' today; 'configured' once tax/VAT modeling lands. */
export type InvoiceVatPosture = 'not-applied' | 'configured'

/** The current posture of invoice VAT handling on the platform. */
export const INVOICE_VAT_POSTURE: InvoiceVatPosture = 'not-applied'

/**
 * Should the zero-VAT note render for this tax amount? True only while the
 * platform posture is 'not-applied' AND the invoice's tax line is zero:
 *   · a manually taxed invoice (tax > 0) states its own tax — no note;
 *   · under a 'configured' posture the note is retired everywhere (the
 *     flip is the deliberate act that retires it).
 * Strict `=== 0`: a negative or non-numeric tax is never "zero-VAT" (the
 * service already rejects negatives; garbage must not earn a clean label).
 */
export function shouldShowZeroVatNote(
  tax: number,
  posture: InvoiceVatPosture = INVOICE_VAT_POSTURE,
): boolean {
  return posture === 'not-applied' && tax === 0
}

/**
 * Should a LIST of invoices surface the note once? True when any listed
 * invoice would show it on its own — the tab list, the supplier table and
 * the CSV export state the posture once beside the rows it explains.
 */
export function anyZeroTaxInvoice(taxes: number[], posture: InvoiceVatPosture = INVOICE_VAT_POSTURE): boolean {
  return taxes.some((tax) => shouldShowZeroVatNote(tax, posture))
}
