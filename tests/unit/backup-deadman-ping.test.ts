/**
 * Issue #217 — the backup dead-man ping seam + the monitoring runbook's
 * shipped scripts (audit §8.4/§8.10).
 *
 * The backup script gained ONE opt-in seam: BACKUP_HEALTHCHECK_URL — a URL
 * curled after every fully successful run so an external dead-man monitor
 * (healthchecks.io / UptimeRobot heartbeat class) can alert when backups
 * stop succeeding. The monitoring runbook (docs/runbooks/MONITORING.md)
 * ships two cron scripts on the same primitive (uptime ping, jobs-drain
 * watch).
 *
 * This suite pins the seams' CONTRACTS (the same content-pin idiom as
 * tests/unit/compose-log-rotation.test.ts — the CI sandbox runs no
 * backups and has no Docker, so the script sources are the interface):
 *
 *   · OPT-IN: the config default is empty (`:=`) and every use is guarded
 *     by `[ -n "$BACKUP_HEALTHCHECK_URL" ]` — unset = nothing external is
 *     contacted (the ERROR_SINK_URL fail-open seam pattern);
 *   · NEVER LOAD-BEARING: curl is NOT in the preflight required-tools loop
 *     (a missing curl must not break the backup), and the ping block
 *     contains no `fail` call — a failed ping logs and continues, because
 *     the artifacts are already good and the monitor's missing-ping alert
 *     IS the intended signal;
 *   · AFTER SUCCESS ONLY: the ping code sits after the run-complete log
 *     line, and --dry-run (which exits 0 before the run section) never
 *     reaches it — the plan prints a "would ping" line instead;
 *   · SECRET DISCIPLINE: the URL is never logged (the ERROR_SINK_URL
 *     rule — it is a bearer capability); the env example documents the
 *     var as secret-class with the chmod-600 consequence;
 *   · THE UNIT'S ONE-NOTCH SANDBOX WIDENING: mjengo-backup.service permits
 *     AF_INET/AF_INET6 ONLY so the optional ping can open a socket — with
 *     the var unset the unit still opens none (the comment says so);
 *   · the shipped monitoring scripts parse (`sh -n`) and read every
 *     URL/token from the environment — nothing secret in-tree;
 *   · DEPLOYMENT.md wires the runbook (§7.2 + §7.2.1 + §10) so it cannot
 *     rot into an orphan doc.
 *
 * NOT covered here (honest): the actual HTTP round-trips — no Docker, no
 * sqlite3 CLI in the CI sandbox, so no end-to-end backup run. The drill
 * (stop the app → expect the page) is documented as the operator's step
 * in MONITORING.md §6, the same posture as the §7.2.2 restore drill.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = readFileSync(`${REPO_ROOT}/deploy/backup/mjengo-backup.sh`, 'utf8')
const SERVICE = readFileSync(`${REPO_ROOT}/deploy/backup/mjengo-backup.service`, 'utf8')
const ENV_EXAMPLE = readFileSync(`${REPO_ROOT}/deploy/backup/mjengo-backup.env.example`, 'utf8')
const RUNBOOK = readFileSync(`${REPO_ROOT}/docs/runbooks/MONITORING.md`, 'utf8')
const UPTIME_PING = readFileSync(`${REPO_ROOT}/deploy/monitoring/mjengo-uptime-ping.sh`, 'utf8')
const JOBS_WATCH = readFileSync(`${REPO_ROOT}/deploy/monitoring/mjengo-jobs-watch.sh`, 'utf8')
const DEPLOYMENT = readFileSync(`${REPO_ROOT}/DEPLOYMENT.md`, 'utf8')

/** The ping block: from the dead-man header comment to end of file. */
const PING_BLOCK = SCRIPT.slice(SCRIPT.indexOf('# ---- dead-man ping'))

