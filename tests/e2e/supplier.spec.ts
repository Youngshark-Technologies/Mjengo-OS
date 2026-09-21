import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

/**
 * Persona 5 — SUPPLIER (Nairobi Hardware Centre).
 * Golden path (issue #182, from the 2026-09-16 QA browser pass §10): sign in → the
 * scoped supplier portal → quotes to answer → orders awaiting action.
 *
 * Seed contract: supplier@mjengo.os / supplier2026 (NOTE: its own password —
 * not mjengo2026). The portal is the supplier-role surface (W5-3): quotes
 * requested (MR-1043), purchase orders (PO-2026-000013 awaiting
 * confirmation, PO-2026-000012 dispatched), invoices / 3-way-match framing.
 */
test.describe('Supplier — scoped portal golden path', () => {
  test('sign in → supplier portal → quotes → orders awaiting action', async ({ page }) => {
    await signIn(page, 'supplier')

    // The portal header — MjengoOS · Supplier portal + the linked business.
    await expect(page.getByText('Supplier portal', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Nairobi Hardware Centre').first()).toBeVisible()

    // Needs-your-action stats over the seeded chain.
    await expect(page.getByText('RFQs waiting for your price').first()).toBeVisible()
    await expect(page.getByText('Orders awaiting your confirmation').first()).toBeVisible()

    // Quotes — MR-1043 is seeded REQUESTED: the card awaits the supplier's price.
    await expect(page.getByText('Quotes requested of you').first()).toBeVisible()
    await expect(page.getByText('Awaiting your price').first()).toBeVisible()
    await expect(page.getByText('MR-1043').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Submit (your )?quote/ }).first()).toBeVisible()

    // Orders — PO-2026-000013 is seeded SENT: confirm + dispatch are the actions.
    await expect(page.getByText('Your purchase orders').first()).toBeVisible()
    await expect(page.getByText('PO-2026-000013').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Confirm order/ }).first()).toBeVisible()

    // The honest money end — supplier invoices with 3-way-match framing.
    await expect(page.getByText('Your invoices').first()).toBeVisible()
    await expect(page.getByText('INV-2026-000027').first()).toBeVisible()
  })
})
