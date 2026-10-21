#!/bin/bash
# MJG-035 — E2E seed: constructor org + site/material/supplier + sent PO.
# Creates the constructor side of the partner journey on a MjengoOS server.
# Usage: bash scripts/e2e-seed-partner.sh [base-url]   (default http://localhost:3000)
set -euo pipefail

BASE="${1:-http://localhost:3000}"
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

post() { curl -sf -m 10 -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

echo "[seed] constructor register"
post -X POST "$BASE/api/auth/register" -d '{
  "name": "E2E Constructor Owner",
  "email": "e2e-constructor@mjengo.test",
  "password": "E2ePass#2026!",
  "organizationName": "E2E Constructors Ltd"
}' >/dev/null

echo "[seed] site + material + supplier"
SITE=$(post -X POST "$BASE/api/sites" -d '{"name":"E2E Tower","location":"Nairobi"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
MAT=$(post -X POST "$BASE/api/materials" -d '{"name":"E2E Cement","unit":"BAG","unitCost":700}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
SUP=$(post -X POST "$BASE/api/suppliers" -d '{"name":"E2E Supply Co","category":"Cement"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')

echo "[seed] PO DRAFT → SENT"
PO=$(post -X POST "$BASE/api/purchase-orders" -d "{
  \"siteId\": \"$SITE\",
  \"supplierId\": \"$SUP\",
  \"items\": [{\"materialId\": \"$MAT\", \"quantity\": 60, \"unitCost\": 700}]
}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
post -X PATCH "$BASE/api/purchase-orders/$PO" -d '{"status":"SENT"}' >/dev/null

echo "SUPPLIER_ID=$SUP"
echo "PARTNER_READY=1"
