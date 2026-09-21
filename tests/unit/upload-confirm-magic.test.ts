/**
 * Register SEC-8 — "Upload confirm lacks magic-number sniff": the confirm
 * half of the presigned-upload flow used to trust the object's HEAD metadata
 * (Content-Type = whatever the client's PUT carried) and mint the Attachment
 * row on that claim alone. This suite pins the fix end to end:
 *
 *   · sniffMagicBytes — the shared, dependency-free magic-number table
 *     (JPEG / PNG / WEBP / PDF / GIF / HEIC / HEIF), including the honest
 *     nulls: foreign brands, unrecognized bytes, EMPTY and TRUNCATED headers;
 *   · readPrefix — the new driver seam both shipped drivers implement:
 *     local-disk reads the first bytes off a REAL tmp-dir file (never the
 *     whole object), s3-compat issues a RANGED presigned GET (Range header
 *     pinned; 416 = empty object, 404 = missing, 200-full-body capped);
 *   · POST /api/upload/confirm — the magic gate itself, driven through the
 *     REAL route handler over BOTH drivers: a .png key must carry PNG magic,
 *     a .jpg key JPEG magic; mismatches (a text file wearing a .png key, a
 *     PNG under a .jpg key, WEBP/PDF/GIF/HEIC under a .png key), empty
 *     objects and truncated headers are all refused 400 with a SPECIFIC
 *     error and NO row; the recorded mimeType is the byte-VERIFIED type even
 *     when the HEAD header lies; a driver that cannot read bytes back
 *     answers the honest 409 (fail closed).
 *
 * The storage-presign-routes.test.ts suite keeps the route's replay /
 * idempotency pins (its fixtures now answer the read-back GET too); this
 * file owns the SEC-8 surface. db-mock + fetch-mock idioms: that file's.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------ session mock
//
// Route handlers authenticate through withGuard → the REAL getSessionFromReq
// → next-auth getToken — mock that seam (storage-presign-routes.test.ts
// idiom). One distinct principal per test keeps the confirm rate limiter
// (10/min per user) out of the picture without disabling it.

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
//
// The in-memory stub with migration 18's semantics (same shape as the
// presign-routes suite): a create whose objectKey is taken rejects with a
// P2002-shaped error. This file only mints FRESH rows — the idempotency
// branches live in the other suites — but the mock keeps the real contract
// so the route's error handling runs against engine-shaped behavior.

vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    attachments: [] as Array<Record<string, unknown>>,
    reset() {
      state.attachments.length = 0
      state.seq = 0
    },
  }
  const attachment = {
    async create({ data }: { data: Record<string, unknown> }) {
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
  // Issue #181 (SEC-15): standing user row at version 0.
  const user = {
    async findUnique({ where }: { where: { id: string } }) {
      return { id: where.id, tokenVersion: 0 }
    },
  }
  const db = { attachment, project, user, __state: state }
  return { db }
})

// z-ai SDK is imported by the upload route's module graph (documents → ai);
// never invoked on these paths — keep the import side-effect-free.
vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: vi.fn(async () => ({})) },
}))

import { db } from '@/backend/lib/db'
import { POST as confirmPost } from '@/app/api/upload/confirm/route'
import {
  createLocalDiskDriver,
  createS3CompatDriver,
  MAGIC_SNIFF_PREFIX_BYTES,
  setStorageDriverForTests,
  sniffMagicBytes,
} from '@/backend/lib/storage'
import type { StorageAdapter } from '@/backend/lib/storage'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    attachments: Array<Record<string, unknown>>
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

// ------------------------------------------------------------ fixtures

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

let photoDir: string
let LOCAL_DRIVER: StorageAdapter

let principalSeq = 0
let sessionEmail: string

beforeEach(async () => {
  state.reset()
  fetchMock.mockReset()
  principalSeq += 1
  sessionEmail = `foreman+magic${principalSeq}@test.dev`
  tokenState.token = {
    id: 'u-1',
    email: sessionEmail,
    name: 'Foreman',
    role: 'contractor',
    projectId: null,
  }
  photoDir = await mkdtemp(path.join(tmpdir(), 'mj-sec8-'))
  LOCAL_DRIVER = createLocalDiskDriver({ photosDir: photoDir })
})

afterEach(async () => {
  setStorageDriverForTests(null)
  await rm(photoDir, { recursive: true, force: true })
})

// ------------------------------------------------------------ helpers

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

/** Respond to the stubbed fetch by method (driver HEAD vs driver GET). */
function fetchByMethod(responses: Record<string, () => Response>) {
  fetchMock.mockImplementation(((_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const make = responses[method]
    if (!make) throw new Error(`unexpected fetch ${method}`)
    return make()
  }) as unknown as typeof fetch)
}

