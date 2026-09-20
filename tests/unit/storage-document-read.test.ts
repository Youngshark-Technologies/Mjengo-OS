/**
 * Issue #37 — the driver READ seam + document mediation, end to end:
 *  · POST /api/upload { mode:'document' } writes through the storage driver
 *    (saveDocument's driver param): local-disk keeps the exact historical
 *    public/docs layout (`docs/<name>` key → <docsDir>/<name>, row storageKey
 *    /docs/<name> — byte-identical, the URL from the driver's publicUrl);
 *    an S3-backed deployment PUTs the document into the bucket under docs/
 *    and records the driver's publicUrl;
 *  · extractDocument resolves the stored object through the ACTIVE driver
 *    (keyFor → read) instead of assuming the local FS: local passthrough,
 *    S3 GET via the same presign machinery — including the expiry mitigation
 *    (a row whose storageKey is an EXPIRED presigned GET still resolves:
 *    the query is dropped at key resolution and read mints a fresh URL);
 *  · the honest errors survive the transport change byte-for-byte: missing
 *    object, foreign storageKey (another backend's row), driver read failure,
 *    PDF-without-hint, sniff/mime mismatches.
 *
 * Mock idioms: storage-presign-routes.test.ts (getToken session stub,
 * in-memory db with __state, z-ai SDK kept side-effect-free, distinct
 * principal per test so the REAL rate limiter stays under its 10/min bucket).
 * The lib/ai seam is mocked with the real extractJson preserved
 * (importOriginal spread) so only the model calls are stubbed.
 *
 * NOT pinned here: saveDocument's driver-less historical write (process.cwd()
 * /public/docs would litter the repo tree — the mediated path is pinned
 * byte-identical against the local-disk driver instead, which is the same
 * layout that branch produces).
 */
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
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
    audits: [] as Array<Record<string, unknown>>,
    reset() {
      state.attachments.length = 0
      state.projects.length = 0
      state.audits.length = 0
      state.seq = 0
    },
  }
  const attachment = {
    async create({ data }: { data: Record<string, unknown> }) {
      const row = { id: `att_${++state.seq}`, createdAt: new Date('2026-03-09T12:00:00Z'), version: 1, ...data }
      state.attachments.push(row)
      return { ...row }
    },
    async findUnique({ where }: { where: { id: string } }) {
      const row = state.attachments.find((r) => r.id === where.id)
      return row ? { ...row } : null
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.attachments.find((r) => r.id === where.id)
      if (!row) throw new Error(`attachment.update: no row ${where.id}`)
      Object.assign(row, data)
      return { ...row }
    },
  }
  const project = {
    async findUnique({ where }: { where: { id: string } }) {
      return state.projects.includes(where.id) ? { id: where.id } : null
    },
  }
  const auditEvent = {
    async create({ data }: { data: Record<string, unknown> }) {
      state.audits.push(data)
      return { ...data }
    },
  }
  // Issue #181 (SEC-15): standing user row at version 0 — see push-routes.
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      return { id: where.id, tokenVersion: 0 }
    },
  }
  const db = { attachment, project, auditEvent, user, __state: state }
  return { db }
})

// z-ai SDK is imported by the module graph (documents → lib/ai); never invoked
// here — keep the import side-effect-free.
vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: vi.fn(async () => ({})) },
}))

// The AI seam: real extractJson (the parser under test), stubbed model calls.
const visionMessageMock = vi.fn()
vi.mock('@/backend/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/ai')>()
  return {
    ...actual,
    visionMessage: (...args: unknown[]) => visionMessageMock(...(args as [])),
    llm: vi.fn(),
  }
})

import { db } from '@/backend/lib/db'
import { POST as uploadPost } from '@/app/api/upload/route'
import { extractDocument } from '@/backend/modules/documents/service'
import { createLocalDiskDriver, createS3CompatDriver, setStorageDriverForTests } from '@/backend/lib/storage'
import type { StorageAdapter } from '@/backend/lib/storage'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    attachments: Array<Record<string, unknown>>
    projects: string[]
    audits: Array<Record<string, unknown>>
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

let photosDir: string
let docsDir: string
type PutSignature = (key: string, bytes: Buffer, contentType: string) => Promise<void>
let putSpy: ReturnType<typeof vi.fn<PutSignature>>
let LOCAL_DRIVER: StorageAdapter

// One distinct principal per test — the REAL rate limiter stays in play (its
// 429 path is pinned elsewhere), buckets stay under 10/min.
let principalSeq = 0
let sessionEmail: string

