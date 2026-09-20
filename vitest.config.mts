import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration — starter suite (Task 5-e).
 *
 *  · path alias `@/` → `./src/` (mirrors tsconfig.json `paths`, so tests import
 *    application modules exactly like production code does);
 *  · path alias `@/lib/site` → `./mjengoos-website/lib/site` — the marketing
 *    website (mjengoos-website/) is a separate Next.js app whose own tsconfig
 *    maps `@/*` → the SITE root, and its tests live in THIS suite (repo
 *    convention, docs/adr/0003), so the website modules imported here must
 *    resolve their `@/lib/site` specifier against the site root exactly like
 *    the site's build does. Specific key FIRST (aliases match in order);
 *    every other `@/…` keeps meaning `./src/`;
 *  · node environment: the seams under test are pure/shared/server modules,
 *    no DOM needed. EXCEPTION (issue #137 / audit FE-8): files under
 *    tests/dom/ opt into jsdom PER FILE via the first-line
 *    `// @vitest-environment jsdom` docblock pragma — vitest's supported
 *    scoping mechanism — so THIS default stays node for every other suite
 *    (no environmentMatchGlobs/projects split needed; jsdom is the only dev
 *    dependency the tier adds). The runtime suite renders React 19 via
 *    react-dom/client + `act` (no @testing-library — see
 *    tests/dom/_helpers/react-render.ts for the harness and its two pinned
 *    gotchas: async act for discrete events, auto-cleanup for id lookups);
 *  · conservative execution for the 4GB CI/dev box: one fork, no file
 *    parallelism, tests inside a file run sequentially.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@/lib/site': fileURLToPath(new URL('./mjengoos-website/lib/site', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    // Hermetic store for every module-level rate-limit/lockout wiring (issue
    // #158 made the multi-process SQLite store the DEFAULT): unit tests run on
    // the in-memory stores so bucket/lockout state can never leak across test
    // files or runs via a persisted db/ratelimit.db. The default wiring and
    // its failure ladder are pinned EXPLICITLY (temp-file sqlite, vi.resetModules
    // re-imports) in tests/unit/rate-limit-store.test.ts — this override only
    // fixes what the rest of the suite runs on.
    env: { RATE_LIMIT_STORE: 'memory' },
    // Issue #204: every route-kit/raw-route handler invocation now emits one
    // request-access line ([http] METHOD /path STATUS Nms rid=… — JSON when
    // LOG_FORMAT=json). Across ~2k route-level tests that is thousands of
    // no-signal lines drowning real test output, so they are filtered HERE.
    // The logger's own contract (shape, rid, access line) is pinned in
    // tests/unit/log.test.ts via console spies, which replace the method and
    // never reach this hook.
    onConsoleLog(log) {
      if (log.startsWith('[http] ')) return false
      if (log.startsWith('{') && log.includes('"scope":"http"')) return false
      // Issue #202: the error sink's once-per-process "unconfigured" warning
      // (fires once in any test file that exercises a wired catch path with
      // ERROR_SINK_URL unset — the default posture). The warning's CONTRACT
      // (exactly once, honestly labeled) is pinned in
      // tests/unit/error-sink.test.ts via console spies, which replace the
      // method and never reach this hook.
      if (log.includes('ERROR_SINK_URL is not set')) return false
    },

    // =====================================================================
    // COVERAGE (issue #185, audit register TEST-4) — `bun run test:coverage`
    // =====================================================================
    // Provider v8 (no source instrumentation — fast, and the suite's only
    // execution mode is this very vitest run). Reporters: text (the table in
    // the terminal) + lcov (coverage/lcov.info — uploaded as a CI artifact by
    // .github/workflows/test.yml once #98's billing lock lifts; locally it is
    // simply written next to the text report in coverage/, which is
    // gitignored). Runtime cost measured on main @b035c74: 143 test files /
    // 3,159 tests, 129.5s plain → 143.2s with coverage (+11%) — well inside
    // the 4GB box's 10-minute CI timeout, fileParallelism: false kept.
    //
    // SCOPE: include is the whole `src/**` TypeScript tree (the marketing
    // site is a separate app with its own gates; `@/lib/site` resolves
    // outside src/). Scoped to *.{ts,tsx} because the five non-source files
    // under src/ (globals.css + four READMEs) are meaningless as coverage
    // and only produce parse noise. Because `include` is set, vitest also
    // lists files the suite never imports — at 0% — so the report doubles
    // as the inventory check: a whole module with zero tests is VISIBLE,
    // not silently absent. The one exclusion is `src/frontend/ui/**` — the
    // generated shadcn/radix scaffolding (vendored primitives, not
    // repo-authored logic); covering it would be noise, which is also
    // exactly why there is NO repo-wide floor: the src/ tree also contains
    // the app-router surface and large UI swaths that this node-env suite
    // exercises only via grep-contract tests, so a global threshold would
    // either fail the build or be set so low it says nothing. Measured
    // repo-wide on main @b035c74: 50.01% lines / 38.08% branches —
    // reported, not floored.
    //
    // THRESHOLDS — measure-first floors for the CRITICAL modules only (money
    // path, sync/outbox core, guard/auth seams), each set at floor(measured)
    // on main @b035c74 (143 files / 3,159 tests, all green). These are
    // TODAY'S TRUTH, not aspirations — none of them fails the build on day
    // one. RATCHET CONVENTION (CONTRIBUTING.md §"Coverage floors"): when a
    // PR raises a module's measured coverage, bump its floor in the same PR;
    // never lower one without an issue that documents why. Vitest's
    // `thresholds.autoUpdate` is deliberately OFF — it would rewrite this
    // file on green runs and there is no write-back path from CI; the
    // conscious, reviewed edit IS the convention.
    //
    //   glob                                measured (lines/branches)  floor
    //   ──────────────────────────────────  ────────────────────────  ─────
    //   money path (issue: wallet/ledger/supply "at minimum")
    //   src/backend/modules/wallet/**       87.48 / 71.76             87/71
    //   src/backend/modules/ledger/**       91.30 / 91.18             91/91
    //   src/backend/modules/supply/**       64.91 / 48.50             64/48
    //   src/backend/modules/invoices/**     74.44 / 54.91             74/54
    //   src/backend/lib/money*.ts           93.90 / 95.00             93/95
    //   src/backend/lib/idempotency.ts     100.0 / 100.0            100/100
    //   sync / outbox core
    //   src/backend/api/sync.ts             78.21 / 56.64             78/56
    //   src/frontend/lib/outbox.ts          94.44 / 92.11             94/92
    //   guard / auth seams
    //   src/backend/lib/guard.ts           100.0 / 89.74             100/89
    //   src/backend/lib/auth.ts             35.19 / 25.33             35/25
    //   src/backend/lib/next-auth-guard.ts 100.0 / 100.0            100/100
    //   src/backend/lib/membership-scope   100.0 / 93.75             100/93
    //   src/shared/permissions.ts           86.49 / 77.27             86/77
    //
    // MEASURED BUT DELIBERATELY NOT FLOORED (keep this honest when editing):
    //   · src/backend/api/v1/** (incl. the 8 money routes) — 96.27/86.73,
    //     healthy; route contracts are pinned by the v1-* suites; candidate
    //     for a follow-up floor, not for this issue's minimum.
    //   · src/backend/lib/storage/** — 98.75/92.56, own dedicated suites.
    //   · rate-limit(+-sqlite) — 95.82/91.35, abuse-protection family (not
    //     guard/auth proper), own suites.
    //   · src/backend/lib/share-token.ts — 100/100 (not floored only to keep
    //     the floor set equal to the issue's critical-module scope).
    //   · src/frontend/mjengo/offline-boot.ts — 100/100, 5 branches total.
    //   · src/frontend/hooks/use-supplier-outbox.ts — 87.5/54.4, app wiring
    //     AROUND the floored outbox engine.
    //   · src/backend/modules/events/** — 43.86/24.27, the notification bus
    //     (not sync/outbox core): the clearest inventory-style gap this
    //     tooling surfaces; follow-up material, not a floor to enshrine.
    //   · supply per-file weak spots the aggregate floor does NOT hide:
    //     compare.ts 11.29% lines, insights.ts 39.08%, session.ts 26.66% —
    //     the floor keeps the module from collapsing; the per-file numbers
    //     are the ratchet targets.
    //
    // A threshold glob that ever matches zero files (rename/move rot) FAILS
    // the run loudly — an empty group summarizes to 0%. The full set is
    // additionally pinned by tests/unit/coverage-config.test.ts.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/frontend/ui/**'],
      thresholds: {
        // money path
        'src/backend/modules/wallet/**': { lines: 87, branches: 71 },
        'src/backend/modules/ledger/**': { lines: 91, branches: 91 },
        'src/backend/modules/supply/**': { lines: 64, branches: 48 },
        'src/backend/modules/invoices/**': { lines: 74, branches: 54 },
        'src/backend/lib/money*.ts': { lines: 93, branches: 95 },
        'src/backend/lib/idempotency.ts': { lines: 100, branches: 100 },
        // sync / outbox core
        'src/backend/api/sync.ts': { lines: 78, branches: 56 },
        'src/frontend/lib/outbox.ts': { lines: 94, branches: 92 },
        // guard / auth seams
        'src/backend/lib/guard.ts': { lines: 100, branches: 89 },
        'src/backend/lib/auth.ts': { lines: 35, branches: 25 },
        'src/backend/lib/next-auth-guard.ts': { lines: 100, branches: 100 },
        'src/backend/lib/membership-scope.ts': { lines: 100, branches: 93 },
        'src/shared/permissions.ts': { lines: 86, branches: 77 },
      },
    },
  },
})
