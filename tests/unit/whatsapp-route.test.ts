/**
 * W4-3 — POST/GET /api/whatsapp: the WhatsApp bi-directional field bot seam.
 *
 * The route mirrors the USSD line's honest-webhook pattern (contract GET,
 * X-Signature HMAC, 20/min/phone + 40/min/IP buckets, withAuditContext,
 * plain-text replies footered "— MjengoOS sim") with the phone number — not
 * a PIN — as the worker identity. Pinned here per acceptance criterion:
 *   · GRAMMAR: PRESENT → attendance.checkin (worker evidence: verification
 *     'verified', evidence ['whatsapp','device'], method 'whatsapp');
 *     ABSENT/HALF → attendance.record (a reported statement, recordedBy
 *     'WhatsApp'); BALANCE → unpaid wage reply (read-only); HELP → usage;
 *     free text → comment.add pinned to the project's most recent site
 *     photo — with __actor/__role stamping on every dispatch (the audit row
 *     says the WORKER acted, from the WhatsApp channel);
 *   · ALLOWLIST (static): the route's action surface is exactly
 *     attendance.checkin / attendance.record / comment.add — ZERO
 *     WALLET/LAND/SUPPLY types, flag-family safe by construction;
 *   · UNKNOWN PHONE → honest "not registered" reply, zero rows written;
 *   · SECRET SET → unsigned/mismatched X-Signature → 401 (timing-safe
 *     compare); UNSET → the open demo posture, now an EXPLICIT opt-in
 *     (issue #156: the fixtures set WEBHOOK_OPEN_POSTURE=1);
 *   · FAIL-CLOSED POSTURE (SEC-4 + issue #156): an unset secret refuses
 *     POST with 503 in EVERY runtime unless WEBHOOK_OPEN_POSTURE=1 opts
 *     into the open demo posture OUTSIDE production. Pinned: production +
 *     unset → 503 (the opt-in is IGNORED there); non-prod + unset + no
 *     opt-in → 503 before any processing (zero writes, zero audits, zero
 *     rate-limit consumption); non-prod + opt-in → open posture; secret
 *     set → the HMAC gate answers, never the 503 gate;
 *   · RATE LIMITS: 20/min/phone and 40/min/IP buckets, 429 + Retry-After.
 *     The per-IP key is trust-aware (issue #156): the fixtures run
 *     TRUST_PROXY=1 (distinct XFF values = distinct principals, keeping
 *     the per-test uniqueIp() bucket isolation honest), and a dedicated
 *     test pins the UNSET posture — rotating XFF values share the one anon
 *     bucket and cannot refresh it;
 *   · VERSION: attendance written via WhatsApp bumps Attendance.version —
 *     the same appliers /api/actions, /api/sync and the USSD line share, so
 *     the offline sync's stale-version rejection keeps working;
 *   · every text reply carries the sim footer.
 *
 * @/backend/lib/db is swapped for an in-memory stub (outbox-versions.test
 * idioms); applyAction stays REAL — the route dispatches through the exact
 * production path, and the audit rows prove the actor stamping + §43
 * request context end-to-end. rate-limit and audit stay real too. Fake
 * timers freeze the clock so the EAT "today" of the attendance appliers and
 * the token-bucket math are deterministic.
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    projects: new Map<string, Row>(),
    workers: new Map<string, Row>(),
    attendance: new Map<string, Row>(),
    photos: new Map<string, Row>(),
    comments: [] as Row[],
    audits: [] as Row[],
    /** Every mutating call (attendance/photoComment create|update). */
    writes: 0,
    reset() {
      state.projects.clear()
      state.workers.clear()
      state.attendance.clear()
      state.photos.clear()
      state.comments = []
      state.audits = []
      state.writes = 0
      seed()
    },
  }

  function seed() {
    state.projects.set('p-1', {
      id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', location: 'Karen',
    })
    state.workers.set('w-1', {
      id: 'w-1', projectId: 'p-1', name: 'Kamau Mwangi', role: 'Fundi wa Mawe',
      phone: '0722111222', pin: '1234', dailyRate: 150000n, active: true,
    })
    state.workers.set('w-2', {
      id: 'w-2', projectId: 'p-1', name: 'Achieng Odhiambo', role: 'Foreman',
      phone: '0733444555', pin: null, dailyRate: 120000n, active: true,
    })
    // Inactive workers are NOT reachable from the line (active:true filter).
    state.workers.set('w-3', {
      id: 'w-3', projectId: 'p-1', name: 'Mgonjwa Fundi', role: 'Labourer',
      phone: '0799888777', pin: null, dailyRate: 80000n, active: false,
    })
  }
  state.reset()

  /** Just enough of Prisma's where for this surface (equality + { not }). */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Row
        if ('not' in c) {
          if (row[key] === c.not) return false
          continue
        }
        continue // unused object filters on this surface
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const pick = (row: Row, select?: Row): Row => {
    if (!select) return { ...row }
    const out: Row = {}
    for (const k of Object.keys(select)) out[k] = row[k]
    return out
  }

  const sortBy = (rows: Row[], orderBy?: Row): Row[] => {
    if (!orderBy) return rows
    const [[key, dir] = []] = Object.entries(orderBy)
    if (!key) return rows
    // Dates compare by time (Date objects or ISO strings), strings lexically.
    const isDatey = (v: unknown) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
    const sorted = [...rows].sort((a, b) => {
      if (isDatey(a[key]) || isDatey(b[key])) {
        return new Date(String(a[key])).getTime() - new Date(String(b[key])).getTime()
      }
      return String(a[key]).localeCompare(String(b[key]))
    })
    return dir === 'desc' ? sorted.reverse() : sorted
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) { return state.projects.get(String(where.id)) ?? null },
      async findFirst() { return [...state.projects.values()][0] ?? null },
    },
    worker: {
      async findMany({ where, orderBy, select }: { where?: Row; orderBy?: Row; select?: Row }) {
        return sortBy([...state.workers.values()].filter((r) => matches(r, where)), orderBy)
          .map((r) => pick(r, select))
      },
      async findUnique({ where }: { where: Row }) { return state.workers.get(String(where.id)) ?? null },
    },
    attendance: {
      async findFirst({ where }: { where: Row }) {
        return [...state.attendance.values()].find((r) => matches(r, where)) ?? null
      },
      async create({ data }: { data: Row }) {
        state.writes++
        const row = { id: `att-${state.attendance.size + 1}`, version: 1, ...data }
        state.attendance.set(String(row.id), row)
        return { ...row }
      },
      async update({ where, data }: { where: Row; data: Row }) {
        state.writes++
        const row = state.attendance.get(String(where.id))
        if (!row) throw new Error(`stub: attendance ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
      async aggregate({ where }: { where: Row }) {
        const rows = [...state.attendance.values()].filter((r) => matches(r, where))
        const wage = rows.reduce((s, r) => s + ((r.wage as bigint) ?? 0n), 0n)
        return { _sum: { wage } }
      },
      async count({ where }: { where: Row }) {
        return [...state.attendance.values()].filter((r) => matches(r, where)).length
      },
    },
    sitePhoto: {
      async findFirst({ where, orderBy }: { where?: Row; orderBy?: Row }) {
        return sortBy([...state.photos.values()].filter((r) => matches(r, where)), orderBy)[0] ?? null
      },
      async findUnique({ where }: { where: Row }) { return state.photos.get(String(where.id)) ?? null },
    },
    photoComment: {
      async create({ data }: { data: Row }) {
        state.writes++
        const row = { id: `cmt-${state.comments.length + 1}`, resolved: false, ...data }
        state.comments.push(row)
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        state.audits.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { POST as whatsappPost, GET as whatsappGet } from '@/app/api/whatsapp/route'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    projects: Map<string, Record<string, unknown>>
    workers: Map<string, Record<string, unknown>>
    attendance: Map<string, Record<string, unknown>>
    photos: Map<string, Record<string, unknown>>
    comments: Array<Record<string, unknown>>
    audits: Array<Record<string, unknown>>
    writes: number
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

const T0 = new Date('2026-02-14T10:00:00Z') // 13:00 EAT — today is 2026-02-14
const TODAY = '2026-02-14'
const KAMAU = '0722111222'
const FOOTER = '— MjengoOS sim'

/** Unique per-request client IP by default so token buckets never bleed between tests. */
let ipSeq = 0
function uniqueIp(): string {
  ipSeq += 1
  return `10.8.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`
}

function waReq(
  from: string,
  text: string,
  opts: { ip?: string; headers?: Record<string, string>; raw?: string } = {},
): NextRequest {
  return new NextRequest('http://localhost/api/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': opts.ip ?? uniqueIp(),
      ...(opts.headers ?? {}),
    },
    body: opts.raw ?? JSON.stringify({ from, text, timestamp: '2026-02-14T09:00:00Z' }),
  })
}

/** One seeded attendance day-row for w-1 (the version-bump fixtures override fields). */
function seedAttendance(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: 'att-seed', workerId: 'w-1', projectId: 'p-1', date: TODAY,
    status: 'present', wage: 150000n, checkIn: new Date('2026-02-14T07:00:00Z'), checkOut: null,
    method: 'app', verification: 'verified', recordedBy: 'App', paid: false,
    version: 2, overrideLog: '[]', evidence: null, exceptionReason: null, exceptionNote: null,
    ...over,
  }
  state.attendance.set(String(row.id), row)
  return row
}

function seedPhoto(id: string, createdAt: Date, caption = 'Scaffolding north side'): Record<string, unknown> {
  const row = { id, projectId: 'p-1', caption, url: `/photos/${id}.jpg`, createdAt, zoneId: null }
  state.photos.set(id, row)
  return row
}

// The route-test fixture posture (issue #156): vitest runs NODE_ENV=test,
// and since #156 an unset secret fails closed in EVERY runtime unless the
// open posture is explicitly opted into. These fixtures set exactly what a
// dev/demo deployment would: WEBHOOK_OPEN_POSTURE=1 (the open
// gateway-trust posture under test — without it every test below would
// rightly get the 503) and TRUST_PROXY=1 (the one topology where distinct
// x-forwarded-for values are distinct throttle principals — keeps the
// per-test uniqueIp() bucket isolation honest). The TRUST_PROXY-unset
// collapse has its own dedicated tests below.
beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  vi.clearAllMocks()
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  delete process.env.WHATSAPP_WEBHOOK_SECRET
  process.env.WEBHOOK_OPEN_POSTURE = '1'
  process.env.TRUST_PROXY = '1'
  state.reset()
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.WHATSAPP_WEBHOOK_SECRET
  delete process.env.WEBHOOK_OPEN_POSTURE
  delete process.env.TRUST_PROXY
  delete process.env.NEXTAUTH_SECRET
})

// ------------------------------------------------------------------- grammar

describe('POST /api/whatsapp — keyword grammar (real applyAction path)', () => {
  it('PRESENT → attendance.checkin: worker evidence, method whatsapp, full-rate wage, actor stamp', async () => {
    const res = await whatsappPost(waReq(KAMAU, '  present ')) // trimmed + case-insensitive
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const reply = await res.text()
    expect(reply).toContain('Attendance recorded.')
    expect(reply).toContain('Kamau Mwangi — PRESENT. Asante!')
    expect(reply.endsWith(FOOTER)).toBe(true)

    expect(state.attendance.size).toBe(1)
    const row = [...state.attendance.values()][0]
    expect(row.workerId).toBe('w-1')
    expect(row.status).toBe('present')
    expect(row.method).toBe('whatsapp')
    expect(row.verification).toBe('verified')
    expect(JSON.parse(String(row.evidence))).toEqual(['whatsapp', 'device'])
    expect(row.wage).toBe(150000n)
    expect(row.checkIn).toBeTruthy()

    // The ledger says the WORKER acted, from the WhatsApp channel (§43 ctx too).
    expect(state.audits.length).toBe(1)
    const audit = state.audits[0]
    expect(audit.actor).toBe('Kamau Mwangi')
    expect(audit.role).toBe('whatsapp')
    expect(JSON.parse(String(audit.meta)).type).toBe('attendance.checkin')
  })

  it('ABSENT → attendance.record: a reported statement from the line, not evidence', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'ABSENT'))
    const reply = await res.text()
    expect(reply).toContain('Kamau Mwangi — ABSENT. Asante!')
    expect(reply.endsWith(FOOTER)).toBe(true)

    const row = [...state.attendance.values()][0]
    expect(row.status).toBe('absent')
    expect(row.wage).toBe(0n)
    expect(row.verification).toBe('reported')
    expect(row.recordedBy).toBe('WhatsApp')
    expect(row.checkIn).toBeNull()
    expect(JSON.parse(String(state.audits[0].meta)).type).toBe('attendance.record')
  })

  it('HALF → attendance.record half_day at half wage', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'half'))
    expect(await res.text()).toContain('Kamau Mwangi — HALF. Asante!')

    const row = [...state.attendance.values()][0]
    expect(row.status).toBe('half_day')
    expect(row.wage).toBe(75000n) // 150000n cents dailyRate × 0.5
    expect(row.verification).toBe('reported')
    expect(JSON.parse(String(state.audits[0].meta)).type).toBe('attendance.record')
  })

  it('BALANCE → unpaid wage reply (unpaid, non-absent days) — read-only, zero rows', async () => {
    seedAttendance({ id: 'att-1', paid: false, status: 'present', wage: 150000n })
    seedAttendance({ id: 'att-2', paid: false, status: 'half_day', wage: 75000n })
    seedAttendance({ id: 'att-3', paid: true, status: 'present', wage: 150000n }) // paid — excluded
    seedAttendance({ id: 'att-4', paid: false, status: 'absent', wage: 0n }) // absent — excluded

    const res = await whatsappPost(waReq(KAMAU, 'BALANCE'))
    const reply = await res.text()
    expect(reply).toContain('Kamau Mwangi')
    expect(reply).toContain('KSh 2,250 (2 day(s))')
    expect(reply.endsWith(FOOTER)).toBe(true)

    expect(state.writes).toBe(0) // read-only surface
    expect(state.audits).toEqual([])
    expect(state.comments).toEqual([])
  })

  it('HELP → usage text with every keyword + the footer', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'HELP'))
    const reply = await res.text()
    for (const kw of ['PRESENT', 'ABSENT', 'HALF', 'BALANCE', 'HELP']) {
      expect(reply).toContain(kw)
    }
    expect(reply.endsWith(FOOTER)).toBe(true)
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('free text → comment.add pinned to the project MOST RECENT site photo, author = the worker', async () => {
    seedPhoto('ph-1', new Date('2026-02-12T09:00:00Z'), 'Foundation pour')
    seedPhoto('ph-2', new Date('2026-02-13T15:00:00Z'), 'Scaffolding north side')

    const res = await whatsappPost(waReq(KAMAU, 'Tumemaliza scaffolding leo'))
    const reply = await res.text()
    expect(reply).toContain('Note added to the site photo thread.')
    expect(reply.endsWith(FOOTER)).toBe(true)

    expect(state.comments.length).toBe(1)
    const comment = state.comments[0]
    expect(comment.photoId).toBe('ph-2') // the LATEST photo, not the first
    expect(comment.author).toBe('Kamau Mwangi')
    expect(comment.role).toBe('foreman') // the applier's field-crew comment role
    expect(comment.message).toBe('Tumemaliza scaffolding leo')

    expect(state.audits.length).toBe(1)
    expect(state.audits[0].actor).toBe('Kamau Mwangi')
    expect(state.audits[0].role).toBe('whatsapp')
    expect(JSON.parse(String(state.audits[0].meta)).type).toBe('comment.add')
  })

  it('free text with NO site photo yet → honest "not saved" reply, zero rows', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'Kazi ya leo imekwenda vizuri'))
    const reply = await res.text()
    expect(reply).toContain('Note not saved')
    expect(reply).toContain('no photo yet')
    expect(reply.endsWith(FOOTER)).toBe(true)

    expect(state.comments).toEqual([])
    expect(state.audits).toEqual([])
    expect(state.writes).toBe(0)
  })
})

// -------------------------------------------------------- worker resolution

describe('POST /api/whatsapp — the phone IS the identity', () => {
  it('international MSISDN forms resolve the same worker (digits normalized, last-9 match)', async () => {
    for (const from of ['+254722111222', '254722111222', '0722111222']) {
      state.reset()
      const res = await whatsappPost(waReq(from, 'PRESENT'))
      expect(res.status, `from=${from}`).toBe(200)
      expect(state.attendance.size, `from=${from}`).toBe(1)
    }
  })

  it('unknown phone → honest "not registered" reply, ZERO rows written', async () => {
    const res = await whatsappPost(waReq('0711999888', 'PRESENT'))
    expect(res.status).toBe(200) // a gateway always gets text back
    const reply = await res.text()
    expect(reply).toContain('0711999888 is not registered to a worker on any MjengoOS site')
    expect(reply).toContain('Fundis tab')
    expect(reply.endsWith(FOOTER)).toBe(true)

    expect(state.attendance.size).toBe(0)
    expect(state.comments).toEqual([])
    expect(state.audits).toEqual([])
    expect(state.writes).toBe(0)
  })

  it('inactive workers are not reachable from the line', async () => {
    const res = await whatsappPost(waReq('0799888777', 'PRESENT'))
    expect(await res.text()).toContain('is not registered to a worker')
    expect(state.writes).toBe(0)
  })
})

// --------------------------------------------------- the sync interplay pin

describe('POST /api/whatsapp — attendance versioning (the shared appliers)', () => {
  it('a status correction via WhatsApp bumps Attendance.version (same appliers as app/USSD/sync)', async () => {
    seedAttendance({ status: 'present', version: 2 }) // an offline client may hold v2

    const res = await whatsappPost(waReq(KAMAU, 'ABSENT'))
    expect(res.status).toBe(200)

    const row = [...state.attendance.values()].find((r) => r.id === 'att-seed')
    expect(row).toBeDefined()
    expect(row!.status).toBe('absent')
    expect(row!.wage).toBe(0n)
    expect(row!.version).toBe(3) // bumped — a stale-version offline edit now REJECTS (§41)
    // Append-only override history, same as any other correction path.
    const log = JSON.parse(String(row!.overrideLog)) as Array<Record<string, unknown>>
    expect(log.length).toBe(1)
    expect(log[0]).toMatchObject({ by: 'WhatsApp', from: 'present', to: 'absent' })
  })

  it('PRESENT opens a NEW day-row at the Prisma default version 1', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'PRESENT'))
    expect(res.status).toBe(200)
    const row = [...state.attendance.values()][0]
    expect(row.version).toBe(1)
    expect(row.wage).toBe(150000n)
  })
})

// ------------------------------------------------------- allowlist (static)

describe('the WhatsApp action allowlist — flag-family safe by construction', () => {
  const routeSrc = readFileSync(
    fileURLToPath(new URL('../../src/app/api/whatsapp/route.ts', import.meta.url)),
    'utf8',
  )

  it('the route declares exactly the three grammar actions', () => {
    expect(routeSrc).toMatch(
      /const WHATSAPP_ACTION_ALLOWLIST = \[\s*'attendance\.checkin',\s*'attendance\.record',\s*'comment\.add',\s*\]/,
    )
  })

  it('the three allowlisted types are disjoint from the REAL wallet/land/supply families', () => {
    const allowlist = ['attendance.checkin', 'attendance.record', 'comment.add']
    const flagged = [...WALLET_ACTIONS, ...LAND_ACTIONS, ...SUPPLY_ACTIONS]
    expect(allowlist.filter((t) => flagged.includes(t))).toEqual([])
    // Spot checks that the family lists are the live module ones, not copies:
    expect(WALLET_ACTIONS).toContain('payment.pay')
    expect(LAND_ACTIONS).toContain('parcel.create')
    expect(SUPPLY_ACTIONS).toContain('supplier.upsert')
  })

  it('NO flagged-family action type literal appears anywhere in the route source', () => {
    const flagged = [...WALLET_ACTIONS, ...LAND_ACTIONS, ...SUPPLY_ACTIONS]
    for (const type of flagged) {
      expect(routeSrc.includes(`'${type}'`), `route source must not quote "${type}"`).toBe(false)
    }
  })

  it('every dispatch call site passes an allowlisted literal (3 call sites, all in the grammar)', () => {
    const callSites = [...routeSrc.matchAll(/dispatchWhatsappAction\(req, '([a-zA-Z.]+)'/g)].map((m) => m[1])
    expect(callSites.sort()).toEqual(['attendance.checkin', 'attendance.record', 'comment.add'])
  })
})

// ------------------------------------------------------------------ signature

describe('X-Signature — HMAC shared-secret verification (WHATSAPP_WEBHOOK_SECRET)', () => {
  const SECRET = 'wa-unit-secret'
  const rawBody = JSON.stringify({ from: KAMAU, text: 'HELP', timestamp: '2026-02-14T09:00:00Z' })
  const goodSig = createHmac('sha256', SECRET).update(rawBody).digest('hex')

  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_SECRET = SECRET
  })

  it('secret set + unsigned POST → 401 with the honest missing-header message', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'HELP', { raw: rawBody }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('Missing X-Signature header'),
    })
    expect(state.writes).toBe(0)
  })

  it('secret set + MISMATCHED signature → 401, nothing written', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'HELP', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex') },
    }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'Invalid X-Signature' })
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('secret set + correct hex HMAC of the RAW body → 200 (footer reply)', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'HELP', {
      raw: rawBody,
      headers: { 'x-signature': goodSig },
    }))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
  })

  it('UNSET secret + WEBHOOK_OPEN_POSTURE=1 (the fixture opt-in) → open demo posture: plain POST goes through', async () => {
    delete process.env.WHATSAPP_WEBHOOK_SECRET
    const res = await whatsappPost(waReq(KAMAU, 'HELP'))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
    expect(process.env.WEBHOOK_OPEN_POSTURE).toBe('1') // the explicit opt-in, not an accident
  })
})

// ------------------------------------------- production fail-closed (SEC-4)

describe('production fail-closed — unset secret → 503, no processing (SEC-4)', () => {
  const rawBody = JSON.stringify({ from: KAMAU, text: 'HELP', timestamp: '2026-02-14T09:00:00Z' })
  const goodSig = createHmac('sha256', 'wa-unit-secret').update(rawBody).digest('hex')

  /** Run one assertion block with NODE_ENV=production; ALWAYS restored. */
  async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  }

  it('NODE_ENV=production + UNSET secret → 503 JSON configuration error, zero processing', async () => {
    await asProduction(async () => {
      const res = await whatsappPost(waReq(KAMAU, 'HELP'))
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('WHATSAPP_WEBHOOK_SECRET is not configured'),
      })
      expect(state.writes).toBe(0)
      expect(state.audits).toEqual([])
    })
    expect(process.env.NODE_ENV).not.toBe('production') // restored for the file
  })

  it('production refuses BEFORE the grammar: a PRESENT attempt writes nothing', async () => {
    await asProduction(async () => {
      const res = await whatsappPost(waReq(KAMAU, 'PRESENT'))
      expect(res.status).toBe(503)
      expect(state.attendance.size).toBe(0)
      expect(state.writes).toBe(0)
      expect(state.audits).toEqual([])
    })
  })

  it('production + secret SET + correct HMAC → 200 — a configured route never sees the 503 gate', async () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = 'wa-unit-secret'
    await asProduction(async () => {
      const res = await whatsappPost(waReq(KAMAU, 'HELP', {
        raw: rawBody,
        headers: { 'x-signature': goodSig },
      }))
      expect(res.status).toBe(200)
      expect((await res.text()).endsWith(FOOTER)).toBe(true)
    })
  })

  it('production + secret SET + unsigned → 401 (the HMAC gate answers, not the 503 gate)', async () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = 'wa-unit-secret'
    await asProduction(async () => {
      const res = await whatsappPost(waReq(KAMAU, 'HELP', { raw: rawBody }))
      expect(res.status).toBe(401)
      expect(state.writes).toBe(0)
    })
  })

  it('production IGNORES the opt-in: WEBHOOK_OPEN_POSTURE=1 + unset secret → STILL 503 (issue #156)', async () => {
    // The beforeEach fixture already sets WEBHOOK_OPEN_POSTURE=1 — production
    // must not read it. (Set it explicitly anyway so the intent is visible.)
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    await asProduction(async () => {
      const res = await whatsappPost(waReq(KAMAU, 'PRESENT'))
      expect(res.status).toBe(503)
      expect(state.attendance.size).toBe(0)
      expect(state.writes).toBe(0)
      expect(state.audits).toEqual([])
    })
  })
})

// ------------------------------------------- open-posture opt-in (issue #156)

describe('open-posture opt-in — WEBHOOK_OPEN_POSTURE gates unauthenticated writes (issue #156)', () => {
  it('non-production + unset secret + NO opt-in → 503 (the new fail-closed default), zero processing', async () => {
    delete process.env.WEBHOOK_OPEN_POSTURE
    const res = await whatsappPost(waReq(KAMAU, 'PRESENT'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('WHATSAPP_WEBHOOK_SECRET is not configured')
    expect(body.error).toContain('WEBHOOK_OPEN_POSTURE') // the honest remedy is named
    expect(state.writes).toBe(0)
    expect(state.audits).toEqual([])
  })

  it('a runtime with NO NODE_ENV at all (bare container) + no opt-in → 503 too', async () => {
    delete process.env.WEBHOOK_OPEN_POSTURE
    const prev = process.env.NODE_ENV
    delete process.env.NODE_ENV // `docker run` of the image without NODE_ENV
    try {
      const res = await whatsappPost(waReq(KAMAU, 'PRESENT'))
      expect(res.status).toBe(503)
      expect(state.attendance.size).toBe(0)
      expect(state.writes).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })

  it('opt-in set to 0/false/blank is NOT an opt-in → 503', async () => {
    for (const v of ['', '0', 'false']) {
      process.env.WEBHOOK_OPEN_POSTURE = v
      const res = await whatsappPost(waReq(KAMAU, 'HELP'))
      expect(res.status, `WEBHOOK_OPEN_POSTURE="${v}"`).toBe(503)
    }
    expect(state.writes).toBe(0)
  })

  it('non-production + unset secret + WEBHOOK_OPEN_POSTURE=1 → 200 (the explicit open demo posture)', async () => {
    process.env.WEBHOOK_OPEN_POSTURE = '1' // the beforeEach default, restated
    const res = await whatsappPost(waReq(KAMAU, 'HELP'))
    expect(res.status).toBe(200)
    expect((await res.text()).endsWith(FOOTER)).toBe(true)
  })

  it('non-production + secret SET → the HMAC gate answers regardless of the opt-in (503 never shadows it)', async () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = 'wa-unit-secret'
    delete process.env.WEBHOOK_OPEN_POSTURE
    const rawBody = JSON.stringify({ from: KAMAU, text: 'HELP', timestamp: '2026-02-14T09:00:00Z' })
    const unsigned = await whatsappPost(waReq(KAMAU, 'HELP', { raw: rawBody }))
    expect(unsigned.status).toBe(401)
    const signed = await whatsappPost(waReq(KAMAU, 'HELP', {
      raw: rawBody,
      headers: { 'x-signature': createHmac('sha256', 'wa-unit-secret').update(rawBody).digest('hex') },
    }))
    expect(signed.status).toBe(200)
  })
})

// ---------------------------------------------------------------- rate limits

describe('rate limits — 20/min/phone + 40/min/IP (fake-timer determinism)', () => {
  it('the 21st message from ONE phone within the window → 429 + Retry-After', async () => {
    const ip = '10.7.0.1'
    for (let i = 0; i < 20; i++) {
      const res = await whatsappPost(waReq(KAMAU, 'HELP', { ip }))
      expect(res.status, `message ${i + 1} should pass`).toBe(200)
    }
    const blocked = await whatsappPost(waReq(KAMAU, 'HELP', { ip }))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
  })

  it('phone buckets are per-number: another phone still passes after one is exhausted', async () => {
    const ip = '10.7.0.2'
    for (let i = 0; i < 20; i++) {
      await whatsappPost(waReq(KAMAU, 'HELP', { ip }))
    }
    expect((await whatsappPost(waReq(KAMAU, 'HELP', { ip }))).status).toBe(429)
    // A DIFFERENT phone from the same IP: fresh phone bucket (its IP budget
    // still has 20 tokens left of 40).
    expect((await whatsappPost(waReq('0733444555', 'HELP', { ip }))).status).toBe(200)
  })

  it('the 41st message from ONE client IP (rotating phones) → 429 — the IP bucket throttles', async () => {
    const ip = '10.7.0.3'
    for (let i = 0; i < 40; i++) {
      const phone = `07110${String(10000 + i).slice(1)}` // unique per request
      const res = await whatsappPost(waReq(phone, 'HELP', { ip }))
      expect(res.status, `request ${i + 1} should pass`).toBe(200) // honest "not registered" text
    }
    const blocked = await whatsappPost(waReq('0711099999', 'HELP', { ip }))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
    expect(state.writes).toBe(0) // 40 unknown-phone replies — never a single row
  })

  it('issue #156: TRUST_PROXY UNSET → rotating x-forwarded-for does NOT refresh the per-IP bucket', async () => {
    // The old first-XFF semantics let a scripted client mint a fresh bucket
    // per request by rotating the forgeable header. Now (TRUST_PROXY unset —
    // direct exposure) the header is ignored: every POST shares the ONE anon
    // bucket, so the 40/min limit actually binds.
    delete process.env.TRUST_PROXY
    try {
      for (let i = 0; i < 40; i++) {
        const phone = `07120${String(20000 + i).slice(1)}` // unique per request
        const spoofedXff = `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}` // ROTATING "IP"
        const res = await whatsappPost(waReq(phone, 'HELP', { ip: spoofedXff }))
        expect(res.status, `request ${i + 1} should pass despite rotation`).toBe(200)
      }
      // a brand-new spoofed "IP" is still the same anon principal → blocked
      const blocked = await whatsappPost(waReq('0712999999', 'HELP', { ip: '203.0.113.99' }))
      expect(blocked.status).toBe(429)
      expect(await blocked.json()).toMatchObject({ error: 'Too many requests' })
      expect(state.writes).toBe(0)
    } finally {
      process.env.TRUST_PROXY = '1' // restore the fixture posture
    }
  })
})

// --------------------------------------------------------------- body hygiene

describe('POST body validation (64 KB cap + shape)', () => {
  it('invalid JSON → 400', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'HELP', { raw: '{not json' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Invalid JSON body' })
  })

  it('missing from / missing text → 400 with the honest field message', async () => {
    const noFrom = await whatsappPost(waReq('', 'HELP', { raw: JSON.stringify({ text: 'HELP' }) }))
    expect(noFrom.status).toBe(400)
    expect(await noFrom.json()).toMatchObject({ error: expect.stringContaining('from required') })

    const noText = await whatsappPost(waReq(KAMAU, '', { raw: JSON.stringify({ from: KAMAU }) }))
    expect(noText.status).toBe(400)
    expect(await noText.json()).toMatchObject({ error: expect.stringContaining('text required') })
  })

  it('a declared Content-Length beyond 64 KB is refused before the body is read', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'HELP', {
      raw: 'x',
      headers: { 'content-length': String(64 * 1024 + 1) },
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('64 KB') })
  })

  it('an actually-oversized body (> 64 KB of real bytes) is refused after the read', async () => {
    const big = JSON.stringify({ from: KAMAU, text: `HELP ${'a'.repeat(70_000)}` })
    const res = await whatsappPost(waReq(KAMAU, 'HELP', { raw: big }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('64 KB') })
  })
})

// ------------------------------------------------------------ audit context

describe('withAuditContext — the §43 request context lands on the ledger rows', () => {
  it('every dispatched action persists ip / userAgent / requestId / entity / entityId', async () => {
    const res = await whatsappPost(waReq(KAMAU, 'PRESENT', {
      headers: { 'x-request-id': 'req-42', 'user-agent': 'relay/1.0' },
      ip: '203.0.113.9',
    }))
    expect(res.status).toBe(200)

    expect(state.audits.length).toBe(1)
    const audit = state.audits[0]
    expect(audit.ip).toBe('203.0.113.9')
    expect(String(audit.userAgent)).toMatch(/^whatsapp-gateway \(relay\/1\.0\)/)
    expect(audit.requestId).toBe('req-42')
    expect(audit.entity).toBe('attendance.checkin')
    expect(audit.entityId).toBe('w-1')
    // Free-text comments get the same treatment.
    state.reset()
    seedPhoto('ph-9', new Date('2026-02-13T15:00:00Z'))
    const res2 = await whatsappPost(waReq(KAMAU, 'Kazi imeendelea', {
      headers: { 'x-request-id': 'req-43' },
      ip: '203.0.113.10',
    }))
    expect(res2.status).toBe(200)
    expect(state.audits[0].entity).toBe('comment.add')
    expect(state.audits[0].requestId).toBe('req-43')
    expect(state.audits[0].entityId).toBe('w-1')
  })
})

// ------------------------------------------------------ domain failure copy

describe('honest failure copy — a gateway always gets text back', () => {
  it('an applier failure returns the honest "could not record" text, still footered', async () => {
    // Simulate the applier failing by breaking the worker table mid-test,
    // restoring it afterwards (the shared module mock survives between cases).
    const w = (db as unknown as {
      worker: { findMany: (args: unknown) => Promise<unknown> }
    }).worker
    const original = w.findMany
    w.findMany = async () => {
      throw new Error('db exploded')
    }
    try {
      const res = await whatsappPost(waReq(KAMAU, 'ABSENT'))
      expect(res.status).toBe(200) // text back to the handset, never a JSON stack
      const reply = await res.text()
      expect(reply).toContain('Could not record — try again or use the app.')
      expect(reply.endsWith(FOOTER)).toBe(true)
    } finally {
      w.findMany = original
    }
  })
})

// ------------------------------------------------------------ GET contract

/** A GET request against the route (NextRequest, the route's new signature). */
function waGet(url = 'http://localhost/api/whatsapp'): NextRequest {
  return new NextRequest(url)
}

describe('GET /api/whatsapp — the contract doc (plain text)', () => {
  it('serves text/plain with the full relay contract', async () => {
    const res = await whatsappGet(waGet())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const doc = await res.text()
    expect(doc).toContain('POST /api/whatsapp')
    expect(doc).toContain('"from"')
    expect(doc).toContain('"timestamp"')
    for (const kw of ['PRESENT', 'ABSENT', 'HALF', 'BALANCE', 'HELP', 'free text']) {
      expect(doc).toContain(kw)
    }
    expect(doc).toContain('attendance.checkin')
    expect(doc).toContain('comment.add')
    expect(doc).toContain('WHATSAPP_WEBHOOK_SECRET')
    expect(doc).toContain('X-Signature')
    expect(doc).toContain('WEBHOOK_OPEN_POSTURE=1') // the opt-in is documented (issue #156)
    expect(doc).toContain('20 requests/min per phone')
    expect(doc).toContain('40 requests/min per client IP')
    expect(doc).toContain('trust-aware') // the per-IP key semantics (issue #156)
    expect(doc).toContain('— MjengoOS sim')
    expect(doc).toContain('not registered')
    expect(doc).toContain('no provider wired') // the honesty claim, verbatim
  })

  it('an unknown query string keeps the text contract (only ?view=simulation is special)', async () => {
    const res = await whatsappGet(waGet('http://localhost/api/whatsapp?view=other'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toContain('POST /api/whatsapp')
  })
})

// ------------------------------------------- #356 server-fed panel content

describe('GET /api/whatsapp?view=simulation — the server-fed panel content (issue #356)', () => {
  it('serves JSON { ok, simulation } with the greeting/keywords/helpText the panel renders', async () => {
    const res = await whatsappGet(waGet('http://localhost/api/whatsapp?view=simulation'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = (await res.json()) as {
      ok?: boolean
      simulation?: { greeting?: string; keywords?: string[]; helpText?: string }
    }
    expect(body.ok).toBe(true)
    expect(body.simulation).toBeTruthy()
    // The greeting is a real line message: honest sim footer included.
    expect(String(body.simulation?.greeting)).toContain('HELP')
    expect(String(body.simulation?.greeting).endsWith(FOOTER)).toBe(true)
    // The keyword chips are the POST grammar, exactly and in order.
    expect(body.simulation?.keywords).toEqual(['PRESENT', 'ABSENT', 'HALF', 'BALANCE', 'HELP'])
    // The helpText is non-empty usage text and carries the same footer.
    expect(String(body.simulation?.helpText).length).toBeGreaterThan(20)
    expect(String(body.simulation?.helpText).endsWith(FOOTER)).toBe(true)
  })

  it('the served helpText is VERBATIM the reply a HELP text gets — the panel cannot drift from the line', async () => {
    const served = (await (await whatsappGet(waGet('http://localhost/api/whatsapp?view=simulation'))).json()) as {
      simulation?: { helpText?: string }
    }
    const reply = await whatsappPost(waReq(KAMAU, 'HELP'))
    expect(reply.status).toBe(200)
    expect(await reply.text()).toBe(String(served.simulation?.helpText))
  })

  it('every grammar keyword the chips serve is one the POST handler actually answers (each gets a 200 reply, not the free-text path)', async () => {
    const served = (await (await whatsappGet(waGet('http://localhost/api/whatsapp?view=simulation'))).json()) as {
      simulation?: { keywords?: string[] }
    }
    for (const kw of served.simulation?.keywords ?? []) {
      const res = await whatsappPost(waReq(KAMAU, kw))
      expect(res.status, `keyword ${kw}`).toBe(200)
      const text = await res.text()
      // Keyword replies are acknowledgments; the free-text path would have
      // answered with the photo-note copy (or its honest no-photo refusal).
      expect(text).not.toContain('not saved')
      expect(text.endsWith(FOOTER)).toBe(true)
    }
  })
})
