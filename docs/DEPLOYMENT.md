# MjengoOS — Deployment Guide

MJG-019. The app is a single Next.js 16 (standalone output) service with a
SQLite database via Prisma. Everything below was validated locally except the
container build itself (no docker daemon in the build sandbox) — the Dockerfile
mirrors the locally-validated `build`/`start` scripts one-to-one.

## What you need

- A host (VM/bare metal) or a container platform.
- Bun 1.x (bare-metal path) or Docker (container path).
- A writable directory for the SQLite file.

## Option A — Docker (recommended)

```bash
docker build -t mjengoos:latest .

docker run -d --name mjengoos \
  -p 3000:3000 \
  -e DATABASE_URL=file:/data/mjengo.db \
  -v mjengo-data:/data \
  mjengoos:latest
```

The entrypoint runs `prisma db push` (idempotent — creates the file and tables,
never drops existing data) before starting the server, so a fresh volume boots
with a working schema and an existing volume upgrades in place. The image ships
without any database file; all data lives in the mounted volume.

Verify:

```bash
bash scripts/smoke.sh http://localhost:3000
```

## Option B — bare metal with bun

```bash
bun install --frozen-lockfile
cp .env.example .env               # set DATABASE_URL to a writable path
bunx prisma db push
bun run build                      # next build + static into standalone
PORT=3000 bun run start            # serves .next/standalone/server.js
```

For systemd/PM2, run the same `PORT=<port> bun run start` under the supervisor
of your choice and set `DATABASE_URL` in the unit environment.

## Post-deploy checks

```bash
bash scripts/smoke.sh http://localhost:<port>
curl -s http://localhost:<port>/api        # {"status":"ok","database":"connected",...}
```

- `/api` is the health endpoint (process + live DB queries; 503 on DB failure).
- `/api/sites` must return 401 unauthenticated (authz boundary intact).

## Backups

Schedule the MJG-018 kit on the host:

```
0 2 * * * cd /path/to/app && bun scripts/db-backup.ts >> db/backups/backup.log 2>&1
0 3 * * * find /path/to/app/db/backups -name 'mjengo-*.db' -mtime +14 -delete
```

Restore procedure and the restore drill: `docs/BACKUPS.md`.

## Environment variables

| Variable       | Required | Meaning                                        |
|----------------|----------|------------------------------------------------|
| `DATABASE_URL` | yes      | SQLite file URL, e.g. `file:/data/mjengo.db`   |
| `PORT`         | no       | Server port (default 3000)                     |

No other secrets are required at runtime: sessions are opaque DB tokens,
passwords are scrypt-hashed, and there are no third-party API integrations.

## Known deferred items (not deployable from this sandbox)

- The physical deployment act itself (needs the target host/credentials).
- Domain + TLS termination (platform-level; put Caddy/nginx in front).
- Off-site backup replication (see docs/BACKUPS.md limits).

---

## First-time production initialization & demo-data cleanup (MJG-023)

A production deployment starts from an EMPTY database. The Docker entrypoint
runs `prisma db push` on a fresh volume — no seed data exists in this product
by design (verified: no seed scripts in `prisma/`).

If you ever need to wipe a database back to this pristine state (e.g. before
go-live, after QA data), use the guarded, backup-mandatory procedure:

```bash
# refuses to run without the flag; takes a verified online backup first;
# wipes all rows; refuses to report success unless the post-audit is zero
bash scripts/db-reset-with-backup.sh --i-understand-this-wipes-the-database
```

Read-only verification at any time (counts + integrity + orphan check):

```bash
bun scripts/db-audit-counts.ts                 # report
bun scripts/db-audit-counts.ts --zero-required # exit 1 unless every table is empty
```

Evidence from the launch wipe (2026-10-21): 62 rows → 0 across 18 tables,
integrity ok, 0 orphans; rollback via the pre-wipe backup in `db/backups/`
(`bun scripts/db-restore.ts <backup> --into db/custom.db`).

---

## Hosted deployment — Vercel (frontend/website) + Render (backend) (MJG-026/027)

This is the product-owner-directed hosting model: **frontend and website on
Vercel, backend (API + database) on Render, deploys originate from `main`
only**. One codebase, two targets:

```text
Browser ──> Vercel (UI: landing/website + app views, vercel.json)
                │  /api/:path*  ── rewrite (BACKEND_URL) ──>  Render service (mjengoos-api)
                │                                              ├─ serves /api/* in-process
                │                                              └─ Render Postgres (DATABASE_URL)
                └─ session cookie stays same-origin (no CORS involved)
```

