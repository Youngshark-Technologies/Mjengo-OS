# MjengoOS — Database Backup & Restore

MJG-018. The production datastore is a single SQLite file (path from `DATABASE_URL`,
default `file:/home/z/my-project/db/custom.db`). The kit below gives verified,
scriptable backup and restore with zero new dependencies (bun + prisma only).

## Why `VACUUM INTO`

`VACUUM INTO '<path>'` takes a single read transaction and writes a fresh,
compact, fully independent copy of the database. Unlike a raw file copy it is
guaranteed consistent even while the app is writing, and it never leaves WAL
sidecar files behind. It is safe to run against the live dev/production server.

## Backup

```bash
bun scripts/db-backup.ts            # -> db/backups/mjengo-<timestamp>.db
bun scripts/db-backup.ts --out /path/to/dir
```

The script prints a per-table row-count comparison (live vs backup) and fails
(non-zero exit) if integrity is not `ok` or any count diverges.

## Restore drill (run regularly — proves backups are usable)

```bash
bun scripts/db-restore.ts db/backups/<file>.db
```

This integrity-checks the backup, copies it to a scratch path (the live DB is
never touched), re-checks the copy and compares row counts. A drill that exits 0
is proof the backup is a usable database.

## Actual restore (incident procedure)

1. Stop the app (`pkill -9 -f next-server` / stop the container).
2. `bun scripts/db-restore.ts db/backups/<file>.db --into /home/z/my-project/db/custom.db`
3. Start the app (`bun run start` or the container entrypoint).
4. Verify: `bash scripts/smoke.sh http://localhost:3000`.
5. Loss window = time since the last backup. With the cron below it is ≤ 24h.

## Scheduling (cron)

```
# Daily 02:00 backup, keep the log alongside the backups
0 2 * * * cd /home/z/my-project && bun scripts/db-backup.ts >> db/backups/backup.log 2>&1
```

Retention guidance (manual, or a small find -delete cron):

```
# Keep the last 14 daily backups
0 3 * * * find /home/z/my-project/db/backups -name 'mjengo-*.db' -mtime +14 -delete
```

## Known limits (documented, deferred)

- **Off-site replication** — needs external storage (S3-compatible bucket or
  rsync target). Copy `db/backups/*.db` off the box as a second step when infra
  exists.
- **PITR (point-in-time recovery)** — SQLite has no write-ahead binlog to replay;
  the recovery granularity is the backup schedule itself.
- **Automated restore alerts** — cron above logs only; wire an alert channel when
  a notification provider is selected.

---

## Reset drill (pre-wipe backup) — added MJG-023

Before any `db-reset-with-backup.sh` run, this kit's backup step executes
automatically and is verified (integrity + row counts vs live) before a single
row is deleted. To roll back a wipe:

```bash
bun scripts/db-restore.ts db/backups/mjengo-<timestamp>.db --into db/custom.db
```

Launch-wipe rollback artifact: `db/backups/mjengo-2026-10-21T11-44-48.db`.
