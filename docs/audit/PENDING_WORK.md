# MjengoOS — Pending Work Register (2026-09-16 wave)

> The visible answer to *"what is still broken or incomplete?"* — every row
> links to evidence (per-surface baseline docs) and to a delivery vehicle
> (merged branch awaiting PR, or a proposed issue). "reg" rows need a GitHub
> issue at sync time; `scripts/github-sync.sh` carries the paste-ready bodies.
>
> **Navigation (2026-09-27, issue #190):** the front door to this folder is
> [`MASTER_AUDIT.md`](./MASTER_AUDIT.md) — the per-document index, the
> register-status tally, and the full register-ID → issue-number crosswalk
> (verified against the tracker). The canonical test-count home is
> [`TEST_BASELINE.md`](./TEST_BASELINE.md). This file remains the rolling
> what-remains register.

## 1. Fixed this wave — branches ready for issue + PR (gates green)

| ID | Finding | Priority | Branch / commit | Tests |
|---|---|---|---|---|
| SEC-1 | CSRF-by-default on all mutating routes (SameSite=None + text/plain tolerated + allowlist off) | **P1** | `fix/audit2-security` @ 11bce21 | +mutation-safety suite |
| SEC-2 | Dev fallback secret accepted in any non-production runtime → forgeable admin sessions | **P1** | `fix/audit2-security` @ 4ad6111 | +prod-rejection pins |
| SEC-3 (entropy) | Share token minted as Prisma cuid() (not CSPRNG) | P2 | `fix/audit2-security` @ 064f1b7 | +entropy pins |
| SEC-4 | USSD/WhatsApp webhooks fail-open when secrets unset | P2 | `fix/audit2-security` @ c8635ad | +503 fail-closed pins |
| FE-1/MD-1 | Demo quick-fill credentials ship in every bundle | **P1**/Med | `fix/audit2-security` @ 82564f8 | +static gate pin |
| DB-2 | consumeStock persisted before negative-stock throw; hardcoded closingQty 0; non-atomic transfers | **High** | `fix/audit2-data` @ 638f8aa | +atomicity suite |
| DB-6/7/8 | No unique (workerId,date); non-unique PO/invoice codes; 1 index in whole DB | Med | `fix/audit2-data` @ 5b0caad (migration `10_integrity_constraints`) | +real-sqlite constraint tests — DB-6 fully closed 2026-09-19 by #144 (SQL SUM balances + migration `15_hot_path_indexes`) |
| DB-4 | v1 money mutations bypassed the audit trail | Med-High | `fix/audit2-data` @ 35bbb33 | +audit pins ×4 routes |

## 2. Proposed issues — not started this wave (prioritized)

### P1 (production blockers for real-money/real-scale operation)

| ID | Proposed issue title | Domain | Notes |
|---|---|---|---|
| DB-1 | `fix(db): integer-cents (or Decimal) money across wallet/ledger/invoices` | finance | Supabase design already specifies NUMERIC(18,2); SQLite path needs service+schema change; blocks real-money pilot |
| TEST-1 | `feat(qa): Playwright E2E golden paths (7 personas)` | qa | manual browser verification is not regression-proof; CI-ready |
| SEC-6 | `feat(authz): project-membership model replacing portfolio-wide site-team reads` | security | design change; pairs with Supabase RLS `project_member` |

### P2 (major quality/completeness)

| ID | Proposed issue title | Domain | Notes |
|---|---|---|---|
| SEC-3r | `feat(security): share-link expiry + re-issue + decision-power review` | security | entropy fixed this wave; expiry + milestone.decide-from-link remains |
| SEC-5 | `chore(auth): next-auth v4→v5 migration plan (supported pairing with Next 16)` | security | 2026-09-18: ADR 0007 + exact pin 4.24.15 + Dependabot advisory watch landed (#173); v5 cutover scheduled per ADR phases |
| DB-3 | `feat(db): DB-level ledger enforcement on SQLite (triggers/checks) parity with Supabase design` | finance | 2026-09-19: CLOSED on SQLite — migration `14_ledger_invariants` (#124) lands the posting-gate balance trigger, append-only guards, reversal-only update whitelist, side/amount CHECKs + the `LedgerMaintenance` exemption; DB-10 (immutability alignment) and the ledger part of DB-11 close with it |
| DB-5 | `fix(seed): production guard on destructive seed scripts` | data | NODE_ENV gate + confirm prompt |
| API-3 | `perf(api): v1 list routes must not materialize full project payload` | backend | |
| API-4 | `perf(api): bound core reads (take/cursor) — milestones, variations, comments, attendance, supply` | backend | 2026-09-18: landed via #155 — roster take 500 + `/api/projects` GET DB-level keyset (additive `nextCursor`/`hasMore`); payload takes milestones 200 / variations 60 / zones 120 / photoComments 120; v1 attendance keyset pushdown (contract unchanged); `loadSupplyOrdersBounded` (take 200) on the v1 list routes, full slice stays on detail surfaces |
| API-5 | `feat(security): confirm-before-decide on share-link money actions` | security | overlaps SEC-3r |
| FE-3 | `feat(i18n): complete EN-only sub-surfaces (audit tab, finder dialogs, land professionals, overview cards, PDF/CSV)` | frontend | |
| FE-4 | `feat(offline): supplier-portal outbox parity` | frontend | |
| WD-1 | `fix(website): per-visitor rate-limit bucket (TRUST_PROXY default posture) + lead-drop alerting` | website | |
| WD-2 | `feat(website): wire analytics endpoint or remove dead code` | website | |
| INF-7 | `feat(ops): automated backups + restore runbook + drill` | ops | 2026-09-18: landed via #199 — `deploy/backup/` (script + systemd timer, shellcheck-clean, drilled incl. live-WAL backup + script-level restore: docs/audit/RESTORE_DRILL_2026-09-18.md) + DEPLOYMENT §7.2.1/§7.2.2; covers app-db/app-photos/website-data (also closes the WD-11 "leads in backup set" gap); operator still owes one full-stack drill on real hardware |
| OBS-1/2 | `feat(observability): structured logs w/ correlation IDs, error tracking, metrics` | sre | 2026-09-19: #204/PR #277 landed the structured logger (OBS-2 — `lib/log.ts`, JSON-in-prod, requestId propagation); #202 landed the opt-in fail-open error sink (OBS-1 — `lib/errors/sink.ts` webhook v1 on that substrate, `ERROR_SINK_URL` gate, unconfigured = journal-only default); metrics (OBS-3) still open |
| INF-1 | `fix(deploy): systemd unit drops to non-root service user` | ops | |
| API-1r | `fix(security): require webhook secrets when secrets are SET but routes also rate-limit per-identity` | backend | residual after SEC-4 |
| TEST-10 | `fix(inventory): unitCost unit drift — writers store KSh, readers assume cents (stockValue ×100 understated)` | data | Found 2026-09-19 by the #184 real-SQLite harness: every writer (frontend "Unit cost (KSh)" contract; supply's postDeliveryToInventory passes `centsToKes(...)`) stores a KSh number into the BigInt `StockMovement.unitCost` column whose schema comment says cents, while `loadInventorySlice` treats it as cents (`mulQtyCents` + `centsToKes` on the movement rows too) — displayed costs and stockValue are ÷100. tests/unit/inventory-realdb.test.ts pins the CURRENT behavior with a fail-on-purpose note; normalizing the units is a money-semantics decision (which side, plus stored historical data), deliberately not done in the test-infra PR. 2026-09-19: #194 lands WITHOUT worsening it (reconciliation writes no unitCost — count-linked adjustments post `unitCost: null` exactly like the free-form `inventory.adjust` path) — filed as issue #282. 2026-09-21: RESOLVED via #282 — unitCost normalized to integer cents end-to-end: the inventory service's `parseUnitCost` is the KSh→cents action boundary (payload stays KSh, `parseNonNegativeMoneyCents` validation), supply's `postDeliveryToInventory` stores the PO line's cents untouched (the `centsToKes` round-trip removed), `loadInventorySlice` unchanged as the cents→KSh read boundary; the fail-on-purpose pin flipped (stockValue 68,400 not 684) + new end-to-end units test (KSh in → raw-SQL cents oracle → KSh out); seeds already wrote cents, migration 12 already converted pre-#122 rows, no production DB — reseed-not-migrate documented in the PR. Twin drift on `BoqLine.estUnitPrice` resolved same day as #285 (see TEST-10b) |
| TEST-10b | `fix(inventory): BoqLine.estUnitPrice unit drift — writers store KSh, loadBoqSlice assumes cents (BOQ totals ÷100 understated)` | data | Filed as issue #285 (2026-09-21, by the #195 coverage audit — the BoqLine twin of #282/TEST-10, different column, same drift class; display/rollup-only — MaterialRequest lines carry no price). 2026-09-21: RESOLVED — estUnitPrice is integer CENTS end-to-end: the payload contract stays KSh (the boq-card "Est. KSh/u" input), createBoq/upsertBoqLine convert at the write boundary via a NEW money.ts helper `nonNegativeKesToCents` (nullish/empty/zero → 0n — the legacy `Number(x ?? 0)` lenience; negative/>2-dp/boolean/object refused with the shared honest error), readers unchanged (loadBoqSlice `centsToKes`, intel/jobs `mulQtyCents` — already assumed cents, so the intel BOQ estimate is corrected by the same fix). Fail-on-purpose pins flipped in inventory-boq{,-realdb}.test.ts + new boundary-conversion/refusal pins. Historical data: NO migration — #122's migration 12 already moved pre-#122 Float rows ×100 into cents and prisma/seed-extras/supply.ts already writes BigInt cents literals (76000n = KSh 760/bag); only runtime-written demo rows since #122 carry the drift, and a stored 650 is ambiguous (KSh-entered vs true cents), so reseed (`bun run seed`) is the documented remedy |
| REC-1 | `feat(inventory): reconciliation residuals — blind-count mode, scheduled counts, variance alerting` | inventory | Post-#194 residuals: the count dialog pre-fills expected qty in place (not a blind count — a storekeeper can copy the book number); no recurring/scheduled count cadence or variance-threshold alerts (the intel anomaly scan is the natural home); history is payload-bounded to the latest 20 sessions. The core loop (count → variance → count-linked adjustment, offline-first, auditable lineage) landed via #194 |

### P3 (non-blocking improvements)

API-2 ~~wire-or-remove `/api/ai/extract-document` orphan~~ — landed 2026-09-19 via #153 (option (a): Copilot "Documents" review panel + GET review-queue read + OpenAPI path) · API-7 default the
SQLite rate-limit store · API-8 idempotent upload/confirm · API-9 dedupe
jobs/run POST handler · API-10 typed /api/actions payload at route · API-11
audit POST /api/projects · API-12 real search index (replace in-memory
300-row window) · API-14 extend OpenAPI to the app surface (the
document-intelligence route joined the doc via #153; the rest remains open) · FE-6 outbox
auto-retry with backoff · FE-7 ~~hide offline-simulation toggle in prod~~ —
landed 2026-09-24 via #136 (module-scope NODE_ENV gate, DCE-verified) · FE-8 runtime DOM a11y suite · FE-9 USSD body i18n · FE-11 SW staleness cue ·
FE-12 offline worklist for online-only flows · WD-3 "escrow-style" wording ·
WD-4 ~~gateway param~~ — landed 2026-09-25 via #139 (Button/not-found
routed through the shared `useGatewayPort` hook) · WD-5/6/11 website minor
set (manifest, sitemap date, leads in backup set) · DB-9 soft-FK sweep ·
DB-10 enums/CHECKs parity · DB-11
ledger reversal marking · MD-2 VAPID subject default · MD-4 replace
Math.random refs · MD-6 supplier demo-editing scope · TEST-2 DB-backed test
harness · TEST-3 coverage config · INF-9 quickstart db/ mkdir note ·
next-intl/lodash-es/uuid cleanup pass.

## 3. Externally blocked (honest-open, owner/business action)

| Issue | Blocker | Workaround today |
|---|---|---|
| #40 USSD production telco gateway | Safaricom/onboarding deal | faithful `*384#` simulation, labeled |
| #43 M-Pesa production certification | Daraja go-live creds/certs | sandbox behind the seam; reconcile sweep keeps books honest |
| #41 Native app | ADR-0001 revisit triggers | PWA-first (offline shell, installable) |
| #98 CI billing lock | account billing (owner) | local gates re-run per wave (exact CI commands); docker.yml now also carries the `smoke` job from #198 (compose-up + /api/health probe + migrate-line assert + /website probe) whose first execution rides the first run after unblock |

## 4. Definition-of-done check for this register

Every P0/P1 engineering item is either **fixed on a green branch** (§1) or
**carries a proposed issue with owner-ready body** (§2). External items (§3)
document blocker + workaround. Remaining P2/P3 are explicitly listed, not
hidden.

---

# Wave 3 addendum (2026-09-17) — the three P1 gates CLOSED

| P1 | Status | Branch | Evidence |
|---|---|---|---|
| #122 integer-cents money (DB-1) | **FIXED — verified branch** | `fix/122-integer-cents-money` (c518181, stacked on chore) | 90 files / 2,135 tests ✅ · tsc ✅ · lint ✅ · fresh `migrate deploy` ✅ · drift ✅ · payload JSON zero-BigInt-leak probe ✅ · E2E green against the seeded app |
| #174 project-membership authz (SEC-6) | **FIXED — verified branch** | `fix/174-project-membership-authz` (96b084d, stacked on #122) | 91 files / 2,161 tests ✅ · tsc ✅ · lint ✅ · fresh deploy (14 migrations) ✅ |
| #182 Playwright E2E (TEST-1) | **FIXED — verified branch** | `feat/182-playwright-e2e` (aeaa46f, on main) | **7/7 persona golden paths passed (35.3s)** against the real dev server + seeded DB · unit gates unchanged ✅ |

Wave-3 findings fixed along the way (all evidence in worklog.md):
- **P0**: fresh `prisma migrate deploy` was BROKEN (lexicographic migration order — `12_` before `2_draw_pack`). Fixed by zero-padding 00–09.
- **P0**: whole `/api/project` payload crashed JSON serialization (BigInt money riding raw supplier relations in supply-slice DTOs) + `/api/projects` 500 (BigInt/number mix in list+summary math) — found BY the new E2E suite.
- **P1-grade**: supply write paths (catalog/supplier/quote-receive/rules) stored raw KSh into BigInt-cent columns — 100× read-back corruption.
- Hygiene: chore branch (dead-code removal) + docs branch; chore branch corrected to keep the test-referenced policy matrices.

**GitHub write remains BLOCKED (no token).** One-command sync when a token exists:
`bash scripts/github-sync-wave3.sh` (labels + issue + pushes + PRs, idempotent), then `--merge`.
Offline transfer: `mjengo-wave3.bundle` (verified complete history; `git clone mjengo-wave3.bundle`).
Dev DB: rebuilt on the renamed migration set + reseeded (`bun run seed`).

Next wave candidates from the register (P2): #124 DB-enforced ledger invariants · #144 SQL SUM aggregation · #154/#155 bounded reads · #156 webhook residual · #194 stock reconciliation (landed 2026-09-19 — migration 16 StockCount/StockCountItem, `inventory.count` + `inventory.count.post` actions, variance view + history + CSV on the Materials Store card; residuals tracked as REC-1) · #199 backups · #202/#204 observability · #183 offline conflict matrix (landed 2026-09-19 — full 11-type stale/fresh/absent/force matrix + §41 semantic outcomes incl. force-refuses-server-wins financial rows; client stamps attendance.override, the one versioned type it missed; client chain unit-pinned incl. the second-offline-edit invariant; reduceLocal gained the attendance.record/exception/override optimistic mirrors) · #184 real-SQLite harness (landed 2026-09-19 — harness + 5 critical-path real-DB suites; its first catches: postEscrowTopup replay projection drift, fixed in-flight; StockMovement.unitCost unit drift, filed as TEST-10) · #212 escrow drift alarm · #186 inventory consumption tests (landed 2026-09-18 — the Consumption model's posting path pinned in both idioms: `consumption.create` applier validation/scoping/audit/append-only + materials-rollup invariant received − consumed = on-site with spend views, FK honesty, over-consumption clamp vs the movement ledger's pre-write refusal, two-ledger non-interference, cross-project isolation; the NaN/Infinity applier-guard gap pinned with the engine as the only backstop).

---

# Session-2 addendum (2026-09-20) — the P3 register CLEARED; zero engineering backlog

The "fix everything + update GitHub" session (worklog S2-SYNC → 7-b). The
live tracker is the truth; this addendum is the landing record.

## Closed this session (issue → PR → one-line evidence)

| Issue | PR | What landed |
|---|---|---|
| #328 (new) | #329 | Dependabot ignore rules for toolchain-blocked majors (TS≥7 breaks typescript-eslint; eslint≥10 breaks eslint-plugin-react) — both npm trees; security advisories unaffected |
| #208 | #331 | docker-compose.staging.yml (distinct names/volumes/ports, NODE_ENV=production, fail-closed secret interpolation) + explicit seed policy + promote runbook (SEC-2 sharp edge closed by construction) |
| #217 | #332 | docs/runbooks/MONITORING.md (the dead-man-ping runbook: external health poll, backup dead-man, two-signal jobs-drain watch) + 2 POSIX monitoring scripts + the backup script's optional BACKUP_HEALTHCHECK_URL seam + 15-test suite |
| #209 | #333 | publish.yml (GHCR + OCI labels + trivy HIGH/CRITICAL gate, GITHUB_TOKEN only) + .trivyignore policy + DEPLOYMENT §8.1 pull-by-digest path + FIXED docker.yml's birth-typo push trigger (`branches: ain]` silently disabled push runs since PR #12) |
| #205 | #334 | /api/metrics — Prometheus text, dedicated METRICS_TOKEN (decision documented vs JOBS_RUN_TOKEN), shared health-query seam, ADR 0009 OTel phase-2 note |
| #181 | #335 | Server-side session revocation — User.tokenVersion (migration 20), guard check (fail-closed, one PK read), jwt-callback embed + events.signOut bump, SECURITY.md incident-response UPDATE line, 16-test REAL-JWE/real-DB suite |
| #193 | #336 | Background Sync — one-shot 'mjengoos-outbox' tag at both enqueue seams, SW sync handler asks open clients to drain, closed-app defers honestly (documented) |
| #192 | #337 | Guarded persistence — quota/private-mode catch + queue-only fallback (banks the queue, drops re-fetchable data), red/amber banners, cross-tab storage-event rehydrate (LWW; CRDT declined with reasoning), orphaned-'syncing' normalization, bounding decision documented |
| #150 | #338 | The Waiting-for-network worklist — REMIND-ONLY (documented decision), 11 online-only guard kinds across 5 surfaces, persisted + deduped + capped, header panel with Retry-now/Discard, reconnect toast |
| #133 | #339 | Reversals as new rows — no UPDATE on the original (derived reversal state), migration 21 tightened the update guard (posting transition only) + reversalOfId UNIQUE, Supabase design in lockstep (INSERT/SELECT-only) |
| #127 | #341 | Soft-FK sweep — Transaction.ledgerTxnId @unique (migration 22; the comment's claim finally held) + ADR 0010 registry (15 remaining soft links, per-column decisions + guards + failure modes) |
| #203 | #342 | BOQ line-level lineage — migration 23 (three SetNull FK hops: boqLineId/requestLineId/StockMovement.requestLineId), ADR 0011, boqProgress derived view (estimated/requested/ordered/delivered/consumed; legacy rows listed, never name-guessed), boq-card wired |
| #140 | #343 | USSD simulation body i18n — 71+71 EN/SW keys (LCD script, keypad aria, explainer, demo-PIN list); dial syntax stays data; locale-snapshot transcript semantics |
| #137 | #345 | The runtime DOM a11y tier — tests/dom/ (jsdom per-file pragma, React-19 render harness, no @testing-library), 20 behavioral tests on the 4 highest-risk contracts; static pins retained as the wide net. INCIDENT fixed: the pragma string in a comment switched a node-only file's environment |
| #344 (QA-found) | #346 | The runtime suite's FIRST CATCH fixed — overflow-tab panels unnamed on mobile; panel carries its own aria-label fallback (accname spec) |

Plus dependabot queue hygiene: #322 + #330 merged (gates verified on true
merge results), #321/#323/#265 closed with evidence (toolchain-blocked
majors; ignore rules prevent recreation), 7 stale pre-transfer PRs
(#262-#264, #266-#269) closed as conflicting-with-reality (the active
weekly schedule re-proposes cleanly), the dead agent's #340 closed as
superseded by #341.

## Session gates (on the fully-merged state)

- **Unit: 154 files / 3,328 tests — all green** (was 144 / 3,172 at session
  start: +10 files, +156 tests, every one shipped with its issue)
- **Runtime DOM tier: 21 tests green** · **E2E: 7/7 persona golden paths
  (40s)** against the live dev server + seeded DB
- lint 0 · strict tsc 0 · 25 migrations, zero drift · fresh migrate deploy clean

## What remains (the honest end state)

- **Externals (owner/business action, documented workarounds):** #40 USSD
  telco gateway · #41 native app (ADR-0001) · #43 M-Pesa production certs ·
  #98 CI billing lock (the publish + smoke workflows are written for unblock
  day).
- **Register residuals (documented, non-blocking):** REC-1 reconciliation
  residuals (blind counts, cadence, variance alerting) · the indexed-DB
  outbox move (true closed-app drain) · supplier-portal key on the guarded
  adapter · axe-core tier if wanted · WhatsApp panel server-fed content ·
  major-version dep migrations arrive as fresh weekly Dependabot PRs for
  real gating.