// Real-ish headers — enough trailing bytes that every signature is complete
// and truncation cases must come from the deliberately-short buffers below.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 0xab)])
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x11)])
const WEBP_BYTES = Buffer.from('RIFF\x1c\x00\x00\x00WEBPVP8 fakepayload', 'latin1')
const PDF_BYTES = Buffer.from('%PDF-1.7\nfake but honest body', 'latin1')
const GIF_BYTES = Buffer.from('GIF89a;p', 'latin1')
const TEXT_BYTES = Buffer.from('<html><body>definitely not an image</body></html>', 'latin1')

/** A minimal ISO-BMFF ftyp box with the given major brand (bytes 8..12). */
function ftypBox(brand: string): Buffer {
  const b = Buffer.alloc(32)
  b.writeUInt32BE(32, 0) // box size — arbitrary, not sniffed
  b.write('ftyp', 4, 'latin1')
  b.write(brand, 8, 'latin1')
  b.write('mif1heic', 12, 'latin1') // compatible brands — not sniffed either
  return b
}

// --------------------------------------------- sniffMagicBytes — the table

describe('sniffMagicBytes — the SEC-8 magic-number table', () => {
  it('JPEG: FF D8 FF → image/jpeg', () => {
    expect(sniffMagicBytes(JPEG_BYTES)).toBe('image/jpeg')
  })

  it('PNG: 89 50 4E 47 → image/png', () => {
    expect(sniffMagicBytes(PNG_BYTES)).toBe('image/png')
  })

  it('WEBP: RIFF…WEBP → image/webp', () => {
    expect(sniffMagicBytes(WEBP_BYTES)).toBe('image/webp')
  })

  it('PDF: %PDF- → application/pdf', () => {
    expect(sniffMagicBytes(PDF_BYTES)).toBe('application/pdf')
  })

  it('GIF: GIF87a and GIF89a → image/gif', () => {
    expect(sniffMagicBytes(Buffer.from('GIF87a rest', 'latin1'))).toBe('image/gif')
    expect(sniffMagicBytes(GIF_BYTES)).toBe('image/gif')
  })

  it('HEIC: ftyp with heic / heix major brand → image/heic', () => {
    expect(sniffMagicBytes(ftypBox('heic'))).toBe('image/heic')
    expect(sniffMagicBytes(ftypBox('heix'))).toBe('image/heic')
  })

  it('HEIF: ftyp with mif1 / msf1 major brand → image/heif', () => {
    expect(sniffMagicBytes(ftypBox('mif1'))).toBe('image/heif')
    expect(sniffMagicBytes(ftypBox('msf1'))).toBe('image/heif')
  })

  it('an ftyp box with a FOREIGN brand (isom — a video) is not ours to claim → null', () => {
    expect(sniffMagicBytes(ftypBox('isom'))).toBeNull()
    expect(sniffMagicBytes(ftypBox('mp42'))).toBeNull()
  })

  it('a RIFF container that is not WEBP (WAVE) → null', () => {
    expect(sniffMagicBytes(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'))).toBeNull()
  })

  it('unrecognized bytes (text, an executable-ish header) → null, never a guess', () => {
    expect(sniffMagicBytes(TEXT_BYTES)).toBeNull()
    expect(sniffMagicBytes(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).toBeNull() // MZ — a PE executable
  })

  it('EMPTY buffer → null (an empty object proves nothing)', () => {
    expect(sniffMagicBytes(Buffer.alloc(0))).toBeNull()
  })

  it('TRUNCATED headers → null (shorter than the signature proves nothing)', () => {
    expect(sniffMagicBytes(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull() // 3 of 4 PNG bytes
    expect(sniffMagicBytes(Buffer.from([0xff, 0xd8]))).toBeNull() // 2 of 3 JPEG bytes
    expect(sniffMagicBytes(Buffer.from('GIF8', 'latin1'))).toBeNull() // brand cut off
    expect(sniffMagicBytes(Buffer.from('%PD', 'latin1'))).toBeNull() // 3 of 5 PDF bytes
    expect(sniffMagicBytes(Buffer.from('RIFF\x00\x00\x00\x00WEB', 'latin1'))).toBeNull() // 11 of 12 WEBP bytes
    expect(sniffMagicBytes(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69]))).toBeNull() // 11 of 12 HEIC bytes
  })

  it('MAGIC_SNIFF_PREFIX_BYTES covers the deepest signature in the table (12-byte ftyp/WEBP)', () => {
    expect(MAGIC_SNIFF_PREFIX_BYTES).toBeGreaterThanOrEqual(12)
  })
})

// --------------------------------- readPrefix — the local-disk seam (real files)

describe('readPrefix (local-disk) — first bytes off a REAL tmp file', () => {
  it('returns exactly the first maxBytes of a larger file (never the whole object)', async () => {
    const bytes = Buffer.alloc(64, 7)
    await LOCAL_DRIVER.put('upp-1712345678-abcd12.png', bytes, 'image/png')
    const prefix = await LOCAL_DRIVER.readPrefix!('upp-1712345678-abcd12.png', 16)
    expect(prefix).toEqual(bytes.subarray(0, 16))
    expect(prefix!.length).toBe(16)
  })

  it('a file smaller than maxBytes returns whole (but statObject still knows the real size)', async () => {
    const small = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2, 1)])
    await LOCAL_DRIVER.put('upp-1712345678-abcd12.png', small, 'image/png')
    expect(await LOCAL_DRIVER.readPrefix!('upp-1712345678-abcd12.png', MAGIC_SNIFF_PREFIX_BYTES)).toEqual(small)
    expect((await LOCAL_DRIVER.statObject!('upp-1712345678-abcd12.png'))!.sizeBytes).toBe(small.length)
  })

  it('missing key → null (a plain answer, not a throw)', async () => {
    expect(await LOCAL_DRIVER.readPrefix!('upp-404-000000.png', 16)).toBeNull()
  })

  it('unsafe keys never touch the disk → null', async () => {
    expect(await LOCAL_DRIVER.readPrefix!('../../etc/passwd', 16)).toBeNull()
    expect(await LOCAL_DRIVER.readPrefix!('a/b.png', 16)).toBeNull()
  })

  it('an EMPTY file is the empty Buffer — a state distinct from missing', async () => {
    await writeFile(path.join(photoDir, 'upp-empty-000000.png'), Buffer.alloc(0))
    const prefix = await LOCAL_DRIVER.readPrefix!('upp-empty-000000.png', 16)
    expect(prefix).not.toBeNull()
    expect(prefix!.length).toBe(0)
  })

  it('docs/-prefixed keys read from the docs tree', async () => {
    const docsDir = await mkdtemp(path.join(tmpdir(), 'mj-sec8-docs-'))
    try {
      const docDriver = createLocalDiskDriver({ photosDir: photoDir, docsDir })
      const bytes = Buffer.from('%PDF-1.4 body')
      await docDriver.put('docs/doc-1712345678-abcd12.pdf', bytes, 'application/pdf')
      expect(await docDriver.readPrefix!('docs/doc-1712345678-abcd12.pdf', 16)).toEqual(bytes.subarray(0, 16))
    } finally {
      await rm(docsDir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------ readPrefix — the s3-compat ranged GET

describe('readPrefix (s3-compat) — the ranged presigned GET', () => {
  it('issues a GET with the exact Range header over the presigned URL (host-only signature)', async () => {
    fetchByMethod({
      GET: () => new Response(new Uint8Array(PNG_BYTES), { status: 206, headers: { 'content-type': 'image/png' } }),
    })
    const prefix = await S3_DRIVER.readPrefix!('upp-1712345678-abcd12.png', 16)
    expect(prefix).toEqual(PNG_BYTES.subarray(0, 16)) // capped at maxBytes even though the store sent more
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url.startsWith('https://s3.test.example/mjengo-test/upp-1712345678-abcd12.png?')).toBe(true)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-15')
  })

  it('a store that ignores Range (200 with the full body) is capped locally to maxBytes', async () => {
    fetchByMethod({
      GET: () => new Response(new Uint8Array(Buffer.alloc(64, 7)), { status: 200, headers: { 'content-type': 'image/png' } }),
    })
    const prefix = await S3_DRIVER.readPrefix!('upp-1712345678-abcd12.png', 16)
    expect(prefix!.length).toBe(16)
  })

  it('404 → null (no such object)', async () => {
    fetchByMethod({ GET: () => new Response(null, { status: 404 }) })
    expect(await S3_DRIVER.readPrefix!('upp-404-000000.png', 16)).toBeNull()
  })

  it('416 → the empty Buffer (a zero-byte object satisfies no range — distinct from missing)', async () => {
    fetchByMethod({ GET: () => new Response(null, { status: 416 }) })
    const prefix = await S3_DRIVER.readPrefix!('upp-empty-000000.png', 16)
    expect(prefix).not.toBeNull()
    expect(prefix!.length).toBe(0)
  })

  it('other failures throw the single-line, secret-free shape (no presigned URL in the message)', async () => {
    fetchByMethod({ GET: () => new Response(null, { status: 500 }) })
    await expect(S3_DRIVER.readPrefix!('upp-1712345678-abcd12.png', 16)).rejects.toThrow(
      /s3-compat read-prefix failed for key "upp-1712345678-abcd12\.png" \(HTTP 500 from s3\.test\.example\)/,
    )
  })
})

// ------------------------------- the confirm route's magic gate (local disk)

describe('POST /api/upload/confirm — the magic gate over REAL files (local-disk)', () => {
  async function confirmStored(key: string, bytes: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
    setStorageDriverForTests(LOCAL_DRIVER)
    await LOCAL_DRIVER.put(key, bytes, 'image/png')
    const res = await confirmHandler(req({ key, category: 'receipt' }))
    return { status: res.status, body: await bodyOf(res) }
  }

  it('a .png key with real PNG bytes → 200, and the row records the byte-verified type', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', PNG_BYTES)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.replayed).toBe(false)
    expect(state.attachments).toHaveLength(1)
    expect(state.attachments[0].mimeType).toBe('image/png')
    expect(state.attachments[0].sizeBytes).toBe(PNG_BYTES.length)
  })

  it('a .jpg key with real JPEG bytes → 200 (mimeType image/jpeg)', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.jpg', JPEG_BYTES)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(state.attachments[0].mimeType).toBe('image/jpeg')
  })

  it('SEC-8 core: a TEXT file wearing a .png key → 400 with the specific error, NO row', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', TEXT_BYTES)
    expect(status).toBe(400)
    expect(String(body.error)).toContain('File content does not match its type')
    expect(String(body.error)).toContain('expects image/png')
    expect(String(body.error)).toContain('no recognized file type')
    expect(String(body.error)).toContain('bytes are the truth')
    expect(state.attachments).toHaveLength(0)
  })

  it('type confusion across image types: PNG bytes under a .jpg key → 400 naming image/png', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.jpg', PNG_BYTES)
    expect(status).toBe(400)
    expect(String(body.error)).toContain('expects image/jpeg')
    expect(String(body.error)).toContain('look like image/png')
    expect(state.attachments).toHaveLength(0)
  })

  it('JPEG bytes under a .png key → 400 naming image/jpeg', async () => {
    const { status } = await confirmStored('upp-1712345678-abcd12.png', JPEG_BYTES)
    expect(status).toBe(400)
    expect(state.attachments).toHaveLength(0)
  })

  it('WEBP under a .png key → 400 naming image/webp (the advisory Content-Type cannot save it)', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', WEBP_BYTES)
    expect(status).toBe(400)
    expect(String(body.error)).toContain('look like image/webp')
    expect(state.attachments).toHaveLength(0)
  })

  it('PDF under a .png key → 400 naming application/pdf', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', PDF_BYTES)
    expect(status).toBe(400)
    expect(String(body.error)).toContain('look like application/pdf')
    expect(state.attachments).toHaveLength(0)
  })

  it('GIF under a .png key → 400 naming image/gif', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', GIF_BYTES)
    expect(status).toBe(400)
    expect(String(body.error)).toContain('look like image/gif')
    expect(state.attachments).toHaveLength(0)
  })

  it('HEIC under a .png key → 400 naming image/heic', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', ftypBox('heic'))
    expect(status).toBe(400)
    expect(String(body.error)).toContain('look like image/heic')
    expect(state.attachments).toHaveLength(0)
  })

  it('EMPTY object under a .png key → 400 (distinct from the missing-object 404), NO row', async () => {
    const { status, body } = await confirmStored('upp-1712345678-abcd12.png', Buffer.alloc(0))
    expect(status).toBe(400)
    expect(String(body.error)).toContain('empty (0 bytes)')
    expect(String(body.error)).toContain('expected image/png')
    expect(state.attachments).toHaveLength(0)
  })

  it('TRUNCATED header (3 of the 4 PNG magic bytes) → 400, NO row', async () => {
    const { status } = await confirmStored('upp-1712345678-abcd12.png', Buffer.from([0x89, 0x50, 0x4e]))
    expect(status).toBe(400)
    expect(state.attachments).toHaveLength(0)
  })
})

