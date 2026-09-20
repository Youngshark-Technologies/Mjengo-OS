#!/usr/bin/env bash
# MjengoOS — scheduled backup: online SQLite snapshot + volume tars
# (deploy/backup/mjengo-backup.sh; issue #199, audit INF-7/DOC-4).
#
# What ONE run does:
#   1. ONLINE SQLite backup of the app database via the sqlite3 CLI's
#      `.backup` dot-command (SQLite's online backup API): a consistent,
#      self-contained snapshot with NO app stop and NO dependence on the
#      live file's WAL sidecars. THE WAL RULE: never plain-copy
#      (`cp`/`rsync`) a SQLite file while the app is running — the copy
#      can hold a half-written page or a detached WAL state and restore
#      as corruption. `.backup` (or app stopped + copy) is the only safe
#      way. The same rule governs restores: DEPLOYMENT.md §7.2.
#   2. tar+gzip of the photo uploads dir (compose volume `app-photos`)
#      and the website-data dir (compose volume `website-data` —
#      submissions.json is plaintext PII, issue #151; the archives are
#      PII too: they are written 0600, handle/store accordingly).
#      Optional: the documents volume (`app-docs`) when MJENGO_DOCS_DIR
#      is set. Excluded BY CONSTRUCTION: only the single file at
#      MJENGO_DB_PATH is ever read from the database directory —
#      db/ratelimit.db (cache-like rate-limit counters, incl. its
#      -wal/-shm sidecars) is never backed up and is safe to lose.
#   3. Verifies what it wrote: `PRAGMA integrity_check` (must print
#      `ok`) on the fresh DB snapshot, a `tar -tzf` read-back of every
#      archive, and a sha256 sidecar per artifact so a restore can be
#      verified before it is trusted (see the runbook).
#   4. Retention (find -mtime pruning): MJENGO_RETAIN_DAILY_DAYS=7
#      dailies + MJENGO_RETAIN_WEEKLY_DAYS=28 (four weeklies). The
#      weekly set refreshes on the FIRST run of each ~7-day window
#      (hardlinked from that day's daily artifacts — zero extra copy;
#      `cp -p` fallback if daily/ and weekly/ are on different
#      filesystems). Only `mjengo-*` files at depth 1 are ever pruned.
#   5. Fails loudly: `set -Eeuo pipefail` + an ERR trap → any failure
#      prints one `[mjengo-backup] FAILED …` line to stderr and exits
#      non-zero. Under the systemd timer, stdout AND stderr land in the
#      journal (journalctl -u mjengo-backup.service) and a failed run is
#      a FAILED UNIT — wire an uptime monitor to it (dead-man switch).
#      Known honest failure mode: a photo/submission written while tar
#      reads the dir makes tar exit 1 ("file changed as we read it") —
#      the run fails on purpose rather than ship a torn archive; re-run.
#   6. (optional, off by default) Pings an external dead-man monitor once
#      after a fully successful run: set BACKUP_HEALTHCHECK_URL (see the
#      config block below and docs/runbooks/MONITORING.md §3 — issue #217).
#      Fail-open in every direction: unset = no ping and nothing external
#      is contacted; a failed ping never fails the run.
#
# Dry run: `mjengo-backup.sh --dry-run` prints the full plan (sources,
# target names, weekly decision, prune candidates) and writes NOTHING.
#
# Dependencies (the self-host posture): bash, sqlite3, tar, gzip,
# sha256sum, find, date — coreutils + sqlite3, nothing else.
#
# INSTALL (root, from a repo checkout — the systemd pair in this
# directory owns the cadence; DEPLOYMENT.md §7.2 is the full guide
# including the RESTORE runbook):
#   # once per host — the dedicated, no-login service user (same one the
#   # jobs timer uses; skip if it already exists):
#   useradd --system --user-group --home-dir /nonexistent \
#          --shell /usr/sbin/nologin mjengo
#   install -D -m 0755 deploy/backup/mjengo-backup.sh  /usr/local/bin/mjengo-backup.sh
#   install -D -m 0644 deploy/backup/mjengo-backup.service /etc/systemd/system/
#   install -D -m 0644 deploy/backup/mjengo-backup.timer   /etc/systemd/system/
#   install -D -m 0644 deploy/backup/mjengo-backup.env.example /etc/mjengo/backup.env
#   install -d -o mjengo -g mjengo -m 0700 /var/backups/mjengo
#   # edit /etc/mjengo/backup.env: set the three source paths for YOUR
#   # deployment (docker volume mountpoints or bare-metal dirs — the
#   # discovery commands are in that file), then:
#   systemctl daemon-reload
#   systemctl enable --now mjengo-backup.timer    # the TIMER, not the service
#   # first run by hand to verify the whole chain (writes real backups):
#   systemctl start mjengo-backup.service
#
# Verify:  systemctl list-timers 'mjengo-backup*'
#          journalctl -u mjengo-backup.service    # each run's artifact list
#          ls -l /var/backups/mjengo/daily/ /var/backups/mjengo/weekly/
#
# Manual run (no systemd): set the env vars (see the env example) or
# rely on the defaults, then run:  mjengo-backup.sh [--dry-run]

