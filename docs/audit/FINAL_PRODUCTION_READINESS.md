# MjengoOS — FINAL PRODUCTION READINESS

**Audit date:** 2026-10-01 · **Auditor:** independent engineering review (Principal Engineer mandate) · **Base commit:** `2520d9b` (main) → live tip `dec4f5b` after this audit's merge
**Method:** every claim below was verified against the actual repository state, a live boot of the application, the real test suite, and a real backup→restore exercise. Nothing is taken from README, issues, or closed PRs on trust. Where this sandbox could not verify something, it says so explicitly.

---

## 1. What was discovered

| Dimension | Verified state |
|---|---|
| Product | Offline-first Construction Operating System for Kenya/Africa: projects, BOQ, procurement, inventory, workforce, wallet/escrow, invoices, evidence, land, professionals, AI advisory, USSD/WhatsApp field channels |
| Stack (declared vs actual) | Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + shadcn/ui + Prisma 6/SQLite + next-auth v4 + vitest + Playwright + bun — **declared = imported = tested = running** (verified by lockfile, imports, suite, live boot) |
| Architecture | Modular monolith (single deployable + PWA), domain modules under `src/backend/modules/*` (ledger, wallet, supply, inventory, invoices, documents, drawpack, land, professionals, intel, reports, ai, notify, events, jobs), isomorphic contracts in `src/shared`, offline outbox in `src/frontend/lib/outbox.ts` (+ IndexedDB variant) |
| Scale | 72 Prisma models / 1,648-line schema · 174 test files · 61 implemented route handlers · 30 OpenAPI-documented v1 paths · 10 ADRs · DEPLOYMENT.md 117KB · separate marketing site (`mjengoos-website`) |
| Process hygiene | Issue-linked commits, PR-only merges to main, audit registers (#364–#369), honest-status comments in code (e.g. webhook fail-closed SEC-4 notes, session-revocation trade-off analysis) |

## 2. What was already working (evidence)

| Claim | Evidence |
|---|---|
| Test suite green | `vitest run`: **167 files, 3,647 tests, 0 failures** (109s, this sandbox, base `2520d9b`) |
| Type safety | `tsc --noEmit`: exit 0, zero errors |
| App boots | Dev server `✓ Ready in 1137ms`; SQLite FK pragma asserted at boot (fail-closed `instrumentation.ts` hook — verified in boot log) |
| Health endpoint | `GET /api/health` → `{"ok":true,"db":"up",...}` (real Prisma probe) |
| API contract honest | `/api/openapi.json` serves OpenAPI 3.1.0 with **exactly 30 paths**; `tests/unit/openapi-cross-check.test.ts` (passing) enforces documented ⇔ implemented 1:1 |
| Auth gate | `GET /api/v1/projects` unauthenticated → **401** |
| Metrics fail-closed | `GET /api/metrics` without `METRICS_TOKEN` → **401** |
| Public webhooks fail-closed | `POST /api/ussd` and `/api/whatsapp` without configured secret → **503 with explicit refusal message** (SEC-4: "refuses unauthenticated writes", checked route source: deliberate, before any body read) |
| Homepage | 200, 46KB HTML |
| Financial integrity | Double-entry ledger module + `tests/unit/ledger-realdb.test.ts`, `wallet-idempotency.test.ts`, `wallet-realdb.test.ts`, `daraja-reconcile.test.ts` — all passing (debits=credits, idempotency keys, reconcile sweep) |
| Inventory invariant | Append-only movements + derived closing stock: `inventory-slices.test.ts`, `inventory-consumption-realdb.test.ts`, reconciliation sessions (#194) — passing |
| Offline outbox | Owner + supplier outboxes with bounded retry, auth-blocked recovery (`outbox.ts`, `outbox-idb.ts`, dom tests) — passing |
| Session security | scrypt+timing-safe passwords, per-user `tokenVersion` revocation, fail-closed on DB error (`session-revocation.ts` + tests) — passing |
| Backup tooling | `deploy/backup/mjengo-backup.sh` + systemd timer + env example + DEPLOYMENT.md §7.2 restore runbook exist and are production-grade by design (online `.backup`, integrity check, sha256 sidecars, retention, dead-man switch, dry-run mode) |

## 3. What was broken

- **Code: nothing found.** No failing tests, no type errors, no leaked secrets (repo-wide scan: only AWS's public documentation fixture pair in a SigV4 test), no dead obvious routes on the main surfaces probed.
- **CI/CD: everything red — one root cause.** All GitHub Actions runs since Sep 9 fail at startup (~3–9s): the account is **billing-locked (issue #98, owner action required)**. This masked everything else and is the single operational blocker to CI validation.
- **The record: one false claim, now corrected.** Commit `280fe0b` ("docker.yml push trigger actually points at main (was a birth typo)") and the `publish.yml` TRIGGER NOTE claimed a trigger typo that **byte-level evidence shows never existed in any trigger line** (grep counts across 5 commits: correct syntax present since birth, malformed literal count 0 in triggers; corroborated by push-triggered CI runs firing Sep 2–21). Root cause of the false claim: an authoring-tool display artifact — independently reproduced and root-caused during this audit. **Fixed by PR #397 (merged), closing issue #395.**

## 4. What was missing (all filed as issues this audit)

| Gap | Issue | Priority |
|---|---|---|
| Dependabot vulnerability alerts disabled (API 403) — the one dark supply-chain sensor for a money-moving app | **#392** | P2 |
| Zero git tags / GitHub Releases despite versioned prose (`package.json` 0.2.5, RELEASE-NOTES.md) — no rollback anchor | **#393** | P2 |
| No code-scanning analysis ever (CodeQL) — first-party code has no static security signal | **#394** | P3 (first run blocked by #98) |
| Zero load/performance measurement — no harness, no baseline, no SLOs | **#396** | P3 |
| Restore never exercised (now exercised in sandbox — §12 below) | — | done here; host re-run recommended |

## 5. Issues created (this audit)

#392 (Dependabot alerts), #393 (release tagging), #394 (CodeQL), #395 (TRIGGER NOTE record — closed by merge), #396 (load baseline). Duplicate-check performed against open+closed issues before each creation (closest prior: #216, closed, covered dependabot *config*, not *alerts*).

## 6. Issues resolved

**#395** — closed via merged PR #397 after byte-level verification.

## 7. PRs merged

**PR #397** `docs(ci): correct the TRIGGER NOTE record` → merge commit `dec4f5b` on main. Comment-only change; QA: trigger line asserted byte-identical before/after; YAML parse verified; correct-filter count 1→1, malformed-literal count 1→0 (existed only in comment prose); content verified by SHA-1 math at commit construction; pushed via checksummed pack protocol and verified by fetch-back.

## 8. Tests executed

- Full vitest suite: **3,647/3,647 pass** (unit + dom + finance incl. ledger/wallet/idempotency/reconciliation real-DB tests)
- TypeScript: `tsc --noEmit` clean
- Runtime battery on live server: 6 probes (§2 table) — all correct, zero 500s
- Backup → restore exercise: full pass (§12)
- Not executed here: Playwright E2E (7 role specs exist but require browser installation beyond sandbox budget), production standalone build (§16)

## 9. Security validation

- **Secrets:** repo-wide scan clean (no committed `.env`, no real credentials; one AWS doc-fixture in tests is public-domain)
- **AuthN/AuthZ:** single guard seam; 401 verified live; role matrix in `src/shared/permissions.ts`; supplier/client fail-closed scoping (`assertSupplierScope`, membership-scope) test-covered
- **Session:** server-side revocation via tokenVersion, fail-closed on lookup error, constant-time compares — test-covered
- **Webhooks:** HMAC-required, fail-closed 503 before body read — verified live
- **PII:** contact PII encrypt-at-rest (AES-256-GCM, PR #385), scrubbing + redaction libs present, retention enforcement
- **Dark sensors (filed):** Dependabot alerts off (#392), no CodeQL (#394), secret-scanning API not accessible from sandbox permissions
- **Not done here:** manual penetration testing, dependency-CVE enumeration (needs #392 enabled)

## 10. Performance results

**Not measured — honestly.** No harness exists (#396). No capacity or latency claims are made. The single-writer SQLite ceiling is a documented architecture choice (DEPLOYMENT.md §7); quantifying it requires the harness + a real host. This audit makes no SLO statements.

## 11. Failure / chaos results

**Chaos experiments: not executed here** (requires isolated environment with non-production financial credentials — none available in sandbox). What IS verified: failure *postures* are encoded in passing tests — payment idempotency under retry, Daraja reconcile sweep, outbox bounded auto-retry + auth-blocked recovery, rate-limit fail-closed, session-revocation fail-closed, webhook refuse-on-missing-secret (live-verified), boot-time FK assert fatal-on-failure. The mission's chaos matrix (DB kill, provider timeout storms, out-of-order webhooks, worker crash mid-job) remains **pending** and should run against docker-compose.staging after #98.

## 12. Backup / restore results — EXECUTED (real exercise, sandbox)

| Step | Result |
|---|---|
| Dataset | Real schema (`prisma db push`) + real seed: 8 users, 3 projects, 13 stock movements, KSh-denominated verified evidence rows |
| `--dry-run` | Correct plan: sources, names, weekly decision, retention; wrote nothing |
| Backup run | 0.05s local; 6 artifacts (db + photos + website tars), **0600 perms**, sha256 sidecars, weekly set hardlinked |
| Snapshot verify | `PRAGMA integrity_check` = `ok`; row counts match source |
| Simulated loss | Original DB deleted |
| Restore per §7.2 | Snapshot copied back; `sha256sum -c` = OK; integrity = `ok`; 8/3/13 rows intact |
| **App-consumability proof** | **Prisma (the app's real ORM) booted against the restored file and read live data** (`PRISMA_OK users=8 projects=3`) |
| RPO/RTO | Mechanism-proven: RPO = timer cadence (04:30 daily per unit file); RTO sandbox = ~4ms file-copy (host RTO dominated by disk + verification steps; re-run on host per runbook) |

## 13. Remaining blockers

1. **#98 — GitHub Actions billing lock** (owner): unblocks CI, Docker smoke, publish workflow, CodeQL first run (#394), scheduled Dependabot updates
2. **#43 — M-Pesa production certification** + reversal initiator credentials (sandbox-only today; SimulatedProvider is the default and is honestly labeled)
3. **#40 — USSD production telco gateway** (sim `*384#` only)
4. **#392 — enable Dependabot alerts** (owner, one toggle, no billing)
5. **#393 — cut first tag/release** (owner decision on retroactive vs v0.3.0)
6. Host re-run of restore drill + chaos day on staging (post-#98)

## 14. Remaining technical debt (documented, not hidden)

- next-auth v4 → v5 cutover pending (ADR-0007, #360) — v4 on Next 16 is a cast-shimmed pairing (#173)
- MFA + password-reset flows absent (#361 — documented security boundary)
- Roadmap registers #364–#369 (polish, Wave-7 AI, beyond-Wave-7, H2/H3 horizons incl. multi-tenant orgs, multi-country)
- Supabase/Postgres target-state designed (ADR-0002, SUPABASE-DATABASE-DESIGN.md, migration plan) — not migrated
- OTel tracing designed-not-shipped (ADR-0009 — deliberate: no consumer exists; phase-1 Prometheus metrics shipped)

## 15. Known limitations (product-honest)

Single-node self-host posture (SQLite, one writer) · PWA-first, native app deliberately deferred (ADR-0001, revisit triggers in #41) · USSD is a faithful simulation (#40) · M-Pesa is sandbox-grade (#43) · AI is advisory-only (never approves; DRAFT-only extraction with human gates; flag-gated OFF by default) · supplier/worker channels restricted to allowlisted actions · MjengoScore gates nothing · marketing-site leads are AES-GCM sealed, key outside backups.

## 16. Production configuration status (Configured ≠ Implemented ≠ Tested ≠ Production-ready)

| Surface | Implemented | Tested here | Production-ready |
|---|---|---|---|
| App server + SQLite + FK boot assert | yes | **live boot + probes** | after #98 unblock + host restore drill |
| Backup/restore | yes | **full exercise** | re-run drill on host; wire dead-man monitor |
| Health/metrics | yes | **live** | wire uptime monitor (runbook §3) |
| Ledger/wallet/idempotency | yes | **suite** | yes (within single-node scope) |
| Offline outbox (owner+supplier) | yes | **suite** | yes |
| M-Pesa Daraja | sandbox-gated | suite (mock/adapter) | **no — #43** |
| USSD/WhatsApp | fail-closed 503 (verified) | live refusal + sim | **no — #40 + secrets** |
| SMS (Africa's Talking) | env-gated seam | fail-closed default | needs creds |
| AI (z-ai seam) | provider-sealed, never-throws | suite (authenticity, draw-review) | flag-off by default; enable consciously |
| Docker images / publish | docker.yml verified-design | **not here** (sandbox build OOM; Actions locked) | after #98: first `docker.yml`+`publish.yml` runs |
| Production standalone build | designed (standalone output) | **not in sandbox** (2 attempts died ~10min, resource-limited host) | run `bun run build` or docker.yml after #98 |
| CI/Docker/Publish workflows | triggers byte-verified correct | n/a (Actions locked) | after #98 |

## 17. Final architecture state

Modular monolith as designed: App Router RSC shell + guarded client app + public fail-closed webhooks + 30-path v1 REST contract (cross-checked 1:1) → action/module layer (allowlisted CLIENT/SUPPLIER actions, mutation-safety, idempotency) → Prisma/SQLite (72 models, FK pragma fatal-at-boot, append-only money/stock/audit lines) → provider seams (payments, SMS, storage, AI) each with an honest default (simulated/fail-closed) and env-gated real provider. Deviations from the master design docs (Temporal, Redis, PostGIS, Keycloak, multi-tenancy) are **not silent**: each is ADR-documented or roadmap-registered (#366/#367) with revisit triggers. No circular domain dependencies observed in the module graph.

## 18. Final production readiness status

### CONDITIONAL — NOT YET production-ready. One operational blocker + two gate items.

**Verdict:** the codebase is the most audit-disciplined single-node system this mandate has reviewed: 3,647 passing tests including real-DB financial invariants, live-verified fail-closed surfaces, and a backup/restore path that was proven end-to-end during this audit (including ORM-consumability). **What separates it from a production cutover is operational, not architectural:**

**Gate checklist (all owner-action):**
- [ ] #98 Actions billing unblocked → first green CI/Docker/Publish runs (triggers verified correct at byte level)
- [ ] Production standalone build completes once on the target host (or first publish.yml image digest)
- [ ] #392 Dependabot alerts enabled; any fired alerts triaged
- [ ] #393 v0.2.5/v0.3.0 tag + Release cut (rollback anchor exists)
- [ ] Restore drill re-run on the actual host; dead-man monitor wired (MONITORING.md §3)
- [ ] #43/#40: M-Pesa production cert + USSD gateway — or launch scoped to simulated providers with the honest small print surfaced to users
- [ ] Chaos day on docker-compose.staging (payment timeout storms, out-of-order webhooks, worker kill mid-job) before real money moves
- [ ] #396 load baseline before public launch claims

**Evidence rule honored:** every ✓ above traces to a command run, a test name, or a file+line in this repository during this audit; every ✗ is stated as ✗.

---

*Audit trail: issues #392–#396, PR #397 (merged, `dec4f5b`), forensics in closed PR #391, scripts preserved in the auditor's workspace. All GitHub artifacts are linked and public in the repository.*
