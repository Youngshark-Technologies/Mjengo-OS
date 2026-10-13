# Validation Results — 2026-10-13

Environment: sandbox, 2 vCPU / 4 GB RAM, bun 1.3.x, Node ≥20.9 (engines pin from #405 lineage). Baseline commit `c9feaac` (local == origin, clean tree).

| Check | Command | Result |
|---|---|---|
| Lint (root app) | `bun run lint` | **0 problems**, exit 0 |
| Typecheck (main app) | `bunx tsc --noEmit` | **0 errors** |
| Lint (website) | `cd mjengoos-website && bun run lint` | **0 problems**, exit 0 |
| Typecheck (website) | `bunx tsc --noEmit` | **0 errors** |
| Unit/integration suite | `bun run test` | **3,647 / 3,647 pass**, 167 files, 110s |
| Website production build | `bun run build` (site) | OK — 29 routes prerendered |
| Secret scan | `git grep` secret patterns over non-test tree | clean |
| Migration tracking | `bunx prisma migrate status` | 26 migrations found; sandbox DB behind (expected — restored snapshot, not a repo defect) |
| Runtime smoke (dev) | boot + curl | `/api/health` → `{ok:true,db:up}`; unauth `/api/projects` → **401** fail-closed |
| Remote tag audit | `git ls-remote --tags origin` | **empty** (no releases exist — #393) |

## Browser QA (agent-browser, production builds)

| Check | Result |
|---|---|
| Homepage overlay scan (pre-#406) | 11 `absolute inset-0` overlays, **1 escaping** (viewport-sized, click-blocking) → post-fix **0** |
| `elementFromPoint` at hero CTA (post-#406) | returns the CTA anchor |
| Hero timeline (post-#407) | phases 0→5 on schedule; 30fps video `hero-story-1440.mp4` |
| Hero overflow | scrollWidth == clientWidth at 1440 / 390 / 320 |
| Hero reduced-motion | phase=5 instantly; float transforms frozen across 1.5s; ring renders settled (instant mode) |
| Hero offscreen pause | phase held while scrolled away (4s), resumed on return |
| Hero a11y | sr-only h1; canvas + 6 captions aria-hidden; keyboard Enter navigates |
| Hero CTAs (trusted clicks) | "Get Started" → `/signup`; "Explore MjengoOS" → `/platform` |
| CTA uniqueness | 1 hero anchor per href target |

## Failed / skipped checks (honest ledger)

| Check | Status | Reason |
|---|---|---|
| `test:e2e` (Playwright) | **skipped** | browser budget spent on hero QA this session; last green on record |
| `test:coverage` thresholds | skipped this session | suite run without coverage flag |
| CodeQL / Dependabot / Actions | **blocked** | #98 billing lock; #392 alerts disabled |
| Authenticated prod-standalone `/api/projects` | **expected-fail (P0 #408)** | sharp native libs missing in standalone tracing — the issue is the record |
| Load baseline (#396) | not reproducible this session | Phase A artifacts lost with wipe; redo required |
| Branch protection readout | 404 | not readable at current permission (non-admin) |

## Reproducibility notes

- Background processes are reaped between tool invocations in this environment — all servers and browsers ran inside single-session scripts (persisted under `scripts/qa-hero*.sh`, `qa-overlay-audit.sh`).
- `prisma migrate status` reporting the sandbox DB behind is an environment artifact; migration *files* are the audited artifact.
- QA artifacts: `download/qa-hero-animation/` (screenshots, video, logs) — session-local, not committed to the repo.
