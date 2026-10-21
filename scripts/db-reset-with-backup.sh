#!/bin/bash
# MJG-023 — Guarded production data reset (demo/test data wipe).
#
# Permanently wipes ALL rows from the runtime database after taking a verified
# online backup, then proves the result: schema intact, integrity ok, zero rows,
# zero orphans. The backup makes the operation reversible; the audit makes it
# auditable; the flag guard makes it deliberate.
#
# Usage:
#   bash scripts/db-reset-with-backup.sh --i-understand-this-wipes-the-database
#
# Steps:
#   1. Pre-audit  — counts + integrity + FK check (scripts/db-audit-counts.ts)
#   2. Backup     — VACUUM INTO verified copy (scripts/db-backup.ts)
#   3. Reset      — bunx prisma db push --force-reset (drops + recreates schema)
#   4. Post-audit — zero-required audit must pass, or the script fails
#
# Exit codes: 0 = wiped and verified; non-zero = nothing changed past the
# failing step (backup still exists from step 2 once reached).

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--i-understand-this-wipes-the-database" ]; then
  echo "[reset] REFUSED — this permanently deletes all rows in DATABASE_URL."
  echo "[reset] Run: bash scripts/db-reset-with-backup.sh --i-understand-this-wipes-the-database"
  exit 2
fi

echo "[reset] STEP 1 — pre-wipe audit (before counts)"
bun scripts/db-audit-counts.ts | tee /tmp/mjengo-wipe-before.log

echo "[reset] STEP 2 — verified online backup"
bun scripts/db-backup.ts | tee /tmp/mjengo-wipe-backup.log
BACKUP_PATH=$(grep -oE 'db/backups/mjengo-[^ ]+\.db' /tmp/mjengo-wipe-backup.log | tail -1)
[ -n "$BACKUP_PATH" ] || { echo "[reset] backup path not found — aborting"; exit 1; }
echo "[reset] backup at: $BACKUP_PATH (restorable via scripts/db-restore.ts)"

echo "[reset] STEP 3 — schema reset (drop + recreate, zero rows)"
bunx prisma db push --force-reset --skip-generate >/tmp/mjengo-wipe-push.log 2>&1 || {
  echo "[reset] prisma db push FAILED:"; cat /tmp/mjengo-wipe-push.log; exit 1;
}
tail -2 /tmp/mjengo-wipe-push.log

echo "[reset] STEP 4 — post-wipe audit (must be zero-residual)"
bun scripts/db-audit-counts.ts --zero-required | tee /tmp/mjengo-wipe-after.log

echo "[reset] SUCCESS — database empty, verified, reversible via $BACKUP_PATH"
