#!/bin/bash
# MJG-019 — deployment smoke check.
# Usage: bash scripts/smoke.sh [base-url]     (default http://localhost:3000)
# Exits non-zero on the first failure. CI/cron-friendly (no deps beyond curl).

set -euo pipefail
BASE="${1:-http://localhost:3000}"
fail() { echo "SMOKE FAIL: $1"; exit 1; }

echo "[smoke] target: $BASE"

# 1. Health endpoint: process + database connectivity.
HEALTH="$(curl -sf -m 10 "$BASE/api")" || fail "GET /api did not return 2xx"
echo "$HEALTH" | grep -q '"status":"ok"' || fail "health status != ok ($HEALTH)"
echo "$HEALTH" | grep -q '"database":"connected"' || fail "database not connected ($HEALTH)"
echo "[smoke] /api health ................ ok"

# 2. Landing page (marketing + hero shell) renders.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/")"
[ "$CODE" = "200" ] || fail "GET / returned $CODE"
echo "[smoke] / landing .................. ok"

# 3. Authorization boundary: business API must reject anonymous callers.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/api/sites")"
[ "$CODE" = "401" ] || fail "GET /api/sites anonymous returned $CODE (expected 401)"
echo "[smoke] /api/sites 401 guard ....... ok"

echo "SMOKE OK — $BASE is serving MjengoOS with a connected database and enforced auth."
