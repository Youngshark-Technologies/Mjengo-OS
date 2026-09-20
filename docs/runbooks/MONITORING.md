# MjengoOS — Monitoring & Alerting Runbook (issue #217)

External uptime, backup dead-man, and jobs-drain watch for a single-node
self-host. This is the repo's first operator **runbook** (docs/runbooks/ —
incident and ops procedures; the audit baselines live in docs/audit/), and
it is cross-wired from DEPLOYMENT.md §7.2 (health) and §10 (observability)
so it cannot rot into an orphan.

## 0. The honest starting point

Nothing in-tree watches your deployment from outside. The compose
healthcheck **restarts a container but tells no human**; the jobs sidecar
logs its failures to a log nobody reads; a healthy jobs-tick loop and a
401-ing one are indistinguishable from outside the box (audit §8.4/§8.10 —
the exact findings that opened #217). If prod goes dark at 2am, discovery
is customer-voicemail-shaped.

This runbook wires the three checks that close those gaps with **one
primitive**: the dead-man ping. A monitor (healthchecks.io / UptimeRobot /
Better Stack heartbeat class — anything that accepts a periodic "still
alive" HTTP ping) alerts when the ping **stops arriving**. App down, DB
down, cron dead, box dead — one mechanism covers all of them, and the
pattern fits every free tier.

**Honest scope:** a single-box self-host is monitored by an external SaaS
or a second box — not a k8s operator, not a Prometheus stack. When #205's
`/api/metrics` endpoint lands, check C upgrades from JSON-sniffing to real
alert rules (§4); the other two checks stay exactly this simple forever.

## 1. The signal surface (what there is to watch)

| Signal | Where | Shape |
|---|---|---|
| Public health probe | `GET /api/health` | 200 `{"ok":true,"db":"up",…}` / **503** `{"ok":false,"db":"down"}` when the DB is down — a real DB roundtrip, not a TCP accept (issue #164's probe minimum) |
| Gated health detail | same route + `X-Health-Detail: $HEALTH_DETAIL_TOKEN` | adds `jobs: {queued, retrying, failed}`, entity counts, version, uptime, `dbLatencyMs` — the #164 machine-header gate (DEPLOYMENT.md §7.2); set `HEALTH_DETAIL_TOKEN` in the app's `.env` to use it |
| Scheduler liveness | `docker compose logs jobs-tick` (compose) / `journalctl -u mjengo-jobs` (systemd) | a `drain failed …` line per failed tick; **silence is health** (§7.3) |
| Backup liveness | `journalctl -u mjengo-backup.service` | a FAILED unit per failed run; one `[mjengo-backup]` artifact list per success (§7.2.1) |
| Error events | `ERROR_SINK_URL` (§10.2) | opt-in webhook POSTs per captured error — complementary (per-event detail, not liveness) |

## 2. Check A — external uptime poll of `/api/health`

Two wirings; pick either or (best) both. They fail in different ways.

### 2a. The dead-man cron (works from the box itself, free tier friendly)

`deploy/monitoring/mjengo-uptime-ping.sh` polls the health route, asserts
the contract, then pings your monitor:

```bash
install -D -m 0755 deploy/monitoring/mjengo-uptime-ping.sh /usr/local/bin/
# /etc/cron.d/mjengo-uptime (root, every 5 minutes):
*/5 * * * * root MJENGO_HEALTH_URL=https://your-host.example/api/health \
  MJENGO_UPTIME_PING_URL=https://hc-ping.com/<check-uuid> \
  /usr/local/bin/mjengo-uptime-ping.sh
```

What the script asserts (and why):

- **HTTP status ≠ 200 → no ping.** The route answers 503 with
  `{"ok":false,"db":"down"}` when the DB is down — `curl -f` turns that
  into a failed probe, so the poll checks the app AND the database, not
  just the port.
- **Body must contain `"ok":true` → else no ping.** Belt-and-braces
  against a proxy/CDN serving a cached or canned 200.
- **Timeout 10s.** The route does a real `SELECT 1`; 5s can flap under
  load, 10s is the calm floor.
- **Cadence 5 min** (matches the compose healthcheck's `interval`).
- **Monitor-side alert tuning:** alert after 2–3 missed pings (grace ≥
  30 min) — `docker compose up -d --build` is a legitimate ~1 min dark
  window (migrate-on-boot + `start_period: 30s`) and must not page.

A dead box stops its own cron, which stops the ping — **box death is
covered even when the cron runs on the monitored host.**

### 2b. The true external poll (sees the network path too)

Point an UptimeRobot / Better Stack / StatusCake-class monitor at the
public URL — their infrastructure polls it, so DNS failure, TLS-certificate
expiry and a down reverse proxy page too (things a box-local cron
structurally cannot see):

| Setting | Value |
|---|---|
| URL | `https://your-host.example/api/health` |
| Expect | HTTP 200, keyword `"ok":true` in the body |
| Cadence | 60–300 s |
| Timeout | 10 s |
| Alert after | 2–3 consecutive failures |

## 3. Check B — the backup dead-man (issue #199's timer)

The backup script ships the seam since #217: **`BACKUP_HEALTHCHECK_URL`**
in `/etc/mjengo/backup.env` — one curl after every **fully successful**
run. Missed run, failed run, dead host: the ping stops, the monitor
alerts.

```bash
# /etc/mjengo/backup.env (then: chmod 600 — see below):
BACKUP_HEALTHCHECK_URL=https://hc-ping.com/<check-uuid>
systemctl restart mjengo-backup.service   # or wait for the 04:30 timer
```

Monitor-side settings and why:

- **Period 1 day, grace 2–4 hours.** A failed 04:30 run pages the same
  morning — deliberate: with 7-daily retention, every silent failed day
  eats the recovery margin (the known honest failure mode, a photo racing
  the tar, self-heals on the next tick but the operator should still
  re-run: §7.2.1).
- **The failed run is also a FAILED unit** in the journal — the ping's
  absence and the journal line corroborate each other.

The seam's contract (pinned by `tests/unit/backup-deadman-ping.test.ts`):

- **Unset = nothing happens** — no ping, nothing external contacted, the
  unit opens no sockets. Fail-open in every direction.
- **A failed ping never fails the backup.** The artifacts are already
  good; the missing ping is the dead-man doing its job.
- **The URL is never logged** — it is a bearer capability (anyone holding
  it can forge "backup ok" pings), same discipline as `ERROR_SINK_URL`.
  Setting it makes `/etc/mjengo/backup.env` carry a secret → `chmod 600`.
- **No `/fail` ping in v1.** An explicit failure ping would alert in
  seconds instead of hours, but it puts a network call inside the failure
  path (the ERR trap) of a script whose failure contract is deliberately
  minimal. Declined for v1; the tight grace above buys most of the
  immediacy. Revisit if the audit asks again.
- **The systemd sandbox was widened by exactly one notch for this:**
  `mjengo-backup.service` now permits `AF_INET`/`AF_INET6` (it was
  `AF_UNIX`-only). With the URL unset the unit still opens no sockets —
  the script simply never curls. Everything else about the sandbox is
  unchanged.

## 4. Check C — the jobs-drain watch (v1: manual-until-#204/#205)

The scheduler is opt-in (`JOBS_RUN_TOKEN` + sidecar/systemd install) and
nothing verified the queue actually drains. v1 of the watch is
`deploy/monitoring/mjengo-jobs-watch.sh` — a documented cron, exactly the
shape #217 blessed ("manual-until-#204/#205"):

```bash
install -D -m 0755 deploy/monitoring/mjengo-jobs-watch.sh /usr/local/bin/
install -d -m 0755 /var/lib/mjengo
# /etc/mjengo/monitoring.env (chmod 600 — carries the detail token):
#   HEALTH_DETAIL_TOKEN=<the app's §7.2 machine token>
#   MJENGO_JOBS_PING_URL=https://hc-ping.com/<check-uuid>
#   MJENGO_HEALTH_URL=https://your-host.example/api/health
#   MJENGO_COMPOSE_DIR=/srv/mjengo-os     # optional — enables signal 2
# /etc/cron.d/mjengo-jobs (root, every 30 minutes):
*/30 * * * * root . /etc/mjengo/monitoring.env && /usr/local/bin/mjengo-jobs-watch.sh
```

It pings while healthy and goes silent when **either** signal trips:

1. **`jobs.queued` strictly rising across two consecutive probes** — read
   from the *gated* health detail (the public probe body carries no
   counts since #164; the `X-Health-Detail` machine header unlocks them).
   The drain ticks every 5 min, so over a 30-min window a healthy queue
   returns to ~0; a rise across the whole window means the ticks are not
   draining. A transient legitimate rise (a bulk import) is absorbed by
   the monitor-side grace (set grace ≈ 2× the cron period).
2. **The scheduler's failure line ≥ N times (default 3) in the last
   hour** — greps `docker compose logs --since 60m jobs-tick` for
   `drain failed` (compose), or the `mjengo-jobs` journal (systemd).

Honest v1 caveats (all deliberate, all upgradeable):

- **An unreadable signal is treated as stuck** — a wrong
  `HEALTH_DETAIL_TOKEN` or an unreachable health route trips the watch
  rather than silently reading as health.
- **`jobs.queued` rising is a proxy, not a diagnosis** — the queue can
  legitimately spike during data imports; the grace absorbs one-window
  spikes, and the alert's triage path (§7.3: check the Intel "Background
  jobs" card, `GET /api/jobs/run`, the sidecar logs) distinguishes them.
- **When #205's `/api/metrics` lands**, replace this script with a
  Prometheus-style alert rule on the same underlying counters
  (`jobs_queued` monotonic across scrape windows; drain-failure counter
  rate > 0) — the script's signals were chosen so the rule is a
  translation, not a redesign.

## 5. Who gets paged (response expectations)

Modeled on SECURITY.md's advisory response expectations — stated plainly
because a monitor without an owner is a light nobody sees:

- **The page goes to the deployment's on-call operator — the person who
  runs the self-host.** Nothing in-tree decides who that is or how they
  are reached: the alert destination (email / push / Slack) belongs to
  the provider account YOU own. Wiring it is part of installing these
  checks, not an optional extra.
- **Realistic response targets for a single-box self-host** (not an SLA,
  and honestly not 24/7):
  - **Uptime page (check A):** same business day. The stack
    self-heals (`restart: unless-stopped`, migrate-on-boot), so a page
    means self-healing failed or the box is gone.
  - **Backup dead-man (check B):** same morning. Every silent day eats
    the 7-daily recovery margin (§7.2.1's retention math).
  - **Jobs-drain watch (check C):** within 1 business day. The queue
    drains on the next healthy tick; prolonged silence means
    money-adjacent jobs (reconciliation, digests, the Daraja safety
    net — §7.3) are stalling.
- **Triage paths:** health page → §7.2 + the container logs; backup
  page → §7.2.1/§7.2.2 (re-run by hand, then restore if needed); jobs
  page → §7.3 (token? app up? queue state in the Intel card).
- **If a page surfaces something security-sensitive:** do not open a
  public issue — SECURITY.md's advisory path (72-hour acknowledgement)
  governs, exactly as for reported vulnerabilities.
- **If the deployment genuinely needs 24/7 paging,** it has outgrown the
  single-node posture this runbook honestly serves (§9.4 multi-instance
  notes; the Supabase target state is the real path).

## 6. The drill (do it once, before you trust any of this)

1. `docker compose stop app` (or `systemctl stop mjengo-app`).
2. Expect: the uptime check pages within cadence + grace (check A), and
   the jobs watch goes silent on its next probe (check C) — a stopped app
   cannot answer the health poll.
3. `docker compose up -d` → both checks recover on their next cycle.
4. For check B: `systemctl start mjengo-backup.service` after wiring the
   ping URL and confirm the "ping: dead-man ping sent" journal line, then
   check the monitor registered it.
5. Write the drill down in your ops notes with timestamps (the same
   discipline as the §7.2.2 restore drill).

**Honest verification status:** this runbook and its scripts were authored
in a Docker-less sandbox — the scripts are `bash -n`/`sh -n` parsed and
their contracts are content-pinned by `tests/unit/backup-deadman-ping.test.ts`,
but the end-to-end drill above is deliberately the operator's step (the
same posture as the §7.2.2 restore runbook). The first operator to run it
is encouraged to append their transcript to this file's history.

## 7. Token discipline

- Every shipped script reads its URLs/tokens **from the environment** —
  nothing secret is committed, and cron lines live in root-owned files.
- Ping URLs and `HEALTH_DETAIL_TOKEN` are bearer capabilities: anyone
  holding them can forge "healthy" signals. Keep them in `0600` root-owned
  files (`/etc/mjengo/monitoring.env`, tightened `/etc/mjengo/backup.env`),
  never in git, never in tickets or chats.
- A monitor that can only see pings learns exactly one bit per interval —
  the health *body* (counts, versions) stays gated behind the token, and
  the public probe keeps answering the minimal shape (issue #164's split
  is the load-bearing boundary here: point the WORLD-facing poll at the
  public body, never expose the detail token to it).
