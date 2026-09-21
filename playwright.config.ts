import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E — the 7 persona golden paths (issue #182 / TEST-1).
 *
 * The suite drives the REAL app on http://localhost:3000 against the SEEDED
 * dev database (prisma/seed-all.ts — `bun run seed`). Every spec asserts
 * actual application state (tab shells, seeded project names, seeded
 * request/order codes), never just "the page loaded".
 *
 * REPO CONVENTION — running dev server, not a managed webServer:
 * The Mjengo-OS QA flow (the browser-verification protocol — historical
 * runs against an already-running dev server, so the suite assumes one is up.
 * Start it yourself exactly like the repo does:
 *
 *   DATABASE_URL=file:./db/custom.db bun run dev
 *
 * (absolute path works too — the sandbox dev server uses
 *  DATABASE_URL=file:/home/z/my-project/db/custom.db). The server must be
 * reachable at http://localhost:3000 and the database must be migrated +
 * seeded (`bun run seed`). If you prefer Playwright to boot and own the
 * server, uncomment the webServer block below.
 */

export default defineConfig({
  testDir: './tests/e2e',
  /* Dev-server cold compiles routes on first hit (Next 16 on-demand), and the
     app boots a PWA shell + session check before the login gate — be generous. */
  timeout: 90_000,
  expect: { timeout: 15_000 },
  /* The specs share ONE seeded dev database and one dev server — no parallel
     workers, no retries: a golden path either walks or it does not. */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    /* Overridable for isolated runs: E2E_BASE_URL=http://localhost:3210 bun run test:e2e */
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    /* Desktop-class viewport so the header's desktop tab strip (role="tab",
       ids `mjengo-tab-<key>`) is the interactable one — the mobile bottom bar
       duplicates the roles behind `md:hidden`. */
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Africa/Nairobi',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // ── Optional: let Playwright manage the dev server (uncomment to use) ──
  // webServer: {
  //   command: 'DATABASE_URL=file:./db/custom.db bun run dev',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: true,   // never double-start against a running dev server
  //   timeout: 120_000,            // Next 16 dev boot (compile-on-demand)
  // },
})
