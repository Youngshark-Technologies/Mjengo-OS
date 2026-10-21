#!/usr/bin/env python3
"""OPEN-ISSUES-03: file MJG-037..MJG-058 from the 10-agent audit (2026-11-12)."""
from pathlib import Path

INDEX = Path("issues/INDEX.md")
text = INDEX.read_text()

ROWS = """| MJG-037 | Split-deploy API shadowing: /api rewrites must be beforeFiles (Vercel→Render) | DevOps | chore/deploy-hardening | DONE |
| MJG-038 | Vercel build: prisma generate + bun trustedDependencies | DevOps | chore/deploy-hardening | DONE |
| MJG-039 | Render build: npm install --include=dev (NODE_ENV=production skips devDeps) | DevOps | chore/deploy-hardening | DONE |
| MJG-040 | Build-time env traps: NEXT_PUBLIC_APP_URL/BACKEND_URL must be set at BUILD time on Vercel | DevOps | chore/deploy-hardening | DONE |
| MJG-041 | Reproducible Render installs: commit package-lock.json (npm ignores bun.lock) | DevOps | chore/deploy-hardening | DONE |
| MJG-042 | Hash session tokens at rest (SHA-256; DB stores digest, cookie keeps raw) | Security | fix/auth-security | DONE |
| MJG-043 | Rate limiting on auth endpoints (login fails, register per-IP) | Security | fix/auth-security | DONE |
| MJG-044 | PATCH /api/assignments/[id] role gate (OWNER/SUPERVISOR) | Backend | fix/api-hardening | DONE |
| MJG-045 | Root README.md + correct the mjengoos-website/ premise (marketing is in-app) | Docs | chore/deploy-hardening | DONE |
| MJG-046 | CI workflow file ready for GitHub billing unlock (local gates stay authoritative) | DevOps | chore/deploy-hardening | DONE |
| MJG-047 | GitHub PAT rotation (USER ACTION) + main-tip daemon purge at release | Security | release | DONE |
| MJG-048 | .gitignore gaps: download/, worklog-entries/ | DevOps | chore/registry-mjg037 | DONE |
| MJG-049 | Route-level error boundaries (error.tsx, global-error.tsx, not-found.tsx) | Frontend | fix/frontend-resilience | DONE |
| MJG-050 | GET /api/partners bad query param returns 500 (raw parse) instead of 400 | Backend | fix/api-hardening | DONE |
| MJG-051 | Milestone PATCH has no terminal-state guard (COMPLETED reopenable) | Backend | fix/api-hardening | DONE |
| MJG-052 | Payment approve: PENDING check→update not transactional | Backend | fix/api-hardening | DONE |
| MJG-053 | Unbounded list queries on payments/deliveries/evidence/purchase-orders/assignments | Backend | fix/api-hardening | DONE |
| MJG-054 | Expired-session pruning (Session table growth on hosted deploys) | Security | fix/auth-security | DONE |
| MJG-055 | Boot-failure retry UI + #get-started opens register mode + radiogroup a11y | Frontend | fix/frontend-resilience | DONE |
| MJG-056 | Suite extensions: cookie flags, malformed payloads 400, org-type guard 403, rate-limit 429, cross-constructor tenancy | QA | test/suite-extensions | DONE |
| MJG-057 | Docs/config hygiene batch: engines>=20, portable .env.example, DEPLOYMENT intro, BACKUPS path, start-script drift note | Docs | chore/deploy-hardening | DONE |
| MJG-058 | MJG-036(a): org-type guard on constructor-domain writes (17 endpoints via requireUser orgType) | Backend | fix/api-hardening | DONE |
"""