// --------------------------------------- the confirm route's magic gate (s3)

describe('POST /api/upload/confirm — the magic gate over the ranged GET (s3-compat)', () => {
  function s3Confirm(key: string, getResponse: () => Response): Promise<{ status: number; body: Record<string, unknown> }> {
    setStorageDriverForTests(S3_DRIVER)
    fetchByMethod({
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': String(PNG_BYTES.length), 'content-type': 'image/png' } }),
      GET: getResponse,
    })
    return confirmHandler(req({ key, category: 'receipt' })).then(async (res) => ({ status: res.status, body: await bodyOf(res) }))
  }

  it('HEAD ok + ranged GET carrying PNG bytes → 200; the GET is the sniff source (Range pinned)', async () => {
    const { status, body } = await s3Confirm('upp-1712345678-abcd12.png', () =>
      new Response(new Uint8Array(PNG_BYTES), { status: 206, headers: { 'content-type': 'image/png' } }),
    )
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(state.attachments).toHaveLength(1)
    const getCalls = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit).method === 'GET')
    expect(getCalls).toHaveLength(1)
    expect((getCalls[0][1] as RequestInit).method).toBe('GET')
    expect(((getCalls[0][1] as RequestInit).headers as Record<string, string>).Range).toBe('bytes=0-15')
  })

  it('HEAD ok + GET carrying TEXT bytes → 400, NO row (the metadata lied; the bytes refused)', async () => {
    const { status, body } = await s3Confirm('upp-1712345678-abcd12.png', () =>
      new Response(new Uint8Array(TEXT_BYTES), { status: 206, headers: { 'content-type': 'image/png' } }),
    )
    expect(status).toBe(400)
    expect(String(body.error)).toContain('does not match its type')
    expect(state.attachments).toHaveLength(0)
  })

  it('HEAD ok + GET answering an EMPTY body → 400 empty-object error, NO row', async () => {
    const { status, body } = await s3Confirm('upp-1712345678-abcd12.png', () =>
      new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    expect(status).toBe(400)
    expect(String(body.error)).toContain('empty (0 bytes)')
    expect(state.attachments).toHaveLength(0)
  })

  it('HEAD ok + GET 404 (object vanished between the two calls) → honest 404, NO row', async () => {
    const { status, body } = await s3Confirm('upp-1712345678-abcd12.png', () => new Response(null, { status: 404 }))
    expect(status).toBe(404)
    expect(String(body.error)).toContain('could not be read back for content verification')
    expect(state.attachments).toHaveLength(0)
  })

  it('the row records the BYTE-VERIFIED type even when the HEAD Content-Type lies', async () => {
    setStorageDriverForTests(S3_DRIVER)
    fetchByMethod({
      HEAD: () => new Response(null, { status: 200, headers: { 'content-length': String(PNG_BYTES.length), 'content-type': 'image/jpeg' } }),
      GET: () => new Response(new Uint8Array(PNG_BYTES), { status: 206, headers: { 'content-type': 'image/jpeg' } }),
    })
    const res = await confirmHandler(req({ key: 'upp-1712345678-abcd12.png', category: 'receipt' }))
    expect(res.status).toBe(200)
    expect(state.attachments).toHaveLength(1)
    expect(state.attachments[0].mimeType).toBe('image/png') // the key's contract, proven on the bytes
  })

  it('a driver that cannot read bytes back answers the honest 409 (fail closed, no row)', async () => {
    const noReadPrefix: StorageAdapter = {
      id: 'local-disk',
      canPresign: false,
      put: async () => {},
      publicUrl: (key: string) => `/photos/${key}`,
      statObject: async () => ({ exists: true, sizeBytes: PNG_BYTES.length, contentType: 'image/png' }),
      // readPrefix deliberately absent — the capability gate's subject
    }
    setStorageDriverForTests(noReadPrefix)
    const res = await confirmHandler(req({ key: 'upp-1712345678-abcd12.png', category: 'receipt' }))
    expect(res.status).toBe(409)
    expect(String((await bodyOf(res)).error)).toContain('cannot read object bytes back for content verification')
    expect(state.attachments).toHaveLength(0)
  })
})
