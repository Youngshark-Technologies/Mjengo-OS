import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import pkg from '../../../../package.json'
import { withRequestLogging } from '@/backend/lib/log'
import { secretsMatch } from '@/backend/lib/jobs-token'
import { getSessionFromReq } from '@/backend/lib/guard'
// Issue #205: the probe + job-count queries are shared with GET /api/metrics
// through this module, so the two endpoints cannot drift apart.
import { dbUp, jobStatusCounts } from '@/backend/lib/health-queries'

export const dynamic = 'force-dynamic'

/**
 * Health / readiness probe (Doc A §45 observability, §46 health checks) —
 * the seam a load balancer or k8s would poll: GET /api/health, NO auth
 * (probes have no session).
 *
 * Issue #164 (audit API-13) — liveness is SPLIT from gated detail:
 *
 *   PUBLIC (the default — what every probe sees):
 *     200 { ok, db: 'up', timestamp }
 *     503 { ok: false, db: 'down', timestamp }   when SQLite is unreachable
 *   That is the exact contract the docker-compose healthcheck (HTTP status
 *   only) and the CI smoke test (docker.yml asserts `.ok == true and
 *   .db == "up"`) rely on; the 503 stays public and minimal — probes must
 *   see it, and the DB error text must not leak to the public.
 *
 *   GATED DETAIL (the full pre-#164 body: uptimeSec, version, dbLatencyMs,
 *   job-queue counts, entity counts — and the 503 error text) is returned
 *   only when ONE of the three gates passes:
 *     1. `X-Health-Detail: <HEALTH_DETAIL_TOKEN>` — the ops-dashboard/curl
 *        machine credential, compared in constant time by the SAME helper
 *        as the jobs/run bearer path (lib/jobs-token.ts). Token unset =
 *        path disabled, fail closed (no default token).
 *     2. `HEALTH_PUBLIC_DETAIL=1|true` — an explicit deployment-wide opt-in
 *        (the demo posture, preserved as a choice).
 *     3. an authenticated ADMIN session — the in-app SystemHealthCard
 *        (overview/role-cards.tsx) fetches this route with its session
 *        cookie; the decode is best-effort (a garbage cookie is "no
 *        session", never a 500 — publicRoute's rule) and only the admin
 *        role unlocks detail.
 *   The detail queries (job groupBy + the three counts) run ONLY on the
 *   gated path — the hot probe path pays one SELECT 1 and nothing more.
 *
 * HONEST scope (§45): this is process-local liveness + a real DB round-trip.
 * No OpenTelemetry/tracing exists (the growth path is the #205 design note,
 * docs/adr/0009); scrapeable Prometheus text lives next door at
 * GET /api/metrics (issue #205), rendered from the SAME queries via
 * src/backend/lib/health-queries.ts. Job counts are point-in-time row
 * counts, not queue depth gauges.
 */

/** Request header carrying the HEALTH_DETAIL_TOKEN machine credential. */
const DETAIL_HEADER = 'x-health-detail'

/**
 * HEALTH_PUBLIC_DETAIL explicit opt-in (issue #164): '1' or 'true',
 * case-insensitive, surrounding whitespace tolerated — the deliberate demo
 * posture. Anything else (unset, '0', 'yes', 'on', …) is NOT an opt-in;
 * a security-relevant flag must be unambiguous.
 */
export function healthPublicDetailOptIn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * The X-Health-Detail machine gate (issue #164): constant-time equality
 * with the configured HEALTH_DETAIL_TOKEN, via the jobs/run bearer helper
 * (lib/jobs-token.ts secretsMatch). Unset or empty configured token →
 * never a match — the path is disabled entirely, fail closed.
 */
export function healthDetailHeaderMatches(
  presented: string | null,
  configured: string | undefined,
): boolean {
  if (!presented || !configured) return false
  return secretsMatch(presented, configured)
}

/**
 * The full #164 detail gate for ONE request: env opt-in, the machine
 * header, or an authenticated admin session (the in-app dashboard).
 * Reads the env per request (operators/tests retune without a re-import);
 * a session-decode failure is "not gated", never a probe 500.
 */
async function detailGateFor(req: NextRequest): Promise<boolean> {
  if (healthPublicDetailOptIn(process.env.HEALTH_PUBLIC_DETAIL)) return true
  if (healthDetailHeaderMatches(req.headers.get(DETAIL_HEADER), process.env.HEALTH_DETAIL_TOKEN)) {
    return true
  }
  try {
    const session = await getSessionFromReq(req)
    return session?.user.role === 'admin'
  } catch {
    return false
  }
}

export function GET(req: NextRequest): Promise<NextResponse> {
  // Issue #204: the probe gets the same request-id/access-line treatment as
  // every other API request (req is the Next-injected Request — probes carry
  // no session, the wrapper adds no auth of its own).
  return withRequestLogging(req, 'api/health', async () => {
  const timestamp = new Date().toISOString()

  // The gate runs FIRST: when no gate passes, the count queries below are
  // skipped entirely — the public probe path costs one SELECT 1 (issue
  // #164's small perf win) and leaks no counts/jobs/version.
  const detail = await detailGateFor(req)
  const startedAt = Date.now()

  try {
    await dbUp()
    if (!detail) {
      // The probe minimum — exactly what compose healthchecks, the CI
      // smoke test (docker.yml's jq check) and uptime monitors assert on.
      return NextResponse.json({ ok: true, db: 'up', timestamp })
    }
    const [jobs, projects, workers, notifications] = await Promise.all([
      jobStatusCounts(),
      db.project.count(),
      db.worker.count(),
      db.notification.count(),
    ])
    return NextResponse.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      version: { name: pkg.name, version: pkg.version },
      timestamp,
      db: 'up',
      dbLatencyMs: Date.now() - startedAt,
      jobs,
      counts: { projects, workers, notifications },
    })
  } catch (e) {
    // DB down → 503. The public body stays minimal (probes must see the
    // failure; the error text must not leak); the gated body keeps the
    // honest pre-#164 detail — counts are unknown, not zero.
    return NextResponse.json(
      detail
        ? {
            ok: false,
            uptimeSec: Math.floor(process.uptime()),
            version: { name: pkg.name, version: pkg.version },
            timestamp,
            db: 'down',
            error: e instanceof Error ? e.message : 'Database unreachable',
            jobs: null,
            counts: null,
          }
        : { ok: false, db: 'down', timestamp },
      { status: 503 },
    )
  }
  })
}
