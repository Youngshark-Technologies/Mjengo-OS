# Requirements Traceability — 2026-10-13

Evidence sources: executed validation battery (`VALIDATION_RESULTS.md`), runtime browser QA, source inspection, merged-PR history, `FINAL_PRODUCTION_READINESS.md` (2026-10-01). Documentation alone is never treated as proof.

Status key: **V** verified · **P** partial · **B** broken · **M** missing · **BLK** blocked · **X** excluded by recorded decision (ADR/issue).

| ID | Requirement / invariant | Domain | Evidence | State | Gap → Issue | Risk |
|---|---|---|---|---|---|---|
| R-01 | Authenticated session gating on project APIs | security | unauth `/api/projects` → 401 (this session); guard tests in suite | V | — | — |
| R-02 | Prod standalone serves native image pipeline (sharp/libvips) | backend | #408 runtime proof: authed `/api/projects` 500 in standalone; dev OK | **B** | re-apply fix → **#408** | P0 user-facing outage |
| R-03 | Financial ledger append-only + compensating corrections | finance | `test:finance` suite green inside 3,647 | V(config-level) | field-scale verification open | medium |
| R-04 | Inventory balances derive from stock movements | inventory | #287/#288-lineage suites green | V | — | — |
| R-05 | Payment callbacks idempotent | finance | pinned suites green; M-Pesa prod creds absent | P | **#43** (owner-gated) | medium |
| R-06 | Evidence preserves source/GPS/time + verification history | evidence | UI contract + schemas; hero evidence narrative matches product rule (human-review-first) | P | prod validation blocked by #408 | medium |
| R-07 | Offline capture never silently loses data | offline | hydration-race fix #389 merged; sync conflict tests in suite | P | field validation | medium |
| R-08 | Tenant/project isolation on every query | security | guarded routes + isolation tests in suite | V(code-level) | production pen-test absent | high if regressed |
| R-09 | CI runs on every push/PR | infra | #98 billing lock → every run fails at startup; triggers parked (#401) | **BLK** | **#98** (owner billing) | high (no CI signal) |
| R-10 | Code scanning (CodeQL security-extended) | security | authored 2026-10-12, lost before push | **M** | **#394** | medium |
| R-11 | Dependabot vulnerability alerts | security | alerts disabled account-wide | **BLK** | **#392** | medium |
| R-12 | Versioned tags + GitHub Release | release | zero tags on origin; version bump lost | **M** | **#393** | medium |
| R-13 | Load baseline (capacity measurement) | perf | Phase A lost; numbers historical only | **M** | **#396** | low-medium |
| R-14 | Login screen modernization (split-screen brand) | frontend | validated spec preserved; code lost | **M** | **#410** | low |
| R-15 | Header integrity at 375–430px | frontend | clip measured pre-fix; fix lost | **M** | **#411** | medium |
| R-16 | 320px surfaces usable (FAB, tables) | frontend | runtime-measured overflow | **M** | **#412** | low |
| R-17 | Marketing homepage fully interactive | frontend | #404 proof (overlay blocked ALL mouse clicks) → fixed+verified #406 | V | — | — |
| R-18 | Animated hero: 6-scene story, a11y, responsive, reduced-motion | frontend | #407 merged; QA battery + 30fps video evidence | V | — | — |
| R-19 | USSD/WhatsApp field channels | integrations | fail-closed 503 verified (SEC-4); prod gateways absent | P/X | **#40** (pending-scope) | — |
| R-20 | Native mobile app | product | PWA-first decision | X | **#41** (ADR-0001) | — |
| R-21 | MFA + password-reset | security | documented boundary, not implemented | **M** | **#361** | medium |
| R-22 | next-auth v5 cutover (ADR-0007) | security | planned, not executed | **M** | **#360** | medium |
| R-23 | M-Pesa production certification | finance | owner-gated | **BLK** | **#43** | high at launch |
| R-24 | Roadmap registers (Wave-7 AI, H2/H3, polish) | product | registered, not in scope | X | #364–#369 | — |
| R-25 | Vercel deploy path documented | infra | owner merged #403/#405 this window | V(owner) | owner continues on `fix/vercel-build-script` | — |

**MVP-critical open path:** #98 → #408 → #393 → branch protection → then MVP feature gaps (#410/#411) and owner-gated integrations (#43/#40).