beforeEach(async () => {
  state.reset()
  visionMessageMock.mockReset()
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
  const tree = await mkdtemp(path.join(tmpdir(), 'mj-docread-'))
  photosDir = path.join(tree, 'photos')
  docsDir = path.join(tree, 'docs')
  const base = createLocalDiskDriver({ photosDir, docsDir })
  putSpy = vi.fn<PutSignature>(base.put.bind(base))
  LOCAL_DRIVER = { ...base, put: putSpy }
})

afterEach(async () => {
  setStorageDriverForTests(null)
  vi.unstubAllGlobals()
  await rm(path.dirname(docsDir), { recursive: true, force: true })
})

// ------------------------------------------------------------ helpers

function req(body: unknown, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/upload', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const uploadHandler = (r: NextRequest) => uploadPost(r, undefined)

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 4, 4])
const DOC_KEY_RE = /^docs\/doc-\d+-[a-f0-9]{6}\.(png|jpg|pdf)$/

const VLM_JSON = JSON.stringify({
  docType: 'invoice',
  supplier: 'Kamau Hardware Ltd',
  total: 4500,
  currency: 'KES',
  lines: [{ description: '50kg cement', qty: 10, unitPrice: 450, total: 4500 }],
  notes: null,
  confidence: 0.9,
})

/** Seed an Attachment row exactly like the ones the flows under test record. */
function seedRow(row: Record<string, unknown>): void {
  state.attachments.push({ createdAt: new Date('2026-03-09T12:00:00Z'), version: 1, ...row })
}

// --------------------------------- document upload mediated through the driver

