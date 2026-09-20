/**
 * /api/upload/confirm idempotency against a REAL SQLite database
 * (issue #159 / audit API-8) — the engine-level companion of the confirm
 * half of storage-presign-routes.test.ts (the stub-suite pins of the same
 * route contract).
 *
 * The stub suite proves the route's replay/conflict/race branches against a
 * mock that IMPOSES migration 18's semantics; this file proves the
 * guarantee the fix actually leans on, where it is supposed to live: the
 * unique index on Attachment.objectKey, created by migration
 * 18_upload_confirm_object_key, applied to a real database by the real
 * `prisma migrate deploy` (see tests/helpers/db.ts) — driven through the
 * REAL route handler with the real Prisma client:
 *
 *   · fresh confirm mints the row (objectKey = the RAW key) — replayed:false;
 *   · a retried confirm returns the ORIGINAL row (200, replayed:true),
 *     answers from the record without re-HEADing the bucket, and leaves
 *     exactly ONE row (raw-SQL count oracle);
 *   · a conflicting retry (same key, different category) → 409 with the
 *     stored row NOT replayed and NOT reclassified (raw-SQL oracle on the
 *     row's category/kind);
 *   · CONCURRENT double-confirm (Promise.all — both replay lookups miss
 *     because both run before either create lands): both 200, ONE row, the
 *     loser replays through the real P2002 — the AC the IdempotencyRecord
 *     seam cannot deliver (check-then-act on a side table);
 *   · the REAL P2002 shape the route's isObjectKeyUniqueViolation must
 *     recognize: a direct duplicate create through Prisma rejects with
 *     code P2002 and a target naming objectKey (field list or index name,
 *     whichever the engine reports) — pinned, not assumed;
 *   · legacy-shaped rows (objectKey NULL — the document mode / pre-#159
 *     corpus) never collide: SQLite unique indexes skip NULLs, so the
 *     constraint is additive over the legacy corpus by construction.
 */
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

// Route handlers authenticate through withGuard → the REAL getSessionFromReq,
// which decodes the session off next-auth's getToken — mock that seam (the
// storage-presign-routes.test.ts idiom).
const tokenState: { token: Record<string, unknown> | null } = { token: null }
vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => tokenState.token),
}))
// Issue #181 (SEC-15): the guard now proves every session against
// User.tokenVersion. This file's tokens are FIXTURES (mocked getToken,
// synthetic principal ids) — the fixture means "a valid, unrevoked
// session", so the revocation seam is mocked to exactly that. The seam
// itself is pinned end-to-end on a REAL JWE + real user rows in
// session-revocation.test.ts.
vi.mock('@/backend/lib/session-revocation', async () => {
  const actual = await vi.importActual<typeof import('@/backend/lib/session-revocation')>(
    '@/backend/lib/session-revocation',
  )
  return { ...actual, sessionTokenIsRevoked: vi.fn(async () => false) }
})

import { db } from '@/backend/lib/db'
import { POST as confirmPost } from '@/app/api/upload/confirm/route'
import { setStorageDriverForTests, createS3CompatDriver } from '@/backend/lib/storage'
import type { StorageAdapter } from '@/backend/lib/storage'
import { disposeRealDb, getRealTestDb } from '../helpers/db'
import { NextRequest } from 'next/server'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

// ------------------------------------------------------------ driver fixture

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

function headOk() {
  fetchMock.mockImplementation(((_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '11', 'content-type': 'image/png' } })
    }
    throw new Error(`unexpected fetch ${init?.method}`)
  }) as unknown as typeof fetch)
}

// One distinct principal per test — the route's rate limiter is real and
// buckets upload:confirm 10/min per user (same posture as the stub suite).
let principalSeq = 0
let sessionEmail: string

