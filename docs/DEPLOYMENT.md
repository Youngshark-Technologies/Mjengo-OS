# MjengoOS — Deployment Guide

MJG-019. The app is a single Next.js 16 (standalone output) service — one
process serves both the UI and the `/api` routes — with Prisma over SQLite
locally and in the self-hosted paths below; the hosted path (§Hosted
deployment) runs PostgreSQL on Render. Everything below was validated locally
except the container build itself (no docker daemon in the build sandbox) —
the Dockerfile mirrors the locally-validated `build`/`start` scripts
one-to-one.

> **Premise correction (MJG-045):** there is **no separate marketing-website
> app/repo** in this lineage — historical artifacts mentioning
> `mjengoos-website/` are wrong; that directory never existed. The marketing
> site IS the in-app landing page (`src/components/marketing/*`, incl. the
> hero animation), served by the same Next.js app.

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
   frontend URL (Step 2), e.g. `https://mjengoupdate.vercel.app`.
   **Leave `BACKEND_URL` unset on Render** — the API must resolve in-process.
   > Audit correction (MJG-040): keeping `NEXT_PUBLIC_APP_URL` set on the
   > Render backend is **correct**, not a defect — the Render build bakes it
   > into the Render-served landing page, so its CTAs carry the right origin.
   > Do not remove it.
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

> **IMPORTANT — BUILD-TIME environment variables on Vercel (MJG-040 — read before
> configuring):** `NEXT_PUBLIC_APP_URL` and `BACKEND_URL` must be present at
> **BUILD time** — set them in Settings → Environment Variables *before* the
> production build runs:
> - `NEXT_PUBLIC_APP_URL` is read at module top-level in `src/lib/app-url.ts`
>   and is **inlined into the client bundle** at build time.
> - `BACKEND_URL` is read inside `rewrites()` in `next.config.ts` and is
>   **baked into the routes manifest** at build time.
>
> A runtime-only value (env var added afterwards, without a fresh
> build/deploy) **silently does nothing**: the landing CTAs keep pointing
> nowhere and `/api/*` is not proxied. Changing either value therefore always
> requires a redeploy (fresh build) — never just a runtime env update.

> **Region note (MJG-057):** set the Vercel function region to `fra1`
> (Frankfurt) and pick the matching region for the Render service — keeping
> the two platforms in the same region keeps the `/api` proxy hop
> low-latency.

### Deploy-from-main-only policy (both platforms)

- `main` = production branch (Render `branch: main`, Vercel production branch
  `main`). `dev` = local integration branch; work reaches `main` only through
  the governed release (issue → temp branch → gates → merge to dev → release).
- Rollback: Render Dashboard → deploys → **Rollback** (redeploys a prior
  build; migrations are forward-only — coordinate schema rollbacks with the
  Database team). Vercel → Deployments → **Instant Rollback**.

### Environment variable matrix

| Variable              | Vercel (frontend)                         | Render (backend)        | Local/Docker            |
|-----------------------|-------------------------------------------|-------------------------|-------------------------|
| `DATABASE_URL`        | — (no DB on frontend)                     | Render Postgres URL     | `file:…` SQLite URL     |
| `BACKEND_URL`         | Render service URL — **BUILD time**      | **unset** (proxy loop!) | unset                   |
| `NEXT_PUBLIC_APP_URL` | app origin (or empty) — **BUILD time**   | app origin (CTAs)       | empty                   |
| `PORT`                | managed by platform                       | managed by platform     | 3000                    |

The **BUILD time** marker means: the variable must be set **at BUILD time** on
Vercel (inlined into the client bundle / routes manifest during `next build`);
a runtime-only value silently breaks
the CTAs (`NEXT_PUBLIC_APP_URL`) and the `/api` proxy (`BACKEND_URL`), so any
change to either requires a redeploy. `NEXT_PUBLIC_APP_URL` on Render is also
baked in at build time — that is intentional and correct (Render-served
landing CTAs; MJG-040 audit correction).

### Start-script drift (benign, MJG-057) — bun vs node

The sandbox `package.json` `start` script runs
`NODE_ENV=production bun .next/standalone/server.js`, while the Render
`startCommand` (`render.yaml`) runs `node .next/standalone/server.js` (after
`prisma migrate deploy`). Both are valid invocations of the same standalone
Next.js server (`output: "standalone"` in `next.config.ts`): bun is the
sandbox runtime, node (22, pinned via `NODE_VERSION` in `render.yaml`) is the
Render runtime. Note also that the `dev` and `start` scripts pipe their
output through `tee` into `dev.log` / `server.log` in the repo root.

### Security notes for the hosted path

- TLS is terminated at the platform edge (Vercel/Render) — cookies already
  carry `secure` in production (MJG-002).
- Rate limiting: the auth endpoints (login/register) are throttled in-app by
  the MJG-043 in-memory limiter (per-process state); platform-level limits
  (Vercel Firewall / Render rate limiting / Cloudflare) remain recommended for
  broader coverage.
- Trusted-proxy note (MJG-061): the limiter derives the client IP from the
  RIGHTMOST `x-forwarded-for` entry — the one set by the LAST trusted proxy.
  On the hosted path Render appends the real client IP (Vercel fronts the
  frontend only); leftmost, client-supplied entries are ignored, so a spoofed
  chain cannot mint fresh limiter buckets. If you deploy behind a different
  proxy topology (or bare, with no proxy), verify its `x-forwarded-for`
  handling — with no proxy the header is entirely client-supplied and should
  be stripped at the edge.
- `/api` health remains public by design; every business route enforces the
  session + org scoping server-side (verified by the 30-case suite, which
  also runs against Postgres: `bun run test:api:pg`).

### Partner organizations (MJG-035)

Registration supports three organization types — **Constructor**, **Supplier**
and **Logistics** (`Organization.type`, default Constructor). Anyone can
self-register as a supplier or logistics partner from the same sign-up form;
partner sessions land in a dedicated read-only **partner portal** instead of
the constructor operating system:

- Supplier orgs see the purchase orders constructors addressed to them —
  and only after a constructor links its supplier record to the partner's
  organization (`PATCH /api/suppliers/{id}`, directory via
  `GET /api/partners?type=SUPPLIER`). DRAFT orders never leave the
  constructor org.
- Logistics orgs get registration + profile today; delivery-task assignment
  ships in a later release (registry MJG-036).

No extra environment configuration is required — the partner model is pure
application logic on the same database and session model.

### Self-hosted alternative (unchanged)

The Docker (Option A) and bare-metal bun (Option B) paths above remain fully
supported — they use the SQLite schema (`prisma/schema.prisma`) and the
`db push` entrypoint. The hosted path uses the Postgres schema
(`prisma/schema.postgres.prisma`) and versioned migrations. The two schemas
are kept identical by `bun run schema:parity`, which runs inside the QA gate.