describe('the dead-man ping seam is opt-in and fail-open (issue #217)', () => {
  it('BACKUP_HEALTHCHECK_URL defaults to empty via the := idiom', () => {
    // The same fail-open default as every other env knob in the script.
    expect(SCRIPT).toContain(': "${BACKUP_HEALTHCHECK_URL:=}"')
  })

  it('every use of the URL is guarded by a non-empty test', () => {
    // Unset = the guard is false = no curl, nothing external contacted.
    const guards = SCRIPT.match(/\[ -n "\$BACKUP_HEALTHCHECK_URL" \]/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(2) // dry-run plan + the ping itself
  })

  it('curl is NOT a required tool — a missing curl must never break the backup', () => {
    const preflight = SCRIPT.slice(
      SCRIPT.indexOf('# ---- preflight'),
      SCRIPT.indexOf('# ---- plan'),
    )
    expect(preflight).toContain('for bin in sqlite3 tar gzip sha256sum find date')
    expect(preflight, 'curl must stay out of the required-tools loop').not.toContain('curl')
  })

  it('the ping block cannot fail the run — no fail() call inside it', () => {
    // The artifacts are already good when the ping runs; a failed ping is
    // the dead-man doing its job, not a failed backup. (Line-anchored so
    // the block's COMMENTS — which discuss failure — never match; only a
    // real `fail "…"` call would.)
    expect(PING_BLOCK).not.toMatch(/^\s*fail /m)
    expect(PING_BLOCK).toContain('if curl -fsS --max-time 10 -o /dev/null "$BACKUP_HEALTHCHECK_URL"; then')
    expect(PING_BLOCK).toContain('backup artifacts unaffected')
  })

  it('the ping fires only after a fully successful run (post run-complete)', () => {
    // Ordering pin: the run's own summary line comes first; --dry-run
    // exits 0 inside the plan section and can never reach the ping.
    expect(SCRIPT.indexOf('log "run complete:')).toBeGreaterThan(-1)
    expect(SCRIPT.indexOf('log "run complete:')).toBeLessThan(SCRIPT.indexOf('# ---- dead-man ping'))
    const dryRun = SCRIPT.slice(SCRIPT.indexOf('if [ "$DRY_RUN" = "1" ]'), SCRIPT.indexOf('# ---- the run'))
    expect(dryRun, 'dry-run prints a plan line, never a real ping').toContain(
      'would send the dead-man ping after a successful run',
    )
  })

  it('the URL is never logged — bearer-capability discipline (ERROR_SINK_URL pattern)', () => {
    // Every log line in the ping block states only THAT a ping was
    // attempted; the URL itself appears solely as the curl argument.
    const logLines = PING_BLOCK.match(/log "[^"]*"/g) ?? []
    expect(logLines.length).toBeGreaterThanOrEqual(3)
    for (const line of logLines) {
      expect(line).not.toContain('$BACKUP_HEALTHCHECK_URL')
    }
  })
})

describe('the systemd unit allows exactly the one optional ping (issue #217)', () => {
  it('AF_INET/AF_INET6 permitted, with the rationale comment alongside', () => {
    expect(SERVICE).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6')
    expect(SERVICE).toContain('dead-man ping')
    expect(SERVICE).toContain('opens no sockets')
  })

  it('the env-file comment states the secret-class consequence (chmod 600)', () => {
    expect(SERVICE).toContain('BACKUP_HEALTHCHECK_URL is set (it is a bearer capability')
    expect(SERVICE).toContain('0600')
  })
})

describe('the env example documents the seam', () => {
  it('BACKUP_HEALTHCHECK_URL: purpose, monitor-side settings, secret class', () => {
    expect(ENV_EXAMPLE).toContain('BACKUP_HEALTHCHECK_URL=')
    expect(ENV_EXAMPLE).toContain('hc-ping.com/<check-uuid>')
    expect(ENV_EXAMPLE).toContain('chmod 600')
    expect(ENV_EXAMPLE).toContain('UNSET (the default) = no ping')
  })
})

describe('the shipped monitoring scripts (runbook companions)', () => {
  it('all three operator scripts parse (bash/sh -n)', () => {
    execFileSync('bash', ['-n', `${REPO_ROOT}/deploy/backup/mjengo-backup.sh`])
    execFileSync('sh', ['-n', `${REPO_ROOT}/deploy/monitoring/mjengo-uptime-ping.sh`])
    execFileSync('sh', ['-n', `${REPO_ROOT}/deploy/monitoring/mjengo-jobs-watch.sh`])
  })

  it('the uptime ping asserts the #164 probe contract (200 + ok:true + timeout)', () => {
    expect(UPTIME_PING).toContain('curl -fsS --max-time 10')
    expect(UPTIME_PING).toContain(`grep -q '"ok":true'`)
    expect(UPTIME_PING).not.toMatch(/hc-ping\.com\/[a-z0-9-]+/) // no in-tree ping URLs
  })

  it('the jobs watch treats an unreadable signal as stuck (fail closed)', () => {
    expect(JOBS_WATCH).toContain('X-Health-Detail: $HEALTH_DETAIL_TOKEN')
    expect(JOBS_WATCH).toContain('jobs.queued rising')
    expect(JOBS_WATCH).toContain("grep -c 'drain failed'")
    expect(JOBS_WATCH).not.toMatch(/hc-ping\.com\/[a-z0-9-]+/) // no in-tree ping URLs
  })

  it('no script carries a hardcoded token or ping URL — env only', () => {
    // The :? guard makes a missing env var a loud usage error; the only
    // hc-ping.com literal anywhere is the <check-uuid> PLACEHOLDER in
    // comments/docs — a real UUID in-tree would be a committed secret.
    expect(UPTIME_PING).toContain('MJENGO_UPTIME_PING_URL:?set MJENGO_UPTIME_PING_URL')
    expect(JOBS_WATCH).toContain('MJENGO_JOBS_PING_URL:?set MJENGO_JOBS_PING_URL')
    for (const src of [UPTIME_PING, JOBS_WATCH, ENV_EXAMPLE]) {
      expect(src).not.toMatch(/hc-ping\.com\/(?!<check-uuid>)/)
    }
  })
})

describe('DEPLOYMENT.md wires the runbook in (no orphan docs)', () => {
  it('§7.2 health bullet + §7.2.1 failure bullet + §10 intro reference it', () => {
    const flat = DEPLOYMENT.replace(/\s+/g, ' ')
    expect(flat).toContain('docs/runbooks/MONITORING.md) §3')
    expect(flat).toContain('the shipped, provider-agnostic wiring guide')
    expect(flat).toContain('outside-in complement')
  })

  it('the runbook covers the three checks + response expectations + drill', () => {
    const flat = RUNBOOK.replace(/\s+/g, ' ')
    expect(flat).toContain('external uptime poll')
    expect(flat).toContain('backup dead-man')
    expect(flat).toContain('jobs-drain watch')
    expect(flat).toContain('Who gets paged')
    expect(flat).toContain('The drill')
    expect(flat).toContain('manual-until-#204/#205')
  })
})
