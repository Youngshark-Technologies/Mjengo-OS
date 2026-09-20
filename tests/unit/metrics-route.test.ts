/**
 * Route-level invariants of GET /api/metrics (issue #205 / audit OBS-3):
 * the Prometheus text exposition endpoint, rendered from the SAME queries
 * /api/health runs (src/backend/lib/health-queries.ts).
 *
 * Pinned here (src/app/api/metrics/route.ts):
 *   · AUTH (fail closed, no default token): no Authorization header → 401;
 *     METRICS_TOKEN unset (even with a header presented) → 401; a non-bearer
 *     scheme → 401; a wrong token → 401 (the constant-time secretsMatch
 *     path — its own invariants live in jobs-token.test.ts, the helper
 *     stays REAL here). A 401 runs NO database query (the gate precedes the
 *     probes — an unauthenticated request must cost nothing).
 *   · 200 (valid token): content-type EXACTLY
 *     `text/plain; version=0.0.4; charset=utf-8`; a parseable text-format
 *     body where every non-comment line is `<metric>{labels}? <number>`;
 *     each required family carries `# HELP` + `# TYPE gauge` and sane
 *     values — db_up 1, integer db_latency_ms/uptime_seconds, the three
 *     mjengo_jobs status labels with the counts from the (mocked) groupBy
 *     (absent → 0; OTHER statuses, e.g. done, are NOT rendered), and
 *     build_info with package.json name/version labels and value 1;
 *   · 503 (DB down): same content-type; `mjengo_scrape_error 1`,
 *     `mjengo_db_up 0`, uptime + build_info still present (true without
 *     the DB); mjengo_db_latency_ms and mjengo_jobs are OMITTED entirely —
 *     unknown, never a misleading zero;
 *   · the SHARED-QUERY contract: the 200 path runs the probe ($queryRaw
 *     SELECT 1) and exactly ONE jobRecord.groupBy — the same reads the
 *     health route's gated detail runs (health-queries.ts), so the two
 *     endpoints cannot drift.
 *
 * db is mocked (this file pins route wiring, not SQLite); withRequestLogging
 * (#204) stays real (vitest's onConsoleLog filters the access lines).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pkg from '../../package.json'

vi.mock('@/backend/lib/db', () => ({
  db: {
    $queryRaw: vi.fn(),
    jobRecord: { groupBy: vi.fn() },
  },
}))

import { db } from '@/backend/lib/db'
import { GET, escapePrometheusLabelValue, metricsBearerTokenMatches } from '@/app/api/metrics/route'

const TOKEN = 'm'.repeat(64)
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

function metricsReq(headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/metrics', { method: 'GET', headers })
}

async function textOf(res: { text: () => Promise<string> }): Promise<string> {
  return res.text()
}

/** The text-format grammar, one line at a time: `name{labels}? value`. */
const SAMPLE_LINE = /^mjengo_[a-z_]+(\{[^\n]*\})? \d+$/

/** Every non-comment, non-empty line must be a well-formed sample. */
function sampleLines(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
}

/** The value of `name` (optionally the exact label string), parsed as an integer. */
function sampleValue(body: string, name: string, labelMatch?: string): number {
  const re = new RegExp(
    `^${name}${labelMatch ? labelMatch.replace(/[{}"]/g, '\\$&') : '(?:\\{[^}]*\\})?'} (-?\\d+)$`,
  )
  for (const line of sampleLines(body)) {
    const m = re.exec(line)
    if (m) return Number(m[1])
  }
  throw new Error(`no sample line for ${name}${labelMatch ?? ''} in:\n${body}`)
}

/** True when at least one SAMPLE line (not a HELP/TYPE comment) exists for the family. */
function hasSample(body: string, prefix: string): boolean {
  return sampleLines(body).some((l) => l.startsWith(prefix))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.$queryRaw).mockResolvedValue([])
  vi.mocked(db.jobRecord.groupBy).mockResolvedValue([])
})

afterEach(() => {
  delete process.env.METRICS_TOKEN
})