set -Eeuo pipefail
umask 077   # backups contain PII (website leads) + business data: 0600 by default

# ---- configuration (env-overridable; see mjengo-backup.env.example) ----
# Source paths. Defaults = the docker-compose named volumes for a clone
# directory named `mjengo-os` (compose prefixes volume names with the
# project name = directory name — adjust the prefix if yours differs,
# discovery commands in the env example). Bare-metal self-hosts: point
# these at the real dirs (e.g. /srv/mjengo/custom.db).
: "${MJENGO_DB_PATH:=/var/lib/docker/volumes/mjengo-os_app-db/_data/custom.db}"
: "${MJENGO_PHOTOS_DIR:=/var/lib/docker/volumes/mjengo-os_app-photos/_data}"
: "${MJENGO_WEBSITE_DIR:=/var/lib/docker/volumes/mjengo-os_website-data/_data}"
# Optional documents volume (compose ships it commented out): empty = skipped.
: "${MJENGO_DOCS_DIR:=}"
# Destination tree (daily/ + weekly/ subdirs are created inside).
: "${MJENGO_BACKUP_DIR:=/var/backups/mjengo}"
# Retention, whole days (find -mtime): 7 = one week of dailies, 28 = four weeklies.
: "${MJENGO_RETAIN_DAILY_DAYS:=7}"
: "${MJENGO_RETAIN_WEEKLY_DAYS:=28}"
# Per-component opt-outs for the tar'd volumes ("0" = skip) — the DB is
# never optional. Useful on a dev box without a website dir.
: "${MJENGO_BACKUP_PHOTOS:=1}"
: "${MJENGO_BACKUP_WEBSITE:=1}"
# Dead-man ping (issue #217 / audit §8.4): URL curled ONCE after a fully
# successful run, so an external monitor (healthchecks.io / UptimeRobot
# heartbeat class) can alert when backups STOP succeeding — missed run,
# failed run, dead host: the ping stops either way. Empty (the default) =
# no ping, nothing external is contacted (the ERROR_SINK_URL opt-in seam
# pattern). SECRET-CLASS: anyone holding the URL can forge "backup ok"
# pings — keep the env file it lives in root-only (0600 once set; see
# mjengo-backup.env.example). Never logged by this script.
: "${BACKUP_HEALTHCHECK_URL:=}"

readonly MJENGO_DB_PATH MJENGO_PHOTOS_DIR MJENGO_WEBSITE_DIR MJENGO_DOCS_DIR
readonly MJENGO_BACKUP_DIR MJENGO_RETAIN_DAILY_DAYS MJENGO_RETAIN_WEEKLY_DAYS
readonly MJENGO_BACKUP_PHOTOS MJENGO_BACKUP_WEBSITE
readonly BACKUP_HEALTHCHECK_URL

