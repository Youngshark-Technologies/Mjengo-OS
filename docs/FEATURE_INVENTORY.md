# MjengoOS — Master Feature Inventory

**Sources:** every product directive across the MjengoOS chat lineage (production-readiness mandate; CTA/hosting/roles directives; "Engineering Execution Mandate §1–§12"; publication wave). Canonical evidence: `issues/INDEX.md` (MJG-001..072), `worklog.md`, test suite `tests/api-mjengo.test.ts` (49 cases / 358 assertions), browser-E2E records.
**Status legend:** SHIPPED (implemented + gate/evidence-backed) · OPEN (filed, in progress) · USER ACTION (requires product-owner credentials/console access).

## 1. Identity, access & tenancy — SHIPPED
| Feature | Evidence |
|---|---|
| Public registration with org types: **Constructor / Supplier / Logistics** (radiogroup a11y) | MJG-030/035/055; suite 34; browser E2E (radio group live) |
| Login / logout, scrypt password hashing, DB-backed httpOnly sessions (Secure in production) | MJG-002; suite 2–3, 31 |
| Role model OWNER / SUPERVISOR / WORKER + org-internal role gates | MJG-002/033/044; suite 35 |
| Org-type guards on all constructor-domain writes (partner orgs → 403) | MJG-058/064; suite 34 |
| Tenant isolation (cross-org lists empty, foreign ids 404) | suite 37, 48 |
| Auth rate limiting (login per-account+IP, register per-IP) with spoof-proof rightmost-XFF keys + bounded limiter memory | MJG-043/061/065; suite 38 |
| Malformed input → zod 400 (no partial account creation) | MJG-056; suite 32 |
| Expired-session pruning on login | MJG-054 |
| CTA deep links: `#get-started` → REGISTER intent, `#signin` → LOGIN intent — **from marketing buttons too** | MJG-028/055/**069**; browser E2E re-verified this wave |

## 2. Constructor operations — SHIPPED
| Feature | Evidence |
|---|---|
| Dashboard with live computed metrics (zero hardcoded stats) | MJG-003 |
| Sites CRUD (org-scoped) | MJG-004; suite golden path |
| Materials catalog + stock levels | MJG-004 |
| Inventory movements ledger (audit every stock change) | MJG-004/020; suite 44–46 |
| Milestones with guarded FSM (COMPLETED terminal, reopen → 422) | MJG-051; suite 36 |

## 3. Procurement & logistics — SHIPPED
| Feature | Evidence |
|---|---|
| Suppliers directory + supplier↔partner-org linking (invalid links rejected) | MJG-005/020; suite 26–27 |
| Purchase orders with guarded FSM; partner visibility (SENT visible, DRAFT private) | MJG-005/035; suite 28, 42 |
| Supplier partner portal: acknowledge PO (repeat → 409) + shipment logging visible to constructor | MJG-036(c); suite 42–43 |
| Logistics partner portal: carrier assignment (wrong org type → 422), delivery-task list, acknowledge (repeat → 409) | MJG-036(b); suite 40–41 |
| Deliveries + human verification (stock increments exactly once) | MJG-005/020 |
| **Pagination** on payments, deliveries, evidence, assignments, inventory movements, purchase orders: `page`/`pageSize` (validated), `X-Total-Count` org-filtered total, byte-compatible legacy mode, pager UI in six views | **MJG-072**; suite 44–49; browser E2E (pager live) |

## 4. Workforce — SHIPPED
| Feature | Evidence |
|---|---|
| Workers roster (org-scoped) | MJG-006 |
| Attendance recording | MJG-006 |
| Assignments with guarded FSM (jumps → 422, terminal locked; WORKER cannot PATCH) | MJG-032/044; suite 29, 35 |

## 5. Payments & evidence — SHIPPED
| Feature | Evidence |
|---|---|
| Payments ledger; OWNER-only approve (conditional write predicate, double-approve → 409), mark-paid | MJG-006/052/063/064; suite 39 |
| Site evidence records; human-only verification (self-verify 403 red line) | MJG-006; suite golden path |

## 6. Frontend experience — SHIPPED
| Feature | Evidence |
|---|---|
| Marketing landing: hero animation (17s six-scene, reduced-motion), product pillars, workflow, CTA band | MJG-007; browser E2E |
| App shell: dashboard / sites / inventory / procurement / deliveries / workforce / evidence / payments views with real loading/empty/error states | MJG-008/009 |
| Route-level error boundaries + boot-failure retry card + 404 | MJG-049/055 |
| In-app auth view (register/login modes with intent) | MJG-009/055/069 |
| Responsive + keyboard a11y (radiogroup, labels) | MJG-055; browser E2E |

## 7. Platform, data & delivery engineering — SHIPPED
| Feature | Evidence |
|---|---|
| Construction-domain schema (Prisma), org-scoped everywhere | MJG-001 |
| Versioned migrations ×3 (`init`, `partner_org_types`, `partner_phase2`), replayed green on hosted-Postgres path (`db:migrate:deploy`) | MJG-026/036; PG gate first-attempt PASS |
| Dual-engine QA gate: SQLite + migrated Postgres, production standalone build, isolated DBs | MJG-020/059/060/067 |
| Replayable API suite — now **49 cases / 358 assertions** | this wave |
| Backup/restore + audit-count kits, guarded reset | MJG-019 |
| Deploy kit: `vercel.json` (beforeFiles `/api` proxy → Render backend), `render.yaml` (healthCheck `/api`, npm ci), Dockerfile, engines ≥20, pinned package-lock | MJG-027/037–041 |
| Health endpoint `/api` with DB connectivity, counts, latency, 503-degraded | MJG-020; render healthCheckPath |
| Smoke gate `scripts/smoke.sh` (health/landing/401 guard) | MJG-020; live PASS |
| Security headers, strict TS builds, secrets hygiene (no secrets tracked; push-protection clean) | MJG-002/029; release scans |
| GitHub publication: PR-protected main honored — PR #415 (merge `add6d05`); history-level secret scrub (MJG-070); **Release SOP** + generalized PR script | MJG-031/047/070/**071** |
| §12 Engineering Execution Report + feature inventory (this file) | Mandate §12 |

## 8. OPEN engineering work
| Feature | Status |
|---|---|
| MJG-069 hero-CTA REGISTER intent | **DONE this wave** (verified live) |
| MJG-071 release SOP docs + generalized publish script | **DONE this wave** |
| MJG-072 list pagination (API + UI + tests) | **DONE this wave** |
| CI enablement | DORMANT — blocked on GitHub Actions billing unlock (external); `.github/workflows/ci.yml` ships ready; local dual-engine gates remain authoritative |

## 9. USER ACTIONS to reach full production (from chat directives)
1. **Vercel:** import the repo → two projects (main app + website if used), track `main` only; set `NEXT_PUBLIC_APP_URL` + backend URL pairing per `docs/DEPLOYMENT.md`; region fra1 to pair with Render. Auto-deploys fire on every PR merge to `main`.
2. **Render:** Blueprint deploy (backend + hosted Postgres); set `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `BACKEND_URL`; first deploy runs `prisma migrate deploy`.
3. **Post-deploy:** `bash scripts/smoke.sh https://<render-app>` + CTA check (Get Started → register with the three org types).
4. **PAT rotation** (MJG-047 hygiene): rotate the push token; pass via `GH_TOKEN` only.
5. **Monitoring (§11):** Render/Vercel dashboards on `/api` health, 429 budgets, p95 on paginated lists, session-table growth (auto-pruned), `migrate deploy` exit codes.
