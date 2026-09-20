/**
 * Route contract for POST /api/upload/re-sign (issue #38 — fresh short-lived
 * presigned GETs for stored attachments). Same mock idioms as
 * storage-presign-routes.test.ts: getToken session stub, in-memory db with
 * __state (attachments + projects + delivery-photo links), z-ai SDK kept
 * import-side-effect-free, one distinct principal per test so the REAL rate
 * limiter (10/min for this bucket) stays in play — except the one test that
 * deliberately trips it.
 *
 * Pins:
 *  · session guard (401) + upload-family role allowlist (403);
 *  · the honest capability gate — local-disk driver → 409 "public URLs never
 *    expire"; a lying driver (canPresign true, methods missing) → 500;
 *  · the happy path — { ok, expiresSec: 900, urls } with SigV4 GET URLs for
 *    the driver-resolved keys, the recorded storageKey NEVER rewritten;
 *  · the entitlement matrix (the photo replay path's checks): client pinned
 *    to their project (own → 200, foreign → 403, unpinned → 403 fail-closed),
 *    delivery-linked unattached photos (link's project decides), unreachable
 *    rows → 403, one bad id poisons the whole batch (no per-item oracle);
 *  · resolution failures — unknown id → 404 (named), a storageKey the active
 *    driver cannot address → 409 (the local→S3 migration case);
 *  · fail-closed validation: non-array / empty / non-string / oversized /
 *    unknown-field / alternate-field-name / unparseable bodies → 400;
 *  · the rate limit — the 11th call in a minute from one principal → 429.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------ session mock

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
    projects: [] as string[],
    deliveryLinks: [] as Array<{ attachmentId: string; projectId: string }>,
    reset() {
      state.attachments.length = 0
      state.projects.length = 0
      state.deliveryLinks.length = 0
      state.seq = 0
    },
  }
  const attachment = {
    async findMany({ where }: { where: { id?: { in?: string[] } } }) {
      const wanted = where.id?.in
      const rows = wanted ? state.attachments.filter((r) => wanted.includes(String(r.id))) : [...state.attachments]
      return rows.map((r) => ({ ...r }))
    },
  }
  const project = {
    async findUnique({ where }: { where: { id: string } }) {
      return state.projects.includes(where.id) ? { id: where.id } : null
    },
  }
  // The route's entitlement probe: a DeliveryPhoto link (simplified to
  // { attachmentId, projectId } — the delivery's order's project).
  const deliveryPhoto = {
    async findFirst({ where }: { where: { attachmentId?: string; delivery?: { order?: { projectId?: string } } } }) {
      const wantedProject = where.delivery?.order?.projectId
      const link = state.deliveryLinks.find(
        (l) => l.attachmentId === where.attachmentId && (wantedProject === undefined || l.projectId === wantedProject),
      )
      return link ? { id: `dp_${link.attachmentId}` } : null
    },
  }
  // Issue #181 (SEC-15): standing user row at version 0 — see push-routes.
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      return { id: where.id, tokenVersion: 0 }
    },
  }
  const db = { attachment, project, deliveryPhoto, user, __state: state }
  return { db }
})

// The route's module graph stays SDK-free in practice; mocked so any future
// import stays side-effect-free (presign-routes idiom).
vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: vi.fn(async () => ({})) },
}))

import { db } from '@/backend/lib/db'
import { POST as resignPost } from '@/app/api/upload/re-sign/route'
import { createLocalDiskDriver, createS3CompatDriver, setStorageDriverForTests } from '@/backend/lib/storage'
import type { StorageAdapter } from '@/backend/lib/storage'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    attachments: Array<Record<string, unknown>>
    projects: string[]
    deliveryLinks: Array<{ attachmentId: string; projectId: string }>
    reset: () => void
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

/** A driver that LIES about the presign capability (the 500 branch). */
const LYING_DRIVER = { id: 's3-compat', canPresign: true } as StorageAdapter

let principalSeq = 0
let sessionEmail: string

beforeEach(() => {
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
})

afterEach(() => {
  setStorageDriverForTests(null)
})

// ------------------------------------------------------------ helpers

