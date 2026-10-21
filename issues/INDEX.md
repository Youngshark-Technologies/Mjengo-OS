# MjengoOS — Production Readiness Issue Registry

Single source of truth for task status, ownership, and evidence. Workflow per issue:
`issue → temp branch from main → implement + tests → PR review → local QA gates → merge to dev (then main)` — no direct commits to `main`.

**Local QA gates (CI disabled — see ISSUE-098-style billing lock; local gates are the real gates):**
1. `bun run lint` 2. `bunx tsc --noEmit` 3. `bunx prisma db push` + integrity 4. security review (secrets, authz) 5. browser E2E golden paths 6. regression pass 7. independent code review 8. Principal acceptance.

| ID | Title | Team | Branch | Status |
|----|-------|------|--------|--------|
| MJG-001 | Construction-domain database schema (Prisma/SQLite) | Database | infra/db-schema | DONE |
| MJG-002 | Real authentication & server-side authorization (sessions, scrypt) | Security | feat/auth-api | DONE |
| MJG-003 | Dashboard API — metrics computed from live records (zero hardcoded stats) | Backend | feat/dashboard-api | DONE |
| MJG-004 | Sites, materials, inventory & milestones APIs (org-scoped, zod-validated) | Backend | feat/api-sites-materials | DONE |
| MJG-005 | Suppliers, purchase orders & deliveries APIs (human verification) | Backend | feat/api-procurement | DONE |
| MJG-006 | Workforce, site evidence & payments APIs (human-only verification/approval red line) | Backend | feat/api-workforce-evidence-payments | DONE |
| MJG-007 | Marketing landing + 17s six-scene hero animation (original choreography, a11y, reduced-motion) | Frontend | feat/marketing-hero | DONE |
| MJG-008 | App shell + dashboard/sites/inventory views (live data, real empty/error states) | Frontend | feat/views-operations | DONE |
| MJG-009 | Procurement/deliveries/payments views + workforce/evidence views + auth view | Frontend | feat/views-commerce | DONE |
| MJG-010 | SPA integration, page wiring, navigation & session routing | Frontend | feat/spa-integration | DONE |
| MJG-011 | Hardcoded-data elimination audit & report | QA | chore/hardcoded-audit | DONE |
| MJG-012 | End-to-end browser QA (golden journeys), regression & gates evidence | QA | chore/e2e-qa | DONE |
| MJG-013 | Git consolidation: exactly `dev` + `main`, temp branch cleanup, final report | DevOps | chore/git-consolidation | DONE |
| MJG-014 | Org member management: OWNER creates SUPERVISOR/WORKER members (discovered via E2E planning — without it the evidence segregation-of-duties journey is unreachable) | Security+Frontend | feat/org-members | DONE |
| MJG-015 | Material catalogue UI: add-material dialog in inventory view (E2E gap — stock-in was impossible without catalogue entries) | Frontend | feat/material-ui | DONE |
| MJG-016 | Delivery supplier inherited from PO: server denormalization + display fallback (discovered in live walkthrough — PO-linked deliveries showed "No supplier recorded") | Backend | feat/delivery-supplier | DONE |
| MJG-017 | Attendance save-bar visibility: dirty-state emphasis + aria-live (discovered in live walkthrough — queued changes were easy to miss; batch save stays by design) | Frontend | feat/attendance-savebar | DONE |
| MJG-018 | SQLite backup & restore drill kit: VACUUM INTO backup, integrity check, count-verified restore, cron doc (report §7 item 2) | DevOps | chore/backup-kit | DONE |
| MJG-019 | Deployment kit: Dockerfile + entrypoint, .env.example, docs/DEPLOYMENT.md, scripts/smoke.sh, /api health log typo (report §7 item 1 — sandbox-testable parts) | DevOps | chore/deploy-kit | DONE |
| MJG-020 | Replayable API integration suite: bun:test against production server + isolated DB on :3111 (report §7 item 3) | QA | test/api-suite | DONE |
| MJG-021 | Gate determinism: lint-green + bare-tsc-green restored (recursive audit — MJG-020's bun-types path reference broke lint; sandbox artifact dirs broke bare tsc) | QA | fix/gate-determinism | DONE |
| MJG-022 | Repo hygiene: untrack sandbox artifact dirs (`examples/`, `tool-results/`) committed by environment checkpoint commits | DevOps | chore/repo-hygiene | DONE |
| MJG-023 | Production demo/test data wipe: read-only audit tooling, backup-mandatory guarded reset, zero-residual verification, runbook (62→0 rows) | Database | chore/prod-data-cleanup | DONE |
| MJG-024 | Production hardening: type-enforced builds (`ignoreBuildErrors:false`), strict mode, baseline security headers | Security | security/prod-hardening | DONE |
| MJG-025 | GitHub publish (non-destructive branch + reconciliation PR — remote main is a divergent Supabase-lineage state) + Vercel redeploy handoff | DevOps | chore/github-release | DONE |
| MJG-026 | PostgreSQL migration track: dual-schema + versioned migrations + `migrate deploy` pipeline (hosting prerequisite — no migrations existed, `db push` only) | Database | feat/pg-migrations | DONE |
| MJG-027 | Hosted deployment: Vercel (frontend/website) + Render (backend/Postgres), API proxy rewrites, env matrix, deploy-from-main-only policy | DevOps | feat/hosting-configs | DONE |
| MJG-028 | CTA routing: Get Started / Sign in navigate to the app (NEXT_PUBLIC_APP_URL) + `#get-started`/`#signin` deep links | Frontend | feat/cta-routing | DONE |
| MJG-029 | Runtime hygiene: gate SQL query logging to development; untrack `.env` + runtime `db/custom.db` from git | Security | chore/runtime-hygiene | DONE |
| MJG-030 | Partner access model: supplier & logistics registration (design proposal — product decision required) | Product | — | OPEN |
| MJG-031 | GitHub lineage adoption: push hosting-ready tree as PR #414 head, close reconciliation per product-owner direction, align local main/dev | DevOps | chore/lineage-adoption | DONE |
| MJG-032 | Assignment status FSM: PATCH /api/assignments/[id] accepts any status jump (POs have a guarded FSM; assignments do not) | Backend | — | OPEN |
| MJG-033 | Role policy inconsistency: POST /api/suppliers is any-role while PO create is OWNER/SUPERVISOR | Backend | — | OPEN |
| MJG-034 | Remove unused dependencies (next-auth, uuid, z-ai-web-dev-sdk — installed, never imported) | Backend | — | OPEN |

---

## MJG-001 — Construction-domain database schema
**Scope:** `prisma/schema.prisma`. Models: Organization, User, Session, Site, Supplier, Material, StockLevel, StockMovement, PurchaseOrder, POItem, Delivery, DeliveryItem, Worker, Assignment, Attendance, Milestone, EvidenceReport, Payment. SQLite (no Prisma enums — string unions validated by zod at API layer). Org-scoped multi-tenancy: every business table carries `organizationId`.
**Accept:** `bunx prisma db push` clean; unique constraints (session token, email, stock per site+material, attendance per worker+date+site); relations + `onDelete: Cascade` inside org data; empty-DB boot verified.

## MJG-002 — Authentication & authorization
**Scope:** `src/lib/auth.ts`, `src/lib/api-helpers.ts`, `/api/auth/{register,login,logout,me}`. scrypt password hashing (node:crypto, no new deps), opaque session tokens in DB, httpOnly `mjengo_session` cookie (7d, SameSite=Lax). Register creates Organization + OWNER user atomically. Roles: OWNER > SUPERVISOR > WORKER, enforced **server-side** per endpoint.
**Accept:** wrong-password 401; duplicate email 409; unauthenticated → 401 on every business API; role gating (verify evidence: OWNER/SUPERVISOR; approve payment: OWNER only); sessions expire; logout invalidates token.

## MJG-003 — Dashboard API (real metrics only)
**Scope:** `/api/dashboard` computes from persisted records: active sites, stock value (Σ stockLevel×unitCost), pending deliveries, evidence awaiting verification, payments awaiting approval, workforce on site today, monthly spend (approved payments), recent activity feed from real tables. **No fabricated numbers anywhere.**
**Accept:** empty org → zeros + empty arrays (valid state); numbers change after mutations (verified in E2E).

## MJG-004 — Sites / materials / inventory / milestones APIs
**Scope:** `/api/sites` (GET/POST/PATCH), `/api/materials` (GET/POST), `/api/inventory` (GET levels; POST movement IN/OUT/ADJUST with transactional StockLevel update + movement row), `/api/milestones` (GET by site, POST). Zod validation, org scoping, 400/401/404 envelopes.
**Accept:** OUT beyond stock → 422; stock math exact; PATCH enforces org ownership.

## MJG-005 — Suppliers / purchase orders / deliveries APIs
**Scope:** `/api/suppliers`, `/api/purchase-orders` (with items, status DRAFT→SENT→RECEIVED/CANCELLED), `/api/deliveries` (POST against PO or ad-hoc; verify endpoint flips PENDING→VERIFIED/REJECTED **by human actor**, updates stock on VERIFIED, records StockMovements). Receiving a delivery applies accepted quantities to inventory.
**Accept:** verify requires authenticated OWNER/SUPERVISOR; stock increments exactly once (idempotency guard: verified delivery cannot re-verify); invalid transitions → 422.

## MJG-006 — Workforce / evidence / payments APIs
**Scope:** `/api/workers`, `/api/assignments`, `/api/attendance`, `/api/evidence` + `/api/evidence/[id]/verify`, `/api/payments` + `/api/payments/[id]/approve`. Milestone progress via status transitions from verified UI actions.
**RED LINE (non-negotiable):** evidence verification and payment approval are **human decisions only** — no AI/auto-approval logic, no timers, no defaults. `verifiedById`/`approvedById` must be the acting session user; server rejects self-verification of evidence by the reporter (segregation of duties).
**Accept:** WORKER cannot verify/approve; reporter cannot verify own evidence; approval required before status PAID; all queries org-scoped.

## MJG-007 — Marketing landing + 17s hero
**Scope:** `src/components/marketing/**`. Landing = hero + product pillars + workflow proof section + CTA + footer. Hero: 17s timeline, 6 scenes — (1) 0–2s blueprint self-draw "Build with clarity."; (2) 2–5s materials float in "Every material. Every movement."; (3) 5–8s mini site assembles + 6 connected modules "One connected construction site."; (4) 8–11s human review Reported→Verified "Know what happened. See the evidence." (copy must NOT imply AI auto-approval); (5) 11–14s orbit + progress ring "From procurement to project completion."; (6) 14–17s end frame brand + "The evidence-backed operating system for construction." + CTAs **Explore MjengoOS / Get Started**.
**Craft:** warm-white background, deep-charcoal (stone-900/950) type, restrained amber accent, soft realistic shadows; framer-motion orchestration + CSS keyframes for idle float; IntersectionObserver pauses offscreen; `prefers-reduced-motion` → static end frame; responsive 375/768/1440; **original choreography — not a copy of any existing site's sequence/assets**.
**Decision record:** approved hybrid spec called for 3D-rendered raster assets; sandbox generation cannot guarantee the cross-object lighting/perspective consistency the spec requires, so the shipped asset layer is a premium hand-built SVG illustration system (crisp at any DPI, per-part animation, zero network cost). Choreography API accepts drop-in raster asset swap later.
**Accept:** plays 17s end-to-end; captions legible ≥WCAG AA on warm white; reduced-motion static fallback; CTA wired to register.

## MJG-008 — App shell + operations views
**Scope:** `src/components/app/app-shell.tsx`, `src/components/views/{dashboard-view,sites-view,inventory-view}.tsx`. Sidebar nav + topbar (user, org, logout). Dashboard consumes `/api/dashboard` (real numbers, skeletons, empty states). Sites CRUD with status pipeline. Inventory: site selector, levels, record movement dialog.
**Accept:** refresh preserves session+view context; all data from API; toasts on success/error; mobile-responsive.

## MJG-009 — Commerce & field views
**Scope:** `src/components/views/{procurement-view,deliveries-view,payments-view,workforce-view,evidence-view,auth-view}.tsx`. Procurement: suppliers + PO builder (line items) + status actions. Deliveries: incoming queue, verify/reject with accepted quantities (human action). Workforce: workers, site assignments, daily attendance. Evidence: report form (workers), verification queue (supervisors — **human review UI**, copy states "Verified by {name}", no AI language). Payments: record (PO/milestone/wage), OWNER approval, mark paid. Auth view: login/register with brand panel.
**Accept:** segregation of duties visible (reporter can't verify own report); approval gating enforced in UI and API; forms validate; empty states guide first use.

## MJG-010 — SPA integration
**Scope:** `src/app/page.tsx`, `src/app/layout.tsx`, `src/lib/store.ts`, `src/lib/api-client.ts`. Session boot via `/api/auth/me`; route-by-state: logged-out → landing (hero) ↔ auth; logged-in → app shell views. Metadata, favicon, footer stickiness, no other page routes (preview surface is `/`).
**Accept:** full journey register→login→work→logout→landing works; no hydration errors in dev.log.

## MJG-011 — Hardcoded-data elimination audit
**Scope:** grep-driven sweep for mock arrays, fabricated metrics, placeholder users, fake success responses, demo fallbacks in production paths; produce `docs/HARDCODED_DATA_AUDIT.md` (location → replacement → verification). Legitimate constants (UI labels, enum unions, route names, validation rules) documented as retained.
**Accept:** zero fabricated business data reachable from UI; audit report complete.

## MJG-012 — End-to-end browser QA
**Scope:** agent-browser golden journeys: register org → dashboard zeros → create site → material + stock-in → supplier + PO → delivery → verify (stock increments) → worker + assignment + attendance → evidence report → verify by supervisor → payment record → approve → mark paid → dashboard reflects every mutation → logout → hero plays. Regression: all gates re-run on merged dev.
**Accept:** every journey passes with evidence in worklog; failures fixed at root cause.

## MJG-013 — Git consolidation & final report
**Scope:** exactly `dev` + `main` remain (temp branches deleted after --no-ff merges); dev → main after full QA; `docs/PRODUCTION_READINESS_REPORT.md` with verified results vs limitations; secrets scan (no committed credentials).
**Accept:** `git branch` = dev, main; report complete; acceptance checklist answered honestly.

## MJG-014 — Org member management (added during E2E planning)
**Root cause:** registration creates OWNER only; evidence verification forbids self-verification (red line), so without SUPERVISOR accounts the verification journey could never run in production. **Fix:** `GET/POST /api/users` (POST OWNER-only, roles SUPERVISOR|WORKER, scrypt-hashed password, 409 duplicate) + "Team" tab in Workforce view (member table, add-member dialog gated to OWNER, role helper copy). **Accept:** OWNER adds supervisor → supervisor signs in → verifies worker's evidence; WORKER/SUPERVISOR see no Add-member button; API 403s non-OWNER creates.

## MJG-015 — Material catalogue UI (added during E2E planning)
**Root cause:** materials list endpoint existed and every dialog consumed it, but no view could CREATE a material — stock-in, POs and deliveries would be dead ends for a fresh org. **Fix:** "Add material" dialog in Inventory view (name, unit enum, category, unit cost) posting to `/api/materials` and invalidating the shared `['materials']` cache. **Accept:** fresh org can catalogue a material and immediately record an IN movement.

## MJG-016 — Delivery supplier inherited from PO (discovered in live walkthrough)
**Root cause:** `POST /api/deliveries` accepted `purchaseOrderId` and `supplierId` independently; a delivery created against a PO without explicitly re-picking the supplier stored `supplierId = null`, so the deliveries card rendered "No supplier recorded" even though the PO carried the supplier.
**Fix (two layers):** (1) server denormalization — when `purchaseOrderId` is provided and `supplierId` is not, the PO is loaded anyway for the org-ownership check, so capture it and inherit `po.supplierId` into the created delivery (data integrity going forward); (2) display fallback — `deliveryInclude` adds `purchaseOrder.supplier`, and `toDeliveryDTO` resolves `supplierName` as `delivery.supplier?.name ?? delivery.purchaseOrder?.supplier?.name ?? null`, which also repairs pre-existing rows without a migration.
**RED LINE:** no interaction with verification/approval flows — supplier metadata only.
**Accept:** delivery created against a PO without explicit supplier shows the PO's supplier name (old and new rows); explicit supplierId still wins when provided; cross-tenant PO still 404; `tsc`/`lint` clean; regression covered by MJG-020 suite assertion.

## MJG-017 — Attendance save-bar visibility (discovered in live walkthrough)
**Root cause (UX, not functional):** attendance is an explicit batch save by design (draft → "Save attendance (n)" bar), but during the walkthrough the queued-changes bar rendered as a neutral grey footer below the fold — the OWNER clicked around, assumed auto-save, and the dashboard briefly showed 0 workers on site. Behavior was correct; discoverability was not.
**Fix:** the sticky bar now signals dirty state with the brand's amber emphasis — when `changedEntries.length > 0`: amber-50 background, amber-300 border, amber-900 label, amber glow on the save button; neutral styling only when everything is saved. Status line gets `role="status" aria-live="polite"` so screen readers announce "N changes ready". Batch-save model itself is retained (deliberate design decision, documented in worklog WALKTHROUGH-01).
**Accept:** dirty bar visually distinct in table (desktop) and card (mobile) layouts; `aria-live` present; saved state quiet; `tsc`/`lint` clean.

## MJG-018 — SQLite backup & restore drill kit (report §7 item 2)
**Scope:** `scripts/db-backup.ts` (bun + prisma): reads `DATABASE_URL`, runs SQLite `VACUUM INTO` to `db/backups/mjengo-<timestamp>.db` (consistent online backup — safe while the dev server holds the DB), then opens the backup with a second PrismaClient (`datasourceUrl` override) and runs `PRAGMA integrity_check` + per-table row counts. `scripts/db-restore.ts <backup> [--into <path>]`: verifies the backup, copies it to the target (default: scratch path — never touches the live DB unless explicitly told). `docs/BACKUPS.md`: cron schedule, retention guidance, restore drill steps.
**Accept:** drill executed live in this sandbox: backup created → integrity ok → restored copy row counts match live DB; script exits non-zero on any check failure; cron line documented.
**Deferred (needs external infra):** off-site replication, scheduled automated runs (cron exists in docs only), PITR (SQLite has no binlog — documented).

## MJG-019 — Deployment kit (report §7 item 1 — sandbox-testable parts)
**Scope:** multi-stage `Dockerfile` (bun deps → prisma generate → next build → slim runtime with `docker-entrypoint.sh` running `prisma db push` before `server.js`), `.dockerignore` (node_modules, .next, dev DBs, logs, walkthrough assets), `.env.example`, `docs/DEPLOYMENT.md` (docker path + bare-metal bun path + smoke + backup cron), `scripts/smoke.sh <base>` (checks `/api` health JSON `status:ok database:connected`, landing 200, `/api/sites` 401 unauthenticated — exit non-zero on any failure). Investigation note: a suspected error-log typo in the `/api` health route was ruled out at byte level (the source already reads `'[health]'`; the earlier reading was a terminal-rendering artifact) — no source change required there.
**Accept:** smoke.sh executed live against :3000 → all checks pass; Dockerfile/entrypoint reviewed and consistent with the validated `build`/`start` scripts (docker daemon unavailable in sandbox — image build itself deferred to the deployment environment, documented).
**Deferred (needs external infra):** the physical deployment act, domain/TLS, secrets management.

## MJG-020 — Replayable API integration suite (report §7 item 3)
**Scope:** `tests/api-mjengo.test.ts` (bun:test, zero new deps) + `scripts/api-tests.sh` + `package.json` script `test:api`. The script boots a **production server** (`next build` → standalone) on **:3111** with an **isolated SQLite DB** (`db/api-test.db`, `prisma db push` before boot; real env `DATABASE_URL` wins over bundled `.env`), waits for `/api` health, runs the suite, kills the server, removes the test DB. The :3000 dev server is never touched.
**Suite (17 ordered cases, one linear journey):** health 200 → register org 201 (+ duplicate 409, wrong-password 401, unauthenticated 401) → site/material/stock IN (inventory math exact; OUT beyond stock 422) → supplier/PO DRAFT→SENT → **delivery against PO inherits supplier (MJG-016 regression)** → verify applies stock exactly once (re-verify 422) → worker/assignment/attendance → evidence self-verification **403** (segregation red line) → supervisor created + logs in + verifies → payment: supervisor approve 403, OWNER approve 200, mark-paid 200 → `/api/dashboard` totals assert every mutation.
**Accept:** `bun run test:api` green end-to-end in this sandbox with the dev server still healthy on :3000 afterwards; suite is the CI-replayable artifact the readiness report asked for.
**Deferred (needs external decisions):** component/E2E Playwright suite (browser CI), coverage thresholds.

## MJG-021 — Gate determinism: lint + bare tsc restored (recursive-audit finding)
**Root cause (two independent regressions):** (1) MJG-020 added `/// <reference path="../node_modules/bun-types/index.d.ts" />` to `tests/api-mjengo.test.ts`; the `@typescript-eslint/triple-slash-reference` rule forbids `path`-style references by default, so `bun run lint` exited 1 — lint was evidently not re-run after that edit, making the shipped "gates green" claim stale. (2) `tsconfig.json` `include: ["**/*.ts", "**/*.tsx"]` with only `node_modules` excluded compiles **sandbox artifact dirs** — `examples/websocket/*` (imports `socket.io`/`socket.io-client`, not installed), `skills/*`, `tool-results/*` — so the registry's documented gate command `bunx tsc --noEmit` failed for reasons unrelated to the product; earlier sessions had masked this by manually scoping tsc to `src/`.
**Fix (verified in working tree before filing):** (1) canonical Bun-documented form `/// <reference types="bun-types" />` — passes the rule's `types: "prefer-import"` option because bun-types is a types-only package; `bun:test` module resolution unchanged. (2) `tsconfig.json` exclude extended to `node_modules, examples, skills, tool-results` — bare tsc then compiles exactly the product scope (next-env, src, tests, scripts incl. db-backup/db-restore, .next/types); probe config run confirmed product dirs EXIT 0.
**Accept:** bare `bun run lint` and bare `bunx tsc --noEmit` both green with no scoping tricks; `bun run test:api` still 21/21 (suite + production build unaffected); scripts/db-*.ts remain inside the type-checked scope.
**Evidence:** lint clean; tsc clean; 21 pass / 0 fail / 63 expect() after the fix.

## MJG-022 — Repo hygiene: untrack sandbox artifact directories
**Root cause:** environment daemon checkpoint commits (UUID-named, e.g. `461dc2b`, `b946e23`) tracked non-product artifacts into the repository: `examples/websocket/{frontend,server}.tsx` (SDK samples referencing uninstalled deps — the very files that broke bare tsc) and `tool-results/read_*.txt` (raw tool output). They are not MjengoOS code, pollute `git ls-files` and future clones, and were the visible symptom behind MJG-021's tsc failure.
**Fix:** `git rm -r --cached examples tool-results` (untrack; files remain on disk, daemon-owned; no `.gitignore` entries — the daemon may legitimately re-checkpoint them). Product evidence convention stays `download/` + `worklog.md`.
**Accept:** `git ls-files examples tool-results` returns empty on both permanent branches; lint/tsc/test gates unaffected (eslint already ignored both dirs).

## MJG-023 — Production demo/test data wipe (launch hardening)
**Problem:** the runtime database carried the QA/walkthrough dataset — 62 rows across 17 tables (4 orgs, 6 users, 7 sessions, 3 sites, 3 suppliers, 5 materials, 3 POs, 3 deliveries, 2 workers, 2 evidence reports, 2 payments, stock levels/movements, attendance, assignments) — unusable for live customers and a PII liability.
**Tooling:** `scripts/db-audit-counts.ts` — read-only audit: dynamic table enumeration (cannot miss a residual table), `PRAGMA integrity_check`, `PRAGMA foreign_key_check` (orphan detection), per-table counts, `--zero-required` gate exits non-zero if any table has rows. `scripts/db-reset-with-backup.sh` — guarded reset: refuses without `--i-understand-this-wipes-the-database`; sequence = pre-audit → **verified online backup (MJG-018 kit, reversible)** → `prisma db push --force-reset` → zero-required post-audit.
**Executed live:** backup `db/backups/mjengo-2026-10-21T11-44-48.db` (integrity ok, restorable via `scripts/db-restore.ts`); wipe 62→0 rows across all 18 tables; integrity ok; 0 orphans; ZERO-RESIDUAL VERIFIED. Sweep of other sources: no seed scripts (`prisma/` has none), no uploads/object storage, no caches/queues/indexes (stack: Next standalone + SQLite), `mini-services/` empty, drill/backup artifacts gitignored, `.next` cache is build-only.
**Accept:** live DB serves smoke green on empty data (health/landing/401 guards); 21-case suite green (isolated DB); runbook documents the exact procedure; rollback = restore the backup.

## MJG-024 — Production hardening (launch)
**Fixes:** `next.config.ts` — (1) `typescript.ignoreBuildErrors: false` (type errors now fail production builds; verified: full `next build` passes with enforcement ON via the 21-case suite); (2) `reactStrictMode: true`; (3) baseline security headers on all routes: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` — verified live via curl. Cookie `secure` flag already production-correct (`NODE_ENV==='production'`, MJG-002); no demo UI/flags/test endpoints exist (MJG-011 audit; 23 routes are all business APIs + health).
**Honest gaps (documented, not blockers for launch posture):** in-app rate limiting absent — mitigate at the edge platform (Vercel firewall/WAF or reverse proxy); no external error-tracking/uptime alerting — health endpoint + `scripts/smoke.sh` provided; HSTS/CSP terminated at the edge (documented in DEPLOYMENT.md).
**Accept:** lint/tsc/test:api all green; headers present on responses; empty-DB smoke green.

## MJG-025 — GitHub publish + Vercel redeploy handoff
**Discovery:** token authenticated as `Roy-Wanyoike` (push access to `Youngshark-Technologies/Mjengo-OS`, default branch `main` @ 774f06ec). **The remote is a divergent implementation lineage: unrelated git histories** (no merge-base), remote carrying PR lineage #407–413, Supabase-based design docs (`docs/SUPABASE-DATABASE-DESIGN.md`), its own blueprint/audit/runbooks, `prisma/seed-all.ts`, `vitest` configs — ~457 src files / +89k lines not present locally, while local holds the validated Prisma/SQLite product (MJG-001..024) the remote lacks.
**Decision (Principal escalation, non-destructive):** overwriting either lineage destroys work (release-blocker class). Full-history push of `dev` was **declined by GitHub push protection** — the token entered the sandbox lineage at its initial commit (`21beec1`), tainting all ancestor blobs. Resolution: clean **squashed-tree branch** from the final validated state (secret-scan 0 hits; `upload/`, `examples/`, `tool-results/` excluded) + **history-bridge merge** (`-s ours`, tree verified identical) adopting remote main as ancestor so a PR is creatable; pushed as `sandbox/prod-readiness-2026-10-21`; **PR #414** (github.com/Youngshark-Technologies/Mjengo-OS/pull/414) documents both reconciliation options (sandbox-becomes-main adopt-merge; or selective feature adoption). Team decides via PR review — GitHub stays the source of truth.
**Security:** `upload/sharkpush.txt` (the token) was tracked locally by a daemon checkpoint — untracked in chore/prod-data-cleanup BEFORE any push; token used only via ephemeral credential helpers (nothing persisted); **rotation recommended**.
**Vercel:** no token/CLI in sandbox → redeploy cannot be executed locally. Handoff: merge the PR (or choose option) → Vercel git integration (per remote PR #408/#409 the repo is Vercel-connected) auto-deploys; note remote #409 changed `build` to plain `next build` for Vercel — reconciliation must carry that fix into whichever tree ships.
**Accept:** branch pushed; PR opened with divergence brief; no force-push; no token leakage; Vercel steps documented.

## MJG-026 — PostgreSQL migration track (hosting prerequisite)
**Problem:** schema changes ship via `prisma db push` only; **zero versioned migrations exist**. Render Postgres (and any hosted Postgres) requires replayable migration SQL; the datasource provider is `sqlite`, which cannot even connect to a hosted Postgres URL.
**Constraint (no collateral damage):** the sandbox runtime, dev DB, Docker path and the 21-case suite all run on SQLite — the switch must NOT break them (MJG-001..025 investments stay green).
**Fix (dual-schema pattern):** `prisma/schema.postgres.prisma` (provider `postgresql`, models identical) alongside the untouched SQLite `prisma/schema.prisma`; versioned migrations in `prisma/migrations/` (Postgres-owned, `migration_lock.toml` provider=postgresql) generated with `prisma migrate diff --from-empty --to-schema-datamodel`; `db:migrate:deploy` script (non-interactive `prisma migrate deploy --schema prisma/schema.postgres.prisma`); `scripts/check-schema-parity.ts` (normalized diff of both schemas, exit 1 on drift) wired into the QA gate; live verification = embedded Postgres → `migrate deploy` on a real server → full 21-case API suite against the migrated Postgres DB (fallback if binaries unavailable: SQL generation + validate + honest disclosure).
**Accept:** migration SQL generated & applied to a real Postgres; suite green against migrated PG DB; SQLite path (dev/sandbox/Docker/test suite) unchanged and green; parity gate in place; runbook documents the schema-change flow for both providers.

## MJG-027 — Hosted deployment: Vercel (frontend) + Render (backend)
**Problem:** no hosting configs exist (`vercel.json`, `render.yaml` absent); SQLite-on-Vercel is ephemeral (MJG-025 residual risk #3); the product owner requires **frontend on Vercel, backend on Render, deploys from `main` only**.
**Architecture (Solution Architect decision):** one codebase, two targets — **Vercel** serves the UI (landing/website + app views); when `BACKEND_URL` is set, `next.config.ts` rewrites `/api/:path*` → `${BACKEND_URL}/api/:path*` so the browser stays same-origin (cookie model unchanged, no CORS needed); **Render** runs the same app as the API service with Render Postgres (`DATABASE_URL`), applying versioned migrations (`prisma migrate deploy`, MJG-026) on every deploy; on Render `BACKEND_URL` is unset so `/api/*` resolves locally.
**Config:** `vercel.json` (framework nextjs, `buildCommand: next build` — carries remote PR #409's plain-build fix); `render.yaml` blueprint (runtime node, `branch: main`, autoDeploy, build = npm install + prisma generate (postgres schema) + next build, start = migrate deploy + node standalone server, health check `/api`); `.env.example` + `NEXT_PUBLIC_APP_URL` (app URL for CTAs, MJG-028) + `BACKEND_URL`; DEPLOYMENT.md hosted-deployment section with step-by-step for both platforms, env matrix, main-only policy, rollback, edge rate-limiting note.
**Accept:** configs present and internally consistent; `next build` + full gates green with rewrites code present (no-op without BACKEND_URL); smoke green; deploy-from-main-only documented and enforced by config (Render `branch: main`, Vercel production branch = main documented).

## MJG-028 — CTA routing to the app (Get Started / Sign in)
**Problem (live audit):** all five conversion CTAs (header, hero end frame ×2, footer ×2) are state-toggle buttons with no href — on a split frontend the marketing page cannot send users to the app; "mjengoupdate" (the product owner's app URL) appears nowhere in config.
**Fix:** `NEXT_PUBLIC_APP_URL` env (via new `src/lib/app-url.ts`): when set, CTAs render as anchors to `${APP_URL}/#get-started` (and `/#signin`); when unset, current in-page toggle behavior is preserved byte-for-byte (sandbox default). `page.tsx` honors the hashes on mount (`#get-started`/`#signin` → open auth view) so the deep link works both same-origin and cross-origin.
**Accept:** with env set, clicking Get Started navigates to the app and opens auth (browser-verified evidence); with env unset, landing/auth flows unchanged; lint/tsc/suite green.

## MJG-029 — Runtime hygiene: query logging + tracked secrets/DB
**Problem (FE/BE audit findings):** (1) `src/lib/db.ts` enables `log: ['query']` unconditionally — full SQL logging (with any embedded values) in production: log noise + potential data leakage; (2) `.env` is git-tracked (predates the `.env*` ignore rule) and the runtime `db/custom.db` is git-tracked — both violate secrets/data hygiene and taint clones.
**Fix:** gate query logging to `NODE_ENV === 'development'`; `git rm --cached .env db/custom.db` (files remain on disk for the sandbox runtime/packager) + explicit `.gitignore` entries; keep `.env.example` committed.
**Accept:** production server logs no SQL (verified via suite run output); `git ls-files` shows neither `.env` nor `db/custom.db`; gates green; sandbox boot unaffected (file still on disk).

## MJG-030 — Partner access model: supplier & logistics registration (OPEN — product decision required)
**Current-state answer to the product owner's question:** roles are exactly `OWNER | SUPERVISOR | WORKER` (`src/lib/types.ts`), assigned only as: register → OWNER of a NEW org; OWNER creates SUPERVISOR/WORKER members (`POST /api/users`, OWNER-only). **Suppliers are data records, not identities** (`Supplier` model + `/api/suppliers`, managed by org staff; no login, no portal, no cross-org relationship). **Logistics/transport does not exist anywhere** in schema or code.
**Proposed design (for decision):** Phase 1 — add `Organization.type` (`CONSTRUCTOR | SUPPLIER | LOGISTICS`) + partner self-registration (creates partner-type org + OWNER); Phase 2 — cross-org PO visibility: supplier-org users see POs addressed to them, accept/acknowledge, optionally log shipments; logistics orgs receive delivery tasks. Segregation and tenancy rules carry over (partner sees only own relationships). Phased to avoid breaking the verified tenant model.
**Accept (of this issue):** design reviewed & approved by product owner → implementation issues filed. NOT implemented in this sprint (no silent scope creep).

## MJG-031 — GitHub lineage adoption & push (execution)
**Basis:** product owner directed "push the changes to GitHub" + "deployment from main only" + hosting prep — this is the PR #414 Option 1 decision (sandbox lineage becomes the product).
**Plan:** re-squash the hosting-ready tree (secret-scan first: no `.env`, no tokens, no runtime DB) onto the PR #414 head branch; comment the PR with the decision record; merge PR #414 via API (merge commit → remote main content = validated tree, remote history preserved in graph); align local `main`/`dev` to the published remote state (content-identical); push `dev`; temp branches deleted.
**Accept:** remote main = hosting-ready validated tree; PR #414 merged/closed with decision evidence; local and remote lineage converged; push protection clean (secret-scan 0 hits before push).

## MJG-032 — Assignment status FSM (OPEN — audit finding)
**Finding:** `PATCH /api/assignments/[id]` accepts any enum value from any current state (ASSIGNED/ACTIVE/COMPLETED jumps), unlike `PATCH /api/purchase-orders/[id]` which enforces `ALLOWED_TRANSITIONS`. Risk: completed assignments reopened, or active set on completed without `endDate` semantics. **Fix proposal:** mirror the PO FSM (ASSIGNED→ACTIVE→COMPLETED, guard endDate). Not implemented this sprint (behavior change requires product sign-off + suite coverage).

## MJG-033 — Supplier creation role policy (OPEN — audit finding)
**Finding:** `POST /api/suppliers` accepts ANY role (WORKERs can create supplier records) while `POST /api/purchase-orders` (which consumes suppliers) is OWNER/SUPERVISOR-gated. Inconsistent privilege surface. **Decision required:** either gate supplier creation to OWNER/SUPERVISOR or document the deliberate looseness. Not changed this sprint (would alter tested behavior — suite asserts supplier creation in the golden journey under the OWNER session, so gating would pass, but policy call belongs to product).

## MJG-034 — Dependency hygiene (OPEN — audit finding)
**Finding:** `next-auth@4.24.11`, `uuid@11`, `z-ai-web-dev-sdk` are declared dependencies with **zero imports** in `src/` (grep-verified). Each enlarges install surface (and `next-auth` pins old tooling). Remove in a dedicated hygiene PR after confirming no dynamic usage. Not done this sprint (install-surface change late in launch cycle = avoidable risk).
