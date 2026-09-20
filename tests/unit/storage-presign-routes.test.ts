/**
 * Route contract for the presigned-upload flow (task 9-b), db-mock + fetch
 * mock idioms (notify-channels.test.ts / pii-scrub-wiring.test.ts pattern).
 *
 * Pins the three routes against BOTH drivers via the factory's test seam:
 *  · POST /api/upload/presign — local driver → the honest 409 (no pretending);
 *    s3 driver → { uploadUrl, key, expiresSec, headers } with the exact
 *    upp-* key shape and a SigV4 presigned PUT URL;
 *  · POST /api/upload/confirm — the FULL client-direct flow end-to-end:
 *    presign → client PUT (stubbed global fetch) → HEAD verification → the
 *    Attachment row (reviewStatus 'pending', category provenance, size/mime
 *    from the HEAD, storageKey = the driver's publicUrl); plus every
 *    fail-closed branch (missing object, over-cap, wrong content type,
 *    non-upp key shapes, local driver answers 404 honestly);
 *  · POST /api/upload/confirm idempotency (issue #159 / audit API-8) — the
 *    db mock enforces the REAL constraint semantics (migration 18's unique
 *    index on Attachment.objectKey: a second create with the same key
 *    throws a P2002-shaped error, findUnique resolves by objectKey), so the
 *    route's replay/conflict/race branches run against the same behavior
 *    the engine provides: retried confirm → 200 replayed:true + the ORIGINAL
 *    row + no re-HEAD; same key different category → 409, nothing replayed;
 *    concurrent double-confirm (Promise.all — both lookups miss, one create
 *    wins, the loser replays through the P2002 catch) → both 200, one row;
 *    non-objectKey P2002s and plain errors rethrow (fail closed);
 *  · POST /api/upload (legacy photo path) — the write goes through
 *    getStorageDriver().put() (spy): same key shape, same URL contract, same
 *    caps/MIME checks, byte-identical response.
 *
 * The s3 driver is injected with a fixed clock + fetchImpl so every URL is
 * deterministic; the db is an in-memory stub exposing __state.attachments.
 */
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------ session mock
//
// route()-wrapped handlers authenticate through withGuard → the REAL
// getSessionFromReq, which decodes the session off next-auth's getToken —
// so the seam to mock here is getToken itself (the guard's session mapping
// then runs for real, which is what these routes actually rely on).
// tokenState.token = null → no session (401); a different role flips the
// role-allowlist branch (403).

const tokenState: { token: Record<string, unknown> | null } = {
  token: {
    id: 'u-1',
    email: 'foreman@test.dev',
    name: 'Foreman',
    role: 'contractor',
    projectId: null,
  },
}

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => tokenState.token),
}))

// ---------------------------------------------------------------- db mock

vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    attachments: [] as Array<Record<string, unknown>>,
    /** One-shot: the next attachment.create throws this instead (error-path seam). */
    failNextCreate: null as unknown | null,
    /** One-shot: the next objectKey findUnique misses (race-window seam — the
     *  lookup runs before a concurrent create has landed). */
    missNextObjectKeyLookup: false,
    reset() {
      state.attachments.length = 0
      state.seq = 0
      state.failNextCreate = null
      state.missNextObjectKeyLookup = false
    },
  }
  // Migration 18 semantics (issue #159): the mock behaves like the real
  // engine — a create whose objectKey is already taken rejects with a
  // P2002-shaped error (code + meta.target, the shape Prisma surfaces), so
  // the route's unique-violation handling is tested against the contract it
  // actually depends on, not a bespoke stub convention.
  const attachment = {
    async create({ data }: { data: Record<string, unknown> }) {
      if (state.failNextCreate) {
        const err = state.failNextCreate
        state.failNextCreate = null
        throw err
      }
      if (
        typeof data.objectKey === 'string' &&
        state.attachments.some((r) => r.objectKey === data.objectKey)
      ) {
        throw Object.assign(
          new Error('Unique constraint failed on the fields: (objectKey)'),
          { code: 'P2002', meta: { target: ['objectKey'] } },
        )
      }
      const row = { id: `att_${++state.seq}`, createdAt: new Date('2026-03-09T12:00:00Z'), version: 1, ...data }
      state.attachments.push(row)
      return { ...row }
    },
    async findUnique({ where }: { where: { id?: string; objectKey?: string } }) {
      if (where.objectKey !== undefined) {
        if (state.missNextObjectKeyLookup) {
          state.missNextObjectKeyLookup = false
          return null
        }
        const row = state.attachments.find((r) => r.objectKey === where.objectKey)
        return row ? { ...row } : null
      }
      const row = state.attachments.find((r) => r.id === where.id)
      return row ? { ...row } : null
    },
  }
  const project = {
    async findUnique() {
      return null
    },
  }
  // Issue #181 (SEC-15): standing user row at version 0 — see push-routes.
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      return { id: where.id, tokenVersion: 0 }
    },
  }
  const db = { attachment, project, user, __state: state }
  return { db }
})