# ---- helpers -----------------------------------------------------------
log()  { printf '[mjengo-backup] %s\n' "$*"; }
fail() { printf '[mjengo-backup] FAILED: %s\n' "$*" >&2; exit 1; }
on_error() {  # ERR trap: the last line above the FAILED line says what broke
  local code=$1 line=$2
  printf '[mjengo-backup] FAILED (line %s, exit %s): run did not complete.\n' \
    "$line" "$code" >&2
  exit "$code"
}
trap 'on_error $? $LINENO' ERR

usage() {
  cat <<'EOF'
usage: mjengo-backup.sh [--dry-run]

Scheduled MjengoOS backup: online SQLite `.backup` snapshot of the app
database + tar+gzip of the app-photos and website-data volumes
(+ optional app-docs), date-stamped (UTC), with 7-daily/4-weekly
retention, per-artifact sha256 sidecars and a DB integrity check.

  --dry-run   print the plan, write nothing
  --help      this text

Sources/destination/retention come from the environment — see
deploy/backup/mjengo-backup.env.example (installed at
/etc/mjengo/backup.env). Full guide + RESTORE runbook: DEPLOYMENT.md §7.2.
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $arg" ;;
  esac
done
readonly DRY_RUN

# ---- preflight: tools, policy, sources --------------------------------
for bin in sqlite3 tar gzip sha256sum find date; do
  command -v "$bin" >/dev/null 2>&1 || fail "required tool not found: $bin (apt install sqlite3 …)"
done

for var in MJENGO_RETAIN_DAILY_DAYS MJENGO_RETAIN_WEEKLY_DAYS; do
  case "${!var}" in
    ''|*[!0-9]*) fail "$var must be a non-negative integer (got: ${!var})" ;;
  esac
done
for var in MJENGO_BACKUP_PHOTOS MJENGO_BACKUP_WEBSITE; do
  case "${!var}" in
    0|1) ;;
    *) fail "$var must be 0 or 1 (got: ${!var})" ;;
  esac
done

[ -f "$MJENGO_DB_PATH" ] || fail "database not found at MJENGO_DB_PATH=$MJENGO_DB_PATH — set the real path in /etc/mjengo/backup.env (discovery commands in the env example)"
[ "$MJENGO_BACKUP_PHOTOS" = "0" ]  || [ -d "$MJENGO_PHOTOS_DIR" ]   || fail "MJENGO_PHOTOS_DIR is not a directory: $MJENGO_PHOTOS_DIR (or set MJENGO_BACKUP_PHOTOS=0)"
[ "$MJENGO_BACKUP_WEBSITE" = "0" ] || [ -d "$MJENGO_WEBSITE_DIR" ]  || fail "MJENGO_WEBSITE_DIR is not a directory: $MJENGO_WEBSITE_DIR (or set MJENGO_BACKUP_WEBSITE=0)"
[ -z "$MJENGO_DOCS_DIR" ] || [ -d "$MJENGO_DOCS_DIR" ] || fail "MJENGO_DOCS_DIR is set but not a directory: $MJENGO_DOCS_DIR"

# ---- plan -------------------------------------------------------------
ts="$(date -u +%Y%m%dT%H%M%SZ)"       # one UTC timestamp names the whole run
daily_dir="$MJENGO_BACKUP_DIR/daily"
weekly_dir="$MJENGO_BACKUP_DIR/weekly"
db_dest="$daily_dir/mjengo-db-$ts.db"
photos_dest="$daily_dir/mjengo-photos-$ts.tar.gz"
website_dest="$daily_dir/mjengo-website-$ts.tar.gz"
docs_dest="$daily_dir/mjengo-docs-$ts.tar.gz"