function req(body: unknown, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/upload/re-sign', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const resignHandler = (r: NextRequest) => resignPost(r, undefined)

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

/** Seed a photo Attachment row the way the flows record them. */
function seedAttachment(row: Partial<Record<string, unknown>> & { id: string }): void {
  state.attachments.push({
    entityType: 'photo',
    entityId: 'unattached',
    fileName: 'upp-1712345678-abcd12.png',
    version: 1,
    createdAt: new Date('2026-03-09T12:00:00Z'),
    reviewStatus: 'pending',
    ...row,
  })
}

const CDN_PHOTO_KEY = 'upp-1712345678-abcd12.png'
const CDN_PHOTO_URL = `https://cdn.test.example/mjengo-test/${CDN_PHOTO_KEY}`

// ------------------------------------------------------------ session + capability

describe('POST /api/upload/re-sign — session and capability gates', () => {
  it('no session → 401 (session guard like the other upload routes)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    tokenState.token = null
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })

  it('a role outside the upload-family allowlist → 403', async () => {
    setStorageDriverForTests(S3_DRIVER)
    tokenState.token = { id: 'u-2', email: 'qs@test.dev', name: 'QS', role: 'qs', projectId: null }
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "qs"' })
  })

  it('local-disk driver → the honest 409 (its public URLs never expire)', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    seedAttachment({ id: 'att_1', storageKey: '/photos/upp-1712345678-abcd12.png', projectId: 'p_1' })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(409)
    expect(await bodyOf(res)).toEqual({
      error:
        'Presigned URLs unavailable — local-disk driver in use ' +
        '(its public URLs never expire; re-signing is only for private object storage)',
    })
  })

  it('a driver that claims presign but lacks the methods → 500 (fail loudly)', async () => {
    setStorageDriverForTests(LYING_DRIVER)
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(500)
    expect(String((await bodyOf(res)).error)).toContain('claims presign support but does not implement it')
  })
})

// ------------------------------------------------------------ happy path

describe('POST /api/upload/re-sign — fresh short-lived presigned GETs', () => {
  it('project-linked row (owner role): 200 { ok, expiresSec, urls } with a SigV4 GET for the resolved key', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1')
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_1' })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.expiresSec).toBe(900)
    const urls = body.urls as Array<{ attachmentId: string; url: string }>
    expect(urls).toHaveLength(1)
    expect(urls[0].attachmentId).toBe('att_1')
    expect(urls[0].url.startsWith(`https://s3.test.example/mjengo-test/${CDN_PHOTO_KEY}?`)).toBe(true)
    expect(urls[0].url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(urls[0].url).toContain('X-Amz-Expires=900') // short-lived on purpose
    expect(urls[0].url).toContain('X-Amz-SignedHeaders=host')
    expect(urls[0].url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/)
    // transport-only: the recorded storageKey row is NEVER rewritten
    expect(state.attachments[0].storageKey).toBe(CDN_PHOTO_URL)
  })

  it('a batch answers one URL per id', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1')
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_1' })
    seedAttachment({ id: 'att_2', storageKey: `https://cdn.test.example/mjengo-test/docs/doc-1712345678-abcd12.png`, projectId: 'p_1' })
    const res = await resignHandler(req({ attachmentIds: ['att_1', 'att_2'] }))
    expect(res.status).toBe(200)
    const urls = ((await bodyOf(res)).urls as Array<{ attachmentId: string }>).map((u) => u.attachmentId).sort()
    expect(urls).toEqual(['att_1', 'att_2'])
  })

  it('an EXPIRED no-base presigned storageKey still re-signs (the whole point of issue #38)', async () => {
    setStorageDriverForTests(S3_DRIVER_NO_BASE)
    const recorded = S3_DRIVER_NO_BASE.publicUrl(CDN_PHOTO_KEY) // 7-day presigned GET
    expect(recorded).toContain('X-Amz-Signature=')
    seedAttachment({ id: 'att_1', storageKey: recorded, projectId: 'p_1' })
    state.projects.push('p_1')
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(200)
    const url = String(((await bodyOf(res)).urls as Array<{ url: string }>)[0].url)
    expect(url.startsWith(`https://s3.test.example/mjengo-test/${CDN_PHOTO_KEY}?`)).toBe(true)
    expect(url).toContain('X-Amz-Expires=900')
    expect(url).not.toBe(recorded) // fresh signature, fresh expiry
  })

  it('an unattached delivery-evidence photo is entitled through its DeliveryPhoto link (owner role)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: null })
    state.deliveryLinks.push({ attachmentId: 'att_1', projectId: 'p_1' })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(200)
    expect(((await bodyOf(res)).urls as unknown[])).toHaveLength(1)
  })
})

// ------------------------------------------------------------ entitlement