// z-ai SDK is imported by the upload route's module graph (documents → ai);
// it is never invoked on these paths — keep the import side-effect-free.
vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: vi.fn(async () => ({})) },
}))

import { db } from '@/backend/lib/db'
import { POST as uploadPost } from '@/app/api/upload/route'
import { POST as presignPost } from '@/app/api/upload/presign/route'
import { POST as confirmPost } from '@/app/api/upload/confirm/route'
import { setStorageDriverForTests, createLocalDiskDriver, createS3CompatDriver } from '@/backend/lib/storage'
import type { StorageAdapter } from '@/backend/lib/storage'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    attachments: Array<Record<string, unknown>>
    reset: () => void
    failNextCreate: unknown | null
    missNextObjectKeyLookup: boolean
  }
}
const state = (db as unknown as { __state: State }).__state

// ------------------------------------------------------------ driver fixtures

const fetchMock = vi.fn()

const S3_DRIVER: StorageAdapter = createS3CompatDriver({
  endpoint: 'https://s3.test.example',
  region: 'test-region',
  bucket: 'mjengo-test',
  accessKeyId: 'AKIATESTKEY',
  secretAccessKey: 'test-secret-not-real',
  publicBase: 'https://cdn.test.example',
  now: () => new Date('2026-03-09T12:00:00Z'),
  fetchImpl: fetchMock as unknown as typeof fetch,
})

const S3_DRIVER_NO_BASE: StorageAdapter = createS3CompatDriver({
  endpoint: 'https://s3.test.example',
  region: 'test-region',
  bucket: 'mjengo-test',
  accessKeyId: 'AKIATESTKEY',
  secretAccessKey: 'test-secret-not-real',
  now: () => new Date('2026-03-09T12:00:00Z'),
  fetchImpl: fetchMock as unknown as typeof fetch,
})

const LOCAL_DRIVER: StorageAdapter = createLocalDiskDriver()

let spyDir: string
type PutSignature = (key: string, bytes: Buffer, contentType: string) => Promise<void>
let putSpy: ReturnType<typeof vi.fn<PutSignature>>
let SPY_LOCAL_DRIVER: StorageAdapter

// One distinct principal per test — the rate limiter buckets per user
// (principalFor), so tests stay under every route's 10/min without
// disabling the limiter (it stays REAL: its 429 path is pinned in
// rate-limit.test.ts).
let principalSeq = 0
let sessionEmail: string

beforeEach(async () => {
  state.reset()
  fetchMock.mockReset()
  principalSeq += 1
  sessionEmail = `foreman+${principalSeq}@test.dev`
  tokenState.token = {
    id: 'u-1',
    email: sessionEmail,
    name: 'Foreman',
    role: 'contractor',
    projectId: null,
  }
  spyDir = await mkdtemp(path.join(tmpdir(), 'mj-upload-'))
  const base = createLocalDiskDriver({ photosDir: spyDir })
  putSpy = vi.fn<PutSignature>(base.put.bind(base))
  SPY_LOCAL_DRIVER = { ...base, put: putSpy }
})

