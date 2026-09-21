import { expect, test } from '@playwright/test'
import { openTab, signIn } from './helpers'

/**
 * Persona 6 — FINANCE OFFICER (Fatuma, the money surface).
 * Golden path (issue #182, from the 2026-09-16 QA browser pass §10): sign in → lands
 * on Money → escrow wallet + payment requests → invoices (Finder) → the
 * "Ledger consistent" chip (derived = stored projection).
 *
 * Seed contract: finance@mjengo.os / mjengo2026 — Money/Finder/Evidence,
 * landing tab Money (ROLE_LANDING). The seeded escrow posts a 2,000,000
 * top-up and an 800,000 release — derived 1,200,000 must equal the stored
 * projection, so the consistency chip renders (seed-extras/money.ts).
 */
test.describe('Finance — money-surface golden path', () => {
  test('sign in → money → invoices → ledger consistency chip', async ({ page }) => {
    await signIn(page, 'finance')

    // Lands on the Money tab (ROLE_LANDING.finance) — the panel is live.
    await expect(page.locator('#mjengo-panel-money')).toBeVisible()

    // Escrow KPIs over the seeded wallet.
    await expect(page.getByText('In escrow').first()).toBeVisible()
    await expect(page.getByText('MjengoPay escrow wallet').first()).toBeVisible()

    // Payment requests — the seeded PR-2026-000001 queue.
    await expect(page.getByText('Payment requests').first()).toBeVisible()

    // The double-entry ledger section renders.
    await expect(page.getByText('Double-entry ledger').first()).toBeVisible()

    // THE honesty chip: derived escrow balance equals the stored projection.
    await expect(page.getByText('Ledger consistent').first()).toBeVisible()

    // Invoices — the Finder tab's supplier-invoice surface (finance keeps Finder).
    await openTab(page, 'Finder')
    await expect(page.getByLabel('Supplier invoices')).toBeVisible()
    // Seeded supplier invoice awaiting the client decision.
    await expect(page.getByText('INV-2026-000027').first()).toBeVisible()
  })
})
