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
