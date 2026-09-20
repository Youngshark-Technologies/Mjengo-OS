import { NextRequest, NextResponse } from 'next/server'
import pkg from '../../../../package.json'
import { withRequestLogging } from '@/backend/lib/log'
import { bearerTokenFromAuthorization, secretsMatch } from '@/backend/lib/jobs-token'
// The SAME queries /api/health runs (issue #205: "extract the health route's
// query block into a shared helper so health and metrics cannot drift").
import { dbUp, jobStatusCounts } from '@/backend/lib/health-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/metrics — Prometheus text exposition (issue #205 / audit OBS-3,
 * phase 1; phase 2 — the opt-in OTel seam — is a design note only,
 * docs/adr/0009, deliberately NOT implemented until a real consumer exists).
 *
 * Renders the signals /api/health already computes, in the standard scrape
 * format (content-type `text/plain; version=0.0.4; charset=utf-8`):
 *
 *   mjengo_db_up 1                    the SELECT 1 probe answered
 *   mjengo_db_latency_ms <int>        ms around this scrape's own queries
 *   mjengo_jobs{status="queued"|"retrying"|"failed"} <int>
 *                                     point-in-time row counts (gauges)
 *   mjengo_uptime_seconds <int>       process.uptime()
 *   mjengo_build_info{name,version} 1 package.json name/version labels
 *
 * AUTH — DEDICATED `METRICS_TOKEN` (the decision the issue asks to make and
 * document; see DEPLOYMENT.md §7.2):
 *   `Authorization: Bearer <METRICS_TOKEN>`
 * The token is deliberately NOT `JOBS_RUN_TOKEN` (nor `HEALTH_DETAIL_TOKEN`):
 *   · separation of concerns / blast radius — the jobs token grants DRAIN
 *     powers (it triggers background-job execution, money-adjacent); the
 *     health-detail token unlocks entity counts + DB error text. Metrics is
 *     READ-ONLY telemetry — a credential that can only read gauges must not
 *     be interchangeable with one that can run jobs, and a leaked scraper
 *     config (Prometheus yml files are notoriously world-readable) must not
 *     hand over queue-drain powers;
 *   · rotation independence — operators can rotate the scraper credential
 *     without re-provisioning the scheduler (and vice versa);
 *   · reuse of the PATTERN, not the value: constant-time compare via the
 *     same lib/jobs-token.ts helpers (secretsMatch / bearer extraction).
 * An operator who genuinely wants one machine secret can set METRICS_TOKEN
 * to the same VALUE deliberately — the explicit assignment IS the decision;
 * there is no silent fallback (fail closed, no default token).
 *
 * FAIL CLOSED: METRICS_TOKEN unset/empty → every request 401s and NO
 * database query runs (the gate is evaluated before any probe). Wrong or
 * missing bearer → 401 (the constant-time path — secretsMatch).
 *
 * DB DOWN → 503 with an honest text body: `mjengo_scrape_error 1`,
 * `mjengo_db_up 0`, uptime + build_info (true without the DB), and the
 * db-latency/job gauges OMITTED (unknown ≠ zero — the health route's rule).
 * Prometheus treats a non-2xx scrape as failed and records `up{job} 0` for
 * the target — that IS the scrapeable error signal; the body is for humans
 * and for tail-based debuggers. This mirrors /api/health's 503 posture so
 * both endpoints tell the same story.
 *
 * House posture (same as /api/health — see route-kit's "deliberately not
 * here" list): standalone route handler, not route()/publicRoute(); GET so
 * the mutation-safety gate does not apply; no rate limit — a high-entropy
 * constant-time-compared machine credential is the abuse boundary (a
 * scraper polls on a fixed cadence; unauthenticated 401s do no DB work).
 */

const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

/**
 * Escape a Prometheus label value per the text-format grammar: `\` → `\\`,
 * `"` → `\"`, literal newline → `\n`. Applied to every label we render with
 * a dynamic value (build_info's name/version come from package.json —
 * trusted-ish, but the escape is cheap and makes the invariant structural).
 */
export function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * The full bearer verdict for GET /api/metrics as ONE pure function (the
 * jobsBearerTokenMatches shape): does this Authorization header authenticate
 * against this configured METRICS_TOKEN? False whenever a bearer credential
 * is not presented, the token is unset/empty (path disabled — fail closed,
 * no default token), or the compare fails.
 */
export function metricsBearerTokenMatches(
  authorizationHeader: string | null | undefined,
  configuredToken: string | null | undefined,
): boolean {
  const presented = bearerTokenFromAuthorization(authorizationHeader)
  if (presented === null) return false // no bearer credential presented
  if (!configuredToken) return false // path disabled — fail closed
  return secretsMatch(presented, configuredToken)
}

/** One sample line: `name{k="v",…} value` (labels optional). */
function sample(name: string, labels: Record<string, string> | null, value: number | string): string {
  const rendered = labels
    ? `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${escapePrometheusLabelValue(v)}"`)
        .join(',')}}`
    : ''
  return `${name}${rendered} ${value}`
}

/** A gauge family: HELP + TYPE + one line per sample. */
function gaugeFamily(name: string, help: string, samples: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples]
}

export function GET(req: NextRequest): Promise<NextResponse> {
  // The scrape gets the same request-id/access-line treatment as every other
  // API request (issue #204) — including the 401s.
  return withRequestLogging(req, 'api/metrics', async () => {
    // Gate FIRST — an unauthenticated request must cost no database work.
    if (!metricsBearerTokenMatches(req.headers.get('authorization'), process.env.METRICS_TOKEN)) {
      // Honest single-line error, JSON like the jobs/run 401 (the secret
      // itself is never echoed back).
      return NextResponse.json({ error: 'Invalid metrics token' }, { status: 401 })
    }

    const startedAt = Date.now()
    try {
      await dbUp()
      const jobs = await jobStatusCounts()
      const body = [
        ...gaugeFamily('mjengo_db_up', 'Whether the database answered this scrape (1 = up, 0 = unreachable).', [
          sample('mjengo_db_up', null, 1),
        ]),
        ...gaugeFamily('mjengo_db_latency_ms', 'Database round-trip latency of this scrape, in milliseconds.', [
          sample('mjengo_db_latency_ms', null, Date.now() - startedAt),
        ]),
        ...gaugeFamily(
          'mjengo_jobs',
          'Background job rows by status (point-in-time row counts, not queue-depth gauges).',
          [
            sample('mjengo_jobs', { status: 'queued' }, jobs.queued),
            sample('mjengo_jobs', { status: 'retrying' }, jobs.retrying),
            sample('mjengo_jobs', { status: 'failed' }, jobs.failed),
          ],
        ),
        ...gaugeFamily('mjengo_uptime_seconds', 'App process uptime in seconds.', [
          sample('mjengo_uptime_seconds', null, Math.floor(process.uptime())),
        ]),
        ...gaugeFamily('mjengo_build_info', 'Build information (labels; the value is always 1).', [
          sample('mjengo_build_info', { name: pkg.name, version: pkg.version }, 1),
        ]),
      ].join('\n')
      return new NextResponse(`${body}\n`, {
        status: 200,
        headers: { 'content-type': METRICS_CONTENT_TYPE },
      })
    } catch {
      // DB down → 503, honest body (see the route header). Latency and job
      // counts are UNKNOWN here, not zero — they are omitted entirely.
      const body = [
        '# ERROR: database unreachable — mjengo_db_latency_ms and mjengo_jobs are unknown, not zero',
        ...gaugeFamily('mjengo_scrape_error', 'Whether this scrape failed (1 = the database was unreachable).', [
          sample('mjengo_scrape_error', null, 1),
        ]),
        ...gaugeFamily('mjengo_db_up', 'Whether the database answered this scrape (1 = up, 0 = unreachable).', [
          sample('mjengo_db_up', null, 0),
        ]),
        ...gaugeFamily('mjengo_uptime_seconds', 'App process uptime in seconds.', [
          sample('mjengo_uptime_seconds', null, Math.floor(process.uptime())),
        ]),
        ...gaugeFamily('mjengo_build_info', 'Build information (labels; the value is always 1).', [
          sample('mjengo_build_info', { name: pkg.name, version: pkg.version }, 1),
        ]),
      ].join('\n')
      return new NextResponse(`${body}\n`, {
        status: 503,
        headers: { 'content-type': METRICS_CONTENT_TYPE },
      })
    }
  })
}
