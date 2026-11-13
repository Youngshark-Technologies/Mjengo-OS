#!/bin/bash
# MJG-026 — Postgres migration verification: build → embedded Postgres →
# prisma migrate deploy (versioned migrations) → full API suite against PG.
# Usage: bun run test:api:pg
set -euo pipefail
cd /home/z/my-project

cleanup_pg() {
  pkill -f 'db/pg-test-data' 2>/dev/null || true
  # MJG-060 — free the pg-verify ports if a previous run leaked processes
  # (failures inside pg-migration-verify.ts used to process.exit() past teardown).
  fuser -k 3113/tcp 2>/dev/null || true
  fuser -k 3112/tcp 2>/dev/null || true
  # MJG-066 — restore the SQLite Prisma client. Step 2/5 generated the
  # POSTGRES client (and the build copies it into .next/standalone), which
  # leaves the tree failing the next `bun run test:api` / `bun run build` with
  # "the URL must start with the protocol `file:`". Regenerate the default
  # client (prisma/schema.prisma → SQLite) on EVERY exit — idempotent, covers
  # early-failure paths (parity/build) too. Best-effort: a failed restore must
  # never mask the script's original exit code.
  bunx prisma generate >/dev/null 2>&1 \
    || echo "[api-tests-pg] WARNING: could not restore the SQLite prisma client — run 'bunx prisma generate' before the next 'bun run test:api'"
}
trap cleanup_pg EXIT

echo "[api-tests-pg] 1/5 schema parity gate"
bun scripts/check-schema-parity.ts

# MJG-059 — generate the POSTGRES client BEFORE the standalone build.
# `next build` traces and COPIES the current node_modules Prisma client into
# .next/standalone/; regenerating the client only after the build (as
# pg-migration-verify.ts used to do) leaves the standalone bundle holding the
# SQLite client, so the PG-backed server fails its health check with
# "the URL must start with the protocol `file:`". Gate only passed when a
# previous failed attempt happened to leave a postgres client behind.
echo "[api-tests-pg] 2/5 prisma generate (postgres client, pre-build)"
bunx prisma generate --schema prisma/schema.postgres.prisma

echo "[api-tests-pg] 3/5 production build (standalone)"
bun run build

echo "[api-tests-pg] 4/5 embedded Postgres: initialise → migrate deploy → 30-case suite"
bun scripts/pg-migration-verify.ts

echo "[api-tests-pg] 5/5 teardown complete"
echo "PG API TESTS PASSED"