afterEach(async () => {
  setStorageDriverForTests(null)
  vi.unstubAllGlobals()
  await rm(spyDir, { recursive: true, force: true })
})

// ------------------------------------------------------------ helpers

function req(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

// route() handlers take (req, ctx) — these give tests the one-arg ergonomics
// while passing the ctx the real router would (jobs-run-route.test.ts idiom).
const presignHandler = (r: NextRequest) => presignPost(r, undefined)
const confirmHandler = (r: NextRequest) => confirmPost(r, undefined)
const uploadHandler = (r: NextRequest) => uploadPost(r, undefined)

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
const UPP_KEY_RE = /^upp-\d+-[a-f0-9]{6}\.(png|jpg)$/

/** Respond to the stubbed fetch by method (client PUT vs driver HEAD). */
function fetchByMethod(responses: Record<string, () => Response>) {
  fetchMock.mockImplementation(((_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const make = responses[method]
    if (!make) throw new Error(`unexpected fetch ${method}`)
    return make()
  }) as unknown as typeof fetch)
}

// ------------------------------------------------------------ presign route

describe('POST /api/upload/presign', () => {
  it('local-disk driver → the honest 409, nothing minted, nothing written', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    const res = await presignHandler(req('/api/upload/presign', { contentType: 'image/png', sizeBytes: 1024, category: 'other' }))
    expect(res.status).toBe(409)
    expect(await bodyOf(res)).toEqual({
      error: 'Presigned uploads unavailable — local-disk driver in use (server-mediated upload only)',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.attachments).toHaveLength(0)
  })

  it('s3 driver → { uploadUrl, key, expiresSec, headers } with a SigV4 PUT URL and the exact key shape', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const res = await presignHandler(req('/api/upload/presign', { contentType: 'image/png', sizeBytes: 1024, category: 'other' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.key).toMatch(UPP_KEY_RE)
    expect(body.expiresSec).toBe(300)
    expect(body.headers).toEqual({ 'Content-Type': 'image/png' })
    const url = String(body.uploadUrl)
    expect(url.startsWith(`https://s3.test.example/mjengo-test/${body.key}?`)).toBe(true)
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(url).toContain('X-Amz-Expires=300')
    expect(url).toContain('X-Amz-SignedHeaders=host')
    expect(url).toContain('X-Amz-Credential=AKIATESTKEY%2F20260309%2Ftest-region%2Fs3%2Faws4_request')
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/)
  })

  it('jpeg → .jpg extension in the key (the legacy MIME_EXT mapping)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const body = await bodyOf(await presignHandler(req('/api/upload/presign', { contentType: 'image/jpeg', sizeBytes: 1024, category: 'receipt' })))
    expect(String(body.key)).toMatch(/^upp-\d+-[a-f0-9]{6}\.jpg$/)
    expect((body.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg')
  })

  it('two presigns mint two different keys', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const a = await bodyOf(await presignHandler(req('/api/upload/presign', { contentType: 'image/png', sizeBytes: 1, category: 'other' })))
    const b = await bodyOf(await presignHandler(req('/api/upload/presign', { contentType: 'image/png', sizeBytes: 1, category: 'other' })))
    expect(a.key).not.toBe(b.key)
  })

  it('strict contract: unknown field / bad contentType / bad size / bad category → 400', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const cases: Array<[unknown, RegExp]> = [
      [{ contentType: 'image/png', sizeBytes: 1024, category: 'other', extra: 1 }, /Unknown field|unrecognized/i],
      [{ contentType: 'image/webp', sizeBytes: 1024, category: 'other' }, /contentType/],
      [{ contentType: 'image/png', sizeBytes: 0, category: 'other' }, /sizeBytes/],
      [{ contentType: 'image/png', sizeBytes: 5 * 1024 * 1024, category: 'other' }, /sizeBytes|4 MB/],
      [{ contentType: 'image/png', sizeBytes: 1024, category: 'photograph' }, /category/],
      [{ contentType: 'image/png', category: 'other' }, /sizeBytes/],
    ]
    for (const [body, pattern] of cases) {
      const res = await presignHandler(req('/api/upload/presign', body))
      expect(res.status).toBe(400)
      expect(JSON.stringify(await bodyOf(res))).toMatch(pattern)
    }
  })

  it('unparseable body → 400 Invalid JSON body (route-kit reject contract)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const res = await presignHandler(req('/api/upload/presign', '{oops'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Invalid JSON body' })
  })

  it('no session → 401; a role outside the upload allowlist → 403', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const valid = { contentType: 'image/png', sizeBytes: 1024, category: 'other' }
    tokenState.token = null
    expect((await presignHandler(req('/api/upload/presign', valid))).status).toBe(401)
    tokenState.token = { id: 'u-2', email: 'qs@test.dev', name: 'QS', role: 'qs', projectId: null }
    const res = await presignHandler(req('/api/upload/presign', valid))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "qs"' })
  })
})