DETAILS = """
## MJG-037 — Split-deploy API shadowing (P1, audit 2026-11-12)
**Finding (FE/BE agent):** `next.config.ts:13-15` returns a plain rewrite array → Next treats it as `afterFiles`; on a split deploy (BACKEND_URL set) the compiled `src/app/api/**` handlers ship in the frontend build and shadow the proxy — `/api/auth/login` would execute on Vercel with no `DATABASE_URL` → 500, the split architecture silently breaks.
**Fix:** return `{ beforeFiles: [{ source: '/api/:path*', destination: `${backend}/api/:path*` }] }` so the proxy wins over local handlers. No-op without BACKEND_URL preserved.
**Owner:** DevOps PE. **Accept:** rewrite object shape; full gates green; split-deploy behavior documented in DEPLOYMENT.md. **Verify:** build + suite + config review.

## MJG-038 — Vercel build must generate the Prisma client (P1)
**Finding (deploy agent):** `vercel.json` buildCommand is bare `next build`; repo ships `bun.lock` → Vercel installs with Bun, which skips `@prisma/client` postinstall (not in `trustedDependencies`) → API-route imports of `src/lib/db.ts` fail the build with an ungenerated client.
**Fix:** `buildCommand: npx prisma generate --schema prisma/schema.prisma && next build` + `trustedDependencies: ["@prisma/client", "prisma"]` in package.json.
**Owner:** DevOps PE. **Accept:** gates green; vercel.json + package.json consistent. **Verify:** config review + full build.

## MJG-039 — Render build installs devDependencies (P1)
**Finding (deploy agent):** `render.yaml:27-28` sets `NODE_ENV=production` as an env var (build+runtime on Render) → `npm install` (line 18) skips devDependencies → `next build` fails (typescript, @tailwindcss/postcss needed; typecheck enforced).
**Fix:** buildCommand `npm install --include=dev && npx prisma generate --schema prisma/schema.postgres.prisma && npm run build`.
**Owner:** DevOps PE. **Accept:** render.yaml consistent; gates green. **Verify:** config review + full build.

## MJG-040 — Build-time env traps on Vercel (P1)
**Finding (ops agent):** `src/lib/app-url.ts:6` reads `NEXT_PUBLIC_APP_URL` at module top-level (inlined at build) and `next.config.ts:12` reads `BACKEND_URL` inside `rewrites()` (baked into the routes manifest at build). Setting either only as Vercel runtime env silently breaks CTAs / the /api proxy.
**Fix (documentation + config):** DEPLOYMENT.md hosted-deploy steps + env matrix get an explicit "set at BUILD time" callout for both vars on Vercel; render.yaml keeps NEXT_PUBLIC_APP_URL (correctly baked into the Render-served landing — audit's "zero effect" claim corrected); .env.example comments updated.
**Owner:** DevOps PE. **Accept:** runbook states build-time requirement unambiguously. **Verify:** doc review against code paths.

## MJG-041 — Reproducible Render installs (P1)
**Finding (ops agent):** `render.yaml:18` uses `npm install` but only `bun.lock` exists → npm cannot see it → unpinned, non-reproducible installs on the backend host.
**Fix:** generate + commit `package-lock.json` (npm install --package-lock-only --ignore-scripts) and switch buildCommand to `npm ci --include=dev` once the lockfile exists (falls back documented). Version drift vs bun.lock reviewed in PR.
**Owner:** DevOps PE. **Accept:** lockfile committed, satisfies package.json ranges; render.yaml uses npm ci. **Verify:** `npm ci --dry-run` clean; gates green.

## MJG-042 — Hash session tokens at rest (P1)
**Finding (security agent):** `src/lib/auth.ts:30` stores the raw session token as the DB unique key (`Session.token`); a DB read/backup leak exposes live sessions. Cookie keeps the raw token (httpOnly) — only the stored digest must change.
**Fix:** SHA-256 digest (hex) stored in `Session.token`; `createSession`/`destroySession`/`requireUser` lookup all hash first. No schema migration (TEXT column). Existing dev sessions invalidate (accepted; dev-only data).
**Owner:** Security PE. **Accept:** DB stores 64-hex digests only; suite (login/logout/me flows) green; no raw token findable in DB. **Verify:** suite + manual DB row check during test run.

## MJG-043 — Rate limiting on auth endpoints (P1)
**Finding (security + ops agents, corroborated):** zero rate limiting anywhere — public deploys expose login to brute force and register to org-spam.
**Fix:** in-memory sliding-window limiter (`src/lib/rate-limit.ts`): login keyed `ip` + `email` on FAILED attempts (8/15min → 429, reset on success), register keyed `ip` (20/hour → 429). 429 uses the standard `{error:{message}}` envelope. Per-instance limiter documented (single Render service = correct scope; Vercel serverless note in DEPLOYMENT.md).
**Owner:** Security PE. **Accept:** thresholds enforced; suite thresholds never trip (suite volumes validated); case MJG-056 covers 429. **Verify:** suite + new case.

## MJG-044 — PATCH /api/assignments/[id] role gate (P1)
**Finding (API agent):** status-machine PATCH is unroled — a WORKER can drive any org assignment through ASSIGNED→ACTIVE→COMPLETED. Creation (POST) stays deliberate-open (commented pattern, same as deliveries); the supervisory transition is not.
**Fix:** `requireUser(['OWNER','SUPERVISOR'])` on PATCH only. Suite case 15/29 drivers verified to be OWNER/SUPERVISOR (green).
**Owner:** Backend PE. **Accept:** WORKER PATCH → 403; FSM suite cases green. **Verify:** suite + manual 403 probe.

## MJG-045 — Root README + mjengoos-website premise (P1)
**Finding (docs agent):** no root README exists; `mjengoos-website/` NEVER existed in this lineage — the marketing site is the in-app landing (src/components/marketing/*, MJG-007). Stale references live only in download/FINAL_PRODUCTION_READINESS.md (evidence artifact) and one QA script.
**Fix:** write root README.md (stack, setup, env, scripts, architecture incl. Vercel/Render split, main-only deploy policy, pointer to docs/); note the premise correction in DEPLOYMENT.md; leave historical evidence files untouched.
**Owner:** Docs PE. **Accept:** README accurate against package.json/scripts; no new stale refs. **Verify:** doc-vs-code cross-check.

## MJG-046 — CI workflow file (P2, blocked-external)
**Finding (QA agent):** remote CI deliberately suspended 2026-10-13 (billing lock, issue #98-style); no .github/ in repo; local gates are the real gates.
**Fix:** commit `.github/workflows/ci.yml` (lint, tsc, schema parity, build, test:api on PRs→dev + pushes→main) so checks resume automatically when the billing lock lifts. Local gates remain authoritative until then.
**Owner:** DevOps PE. **Accept:** workflow YAML valid; documented as dormant. **Verify:** YAML lint.

## MJG-047 — GitHub PAT rotation + main-tip purge (P1, PARTLY USER ACTION)
**Finding (hygiene + security agents):** `upload/sharkpush.txt` holds an old, now-INVALID GitHub PAT (401 at last push attempt — MJG-031). File is untracked+ignored (never committed); two daemon-junk scripts on the polluted main tip reference its path. Rotation was already recommended.
**Fix (sandbox-side):** release process resets main's tree to dev (purges junk + any token-path references from the published tree). **User action:** create a fresh push-scoped token; publish via the prepared fast-forward push command (see OPEN-ISSUES-03 release notes).
**Owner:** Security PE (sandbox) / Product Owner (token). **Accept:** released tree contains no token paths; push command ready. **Verify:** secret scan 0 hits on released tree.

## MJG-048 — .gitignore gaps (P1)
**Finding (hygiene agent):** `download/` and `worklog-entries/` not ignored — daemon checkpoints re-track them (MJG-029 recurrence surface).
**Fix:** add both to .gitignore; release resets main tree. Daemon force-adds cannot be fully prevented sandbox-side — documented.
**Owner:** DevOps PE. **Accept:** entries present; released tree free of both dirs. **Verify:** git check-ignore + ls-tree.

## MJG-049 — Route-level error boundaries (P1)
**Finding (ops agent):** no error.tsx / global-error.tsx / not-found.tsx anywhere → runtime render errors show the default Next crash page.
**Fix:** minimal styled client boundaries with retry; not-found for bad URLs. SPA (single page.tsx) keeps boundaries at root level.
**Owner:** Frontend PE. **Accept:** files present; build green; error UI matches design tokens. **Verify:** build + tsc.

## MJG-050 — GET /api/partners returns 500 on bad query (P2)
**Finding (security + API agents):** raw `querySchema.parse` bypasses the `parseQuery` helper → `?type=BOGUS` throws ZodError → 500 instead of 400. Only route doing so.
**Fix:** use `parseQuery` (400 with message).
**Owner:** Backend PE. **Accept:** bad type → 400; suite case 26 (valid types) green. **Verify:** suite + MJG-056 case.

## MJG-051 — Milestone terminal-state guard (P2)
**Finding (API agent):** milestones PATCH lacks a transition map — COMPLETED reopenable, any role completes. Inconsistent with PO/assignment FSMs.
**Fix:** minimal guard mirroring assignment FSM: COMPLETED is terminal (reopen → 422); role policy left as-is (org-internal, was deliberate). Suite unaffected (no reopen case exists; MJG-056 adds one).
**Owner:** Backend PE. **Accept:** reopen → 422; create/complete flows green. **Verify:** suite + MJG-056 case.

## MJG-052 — Payment approve transactional (P2)
**Finding (API agent):** PENDING check → update not wrapped in a transaction (concurrent approvals could double-advance); recorder≠approver segregation deliberately NOT added (small-org OWNER self-approve is a legitimate pattern; evidence's rule is domain-specific).
**Fix:** wrap check+update in `db.$transaction` (interactive), re-check status inside.
**Owner:** Backend PE. **Accept:** suite case 18 green; race window closed. **Verify:** suite.

## MJG-053 — Bounded list queries (P2)
**Finding (API agent):** unbounded findMany on payments, deliveries, evidence, purchase-orders (nested items), assignments. Org-scoped so growth is per-org, but no ceiling.
**Fix:** `take: 500` + stable orderBy on each; frontend pagination is out of scope (lists stay UI-compatible at realistic sizes; ceiling documented).
**Owner:** Backend PE. **Accept:** suite list assertions green with limits in place. **Verify:** suite.

## MJG-054 — Expired-session pruning (P2)
**Finding (ops agent):** expired sessions only lazily deleted when presented → unbounded Session table growth on Render.
**Fix:** on successful login, `deleteMany({ expiresAt: { lt: now } })` (global, cheap, indexed enough at this scale).
**Owner:** Security PE. **Accept:** login prunes expired rows; suite login cases green. **Verify:** suite.

## MJG-055 — Boot-failure retry + deep-link intent + a11y (P2/P3 batch)
**Findings (UX + CTA agents):** (1) non-401 /api/auth/me failure renders BootSplash forever — no error, no retry; (2) `#get-started` deep link opens auth in LOGIN mode (default) instead of REGISTER — conversion friction against CTA intent; (3) org-type radio buttons lack a `role="radiogroup"` container.
**Fix:** page.tsx error card with Retry on non-401; `#get-started` → register mode, `#signin` → login mode; radiogroup wrapper.
**Owner:** Frontend PE. **Accept:** gates green; CTA deep links verified in browser evidence. **Verify:** suite + browser E2E.

## MJG-056 — Suite extensions (P2)
**Scope:** add cases: cookie flags (HttpOnly/SameSite on login), malformed register payload → 400, /api/partners?type=BOGUS → 400 (MJG-050), partner-org POST /api/sites → 403 (MJG-058), WORKER assignment PATCH → 403 (MJG-044), milestone reopen → 422 (MJG-051), rate-limit 429 (MJG-043, throwaway email), cross-constructor tenancy (second constructor sees empty lists + 404 on foreign ids).
**Owner:** QA PE. **Accept:** suite green (SQLite + Postgres); case count grows 30→38. **Verify:** both engines.

## MJG-057 — Docs/config hygiene batch (P3)
**Scope:** package.json `engines.node >=20`; .env.example portable `file:../db/custom.db` (prisma resolves relative to schema dir) + GH_TOKEN/MJENGO_API_BASE notes; DEPLOYMENT.md:3-4 intro de-staled; BACKUPS.md absolute path generalized; start-script drift (bun sandbox vs node Render) + `tee` note; vercel region note (fra1 recommended to pair with Render region).
**Owner:** Docs PE. **Accept:** every doc statement matches code. **Verify:** doc-vs-code cross-check.

## MJG-058 — MJG-036(a): constructor-domain org-type guard (P1)
**Basis:** MJG-036 design (product-approved phasing); part (a) is mechanical and closes the "partner org can create constructor-domain records in its own org" sloppiness. Parts (b) logistics task model and (c) partner accept/acknowledge + shipment logging remain the phase-3 roadmap (MJG-036, owner: Product+Staff, acceptance criteria unchanged) — deliberately deferred per the phased MJG-030 design to keep each schema/tenancy change reviewable.
**Fix:** `requireUser(roles?, opts?: { orgType: OrganizationType[] })` (new optional param; SessionUser already carries organizationType) + apply `orgType: ['CONSTRUCTOR']` to constructor-domain WRITES: sites POST/PATCH, materials POST, workers POST, inventory/movements POST, attendance POST, assignments POST/PATCH, milestones POST/PATCH, evidence POST, deliveries POST, purchase-orders POST/PATCH, suppliers POST, payments POST. NOT gated: users POST (org-generic team management), all GETs (read-only), partner routes (own gates).
**Owner:** Backend PE. **Accept:** partner-org user → 403 on each listed write (MJG-056 case); every constructor flow green; suite green on both engines. **Verify:** suite both engines + 403 probe.

## OPEN-ISSUES-03 — audit provenance
Ten parallel read-only audits (2026-11-12): CTA wiring, FE/BE integration, security/authz, DB/migrations, deploy configs, API surface, partner model, QA infra, docs accuracy, repo hygiene + frontend UX + prod ops. Consolidated: 0 P0, 13 P1, 8 P2, several P3 → filed as MJG-037..058 above. Prior-session claims re-verified: partner model (MJG-030/035) correctly implemented, FSMs correct, delivery-verify idempotent, payments OWNER-only, migrations replayable, schema parity clean, dev tree clean of secrets/junk (main tip polluted by daemon only).
"""

