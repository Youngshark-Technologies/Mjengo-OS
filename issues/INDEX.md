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
| MJG-012 | End-to-end browser QA (golden journeys), regression & gates evidence | QA | chore/e2e-qa | IN_PROGRESS |
| MJG-013 | Git consolidation: exactly `dev` + `main`, temp branch cleanup, final report | DevOps | chore/git-consolidation | TODO |

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
