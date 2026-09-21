import { expect, test } from '@playwright/test'
import { expectActiveProject, expectTabHidden, openTab, SEEDED_PROJECT, signIn } from './helpers'

/**
 * Persona 2 — CONTRACTOR (site manager, the full owner app).
 * Golden path (issue #182, mirroring the 2026-09-16 QA browser pass §10):
 * sign in → workspace loads (project switcher "Nyumba Yangu — 3BR Bungalow",
 * 12 tabs) → workforce (Fundis) → materials → progress & milestones.
 *
 * Seed contract: contractor@mjengo.os / mjengo2026 owns all three seeded
 * projects; ROLE_TABS.contractor = every tab except audit/supplier (12).
 */
test.describe('Contractor — full owner-app golden path', () => {
  test('sign in → project → workforce → materials → progress/milestones', async ({ page }) => {
    await signIn(page, 'contractor')

    // Workspace: the seeded project is the active one, with the full strip.
    await expectActiveProject(page)
    // The header's desktop strip carries the contractor's 12 role tabs
    // (W1-PERM: everything except the admin-only Audit and supplier portal).
    const tabCount = await page.locator('header nav[role="tablist"] [role="tab"]').count()
    expect(tabCount).toBe(12)
    // Audit is admin-only; the supplier portal is supplier-role-only.
    await expectTabHidden(page, 'Audit')

    // Overview — the role dashboard + phase table for the seeded build.
    await openTab(page, 'Overview')
    await expect(page.getByText('Project health', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Phases', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Site Prep & Foundation').first()).toBeVisible()

    // Workforce — Fundis: today's crew + the seeded roster + attendance matrix.
    await openTab(page, 'Fundis')
    await expect(page.getByText('On site today', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Labour summary — workforce trust', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Attendance — last 7 days', { exact: true }).first()).toBeVisible()
    // Seeded workers (prisma/seed.ts workerDefs).
    await expect(page.getByText('Mwangi Kariuki').first()).toBeVisible()
    await expect(page.getByText('Otieno Odhiambo').first()).toBeVisible()

    // Materials — the global catalog + site store movements.
    await openTab(page, 'Materials')
    await expect(page.getByText('Site Store', { exact: true }).first()).toBeVisible()
    // Seeded catalog rows.
    await expect(page.getByText('Cement (32.5N)').first()).toBeVisible()
    await expect(page.getByText('Machine cut stones 9"').first()).toBeVisible()

    // Progress/milestones — the build plan, then money tied to proof of work.
    await openTab(page, 'Site Plan')
    await expect(page.getByText(`Build plan — ${SEEDED_PROJECT}`)).toBeVisible()
    await expect(page.getByText('Ring beam shuttering & casting').first()).toBeVisible()

    await openTab(page, 'Money')
    await expect(page.getByText('Milestones — money tied to proof of work', { exact: true }).first()).toBeVisible()
    // Seeded milestones: one released, one awaiting release.
    await expect(page.getByText('Foundation complete').first()).toBeVisible()
    await expect(page.getByText('Walling to ring beam').first()).toBeVisible()
  })
})