# 1) insert rows after MJG-036 table row
anchor_row = "| MJG-036 | Partner phase-2 remainder: constructor-endpoint org-type guard + logistics delivery-task model (follow-up from MJG-035) | Backend | — | OPEN |"
assert anchor_row in text, "table anchor missing"
text = text.replace(anchor_row, anchor_row + "\n" + ROWS.rstrip("\n"), 1)

# 2) append details
text = text.rstrip("\n") + "\n" + DETAILS
INDEX.write_text(text)
print("INDEX.md updated:", len(text.splitlines()), "lines")

# 3) gitignore gaps (MJG-048)
gi = Path(".gitignore")
g = gi.read_text()
if "worklog-entries/" not in g:
    g = g.rstrip("\n") + "\n\n# MJG-048 — sprint evidence + per-agent worklog drafts are sandbox-local\ndownload/\nworklog-entries/\n"
    gi.write_text(g)
    print(".gitignore updated")
else:
    print(".gitignore already covers")

# 4) preserve the OPEN-ISSUES-02-PUSH worklog entry (daemon put it on main only)
wl = Path("worklog.md")
w = wl.read_text()
if "OPEN-ISSUES-02-PUSH" not in w:
    entry = """

---
Task ID: OPEN-ISSUES-02-PUSH
Agent: Principal Orchestrator (main)
Task: GitHub push of the OPEN-ISSUES-02 release (continuation of MJG-031 lineage adoption).

Work Log:
- Pre-push regression caught: daemon checkpoint commits had re-added `.env` + `db/custom.db` to MAIN's tree (MJG-029 recurrence; dev was clean). Release commit tree = dev tree → both purged from main (files remain on disk). Verified: `git ls-tree main` has no `.env`, no `db/`.
- Backwards-synced main-only content into dev BEFORE the release (established pattern): `scripts/pg-keep.ts` (persistent embedded-PG keeper from HOSTING-01) + worklog HOSTING-01-PUSH tail. Temp branch chore/backwards-sync-02 merged to dev, deleted.
- Sprint merged via plumbing: chore/backwards-sync-02 → dev (38df356), chore/dep-hygiene → dev (85a4130, MJG-034), feat/partner-access → dev (fecf9ad, MJG-030/032/033/035). All temp branches deleted; `git branch` = dev + main only.
- Release: main tree == dev tree (identical), secret scan on released tree: 0 hits (no .env/db/token paths in 219 tracked files).
- PUSH BLOCKED: upload/sharkpush.txt token is now INVALID (API 401; git push "Invalid username or token" with both x-access-token and classic PAT forms; the earlier ls-remote "success" was anonymous read of the public repo). Token likely rotated/expired — matches the standing rotation recommendation.
- Bridges prepared and verified fast-forward-pushable the moment a valid token exists: main @ 7a2d662 (parents: previous main, dev, remote main f8e8c4e — adopts remote lineage), dev @ 2ab32ac (parents: dev, release). Remote expected FF: main f8e8c4e → 7a2d662, dev 1600308 → 2ab32ac.

Stage Summary:
- Local state is the release state: main @ 7a2d662 + dev @ 2ab32ac, identical clean trees, 35/36 registry DONE (MJG-036 OPEN).
- USER ACTION REQUIRED: provide a fresh push-scoped GitHub token (or push manually) to publish:
  `git push https://<token>@github.com/Youngshark-Technologies/Mjengo-OS.git main dev`
  (fast-forward, no force needed). After merge, Vercel git-integration auto-deploys per docs/DEPLOYMENT.md; Render blueprint deploy + NEXT_PUBLIC_APP_URL/BACKEND_URL env pairing remain per the HOSTING-01 runbook.
"""
    wl.write_text(w.rstrip("\n") + entry)
    print("worklog.md: preserved OPEN-ISSUES-02-PUSH entry")
else:
    print("worklog.md already has entry")
