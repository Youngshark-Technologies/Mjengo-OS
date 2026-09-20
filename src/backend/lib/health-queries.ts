// Shared health/metrics probe queries (issue #205 / audit OBS-3).
//
// GET /api/health and GET /api/metrics must derive their numbers from the
// SAME queries — the issue's suggested approach ("extract the health
// route's query block into a shared helper so health and metrics cannot
// drift"). Before this module both routes would have had to copy the
// `SELECT 1` probe and the jobRecord.groupBy read; now the SQL lives in
// exactly one place and the two endpoints are renderers over it:
//
//   · dbUp()              — the liveness probe: one `SELECT 1` round-trip
//                           (throws when the database is unreachable; both
//                           routes' 503 paths hang off that throw);
//   · jobStatusCounts()   — the background-job queue snapshot
//                           ({ queued, retrying, failed }) from ONE groupBy;
//                           absent statuses read as 0 (point-in-time ROW
//                           COUNTS, not queue-depth gauges — the honest
//                           scope note the health route has always carried).
//
// Health additionally counts projects/workers/notifications — deliberately
// NOT extracted: metrics does not serve those, so sharing them would couple
// the scrape path to queries it does not need (the #164 lesson: the probe
// path pays only for what it renders).

import { db } from '@/backend/lib/db'

/**
 * The database liveness probe: one `SELECT 1` round-trip. Resolves when the
 * database answered; THROWS when it did not (the caller's 503 path). Returns
 * the elapsed milliseconds so a caller that wants latency-only semantics can
 * have it without a second abstraction.
 */
export async function dbUp(): Promise<number> {
  const startedAt = Date.now()
  await db.$queryRaw`SELECT 1`
  return Date.now() - startedAt
}

/** The job-status keys both endpoints render (health's exact pre-#205 set). */
export type JobStatusCounts = { queued: number; retrying: number; failed: number }

/**
 * Background-job rows grouped by status: ONE `jobRecord.groupBy` read,
 * mapped to the fixed { queued, retrying, failed } shape with absent
 * statuses reading as 0 — byte-identical to the health route's historical
 * `jobs` payload (its tests pin that shape; this function must not change
 * it). These are point-in-time row counts, not queue-depth gauges.
 */
export async function jobStatusCounts(): Promise<JobStatusCounts> {
  const groups = await db.jobRecord.groupBy({ by: ['status'], _count: { _all: true } })
  const byStatus = new Map(groups.map((g) => [g.status, g._count._all]))
  return {
    queued: byStatus.get('queued') ?? 0,
    retrying: byStatus.get('retrying') ?? 0,
    failed: byStatus.get('failed') ?? 0,
  }
}
