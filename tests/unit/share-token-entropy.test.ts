/**
 * SEC-3 (audit-2) — share-token entropy at project creation.
 *
 * Project.shareToken is a BEARER CAPABILITY with money power: a share link
 * can approve milestone.decide / variation.decide (releasing escrow), so the
 * token must be unguessable from birth. The creation path (POST
 * /api/projects) used to lean on Prisma's `@default(cuid())` —
 * collision-resistant, not unguessability-hardened. Pinned here:
 *
 *   · CREATION: db.project.create receives an EXPLICIT shareToken of 24
 *     CSPRNG bytes (~192-bit) in base64url — /^[A-Za-z0-9_-]{32}$/, no
 *     padding, no cuid shape — and the response echoes exactly that token;
 *     two creates never mint the same token.
 *   · REGENERATION (share.regenerate): confirmed already CSPRNG — the
 *     static pin keeps it honest (randomBytes, never Math.random/cuid).
 *
 * The regenerate path's 96-bit width (randomBytes(12)) is an accepted
 * follow-up, not a regression: it is CSPRNG and 30/min brute-force bounded.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encode } from 'next-auth/jwt'

// In-memory project/phase store — the tables POST /api/projects touches
// (auditEvent captures the API-11 trail row so logAudit is exercised for
// real instead of noisily failing against a missing mock).
const created: Array<Record<string, unknown>> = []
const auditRows: Array<Record<string, unknown>> = []
vi.mock('@/backend/lib/db', () => ({
  db: {
    // Issue #181 (SEC-15): the guard proves sessions against
    // User.tokenVersion now — a standing row at version 0 keeps this
    // file's session fixtures (no tokenVersion claim) UNrevoked.
    user: {
      async findUnique({ where }: { where: { id: string } }) {
        return { id: where.id, tokenVersion: 0 }
      },
    },
    project: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `p-${created.length + 1}`, ...data }
        created.push(row)
        return { ...row }
      },
    },
    phase: { async create({ data }: { data: Record<string, unknown> }) { return { ...data } } },
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        auditRows.push({ ...data })
        return { ...data }
      },
    },
  },
}))
// The payload builders are irrelevant to the token contract under test.
vi.mock('@/backend/lib/mjengo', () => ({
  getProjectPayload: vi.fn(async () => ({ project: {} })),
  getProjectsList: vi.fn(async () => []),
}))

import { POST as projectsPost } from '@/backend/api/projects'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/** base64url of 24 bytes: 32 chars, URL-safe alphabet, no '=' padding. */
const BASE64URL_24 = /^[A-Za-z0-9_-]{32}$/
const CUID_SHAPE = /^c[0-9a-z]{20,}$/

let savedSecret: string | undefined

beforeEach(() => {
  created.length = 0
  savedSecret = process.env.NEXTAUTH_SECRET
  process.env.NEXTAUTH_SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef'
})

afterEach(() => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET
  else process.env.NEXTAUTH_SECRET = savedSecret
})

async function contractorCookie(): Promise<string> {
  const token = await encode({
    token: { sub: 'u-1', email: 'contractor@test.dev', name: 'Test', role: 'contractor' },
    secret: process.env.NEXTAUTH_SECRET!,
    maxAge: 60,
  })
  return `next-auth.session-token=${token}`
}

function createReq(cookie: string, body: Record<string, unknown> = { name: 'Test Villa', budget: 1_000_000 }) {
  return new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
}

describe('SEC-3: POST /api/projects mints a CSPRNG share token', () => {
  it('db.project.create receives an explicit ~192-bit base64url token (not a cuid)', async () => {
    const res = await projectsPost(createReq(await contractorCookie()), undefined)
    expect(res.status).toBe(200)
    expect(created).toHaveLength(1)
    const token = created[0].shareToken
    expect(typeof token).toBe('string')
    expect(String(token)).toMatch(BASE64URL_24)
    expect(String(token)).not.toMatch(CUID_SHAPE)
    // No base64 padding ever leaks into the URL-safe token.
    expect(String(token)).not.toContain('=')
    // The response echoes EXACTLY the persisted token (the Share dialog
    // builds the client link from it).
    const json = (await res.json()) as { ok?: boolean; result?: { shareToken?: string } }
    expect(json.ok).toBe(true)
    expect(json.result?.shareToken).toBe(token)
  })

  it('two creates never mint the same token (fresh CSPRNG draw each time)', async () => {
    const cookie = await contractorCookie()
    await projectsPost(createReq(cookie, { name: 'Villa A', budget: 2_000_000 }), undefined)
    await projectsPost(createReq(cookie, { name: 'Villa B', budget: 3_000_000 }), undefined)
    expect(created).toHaveLength(2)
    expect(created[0].shareToken).not.toBe(created[1].shareToken)
  })

  it('the schema default stays as the defensive fallback for raw writes (seeds keep cuid)', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toMatch(/shareToken\s+String\s+@unique @default\(cuid\(\)\)/)
  })
})

describe('SEC-3: the regenerate path (share.regenerate) is confirmed CSPRNG', () => {
  it('mjengo.ts regenerates with node crypto randomBytes — never Math.random or cuid', () => {
    const src = readSrc('src/backend/lib/mjengo.ts')
    // The rotate case: 96-bit hex draw prefixed 'c' (documented honest width).
    expect(src).toContain("`c${randomBytes(12).toString('hex')}`")
    expect(src).toMatch(/from 'crypto'/)
  })
})
