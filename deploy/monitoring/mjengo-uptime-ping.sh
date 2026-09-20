#!/bin/sh
# MjengoOS — uptime dead-man ping (deploy/monitoring/; issue #217, audit
# §8.4). Polls GET /api/health, asserts the probe contract, then pings the
# monitor's success URL. The monitor (healthchecks.io / UptimeRobot
# heartbeat / Better Stack heartbeat — any dead-man check) alerts when the
# ping stops arriving: app down, DB down, box dead — one mechanism covers
# all three (a dead box stops its own cron, which stops the ping).
#
# INSTALL:
#   install -D -m 0755 deploy/monitoring/mjengo-uptime-ping.sh /usr/local/bin/
#   # cron (root — /etc/cron.d/mjengo-uptime, every 5 minutes):
#   */5 * * * * root MJENGO_HEALTH_URL=https://your-host.example/api/health \
#     MJENGO_UPTIME_PING_URL=https://hc-ping.com/<check-uuid> \
#     /usr/local/bin/mjengo-uptime-ping.sh
#
# Thresholds (the values below; reasoning in docs/runbooks/MONITORING.md §2):
#   · HTTP status must be 200 — `curl -f` makes anything else a failure
#     (the route answers 503 {"ok":false,"db":"down"} when the DB is down);
#   · the 200 body must contain "ok":true — belt-and-braces against a
#     proxy/CDN serving a cached or canned 200;
#   · 10s timeout — the route does a real DB roundtrip (SELECT 1); 5s can
#     flap under load, 10s is the calm floor;
#   · cadence 5 min (matches the compose healthcheck interval); configure
#     the ALERT side on the monitor: 2-3 missed pings / grace ≥ 30 min —
#     a `docker compose up -d --build` deploy is a legitimate ~1 min dark
#     window and must not page.
#
# Honest scope: this cron MAY run on the monitored box itself (box death =
# ping stops = the alert fires — that is the dead-man model). What it
# cannot see is the NETWORK PATH (DNS failure, TLS expiry, a down proxy):
# pair it with a true external poll (UptimeRobot / Better Stack class) on
# the public URL for that — MONITORING.md §2 covers both wirings.
#
# No secrets in this file: the URLs come from the environment (cron lines
# live in root-owned crontabs, never in git). Dependencies: POSIX sh +
# curl + grep. Exit status is for the cron journal only — the monitor's
# missing-ping alert is the real signal.
set -u

MJENGO_HEALTH_URL="${MJENGO_HEALTH_URL:?set MJENGO_HEALTH_URL (e.g. https://your-host.example/api/health)}"
MJENGO_UPTIME_PING_URL="${MJENGO_UPTIME_PING_URL:?set MJENGO_UPTIME_PING_URL (the monitor's ping URL)}"

body="$(curl -fsS --max-time 10 "$MJENGO_HEALTH_URL" 2>/dev/null)" || {
  echo "mjengo-uptime-ping: /api/health probe FAILED (non-200 or timeout) - no ping sent" >&2
  exit 1
}
printf '%s' "$body" | grep -q '"ok":true' || {
  echo "mjengo-uptime-ping: /api/health answered 200 without ok:true - no ping sent" >&2
  exit 1
}
curl -fsS --max-time 10 -o /dev/null "$MJENGO_UPTIME_PING_URL" || {
  echo "mjengo-uptime-ping: the monitor ping itself failed (check the ping URL / egress)" >&2
  exit 1
}