// ------------------------------------------------------------ confirm route

describe('POST /api/upload/confirm — the full client-direct flow', () => {
  it('presign → client PUT → HEAD verify → Attachment row (the happy path, end to end)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    vi.stubGlobal('fetch', fetchMock) // the CLIENT's fetch is also stubbed

    const presigned = await bodyOf(await presignHandler(req('/api/upload/presign', { contentType: 'image/png', sizeBytes: PNG_BYTES.length, category: 'receipt' })))
    const key = String(presigned.key)
    const uploadUrl = String(presigned.uploadUrl)

    // The client PUTs straight to object storage with the advisory headers.
    fetchByMethod({
      PUT: () => new Response(null, { status: 200 }),
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': String(PNG_BYTES.length), 'content-type': 'image/png' } }),
    })
    const putRes = await fetch(uploadUrl, { method: 'PUT', headers: (presigned.headers as Record<string, string>), body: new Uint8Array(PNG_BYTES) })
    expect(putRes.ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe(uploadUrl)
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT')

    const res = await confirmHandler(req('/api/upload/confirm', { key, category: 'receipt' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.replayed).toBe(false) // #159: fresh confirm — the stable replay flag
    const attachment = body.attachment as Record<string, unknown>
    expect(attachment.id).toBe('att_1')
    expect(attachment.fileName).toBe(key)
    expect(attachment.storageKey).toBe(`https://cdn.test.example/mjengo-test/${key}`) // driver.publicUrl (CDN base)
    expect(attachment.category).toBe('receipt')
    expect(attachment.reviewStatus).toBe('pending') // the existing upload default

    // The row itself, exactly as persisted:
    const row = state.attachments[0]
    expect(row.entityType).toBe('photo')
    expect(row.entityId).toBe('unattached')
    expect(row.kind).toBe('receipt_photo')
    expect(row.fileName).toBe(key)
    expect(row.objectKey).toBe(key) // #159: the RAW key — the dedupe natural key
    expect(row.storageKey).toBe(`https://cdn.test.example/mjengo-test/${key}`)
    expect(row.mimeType).toBe('image/png')
    expect(row.sizeBytes).toBe(PNG_BYTES.length)
    expect(row.uploadedBy).toBe(sessionEmail)
    expect(row.reviewStatus).toBe('pending')
    expect(row.projectId).toBeNull()

    // The driver verified via a presigned HEAD:
    const headCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'HEAD')
    expect(headCall).toBeTruthy()
    expect(String(headCall![0])).toContain(`/mjengo-test/${key}?`)
    expect(String(headCall![0])).toContain('X-Amz-Expires=60')
  })

  it('without a public base, the recorded storageKey is the presigned GET (documented tradeoff)', async () => {
    setStorageDriverForTests(S3_DRIVER_NO_BASE)
    fetchByMethod({
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': '11', 'content-type': 'image/png' } }),
    })
    const res = await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const storageKey = String((body.attachment as Record<string, unknown>).storageKey)
    expect(storageKey.startsWith('https://s3.test.example/mjengo-test/upp-1712345678-abcd12.png?')).toBe(true)
    expect(storageKey).toContain('X-Amz-Expires=604800') // SigV4 7-day maximum
  })

  it('object never uploaded → honest 404, NO row created', async () => {
    setStorageDriverForTests(S3_DRIVER)
    fetchByMethod({ HEAD: () => new Response(null, { status: 404 }) })
    const res = await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other' }))
    expect(res.status).toBe(404)
    expect(String((await bodyOf(res)).error)).toContain('No uploaded object')
    expect(state.attachments).toHaveLength(0)
  })

  it('object over the 4 MB cap → 413, no row', async () => {
    setStorageDriverForTests(S3_DRIVER)
    fetchByMethod({
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': String(5 * 1024 * 1024), 'content-type': 'image/png' } }),
    })
    const res = await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other' }))
    expect(res.status).toBe(413)
    expect(String((await bodyOf(res)).error)).toContain('limit is 4 MB')
    expect(state.attachments).toHaveLength(0)
  })

  it('object stored with a non-image Content-Type → 400 explaining the header contract, no row', async () => {
    setStorageDriverForTests(S3_DRIVER)
    fetchByMethod({
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': '11', 'content-type': 'application/octet-stream' } }),
    })
    const res = await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other' }))
    expect(res.status).toBe(400)
    expect(String((await bodyOf(res)).error)).toContain('Content-Type')
    expect(state.attachments).toHaveLength(0)
  })

  it('non-upp keys are refused before any storage probe (traversal/foreign shapes)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    for (const bad of ['../../etc/passwd', 'doc-1712345678-abcd12.jpg', 'upp-x.png', 'upp-1712345678-abcd12.txt', 'x']) {
      const res = await confirmHandler(req('/api/upload/confirm', { key: bad, category: 'other' }))
      expect(res.status).toBe(400)
      expect(String((await bodyOf(res)).error)).toMatch(/key/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.attachments).toHaveLength(0)
  })

  it('bad category / unknown field / bad JSON → 400 (strict contract)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    expect((await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'selfie' }))).status).toBe(400)
    expect((await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other', who: 1 }))).status).toBe(400)
    expect((await confirmHandler(req('/api/upload/confirm', 'nope'))).status).toBe(400)
  })

  it('local-disk driver answers confirm honestly: no such object → 404 (fail closed, no row)', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    const res = await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other' }))
    expect(res.status).toBe(404)
    expect(state.attachments).toHaveLength(0)
  })

  it('no session → 401 (session guard mirrors /api/upload)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    tokenState.token = null
    expect((await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-abcd12.png', category: 'other' }))).status).toBe(401)
  })
})

// ------------------------------------------- confirm idempotency (issue #159)

describe('POST /api/upload/confirm — idempotent on the object key (#159 / API-8)', () => {
  const KEY = 'upp-1712345678-abcd12.png'

  function headOk() {
    fetchByMethod({
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': '11', 'content-type': 'image/png' } }),
    })
  }

  it('a retried confirm returns the ORIGINAL row (200, replayed: true) — one row, no re-HEAD', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    const first = await bodyOf(await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'receipt' })))
    expect(first.ok).toBe(true)
    expect(first.replayed).toBe(false)

    // The retry: same key, same category. The replay must NOT hit storage —
    // the row is the durable answer — so no further fetch after this clear.
    fetchMock.mockClear()
    const res = await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'receipt' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.replayed).toBe(true) // the family's replay idiom
    expect((body.attachment as Record<string, unknown>).id).toBe('att_1') // the ORIGINAL row
    expect((body.attachment as Record<string, unknown>).category).toBe('receipt')
    expect(fetchMock).not.toHaveBeenCalled() // replay answered from the record, not the bucket
    expect(state.attachments).toHaveLength(1) // no second row — the whole point of #159
    expect(state.attachments[0].objectKey).toBe(KEY)
  })

  it('a conflicting retry (same key, DIFFERENT category) → 409, nothing replayed, nothing rewritten', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'receipt' }))

    const res = await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'invoice' }))
    expect(res.status).toBe(409)
    const body = await bodyOf(res)
    expect(String(body.error)).toContain('already confirmed as category "receipt"')
    expect(String(body.error)).toContain('NOT replayed')
    expect(body.attachment).toBeUndefined()
    expect(state.attachments).toHaveLength(1)
    expect(state.attachments[0].category).toBe('receipt') // the row keeps its classification
    expect(state.attachments[0].kind).toBe('receipt_photo')
  })

  it('concurrent double-confirm: both 200, ONE row — the unique index breaks the race', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    // Promise.all interleaves at every await: BOTH replay lookups miss (the
    // race window), both verifies pass, one create wins, the loser's create
    // rejects P2002 on the unique index and replays the winner's row.
    const [a, b] = await Promise.all([
      confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'other' })),
      confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'other' })),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const bodyA = await bodyOf(a)
    const bodyB = await bodyOf(b)
    expect([bodyA.replayed, bodyB.replayed].sort()).toEqual([false, true]) // exactly one replay
    expect((bodyA.attachment as Record<string, unknown>).id).toBe(
      (bodyB.attachment as Record<string, unknown>).id,
    ) // both point at the ONE row
    expect(state.attachments).toHaveLength(1)
  })

  it('distinct keys are unaffected — two rows, both fresh', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    const a = await bodyOf(await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-aaaaaa.png', category: 'other' })))
    const b = await bodyOf(await confirmHandler(req('/api/upload/confirm', { key: 'upp-1712345678-bbbbbb.png', category: 'receipt' })))
    expect(a.replayed).toBe(false)
    expect(b.replayed).toBe(false)
    expect(state.attachments).toHaveLength(2)
    expect(new Set(state.attachments.map((r) => r.id)).size).toBe(2)
  })

  it('fail closed: a plain create error is NOT swallowed (500 via the route contract)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    state.failNextCreate = new Error('database exploded')
    const res = await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'other' }))
    expect(res.status).toBe(500)
    expect(await bodyOf(res)).toEqual({ error: 'Confirm failed' })
    expect(state.attachments).toHaveLength(0)
  })

  it('fail closed: a P2002 naming a DIFFERENT constraint is NOT treated as a replay (rethrown → 500)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    state.failNextCreate = Object.assign(new Error('Unique constraint failed on the fields: (id)'), {
      code: 'P2002',
      meta: { target: ['id'] },
    })
    const res = await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'other' }))
    expect(res.status).toBe(500)
    expect(await bodyOf(res)).toEqual({ error: 'Confirm failed' })
    expect(state.attachments).toHaveLength(0)
  })

  it('fail closed: a string-target P2002 (index-name shape) on objectKey IS a replay', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'drawing' }))
    const row = state.attachments[0]
    // Simulate the race window: the pre-lookup MISSES (a concurrent confirm
    // has not landed yet from this request's viewpoint), the create then hits
    // the unique index — reported by its INDEX NAME (the string target shape
    // some engine versions surface) — still recognized, still a replay.
    state.missNextObjectKeyLookup = true
    state.failNextCreate = Object.assign(new Error('Unique constraint failed on the fields: (objectKey)'), {
      code: 'P2002',
      meta: { target: 'Attachment_objectKey_key' },
    })
    const res = await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'drawing' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.replayed).toBe(true)
    expect((body.attachment as Record<string, unknown>).id).toBe(row.id)
    expect(state.attachments).toHaveLength(1)
  })

  it('fail closed: the race window with a VANISHED row (P2002 then no row) rethrows — honest 500', async () => {
    setStorageDriverForTests(S3_DRIVER)
    headOk()
    // Pre-lookup misses, create collides, and the re-read finds nothing
    // (row deleted between violation and re-read) — the route must not
    // invent a replay; it rethrows and the route contract answers 500.
    state.failNextCreate = Object.assign(new Error('Unique constraint failed on the fields: (objectKey)'), {
      code: 'P2002',
      meta: { target: ['objectKey'] },
    })
    const res = await confirmHandler(req('/api/upload/confirm', { key: KEY, category: 'other' }))
    expect(res.status).toBe(500)
    expect(await bodyOf(res)).toEqual({ error: 'Confirm failed' })
  })
})

