#!/bin/sh
# MjengoOS — jobs-drain watch v1 (deploy/monitoring/; issue #217, audit
# §8.10). #205's /api/metrics HAS LANDED (auth-gated Prometheus text,
# METRICS_TOKEN): an operator running a Prometheus-shaped scraper can
# retire this script's JSON sniffing for the alert-rule translation
# (MONITORING.md §4 records the exact mapping — mjengo_jobs{status="queued"}
# monotonic + up{job} 0). The script stays shipped and valid: it needs zero
# extra infrastructure (no scraper), and until someone runs one it remains
# the whole of check C. It pings a dead-man monitor while the
# background-job queue looks healthy and goes silent (→ the monitor's
# "ping overdue" alert) when EITHER stuck-signal fires:
#
#   signal 1 — jobs.queued is strictly RISING across two consecutive
#     probes. The drain ticks every 5 min (§7.3), so over a 30-60 min
#     probe spacing a healthy queue returns to ~0; rising across a whole
#     window means the ticks are not draining. (A transient legitimate
#     rise — a bulk import — is absorbed by the monitor-side grace; the
#     runbook §4 explains the tuning.)
#   signal 2 — the scheduler's failure line repeated N times (default 3)
#     in the last hour: the jobs-tick sidecar's "drain failed" log line
#     (compose) or the mjengo-jobs unit's journal (systemd). A 401-ing
#     token loop and a healthy loop are otherwise indistinguishable from
#     outside the box — the exact §8.10 finding.
#
# PREREQUISITE for signal 1: HEALTH_DETAIL_TOKEN set in the APP's .env
# (DEPLOYMENT.md §7.2) — the X-Health-Detail machine header unlocks the
# #164 gated body (jobs counts) on the same /api/health route. The PUBLIC
# probe body deliberately carries no counts (issue #164), so a
# missing/wrong token reads as "could not read jobs.queued", which this
# script treats as STUCK — an unreadable signal must never look like
# health. Signal 2 needs the docker CLI + the compose project dir
# (MJENGO_COMPOSE_DIR), or journalctl on bare metal — EITHER signal alone
# trips the watch.
#
# INSTALL:
#   install -D -m 0755 deploy/monitoring/mjengo-jobs-watch.sh /usr/local/bin/
#   install -d -m 0755 /var/lib/mjengo        # the state file's home
#   # root-only env (chmod 600 — carries the detail token):
#   #   /etc/mjengo/monitoring.env:
#   #     HEALTH_DETAIL_TOKEN=<the app's §7.2 machine token>
#   #     MJENGO_JOBS_PING_URL=https://hc-ping.com/<check-uuid>
#   #     MJENGO_HEALTH_URL=https://your-host.example/api/health
#   #     MJENGO_COMPOSE_DIR=/srv/mjengo-os    # signal 2 (compose only)
#   # cron (root — /etc/cron.d/mjengo-jobs, every 30 minutes):
#   */30 * * * * root . /etc/mjengo/monitoring.env && /usr/local/bin/mjengo-jobs-watch.sh
#
# Dependencies: POSIX sh + curl + grep + sed (+ docker/journalctl for
# signal 2 — optional). No jq: the queued count is extracted with sed so
# the self-host posture stays coreutils-only (same rule as the backup
# script). No secrets in this file — everything arrives via env.
set -u

MJENGO_HEALTH_URL="${MJENGO_HEALTH_URL:-https://your-host.example/api/health}"
MJENGO_JOBS_PING_URL="${MJENGO_JOBS_PING_URL:?set MJENGO_JOBS_PING_URL (the monitor's ping URL)}"
HEALTH_DETAIL_TOKEN="${HEALTH_DETAIL_TOKEN:?set HEALTH_DETAIL_TOKEN (the app's §7.2 machine header token)}"
STATE="${MJENGO_JOBS_STATE:-/var/lib/mjengo/jobs-queued.state}"
FAIL_LINES="${MJENGO_JOBS_FAIL_LINES:-3}"
COMPOSE_DIR="${MJENGO_COMPOSE_DIR:-}"
JOBS_UNIT="${MJENGO_JOBS_UNIT:-mjengo-jobs}"

stuck=0

# ---- signal 1: jobs.queued strictly rising across probes -----------------
now="$(curl -fsS --max-time 10 -H "X-Health-Detail: $HEALTH_DETAIL_TOKEN" \
  "$MJENGO_HEALTH_URL" 2>/dev/null | tr -d ' ' \
  | sed -n 's/.*"queued":\([0-9][0-9]*\).*/\1/p')"
if [ -n "$now" ]; then
  prev="$(cat "$STATE" 2>/dev/null || echo "$now")"
  if printf '%s\n' "$now" > "$STATE" 2>/dev/null; then
    if [ -n "$prev" ] && [ "$now" -gt "$prev" ]; then
      echo "mjengo-jobs-watch: jobs.queued rising ($prev -> $now) - the drain looks stuck" >&2
      stuck=1
    fi
  else
    echo "mjengo-jobs-watch: cannot write state file $STATE (create its dir) - signal 1 would be blind" >&2
    stuck=1
  fi
else
  echo "mjengo-jobs-watch: could not read jobs.queued (health detail unreachable, or HEALTH_DETAIL_TOKEN rejected)" >&2
  stuck=1
fi

# ---- signal 2: the scheduler's failure line repeating in the last hour ---
fails=0
if [ -n "$COMPOSE_DIR" ] && command -v docker >/dev/null 2>&1; then
  fails="$(cd "$COMPOSE_DIR" && docker compose logs --since 60m jobs-tick 2>/dev/null | grep -c 'drain failed')"
elif command -v journalctl >/dev/null 2>&1; then
  fails="$(journalctl -u "$JOBS_UNIT" --since '1 hour ago' --no-pager 2>/dev/null | grep -c 'drain failed')"
fi
if [ "$fails" -ge "$FAIL_LINES" ]; then
  echo "mjengo-jobs-watch: $fails drain-failure line(s) in the last hour (threshold: $FAIL_LINES)" >&2
  stuck=1
fi

# ---- the dead-man ping: sent only while the queue looks healthy ----------
if [ "$stuck" = "0" ]; then
  curl -fsS --max-time 10 -o /dev/null "$MJENGO_JOBS_PING_URL" || {
    echo "mjengo-jobs-watch: the monitor ping itself failed (check the ping URL / egress)" >&2
    exit 1
  }
else
  echo "mjengo-jobs-watch: STUCK - no ping sent (the monitor's overdue alert is the page)" >&2
  exit 1
fi