Database migrations are **versioned Postgres SQL** in `prisma/migrations/`
(MJG-026), applied automatically on every Render deploy by
`prisma migrate deploy` (idempotent — no-op when up to date).

### Step 1 — Render (backend + database)

1. Render Dashboard → **New → Blueprint** → select this repository → branch
   `main`. Render reads `render.yaml` and provisions:
   - web service `mjengoos-api` (Node 22, health check `/api`),
   - PostgreSQL database `mjengoos-db` (connection string wired to
     `DATABASE_URL` automatically).
2. When prompted for the `NEXT_PUBLIC_APP_URL` sync parameter, enter the
   frontend URL (Step 2.5), e.g. `https://mjengoupdate.vercel.app`.
   **Leave `BACKEND_URL` unset on Render** — the API must resolve in-process.
3. Deploy. First boot: `prisma migrate deploy` creates the full schema from
   the versioned migrations → empty, production-clean database (no seed data
   by design, MJG-023).
4. Verify: `curl https://<render-url>/api` →
   `{"status":"ok","database":"connected",...}`.

> **Plan note:** Render's free PostgreSQL expires after 30 days. For live
> customer use, upgrade the database to a paid plan (and consider a paid web
> instance for always-on capacity — free web services sleep, which pauses the
> API behind the frontend).

### Step 2 — Vercel (frontend + website)

1. Vercel → **Add New → Project** → import this repository.
2. **Settings → Git → Production Branch: `main`** (deploy-from-main-only;
   `dev` and branches build as previews only if you enable them).
3. Framework preset: Next.js (from `vercel.json`; build command `next build`).
4. Environment variables (Production):
   - `BACKEND_URL` = the Render service URL from Step 1.4 (e.g.
     `https://mjengoos-api.onrender.com`) → enables the `/api` proxy rewrite.
   - `NEXT_PUBLIC_APP_URL` = the public app origin (e.g.
     `https://mjengoupdate.vercel.app` or your custom domain) → marketing
     CTAs navigate to the app (MJG-028). On Vercel this is typically the same
     origin, in which case the value may stay empty (in-page auth).
   - Do **not** set `DATABASE_URL` on Vercel — the frontend holds no database.
5. Deploy. Every push to `main` produces a production deployment; the Vercel
   git integration is the redeploy mechanism (no manual redeploy needed).

### Deploy-from-main-only policy (both platforms)

- `main` = production branch (Render `branch: main`, Vercel production branch
  `main`). `dev` = local integration branch; work reaches `main` only through
  the governed release (issue → temp branch → gates → merge to dev → release).
- Rollback: Render Dashboard → deploys → **Rollback** (redeploys a prior
  build; migrations are forward-only — coordinate schema rollbacks with the
  Database team). Vercel → Deployments → **Instant Rollback**.

### Environment variable matrix

| Variable              | Vercel (frontend)        | Render (backend)        | Local/Docker            |
|-----------------------|--------------------------|-------------------------|-------------------------|
| `DATABASE_URL`        | — (no DB on frontend)    | Render Postgres URL     | `file:…` SQLite URL     |
| `BACKEND_URL`         | Render service URL       | **unset** (proxy loop!) | unset                   |
| `NEXT_PUBLIC_APP_URL` | app origin (or empty)    | app origin (CTAs)       | empty                   |
| `PORT`                | managed by platform      | managed by platform     | 3000                    |

### Security notes for the hosted path

- TLS is terminated at the platform edge (Vercel/Render) — cookies already
  carry `secure` in production (MJG-002).
- Rate limiting is not in-app by design (MJG-024 disclosure) — enable Vercel
  Firewall / Render rate limiting or put Cloudflare in front.
- `/api` health remains public by design; every business route enforces the
  session + org scoping server-side (verified by the 21-case suite, which
  also runs against Postgres: `bun run test:api:pg`).

### Self-hosted alternative (unchanged)

The Docker (Option A) and bare-metal bun (Option B) paths above remain fully
supported — they use the SQLite schema (`prisma/schema.prisma`) and the
`db push` entrypoint. The hosted path uses the Postgres schema
(`prisma/schema.postgres.prisma`) and versioned migrations. The two schemas
are kept identical by `bun run schema:parity`, which runs inside the QA gate.
