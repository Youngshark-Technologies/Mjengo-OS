#!/bin/bash
# MJG-020 — boot a REAL production server on :3111 with an isolated SQLite DB,
# run the API golden-journey suite, tear everything down.
#
# Usage:  bun run test:api     (= bash scripts/api-tests.sh)
#
# Guarantees:
#   - the dev server on :3000 is never touched
#   - the test database (db/api-test.db) is created fresh and removed after
#   - any gate failure (build, boot, health, tests) exits non-zero

set -euo pipefail
cd /home/z/my-project

echo "[api-tests] 0/5 schema parity gate (MJG-026)"
bun scripts/check-schema-parity.ts

PORT=3111
BASE="http://localhost:$PORT"
TEST_DB="$PWD/db/api-test.db"

export DATABASE_URL="file:$TEST_DB"
export MJENGO_API_BASE="$BASE"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$TEST_DB" "$TEST_DB-journal"
}
trap cleanup EXIT

echo "[api-tests] 1/5 fresh test database + schema"
rm -f "$TEST_DB" "$TEST_DB-journal"
bunx prisma db push --skip-generate >/dev/null

echo "[api-tests] 2/5 production build (standalone)"
bun run build

echo "[api-tests] 3/5 boot production server on :$PORT"
PORT=$PORT HOSTNAME=127.0.0.1 NODE_ENV=production bun .next/standalone/server.js >api-test-server.log 2>&1 &
SERVER_PID=$!

for i in $(seq 1 60); do
  if curl -sf -m 2 "$BASE/api" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[api-tests] server process died — last log lines:"
    tail -20 api-test-server.log || true
    exit 1
  fi
  if [ "$i" -eq 60 ]; then
    echo "[api-tests] server never became healthy — last log lines:"
    tail -20 api-test-server.log || true
    exit 1
  fi
  sleep 1
done
echo "[api-tests] server healthy: $BASE/api"

echo "[api-tests] 4/5 run suite"
bun test tests/api-mjengo.test.ts

echo "[api-tests] 5/5 teardown (server killed, test DB removed)"
echo "API TESTS PASSED"