# Weekly refresh due? Due when no weekly DB snapshot is younger than 6
# days (with a daily timer that means: the first run of each ~7-day
# window, catch-up included). -mtime -6, not -7, so the weekly cadence
# can only ever be <= 7 days, never drift past it.
weekly_due=1
if [ -d "$weekly_dir" ] \
   && find "$weekly_dir" -maxdepth 1 -type f -name 'mjengo-db-*.db' -mtime -6 -print -quit | grep -q .; then
  weekly_due=0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN — nothing will be written"
  log "db:       $MJENGO_DB_PATH"
  log "            → $db_dest (online sqlite3 .backup + integrity_check)"
  if [ "$MJENGO_BACKUP_PHOTOS" = "1" ]; then
    log "photos:   $MJENGO_PHOTOS_DIR"
    log "            → $photos_dest (tar+gzip + tar -tzf read-back)"
  else
    log "photos:   SKIPPED (MJENGO_BACKUP_PHOTOS=0)"
  fi
  if [ "$MJENGO_BACKUP_WEBSITE" = "1" ]; then
    log "website:  $MJENGO_WEBSITE_DIR  [PII — #151]"
    log "            → $website_dest (tar+gzip + tar -tzf read-back)"
  else
    log "website:  SKIPPED (MJENGO_BACKUP_WEBSITE=0)"
  fi
  if [ -n "$MJENGO_DOCS_DIR" ]; then
    log "docs:     $MJENGO_DOCS_DIR"
    log "            → $docs_dest (tar+gzip + tar -tzf read-back)"
  fi
  log "excluded by construction: db/ratelimit.db (+ -wal/-shm) — cache-like, safe to lose"
  if [ -n "$BACKUP_HEALTHCHECK_URL" ]; then
    log "ping:     would send the dead-man ping after a successful run (BACKUP_HEALTHCHECK_URL is set)"
  else
    log "ping:     none (BACKUP_HEALTHCHECK_URL unset — the default; nothing external is contacted)"
  fi
  log "weekly refresh this run: $([ "$weekly_due" = "1" ] && echo yes || echo 'no — a weekly set newer than 6 days exists')"
  log "retention: would prune from $daily_dir files older than $MJENGO_RETAIN_DAILY_DAYS days:"
  if [ -d "$daily_dir" ]; then
    find "$daily_dir" -maxdepth 1 -type f -name 'mjengo-*' -mtime "+$MJENGO_RETAIN_DAILY_DAYS" -print
  else
    log "  (nothing yet — $daily_dir does not exist)"
  fi
  log "retention: would prune from $weekly_dir files older than $MJENGO_RETAIN_WEEKLY_DAYS days:"
  if [ -d "$weekly_dir" ]; then
    find "$weekly_dir" -maxdepth 1 -type f -name 'mjengo-*' -mtime "+$MJENGO_RETAIN_WEEKLY_DAYS" -print
  else
    log "  (nothing yet — $weekly_dir does not exist)"
  fi
  log "DRY RUN complete — nothing was written"
  exit 0
fi

# ---- the run ----------------------------------------------------------
mkdir -p "$daily_dir"
written=()   # this run's artifacts (for the weekly refresh + summary)

# Online snapshot: `.backup` runs SQLite's backup API against the LIVE
# file — consistent even mid-write, WAL handled internally. .timeout
# rides out a briefly-locked source. Then integrity-check the RESULT
# (a backup that has never been checked is a hope, not a backup).
log "db: online .backup → $db_dest"
sqlite3 -cmd '.timeout 5000' "$MJENGO_DB_PATH" ".backup '$db_dest'"
integrity="$(sqlite3 "$db_dest" 'PRAGMA integrity_check;')"
[ "$integrity" = "ok" ] || fail "integrity_check of the fresh snapshot said: $integrity (snapshot kept for forensics: $db_dest)"
written+=("$db_dest")
log "db: integrity_check ok, $(du -h "$db_dest" | cut -f1)"

# tar a volume dir (+ read the archive back — catches truncated writes)
backup_volume() {
  local label="$1" src="$2" dest="$3"
  log "$label: tar+gzip $src → $dest"
  tar -C "$src" -czf "$dest" .
  local entries
  entries="$(tar -tzf "$dest" | wc -l)"
  [ "$entries" -gt 0 ] || fail "$label archive is empty: $dest"
  written+=("$dest")
  log "$label: $entries entries, $(du -h "$dest" | cut -f1)"
}