beforeEach(() => {
  fetchMock.mockReset()
  headOk()
  principalSeq += 1
  sessionEmail = `foreman+confirm${principalSeq}@test.dev`
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

// ---------------------------------------------------------------- helpers

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/upload/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const confirmHandler = (r: NextRequest) => confirmPost(r, undefined)

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

/** Raw-SQL count oracle — independent of Prisma, the stub suites' toolkit. */
const attachmentCount = (where = ''): number =>
  Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM Attachment ${where}`).get() as { n: bigint }).n)

/** The file's harness is ONE lazily-created database per FILE — every test
 *  uses its own objectKey so pins stay independent of execution order. */
const keyFor = (n: number) => `upp-171234567${n}-abcd1${n}.png`

// ---------------------------------------------------------------- the pins

describe('POST /api/upload/confirm — idempotent on the real engine (#159)', () => {
  it('the migration 18 index is live on the deployed database', () => {
    const indexes = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='Attachment'").all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexes).toContain('Attachment_objectKey_key')
  })

  it('fresh confirm mints the row (objectKey = the RAW key); retry replays the ORIGINAL — one row, no re-HEAD', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const KEY = keyFor(1)
    const first = await bodyOf(await confirmHandler(req({ key: KEY, category: 'receipt' })))
    expect(first.ok).toBe(true)
    expect(first.replayed).toBe(false)
    const firstId = (first.attachment as Record<string, unknown>).id

    const row = await prisma.attachment.findUnique({ where: { objectKey: KEY } })
    expect(row?.objectKey).toBe(KEY)
    expect(row?.fileName).toBe(KEY)
    expect(row?.storageKey).toBe(`https://cdn.test.example/mjengo-test/${KEY}`)
    expect(row?.category).toBe('receipt')

    // The retry: answered from the record — no further bucket round-trip.
    fetchMock.mockClear()
    const res = await confirmHandler(req({ key: KEY, category: 'receipt' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.replayed).toBe(true)
    expect((body.attachment as Record<string, unknown>).id).toBe(firstId)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(attachmentCount(`WHERE "objectKey" = '${KEY}'`)).toBe(1)
  })

  it('conflicting retry (same key, different category) → 409; the stored row is neither replayed nor reclassified', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const KEY = keyFor(2)
    await confirmHandler(req({ key: KEY, category: 'receipt' }))

    const res = await confirmHandler(req({ key: KEY, category: 'invoice' }))
    expect(res.status).toBe(409)
    const body = await bodyOf(res)
    expect(String(body.error)).toContain('already confirmed as category "receipt"')
    expect(body.attachment).toBeUndefined()

    // Raw-SQL oracle: the row keeps its original classification.
    const row = sqlite
      .prepare('SELECT category, kind, uploadedBy FROM Attachment WHERE "objectKey" = ?')
      .get(KEY) as { category: string; kind: string; uploadedBy: string }
    expect(row.category).toBe('receipt')
    expect(row.kind).toBe('receipt_photo')
    expect(row.uploadedBy).toBe(sessionEmail)
    expect(attachmentCount(`WHERE "objectKey" = '${KEY}'`)).toBe(1)
  })

  it('CONCURRENT double-confirm: both 200, ONE row — the loser replays through the real P2002', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const KEY = keyFor(3)
    // Promise.all interleaves at every await: both replay lookups run before
    // either create lands (the race window), one create wins the unique
    // index, the loser's create rejects P2002 and replays the winner's row.
    const [a, b] = await Promise.all([
      confirmHandler(req({ key: KEY, category: 'other' })),
      confirmHandler(req({ key: KEY, category: 'other' })),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const bodyA = await bodyOf(a)
    const bodyB = await bodyOf(b)
    expect([bodyA.replayed, bodyB.replayed].sort()).toEqual([false, true])
    expect((bodyA.attachment as Record<string, unknown>).id).toBe(
      (bodyB.attachment as Record<string, unknown>).id,
    )
    expect(attachmentCount(`WHERE "objectKey" = '${KEY}'`)).toBe(1)
  })

  it('the REAL P2002 shape: a duplicate create through Prisma names objectKey (the shape the route must recognize)', async () => {
    await prisma.attachment.create({
      data: {
        entityType: 'photo',
        entityId: 'unattached',
        fileName: 'upp-1712345678-cafe00.png',
        storageKey: 'https://cdn.test.example/mjengo-test/upp-1712345678-cafe00.png',
        objectKey: 'upp-1712345678-cafe00.png',
        kind: 'other_photo',
        uploadedBy: 'shape@test.dev',
        category: 'other',
        reviewStatus: 'pending',
      },
    })
    const err = await prisma.attachment
      .create({
        data: {
          entityType: 'photo',
          entityId: 'unattached',
          fileName: 'upp-1712345678-cafe00.png',
          storageKey: 'https://cdn.test.example/mjengo-test/upp-1712345678-cafe00.png',
          objectKey: 'upp-1712345678-cafe00.png',
          kind: 'other_photo',
          uploadedBy: 'shape@test.dev',
          category: 'other',
          reviewStatus: 'pending',
        },
      })
      .catch((e: unknown) => e)
    const known = err as { code?: string; message?: string; meta?: { target?: unknown } }
    expect(known.code).toBe('P2002')
    const target = known.meta?.target
    const names = Array.isArray(target) ? target.map(String) : [String(target)]
    expect(names.some((n) => n.includes('objectKey'))).toBe(true)
  })

  it('legacy-shaped rows (objectKey NULL) never collide — the constraint is additive over the pre-#159 corpus', async () => {
    const base = {
      entityType: 'document',
      entityId: 'unattached',
      fileName: 'site-visit-notes.pdf', // the document mode's DISPLAY fileName
      storageKey: '/docs/doc-1712345678-dead00.pdf',
      kind: 'other_doc',
      uploadedBy: 'docs@test.dev',
      category: 'other',
      reviewStatus: 'pending',
    }
    // Two NULL-objectKey rows — even with IDENTICAL fileName/storageKey
    // (the duplicated-evidence shape #159 is about) — are untouched by the
    // index: historical rows are left as-is, never a migration blocker.
    await prisma.attachment.create({ data: { ...base } })
    await prisma.attachment.create({ data: { ...base } })
    expect(attachmentCount(`WHERE "objectKey" IS NULL AND "storageKey" = '${base.storageKey}'`)).toBe(2)
  })
})