describe('POST /api/upload mode=document — driver-mediated write (issue #37)', () => {
  it('local-disk: put() receives the docs/ key + exact bytes; file lands in the exact public/docs layout', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    const res = await uploadHandler(
      req({ mode: 'document', fileName: 'cement-quote.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'quote' }),
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)

    expect(putSpy).toHaveBeenCalledTimes(1)
    const [key, bytesArg, mimeArg] = putSpy.mock.calls[0] as [string, Buffer, string]
    expect(key).toMatch(DOC_KEY_RE)
    expect(Buffer.from(bytesArg)).toEqual(PNG_BYTES)
    expect(mimeArg).toBe('image/png')

    // byte-identical public/docs layout + the driver's publicUrl as the URL:
    const name = key.slice('docs/'.length)
    expect(await readFile(path.join(docsDir, name))).toEqual(PNG_BYTES)
    expect((body.attachment as Record<string, unknown>).storageKey).toBe(`/docs/${name}`)
    expect((body.attachment as Record<string, unknown>).storageKey).toBe(LOCAL_DRIVER.publicUrl(key))
  })

  it('the Attachment row keeps the §60 provenance contract (transport-only change)', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    await uploadHandler(
      req({ mode: 'document', fileName: 'cement-quote.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'quote', title: 'March cement' }),
    )
    const row = state.attachments[0]
    expect(row.entityType).toBe('document')
    expect(row.entityId).toBe('unattached')
    expect(row.fileName).toBe('cement-quote.png')
    expect(row.storageKey).toMatch(/^\/docs\/doc-\d+-[a-f0-9]{6}\.png$/)
    expect(row.kind).toBe('quote_doc')
    expect(row.uploadedBy).toBe(sessionEmail)
    expect(row.projectId).toBeNull()
    expect(row.category).toBe('quote')
    expect(row.mimeType).toBe('image/png')
    expect(row.sizeBytes).toBe(PNG_BYTES.length)
    expect(row.title).toBe('March cement')
    expect(row.reviewStatus).toBe('pending')
  })

  it('project-linked upload: row carries projectId and the audit event still lands', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    state.projects.push('p_1')
    const res = await uploadHandler(
      req({ mode: 'document', fileName: 'x.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'other', projectId: 'p_1' }),
    )
    expect(res.status).toBe(200)
    expect(state.attachments[0].projectId).toBe('p_1')
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0].projectId).toBe('p_1')
    expect(state.audits[0].kind).toBe('document')
  })

  it('unknown projectId still answers 404 before any write', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    const res = await uploadHandler(
      req({ mode: 'document', fileName: 'x.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'other', projectId: 'p_nope' }),
    )
    expect(res.status).toBe(404)
    expect(putSpy).not.toHaveBeenCalled()
    expect(state.attachments).toHaveLength(0)
  })

  it('client-role sessions still cannot use document mode (owner-app surface, 403)', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    tokenState.token = { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p_1' }
    const res = await uploadHandler(
      req({ mode: 'document', fileName: 'x.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'other' }),
    )
    expect(res.status).toBe(403)
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('s3-backed deployment: the document lands in the bucket (PUT) and the row records the driver publicUrl', async () => {
    setStorageDriverForTests(S3_DRIVER)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const res = await uploadHandler(
      req({ mode: 'document', fileName: 'quote.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'invoice' }),
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const storageKey = String((body.attachment as Record<string, unknown>).storageKey)
    expect(storageKey).toMatch(/^https:\/\/cdn\.test\.example\/mjengo-test\/docs\/doc-\d+-[a-f0-9]{6}\.png$/)
    expect(state.attachments[0].storageKey).toBe(storageKey)

    // the bucket write: one presigned PUT carrying the exact bytes + mime
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(url.startsWith('https://s3.test.example/mjengo-test/docs/')).toBe(true)
    expect(url).toContain('X-Amz-Expires=60')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    expect(Buffer.from(init.body as Uint8Array)).toEqual(PNG_BYTES)
  })
})

// ------------------------------------------ extraction reads through the seam

describe('extractDocument — the driver read seam (issue #37)', () => {
  it('local-disk: reads the exact stored bytes and feeds them to the VLM (base64 round-trip)', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    const key = 'docs/doc-1712345678-abcd12.png'
    await LOCAL_DRIVER.put(key, PNG_BYTES, 'image/png')
    seedRow({ id: 'att_1', entityType: 'document', entityId: 'unattached', fileName: 'quote.png', storageKey: '/docs/doc-1712345678-abcd12.png', mimeType: 'image/png', reviewStatus: 'pending' })

    visionMessageMock.mockResolvedValueOnce(VLM_JSON)
    const result = await extractDocument('att_1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model).toBe('glm-5v-turbo')
    expect(result.confidence).toBe(0.9)
    expect(result.extraction.docType).toBe('invoice')
    expect(result.extraction.total).toBe(4500)
    expect(result.extraction.lines).toHaveLength(1)

    // the seam: visionMessage got the EXACT stored bytes, base64-encoded
    expect(visionMessageMock).toHaveBeenCalledTimes(1)
    const b64 = String(visionMessageMock.mock.calls[0][1])
    expect(Buffer.from(b64, 'base64')).toEqual(PNG_BYTES)
    expect(visionMessageMock.mock.calls[0][2]).toBe('image/png')

    // the row: draft-only persistence + review reset
    const row = state.attachments[0]
    expect(row.ocrText).toBe(VLM_JSON)
    expect(JSON.parse(String(row.extractedJson))).toMatchObject({ docType: 'invoice', total: 4500 })
    expect(row.extractionConfidence).toBe(0.9)
    expect(row.extractionModel).toBe('glm-5v-turbo')
    expect(row.reviewStatus).toBe('pending')
    expect(row.reviewedBy).toBeNull()
  })

  it('upload → extract round trip through the driver (the issue #37 loop closed)', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    const uploaded = await bodyOf(
      await uploadHandler(
        req({ mode: 'document', fileName: 'invoice.png', mimeType: 'image/png', contentBase64: PNG_BYTES.toString('base64'), category: 'invoice' }),
      ),
    )
    const id = String((uploaded.attachment as Record<string, unknown>).id)
    visionMessageMock.mockResolvedValueOnce(VLM_JSON)
    const result = await extractDocument(id)
    expect(result.ok).toBe(true)
    // the bytes the model saw are exactly the bytes the driver stored
    expect(Buffer.from(String(visionMessageMock.mock.calls[0][1]), 'base64')).toEqual(PNG_BYTES)
  })

  it('s3 no-base: a row whose storageKey is an EXPIRED presigned GET still extracts (fresh URL minted)', async () => {
    setStorageDriverForTests(S3_DRIVER_NO_BASE)
    const key = 'docs/doc-1712345678-abcd12.png'
    const recorded = S3_DRIVER_NO_BASE.publicUrl(key) // the 7-day presigned GET the row would carry
    expect(recorded).toContain('X-Amz-Signature=')
    seedRow({ id: 'att_1', entityType: 'document', entityId: 'unattached', fileName: 'quote.png', storageKey: recorded, mimeType: 'image/png', reviewStatus: 'pending' })

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    visionMessageMock.mockResolvedValueOnce(VLM_JSON)
    const result = await extractDocument('att_1')
    expect(result.ok).toBe(true)

    // the read was a FRESH short-lived presigned GET, not the recorded one
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(url.startsWith('https://s3.test.example/mjengo-test/docs/doc-1712345678-abcd12.png?')).toBe(true)
    expect(url).toContain('X-Amz-Expires=60')
    expect(url).not.toBe(recorded)
    expect(Buffer.from(String(visionMessageMock.mock.calls[0][1]), 'base64')).toEqual(PNG_BYTES)
  })

  it('s3 with public base: reads via a fresh GET even though the recorded key is stable', async () => {
    setStorageDriverForTests(S3_DRIVER)
    const key = 'docs/doc-1712345678-abcd12.png'
    seedRow({ id: 'att_1', entityType: 'document', entityId: 'unattached', fileName: 'quote.png', storageKey: S3_DRIVER.publicUrl(key), mimeType: 'image/png', reviewStatus: 'pending' })
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    visionMessageMock.mockResolvedValueOnce(VLM_JSON)
    const result = await extractDocument('att_1')
    expect(result.ok).toBe(true)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toContain('/mjengo-test/docs/doc-1712345678-abcd12.png?')
  })

  it('missing object → the honest error, byte-identical', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    seedRow({ id: 'att_1', storageKey: '/docs/doc-2-nothing-here.png', mimeType: 'image/png', reviewStatus: 'pending' })
    expect(await extractDocument('att_1')).toEqual({
      ok: false,
      error: 'Stored file is missing or unreadable — re-upload the document',
    })
  })

  it('foreign storageKey (a row the active driver cannot address) → the same honest error', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    seedRow({ id: 'att_1', storageKey: 'https://elsewhere.example/mjengo-test/docs/x.png', mimeType: 'image/png', reviewStatus: 'pending' })
    const result = await extractDocument('att_1')
    expect(result).toEqual({ ok: false, error: 'Stored file is missing or unreadable — re-upload the document' })
  })

  it('s3 driver read failure → the same honest error (unreadable is unreadable)', async () => {
    setStorageDriverForTests(S3_DRIVER_NO_BASE)
    const key = 'docs/doc-1712345678-abcd12.png'
    seedRow({ id: 'att_1', storageKey: S3_DRIVER_NO_BASE.publicUrl(key), mimeType: 'image/png', reviewStatus: 'pending' })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const result = await extractDocument('att_1')
    expect(result).toEqual({ ok: false, error: 'Stored file is missing or unreadable — re-upload the document' })
  })

  it('PDF without ocrTextHint → server-side text-layer extraction attempt, honest parse failure on a malformed PDF', async () => {
    // Since feat/pdf-text-extraction, extraction is AVAILABLE server-side
    // (pdf-text.ts) — the old "not available in this environment" branch is
    // gone. A pretend/malformed PDF now fails parsing honestly; a real
    // text-layer PDF extracts (pinned in extract-document-pdf.test.ts).
    setStorageDriverForTests(LOCAL_DRIVER)
    const pdf = Buffer.from('%PDF-1.4 pretend document')
    await LOCAL_DRIVER.put('docs/doc-1712345678-abcd12.pdf', pdf, 'application/pdf')
    seedRow({ id: 'att_1', storageKey: '/docs/doc-1712345678-abcd12.pdf', mimeType: 'application/pdf', reviewStatus: 'pending' })
    expect(await extractDocument('att_1')).toEqual({
      ok: false,
      error: 'PDF text extraction failed (no readable objects (malformed PDF)) — upload an image of the document, or provide ocrTextHint',
    })
    expect(visionMessageMock).not.toHaveBeenCalled()
  })

  it('stored bytes sniffed as a non-document → the honest re-upload error', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    await LOCAL_DRIVER.put('docs/doc-1712345678-abcd12.png', Buffer.from('plain text, not a doc'), 'image/png')
    seedRow({ id: 'att_1', storageKey: '/docs/doc-1712345678-abcd12.png', mimeType: 'image/png', reviewStatus: 'pending' })
    expect(await extractDocument('att_1')).toEqual({
      ok: false,
      error: 'Stored file is not a recognizable document (PDF/PNG/JPEG) — re-upload',
    })
  })

  it('stored bytes disagree with the recorded mime → the honest mismatch error', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    await LOCAL_DRIVER.put('docs/doc-1712345678-abcd12.jpg', PNG_BYTES, 'image/jpeg')
    seedRow({ id: 'att_1', storageKey: '/docs/doc-1712345678-abcd12.jpg', mimeType: 'image/jpeg', reviewStatus: 'pending' })
    expect(await extractDocument('att_1')).toEqual({
      ok: false,
      error: 'Stored file bytes do not match its recorded type (image/jpeg) — re-upload',
    })
  })

  it('unknown attachment → Attachment not found', async () => {
    setStorageDriverForTests(LOCAL_DRIVER)
    expect(await extractDocument('att_nope')).toEqual({ ok: false, error: 'Attachment not found' })
  })
})