if [ "$MJENGO_BACKUP_PHOTOS" = "1" ]; then
  backup_volume photos "$MJENGO_PHOTOS_DIR" "$photos_dest"
fi
if [ "$MJENGO_BACKUP_WEBSITE" = "1" ]; then
  backup_volume website "$MJENGO_WEBSITE_DIR" "$website_dest"
fi
if [ -n "$MJENGO_DOCS_DIR" ]; then
  backup_volume docs "$MJENGO_DOCS_DIR" "$docs_dest"
fi

# sha256 sidecars (basename-relative, so `sha256sum -c` works wherever
# the pair travels together)
sidecars=()
for artifact in "${written[@]}"; do
  base="$(basename "$artifact")"
  (
    cd "$(dirname "$artifact")" && sha256sum "$base" > "$base.sha256"
  )
  sidecars+=("$artifact.sha256")
done
written+=("${sidecars[@]}")

# Weekly refresh: hardlink this run's artifacts into weekly/ (same inode,
# zero extra space; cp -p fallback covers weekly/ on another filesystem).
if [ "$weekly_due" = "1" ]; then
  mkdir -p "$weekly_dir"
  for artifact in "${written[@]}"; do
    base="$(basename "$artifact")"
    if ! ln "$artifact" "$weekly_dir/$base" 2>/dev/null; then
      cp -p "$artifact" "$weekly_dir/$base"
    fi
  done
  log "weekly: refreshed ($weekly_dir now holds this run's set)"
else
  log "weekly: skipped (a weekly set newer than 6 days already exists)"
fi

# Retention. -delete only touches regular files named mjengo-* at depth
# 1 — never the dirs, never anything an operator parked next to them.
prune() {
  local dir="$1" days="$2" pruned
  [ -d "$dir" ] || return 0
  pruned="$(find "$dir" -maxdepth 1 -type f -name 'mjengo-*' -mtime "+$days" -print -delete | wc -l)"
  log "retention: pruned $pruned old artifact(s) from $dir (keep ${days}d)"
}
prune "$daily_dir" "$MJENGO_RETAIN_DAILY_DAYS"
prune "$weekly_dir" "$MJENGO_RETAIN_WEEKLY_DAYS"

log "run complete: ${#written[@]} file(s) under $daily_dir — verify with: sha256sum -c <artifact>.sha256"

# ---- dead-man ping (issue #217) ----------------------------------------
# ONE best-effort curl after a fully successful run, so an external dead-man
# monitor (docs/runbooks/MONITORING.md §3) can alert when the ping stops
# arriving. Deliberately:
#   · UNSET = nothing here runs at all (fail-open, the opt-in seam);
#   · a failed ping NEVER fails the run — the artifacts are already good,
#     and the monitor's "ping overdue" alert is the dead-man doing its job;
#   · the URL is never logged (a bearer capability — the ERROR_SINK_URL
#     discipline); the journal line states only that a ping was attempted;
#   · failure is signaled by the MISSING ping + the FAILED unit, not by an
#     explicit /fail ping: no network call is made from any failure path
#     (a failure ping was considered and declined for v1 — MONITORING.md §3
#     records the tradeoff: tune the monitor's grace tight instead);
#   · curl is NOT in the preflight tool check above — a missing curl must
#     never break the backup itself.
if [ -n "$BACKUP_HEALTHCHECK_URL" ]; then
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 10 -o /dev/null "$BACKUP_HEALTHCHECK_URL"; then
      log "ping: dead-man ping sent"
    else
      log "ping: dead-man ping failed (monitor unreachable) - backup artifacts unaffected"
    fi
  else
    log "ping: BACKUP_HEALTHCHECK_URL is set but curl is not installed - no ping sent"
  fi
fi