describe('GET /api/metrics — auth matrix (fail closed)', () => {
  it('no Authorization header → 401, and NO database query runs', async () => {
    process.env.METRICS_TOKEN = TOKEN
    const res = await GET(metricsReq())
    expect(res.status).toBe(401)
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })

  it('METRICS_TOKEN unset (even with a header presented) → 401 — no default token', async () => {
    const res = await GET(metricsReq({ authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(401)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('METRICS_TOKEN set but empty → 401 (empty is unset — the path is disabled)', async () => {
    process.env.METRICS_TOKEN = ''
    const res = await GET(metricsReq({ authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(401)
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })

  it('a non-bearer Authorization scheme → 401', async () => {
    process.env.METRICS_TOKEN = TOKEN
    const res = await GET(metricsReq({ authorization: `Basic ${TOKEN}` }))
    expect(res.status).toBe(401)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('wrong token → 401 (the constant-time compare path), no DB work', async () => {
    process.env.METRICS_TOKEN = TOKEN
    const res = await GET(metricsReq({ authorization: `Bearer ${'d'.repeat(64)}` }))
    expect(res.status).toBe(401)
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })

  it('case-insensitive Bearer scheme + tolerant spacing still authenticates', async () => {
    process.env.METRICS_TOKEN = TOKEN
    vi.mocked(db.jobRecord.groupBy).mockResolvedValue([])
    const res = await GET(metricsReq({ authorization: `bearer   ${TOKEN}` }))
    expect(res.status).toBe(200)
  })
})

describe('GET /api/metrics — the 200 exposition format', () => {
  beforeEach(() => {
    process.env.METRICS_TOKEN = TOKEN
    // One queued + one failed job; retrying absent → 0; 'done' must NOT render.
    vi.mocked(db.jobRecord.groupBy).mockResolvedValue([
      { status: 'queued', _count: { _all: 2 } },
      { status: 'failed', _count: { _all: 1 } },
      { status: 'done', _count: { _all: 9 } },
    ] as Awaited<ReturnType<typeof db.jobRecord.groupBy>>)
  })

  it('valid token → 200 with EXACTLY the Prometheus text content-type', async () => {
    const res = await GET(metricsReq({ authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(CONTENT_TYPE)
  })

  it('every non-comment line is a well-formed sample; each family has HELP + TYPE gauge', async () => {
    const body = await textOf(await GET(metricsReq({ authorization: `Bearer ${TOKEN}` })))
    for (const line of sampleLines(body)) expect(line).toMatch(SAMPLE_LINE)
    for (const family of [
      'mjengo_db_up',
      'mjengo_db_latency_ms',
      'mjengo_jobs',
      'mjengo_uptime_seconds',
      'mjengo_build_info',
    ]) {
      expect(body).toContain(`# HELP ${family} `)
      expect(body).toContain(`# TYPE ${family} gauge`)
    }
    // The metric names the issue requires, verbatim.
    expect(body).toContain('mjengo_db_latency_ms ')
    expect(body).toContain('mjengo_uptime_seconds ')
    expect(body).toContain('mjengo_build_info{')
  })

  it('the exact family/label skeleton (values vary, structure does not)', async () => {
    const body = await textOf(await GET(metricsReq({ authorization: `Bearer ${TOKEN}` })))
    const skeleton = sampleLines(body)
      .map((l) => (l.startsWith('mjengo_build_info{') ? l : l.replace(/ \d+$/, ' <n>')))
      .sort()
    const expected = [
      // build_info's labels and value are pinned constants — not masked.
      `mjengo_build_info{name="${pkg.name}",version="${pkg.version}"} 1`,
      'mjengo_db_latency_ms <n>',
      'mjengo_db_up <n>',
      'mjengo_jobs{status="failed"} <n>',
      'mjengo_jobs{status="queued"} <n>',
      'mjengo_jobs{status="retrying"} <n>',
      'mjengo_uptime_seconds <n>',
    ].sort()
    expect(skeleton).toEqual(expected)
  })

  it('sane values: db_up 1, integer latency/uptime, jobs from the groupBy (absent → 0, other statuses not rendered)', async () => {
    const body = await textOf(await GET(metricsReq({ authorization: `Bearer ${TOKEN}` })))
    expect(sampleValue(body, 'mjengo_db_up')).toBe(1)
    expect(Number.isInteger(sampleValue(body, 'mjengo_db_latency_ms'))).toBe(true)
    expect(sampleValue(body, 'mjengo_db_latency_ms')).toBeGreaterThanOrEqual(0)
    expect(sampleValue(body, 'mjengo_uptime_seconds')).toBeGreaterThanOrEqual(0)
    expect(sampleValue(body, 'mjengo_jobs', '{status="queued"}')).toBe(2)
    expect(sampleValue(body, 'mjengo_jobs', '{status="retrying"}')).toBe(0)
    expect(sampleValue(body, 'mjengo_jobs', '{status="failed"}')).toBe(1)
    expect(body).not.toContain('status="done"')
    expect(sampleValue(body, 'mjengo_build_info')).toBe(1)
    expect(body).toContain(`mjengo_build_info{name="${pkg.name}",version="${pkg.version}"} 1`)
  })

  it('the SHARED-QUERY contract: the probe runs once and jobRecord.groupBy runs EXACTLY once', async () => {
    await GET(metricsReq({ authorization: `Bearer ${TOKEN}` }))
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.jobRecord.groupBy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.jobRecord.groupBy).mock.calls[0][0]).toEqual({
      by: ['status'],
      _count: { _all: true },
    })
  })

  it('the body ends with a trailing newline (the text-format convention)', async () => {
    const body = await textOf(await GET(metricsReq({ authorization: `Bearer ${TOKEN}` })))
    expect(body.endsWith('\n')).toBe(true)
  })
})

describe('GET /api/metrics — DB down → 503, honest (never a misleading zero)', () => {
  beforeEach(() => {
    process.env.METRICS_TOKEN = TOKEN
  })

  it('503 with the same content-type and a scrapeable error signal', async () => {
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error('INTERNAL: sqlite file locked'))
    const res = await GET(metricsReq({ authorization: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toBe(CONTENT_TYPE)
    const body = await textOf(res)
    expect(sampleValue(body, 'mjengo_scrape_error')).toBe(1)
    expect(sampleValue(body, 'mjengo_db_up')).toBe(0)
    // Still true without the DB:
    expect(sampleValue(body, 'mjengo_uptime_seconds')).toBeGreaterThanOrEqual(0)
    expect(body).toContain(`mjengo_build_info{name="${pkg.name}",version="${pkg.version}"} 1`)
    // Unknown, NOT zero — no SAMPLE line for them (the ERROR comment line
    // names them, so a raw toContain would false-positive on it):
    expect(hasSample(body, 'mjengo_db_latency_ms')).toBe(false)
    expect(hasSample(body, 'mjengo_jobs{')).toBe(false)
    expect(body).toContain('unknown, not zero')
  })

  it('the groupBy never runs when the probe itself fails', async () => {
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error('db gone'))
    await GET(metricsReq({ authorization: `Bearer ${TOKEN}` }))
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })
})

describe('escapePrometheusLabelValue — the label grammar', () => {
  it('escapes backslash, double quote and newline; leaves everything else', () => {
    expect(escapePrometheusLabelValue('plain-1.2.3')).toBe('plain-1.2.3')
    expect(escapePrometheusLabelValue('a\\b')).toBe('a\\\\b')
    expect(escapePrometheusLabelValue('a"b')).toBe('a\\"b')
    expect(escapePrometheusLabelValue('a\nb')).toBe('a\\nb')
    expect(escapePrometheusLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd')
  })
})

describe('metricsBearerTokenMatches — the pure verdict (jobsBearerTokenMatches shape)', () => {
  it('exact match → true; anything else → false (fail closed)', () => {
    expect(metricsBearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(metricsBearerTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(metricsBearerTokenMatches(`Bearer ${'d'.repeat(64)}`, TOKEN)).toBe(false)
    // Unset/empty configured token: the path is disabled entirely.
    expect(metricsBearerTokenMatches(`Bearer ${TOKEN}`, undefined)).toBe(false)
    expect(metricsBearerTokenMatches(`Bearer ${TOKEN}`, '')).toBe(false)
    // No/empty/non-bearer presented credential.
    expect(metricsBearerTokenMatches(null, TOKEN)).toBe(false)
    expect(metricsBearerTokenMatches(undefined, TOKEN)).toBe(false)
    expect(metricsBearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false)
    expect(metricsBearerTokenMatches('Bearer', TOKEN)).toBe(false)
    // Case matters for a secret.
    expect(metricsBearerTokenMatches(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false)
  })
})
