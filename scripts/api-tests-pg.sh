#!/bin/bash
# MJG-026 — Postgres migration verification: build → embedded Postgres →
# prisma migrate deploy (versioned migrations) → full API suite against PG.
# Usage: bun run test:api:pg
set -euo pipefail
cd /home/z/my-project

cleanup_pg() { pkill -f 'db/pg-test-data' 2>/dev/null || true; }
trap cleanup_pg EXIT

echo "[api-tests-pg] 1/4 schema parity gate"
bun scripts/check-schema-parity.ts

echo "[api-tests-pg] 2/4 production build (standalone)"
bun run build

echo "[api-tests-pg] 3/4 embedded Postgres: initialise → migrate deploy → 21-case suite"
bun scripts/pg-migration-verify.ts

echo "[api-tests-pg] 4/4 teardown complete"
echo "PG API TESTS PASSED"