// ------------------------------------------------- the existing upload route

describe('POST /api/upload (legacy photo path) — now writes through the adapter', () => {
  it('put() is called with the exact key/bytes/mime; URL derives from publicUrl; response unchanged', async () => {
    setStorageDriverForTests(SPY_LOCAL_DRIVER)
    const res = await uploadHandler(req('/api/upload', { dataUrl: PNG_DATA_URL }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.bytes).toBe(PNG_BYTES.length)

    expect(putSpy).toHaveBeenCalledTimes(1)
    const [key, bytesArg, mimeArg] = putSpy.mock.calls[0] as [string, Buffer, string]
    expect(key).toMatch(UPP_KEY_RE)
    expect(Buffer.from(bytesArg)).toEqual(PNG_BYTES)
    expect(mimeArg).toBe('image/png')

    // The URL is the driver's publicUrl for the SAME key (byte-identical to
    // the historical /photos/<name>):
    expect(body.url).toBe(`/photos/${key}`)
    // And the bytes actually landed on disk through the real local write:
    expect(await readFile(path.join(spyDir, key))).toEqual(PNG_BYTES)
  })

  it('webp data URL round-trips the same way (the ext mapping the route always had)', async () => {
    setStorageDriverForTests(SPY_LOCAL_DRIVER)
    const webp = Buffer.from('RIFF0000WEBPVP8 ')
    const res = await uploadHandler(req('/api/upload', { dataUrl: `data:image/webp;base64,${webp.toString('base64')}` }))
    expect(res.status).toBe(200)
    expect(putSpy).toHaveBeenCalledTimes(1)
    expect(putSpy.mock.calls[0][0]).toMatch(/\.webp$/)
    expect((await bodyOf(res)).url).toMatch(/^\/photos\/upp-.*\.webp$/)
  })

  it('MIME-mismatched bytes are refused BEFORE any driver write (W-AUDIT #4 intact)', async () => {
    setStorageDriverForTests(SPY_LOCAL_DRIVER)
    const fake = Buffer.from('<html>not an image</html>')
    const res = await uploadHandler(req('/api/upload', { dataUrl: `data:image/png;base64,${fake.toString('base64')}` }))
    expect(res.status).toBe(400)
    expect(String((await bodyOf(res)).error)).toContain('does not match its type')
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('oversized decoded payload → 413 before any driver write', async () => {
    setStorageDriverForTests(SPY_LOCAL_DRIVER)
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 7)
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47 // png magic, over cap
    const res = await uploadHandler(req('/api/upload', { dataUrl: `data:image/png;base64,${big.toString('base64')}` }))
    expect(res.status).toBe(413)
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('an s3-backed deployment: same route, URL becomes the driver publicUrl (CDN base)', async () => {
    setStorageDriverForTests({
      ...S3_DRIVER,
      put: vi.fn(async () => {}),
    })
    const res = await uploadHandler(req('/api/upload', { dataUrl: PNG_DATA_URL }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(String(body.url)).toMatch(/^https:\/\/cdn\.test\.example\/mjengo-test\/upp-\d+-[a-f0-9]{6}\.png$/)
    expect(body.bytes).toBe(PNG_BYTES.length)
  })
})