describe('POST /api/upload/re-sign — entitlement (the photo replay path checks)', () => {
  it('client pinned to their project: own row → 200', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1')
    tokenState.token = { id: 'u-3', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p_1' }
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_1' })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(200)
  })

  it('client pinned to their project: foreign row → 403, fail closed', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1', 'p_2')
    tokenState.token = { id: 'u-3', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p_1' }
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_2' })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(403)
    expect(String((await bodyOf(res)).error)).toContain('not reachable through a project your session can access')
  })

  it('an UNPINNED client can establish entitlement to nothing → 403', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1')
    tokenState.token = { id: 'u-4', email: 'client@test.dev', name: 'Client', role: 'client', projectId: null }
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_1' })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(403)
  })

  it('client + unattached photo: the link\u2019s project decides (own → 200, foreign → 403)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: null })
    state.deliveryLinks.push({ attachmentId: 'att_1', projectId: 'p_2' })

    tokenState.token = { id: 'u-5', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p_1' }
    expect((await resignHandler(req({ attachmentIds: ['att_1'] }))).status).toBe(403)

    tokenState.token = { id: 'u-6', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p_2' }
    expect((await resignHandler(req({ attachmentIds: ['att_1'] }))).status).toBe(200)
  })

  it('an unattached row with NO delivery link is reachable nowhere → 403 even for owner roles', async () => {
    setStorageDriverForTests(S3_DRIVER)
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: null })
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(403)
    expect(String((await bodyOf(res)).error)).toContain('not reachable through a project your session can access')
  })

  it('one non-entitled id poisons the whole batch (no per-item entitlement oracle)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1', 'p_2')
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_1' })
    seedAttachment({ id: 'att_2', storageKey: CDN_PHOTO_URL, projectId: 'p_2' })
    tokenState.token = { id: 'u-7', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p_1' }
    const res = await resignHandler(req({ attachmentIds: ['att_1', 'att_2'] }))
    expect(res.status).toBe(403)
  })

  it('owner role + project-linked row whose project vanished → 403 (no entitlement through a deleted project)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_gone' }) // p_gone NOT in state.projects
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(403)
  })
})

// ------------------------------------------------------------ resolution failures

describe('POST /api/upload/re-sign — honest resolution failures', () => {
  it('unknown id → 404 naming it', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const res = await resignHandler(req({ attachmentIds: ['att_nope'] }))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Attachment not found: att_nope' })
  })

  it('a storageKey the active driver cannot address → 409 (the local→S3 migration case)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1')
    seedAttachment({ id: 'att_1', storageKey: '/photos/upp-1712345678-abcd12.png', projectId: 'p_1' }) // a local-disk row
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(409)
    const error = String((await bodyOf(res)).error)
    expect(error).toContain('cannot address')
    expect(error).toContain('re-upload')
  })
})

// ------------------------------------------------------------ strict contract

describe('POST /api/upload/re-sign — fail-closed validation', () => {
  it.each([
    ['attachmentIds is not an array', { attachmentIds: 'att_1' }],
    ['empty array', { attachmentIds: [] }],
    ['non-string entries', { attachmentIds: [1, 2] }],
    ['51 ids (over the batch cap)', { attachmentIds: Array.from({ length: 51 }, (_, i) => `att_${i}`) }],
    ['unknown field', { attachmentIds: ['att_1'], extra: 1 }],
    ['the alternate field name is NOT accepted (strict contract)', { ids: ['att_1'] }],
  ])('%s → 400', async (_name, body) => {
    setStorageDriverForTests(S3_DRIVER)
    const res = await resignHandler(req(body))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await bodyOf(res))).toMatch(/attachmentIds|Unknown field|ids/)
  })

  it('unparseable body → 400 Invalid JSON body (route-kit reject contract)', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const res = await resignHandler(req('{oops'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Invalid JSON body' })
  })

  it('validation failures never touch the driver or the db', async () => {
    setStorageDriverForTests(S3_DRIVER)
    await resignHandler(req({ attachmentIds: [] }))
    await resignHandler(req({ ids: ['att_1'] }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.attachments).toHaveLength(0)
  })
})

// ------------------------------------------------------------ rate limit

describe('POST /api/upload/re-sign — rate limit (10/min per principal)', () => {
  it('the 11th call within the window → 429 with Retry-After', async () => {
    setStorageDriverForTests(S3_DRIVER)
    state.projects.push('p_1')
    seedAttachment({ id: 'att_1', storageKey: CDN_PHOTO_URL, projectId: 'p_1' })
    // the SAME principal for all 11 calls (no beforeEach principal bump)
    for (let i = 0; i < 10; i++) {
      const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
      expect(res.status).toBe(200)
    }
    const res = await resignHandler(req({ attachmentIds: ['att_1'] }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(String((await bodyOf(res)).error)).toContain('Too many requests')
  })
})
