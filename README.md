# MjengoOS

Evidence-backed operating system for construction sites: sites, workforce,
inventory, procurement, deliveries, evidence reports and payments — one
multi-tenant (organization-scoped) construction-management app.

## Architecture

One codebase, one process:

- **Single Next.js 16 App Router app** (standalone output, `next.config.ts`)
  that serves **both** the UI and the `/api` routes in the same server
  process.
- **No separate marketing website.** The marketing site IS the in-app landing
  page (`src/components/marketing/*`, incl. the animated hero), served by the
  same app. There is no `mjengoos-website/` repo/app — historical artifacts
  implying one are wrong.
- **Prisma 6 data layer, two schemas kept in lock-step** by
  `bun scripts/check-schema-parity.ts`:
  - `prisma/schema.prisma` — **SQLite** for local dev/self-hosting
    (`DATABASE_URL` like `file:../db/custom.db`; relative SQLite paths resolve
    against the `prisma/` directory);
  - `prisma/schema.postgres.prisma` — **PostgreSQL** for the hosted targets,
    with versioned SQL migrations under `prisma/migrations/` applied via
    `prisma migrate deploy`.
- **Hosted split deployment (production):** frontend on **Vercel**, API + DB
  on **Render** (Render Postgres). When `BACKEND_URL` is set at build time,
  a `next.config.ts` rewrite (`beforeFiles`) proxies `/api/:path*` to
  `${BACKEND_URL}/api/:path*` — the browser only ever talks to the frontend
  origin, so the session cookie stays same-origin and no CORS is involved.
  On the Render backend itself `BACKEND_URL` must remain **unset** (the API
  resolves in-process; setting it would create a proxy loop).

```text
Browser ──> Vercel (UI + landing, vercel.json)
                │  /api/:path*  ── rewrite (BACKEND_URL, build-time) ──>  Render (mjengoos-api)
                │                                                        ├─ serves /api/* in-process
                │                                                        └─ Render Postgres (DATABASE_URL)
                └─ session cookie stays same-origin (no CORS)
```

## Tech stack

Next.js 16 (App Router, standalone output) · React 19 · TypeScript 5 ·
Tailwind 4 · shadcn/ui (Radix) · Prisma 6 (SQLite dev / PostgreSQL prod) ·
zod 4 · framer-motion · next-intl · TanStack Query/Table.

Runtimes: **bun 1.x** in the dev sandbox; on hosts **Node.js ≥ 20** is the
expected runtime (`engines` in `package.json`; Render pins Node 22 in
`render.yaml`).

## Getting started (local dev)

```bash
bun install
cp .env.example .env        # set DATABASE_URL to a writable SQLite path
mkdir -p db                 # .env.example's file:../db/custom.db needs db/ to exist
bun run db:push             # create/update the dev schema (SQLite)
bun run dev                 # http://localhost:3000 (output tee'd into dev.log)
```

## Scripts (`package.json`)

| Script                | Command                                                                                  |
|-----------------------|------------------------------------------------------------------------------------------|
| `dev`                 | `next dev -p 3000 2>&1 \| tee dev.log`                                                    |
| `build`               | `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/` |
| `start`               | `NODE_ENV=production bun .next/standalone/server.js 2>&1 \| tee server.log`               |
| `lint`                | `eslint .`                                                                                |
| `db:push`             | `prisma db push --accept-data-loss`                                                       |
| `db:generate`         | `prisma generate`                                                                         |
| `db:migrate:deploy`   | `prisma migrate deploy --schema prisma/schema.postgres.prisma`                            |
| `schema:parity`       | `bun scripts/check-schema-parity.ts`                                                      |
| `db:migrate`          | `prisma migrate dev`                                                                      |
| `db:reset`            | `prisma migrate reset`                                                                    |
| `test:api`            | `bash scripts/api-tests.sh`                                                               |
| `test:api:pg`         | `bash scripts/api-tests-pg.sh`                                                            |

## Environment variables

