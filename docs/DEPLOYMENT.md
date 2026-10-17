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
