# Remaining Work — 2026-10-13

Human-readable view of the authoritative backlog (GitHub Issues). Execution order follows dependencies and risk, not issue numbers.

## Tier 0 — Owner-gated unblockers (nothing else unblocks behind these)

| # | Item | Why it blocks |
|---|---|---|
| **#98** | GitHub Actions billing lock | Every CI run fails at startup; no CI signal, no publish path, CodeQL cannot run |
| — | Branch protection on `main` (owner setting; API unreadable at current permission) | `main` currently accepts direct pushes; required reviews/status checks unenforceable |

## Tier 1 — Data/integrity & release safety (code-side)

| # | Item | Priority | Verification |
|---|---|---|---|
| **#408** | Re-apply P0 sharp native-libs fix (standalone tracing + Dockerfile COPY + unauth-401 smoke guard) | **P0** | authed `/api/projects` 200 in standalone; smoke guard green |
| **#393** | Cut v0.2.5 (retroactive) + v0.3.0 tags + GitHub Release | P2 | `git ls-remote --tags` non-empty; release page live |
| **#392** | Enable Dependabot alerts | P2 | alerts page populated |
| **#394** | Re-apply codeql.yml (workflow_dispatch-only while #98 stands) | P3 | workflow file on main; first run after #98 unblocks |

## Tier 2 — Core UX gaps (validated specs exist)

| # | Item | Priority | Verification |
|---|---|---|---|
| **#411** | Mobile header clip at 375–430px | P2 | 0 clipped children at 320/375/390/430 |
| **#410** | Login split-screen modernization | P2 | a11y+i18n suites green; leak-scan 0; visual QA 4 breakpoints |
| **#412** | 320px FAB + table overflow | P3 | no page-level horizontal scroll at 320px |

## Tier 3 — Capacity & integration validation

| # | Item | Priority |
|---|---|---|
| **#396** | Redo Phase A load baseline, then Phase B write-path/staging | P3 |
| **#43** | M-Pesa production certification (owner credentials) | P2 at launch |
| **#40** | USSD production gateway (owner contract) | pending-scope |
| **#360/#361** | next-auth v5 cutover; MFA + password-reset | P2 |

## Tier 4 — Registered roadmap (not MVP)

#364 polish register · #365 Wave-7 AI · #366 beyond-Wave-7 · #367 H2/H3 · #368 trigger-gated deferrals · #369 revenue hypothesis.

## Open PR needing owner action

| # | Item |
|---|---|
| **#390** | dependabot: trivy-action 0.28.0 → 0.36.0 — review/merge consciously |

## Deferred / excluded (recorded decisions)

- Native mobile app — excluded by ADR-0001 (#41)
- Everything in #364–#369 registers — deferred by design with trigger conditions
- Owner's in-flight Vercel work (`fix/vercel-build-script`, follow-ups to #403/#405) — intentionally not audited or touched mid-flight

## Recommended execution order (next session)

1. #408 (P0, spec complete, ~1 hour) — restores authenticated prod usage
2. #393 tags+release (needs #98 ideally; can cut locally+push regardless)
3. #411 → #410 → #412 (UI gaps, specs preserved in issues)
4. #396 Phase A redo → Phase B
5. #394 re-apply (run-AC after #98 unblocks)
6. Owner: #98 billing, branch protection, #390 review, #43 credentials