| Variable              | Required | When needed / notes                                                                                                                                               |
|-----------------------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `DATABASE_URL`        | yes      | SQLite file URL locally (`file:…`) / Postgres connection string in production. On Render it is wired automatically from the `mjengoos-db` database (`render.yaml`). |
| `NEXT_PUBLIC_APP_URL` | optional | Public app origin for the marketing CTA deep links (`/#get-started`, `/#signin` — `src/lib/app-url.ts`). **BUILD-time on Vercel**: inlined into the client bundle; runtime-only values silently do nothing. Empty ⇒ in-page auth (sandbox default). |
| `BACKEND_URL`         | optional | Split deploy only: set on the **Vercel frontend** to the Render service URL → proxies `/api/*`. **BUILD-time on Vercel**: baked into the routes manifest. Must stay **unset** on the Render backend (proxy loop) and locally. |
| `MJENGO_API_BASE`     | no       | Test tooling only (`scripts/api-tests*.sh`, `tests/api-mjengo.test.ts`); never needed by the app.                                                                   |
| `GH_TOKEN`            | no       | GitHub tooling scripts only (`scripts/github-open-pr.ts`, `scripts/github-publish-pr.ts`, `scripts/gh_*.py`); never needed by the app. Pass via env only and rotate PATs regularly (MJG-047 hygiene).                                                                                              |
| `PORT`                | no       | Standalone-server port (default 3000); also read by the Docker entrypoint.                                                                                          |

`.env.example` is the template; copy it to `.env` for local dev.

## Hosted deployment — Vercel (frontend) + Render (backend)

- **Vercel** hosts the frontend (project per `vercel.json`). `NEXT_PUBLIC_APP_URL`
  and `BACKEND_URL` must be set in Vercel → Settings → Environment Variables
  **before the build** (both are consumed at build time — see the warning
  above). Do **not** set `DATABASE_URL` on Vercel — the frontend holds no DB.
- **Render** hosts the backend via `render.yaml` (Blueprint): web service
  `mjengoos-api` (Node 22, health check `/api`) + managed PostgreSQL
  `mjengoos-db`. Every deploy runs `prisma migrate deploy` (versioned
  migrations, idempotent) before booting `.next/standalone/server.js`.
- **Deploy-from-main-only:** production deploys trigger **only** from `main`
  (Vercel production branch `main`; `render.yaml` pins `branch: main`,
  `autoDeploy: true`). `dev` is never deployed — it is validated locally and
  released to `main` via the release PR flow (`main` is PR-protected — direct
  pushes are rejected, see `docs/DEPLOYMENT.md` § Release SOP). PRs and temp
  branches never deploy.

Full runbook (steps, env matrix, rollbacks, region notes): **`docs/DEPLOYMENT.md`**.

## Branch model

Two permanent branches: **`main`** (production-ready) and **`dev`**
(integration). Work flows through short-lived temp branches → PR into `dev`;
`main` receives only verified releases (issue → temp branch → gates → merge
to `dev` → release to `main`).

`main` is **PR-protected** (direct pushes rejected, GH006): a release = push
`dev` → push a `release/*` head branch at the release commit → open a PR into
`main` and merge it via `GH_TOKEN=<token> bun scripts/github-publish-pr.ts <head> <base> <title> <bodyFile>`
→ align local `main` to `origin/main` and bridge `dev` (tree-identical merge
commit). Full SOP: `docs/DEPLOYMENT.md` § Release SOP (MJG-071).

## Testing / QA gates (local, authoritative)

```bash
bun run lint                        # eslint
bunx tsc --noEmit                   # typecheck
bun scripts/check-schema-parity.ts  # SQLite vs Postgres schema drift gate
bun run test:api                    # real production build on :3111 + isolated SQLite DB + 30-case API suite
bun run test:api:pg                 # same suite against embedded Postgres (migrate deploy verified)
```

Plus browser E2E. GitHub CI is currently **dormant** (account billing lock):
`.github/workflows/ci.yml` is committed and will run automatically (PRs →
`dev`, pushes → `main`) once Actions is enabled — until then the local gates
above are the authoritative QA.

## Repository map

- `docs/` — deployment guide (`DEPLOYMENT.md`), backup/restore kit
  (`BACKUPS.md`), launch/readiness reports.
- `issues/INDEX.md` — the issue registry (MJG-xxx specs, owners, status).
- `prisma/` — schemas + versioned migrations; `scripts/` — QA/ops tooling.
