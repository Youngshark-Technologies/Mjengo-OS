/**
 * Issue #181 / audit SEC-15 — server-side session revocation, pinned
 * end-to-end on the REAL stack: real SQLite (the #184 harness — full
 * migration history applied by the real `prisma migrate deploy`, so
 * migration 20_token_version is exercised), real User rows, REAL JWE
 * session tokens minted with next-auth/jwt `encode`, decoded by the REAL
 * guard (getSessionFromReq → sessionTokenIsRevoked → db.user).
 *
 * This is the suite the fixture-mocked files point at: the realdb search/
 * upload suites mock the revocation seam because their tokens are
 * synthetic fixtures; the semantic contract — a bumped tokenVersion kills
 * the session, an unbumped one does not, pre-#181 tokens read as version
 * 0, deleted users lose everything, the DB-error path fails CLOSED — is
 * pinned HERE, against the real engine and the real guard.
 *
 * Auth-side wiring (auth.ts) is pinned in the last describe: the jwt
 * callback embeds the CURRENT User.tokenVersion at sign-in, and the
 * events.signOut hook bumps it (revoking every device).
 */
import { NextRequest } from 'next/server'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// The REAL engine for every db read/write in this file (incl. the guard's
// revocation lookup — that is the point).
vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { encode } from 'next-auth/jwt'
import { buildAuthOptions } from '@/backend/lib/auth'
import { getSessionFromReq } from '@/backend/lib/guard'
import { bumpUserTokenVersion, sessionTokenIsRevoked } from '@/backend/lib/session-revocation'
import { disposeRealDb, getRealTestDb } from '../helpers/db'

const { prisma } = getRealTestDb()
afterAll(disposeRealDb)

const SECRET = 'revocation-test-secret-0123456789abcdef0123456789' // ≥32 chars, test-only

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.NODE_ENV_ENVIRONMENT // never set — paranoia
})

/** A user row on the real engine (unique email per call). */
let userSeq = 0
async function mkUser(tokenVersion = 0): Promise<string> {
  userSeq += 1
  const u = await prisma.user.create({
    data: {
      email: `rev-${userSeq}@demo.test`,
      passwordHash: 'x',
      name: 'Rev Test',
      role: 'contractor',
      tokenVersion,
    },
  })
  return u.id
}

/** A REAL JWE session cookie for the user, carrying tokenVersion (or not). */
async function cookieFor(
  userId: string,
  tokenVersion?: number,
): Promise<string> {
  const token: Record<string, unknown> = {
    id: userId,
    email: `rev@demo.test`,
    name: 'Rev Test',
    role: 'contractor',
  }
  if (tokenVersion !== undefined) token.tokenVersion = tokenVersion
  return encode({ token, secret: SECRET, maxAge: 60 * 30 })
}

/** A request carrying that cookie against the REAL guard. */
async function sessionFor(cookie: string) {
  vi.stubEnv('NEXTAUTH_SECRET', SECRET)
  const req = new NextRequest('http://localhost:3000/api/projects', {
    headers: { cookie: `next-auth.session-token=${cookie}` },
  })
  return getSessionFromReq(req)
}

// --------------------------------------------- the decision matrix (real db)

describe('sessionTokenIsRevoked — the decision matrix on the real engine', () => {
  it('a token matching the row version is NOT revoked (the no-regression case)', async () => {
    const id = await mkUser(0)
    expect(await sessionTokenIsRevoked({ id, tokenVersion: 0 })).toBe(false)
    const id2 = await mkUser(3)
    expect(await sessionTokenIsRevoked({ id: id2, tokenVersion: 3 })).toBe(false)
  })

  it('a token BEHIND the row version IS revoked (the revocation)', async () => {
    const id = await mkUser(2)
    expect(await sessionTokenIsRevoked({ id, tokenVersion: 1 })).toBe(true)
  })

  it('a token AHEAD of the row is rejected too (forged/downgraded claim)', async () => {
    const id = await mkUser(1)
    expect(await sessionTokenIsRevoked({ id, tokenVersion: 5 })).toBe(true)
  })

  it('a pre-#181 token (NO claim) reads as version 0 — the deploy invalidates nobody', async () => {
    const id = await mkUser(0)
    expect(await sessionTokenIsRevoked({ id })).toBe(false)
    // ...and the first bump revokes exactly those legacy tokens:
    await bumpUserTokenVersion(id)
    expect(await sessionTokenIsRevoked({ id })).toBe(true)
  })

  it('a token naming no user, or a DELETED user, fails closed (revoked)', async () => {
    expect(await sessionTokenIsRevoked({})).toBe(true)
    expect(await sessionTokenIsRevoked({ tokenVersion: 0 })).toBe(true)
    const id = await mkUser(0)
    await prisma.user.delete({ where: { id } })
    expect(await sessionTokenIsRevoked({ id, tokenVersion: 0 })).toBe(true)
  })

  it('a DB error fails CLOSED (revoked), not open', async () => {
    const id = await mkUser(0)
    const orig = prisma.user.findUnique
    vi.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('db down'))
    try {
      expect(await sessionTokenIsRevoked({ id, tokenVersion: 0 })).toBe(true)
    } finally {
      vi.spyOn(prisma.user, 'findUnique').mockRestore(orig as never)
    }
    // Restored: the same token now verifies again.
    expect(await sessionTokenIsRevoked({ id, tokenVersion: 0 })).toBe(false)
  })
})

// ------------------------------------------------- bumpUserTokenVersion

describe('bumpUserTokenVersion — the incident-response primitive', () => {
  it('increments the row and reports success', async () => {
    const id = await mkUser(0)
    expect(await bumpUserTokenVersion(id)).toBe(true)
    const row = await prisma.user.findUnique({ where: { id }, select: { tokenVersion: true } })
    expect(row?.tokenVersion).toBe(1)
    expect(await bumpUserTokenVersion(id)).toBe(true)
    expect((await prisma.user.findUnique({ where: { id } }))?.tokenVersion).toBe(2)
  })

  it('NEVER throws — a failed bump is reported, not raised (the signOut path must survive)', async () => {
    const orig = prisma.user.update
    vi.spyOn(prisma.user, 'update').mockRejectedValueOnce(new Error('db down'))
    try {
      await expect(bumpUserTokenVersion('no-such-user-id')).resolves.toBe(false)
    } finally {
      vi.spyOn(prisma.user, 'update').mockRestore(orig as never)
    }
  })
})

// ------------------------------- the REAL guard on REAL JWE tokens (e2e)

describe('the guard end-to-end: real JWE, real rows, real decode', () => {
  it('a minted token verifies through getSessionFromReq (the regression case)', async () => {
    const id = await mkUser(0)
    const session = await sessionFor(await cookieFor(id, 0))
    expect(session?.user.id).toBe(id)
    expect(session?.user.role).toBe('contractor')
  })

  it('THE REVOCATION: after the bump, the SAME cookie is a null session (401 posture)', async () => {
    const id = await mkUser(0)
    const cookie = await cookieFor(id, 0)
    expect((await sessionFor(cookie))?.user.id).toBe(id)
    await bumpUserTokenVersion(id)
    expect(await sessionFor(cookie)).toBeNull()
  })

  it('a re-minted token (fresh sign-in) verifies again after the bump', async () => {
    const id = await mkUser(0)
    await bumpUserTokenVersion(id)
    expect(await sessionFor(await cookieFor(id, 0))).toBeNull()
    // The next sign-in embeds the CURRENT version (1):
    const session = await sessionFor(await cookieFor(id, 1))
    expect(session?.user.id).toBe(id)
  })

  it('a pre-#181 cookie (no claim) on a version-0 row still verifies (deploy safety)', async () => {
    const id = await mkUser(0)
    const session = await sessionFor(await cookieFor(id))
    expect(session?.user.id).toBe(id)
  })

  it('revocation is user-scoped: ANOTHER user\'s token is untouched', async () => {
    const a = await mkUser(0)
    const b = await mkUser(0)
    await bumpUserTokenVersion(a)
    const sessionB = await sessionFor(await cookieFor(b, 0))
    expect(sessionB?.user.id).toBe(b)
    expect(await sessionFor(await cookieFor(a, 0))).toBeNull()
  })
})

// ------------------------------------------- auth.ts wiring (sign-in/sign-out)

describe('auth wiring: the jwt callback embeds, the signOut event bumps', () => {
  it('the jwt callback stamps the authorize-provided tokenVersion into the token', async () => {
    const opts = buildAuthOptions(false)
    expect(opts.callbacks).toBeDefined()
    const jwt = opts.callbacks!.jwt as (a: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown>>
    const out = await jwt({
      token: { sub: 'sub-1', email: 'e@x.test' },
      user: { id: 'user-9', role: 'finance', tokenVersion: 4 },
    })
    expect(out.tokenVersion).toBe(4)
    // Without a user (session refresh, not sign-in) the claim is preserved:
    const refresh = await jwt({ token: { ...out }, user: undefined as never })
    expect(refresh.tokenVersion).toBe(4)
  })

  it('a user row without tokenVersion (defensive) mints version 0', async () => {
    const opts = buildAuthOptions(false)
    const jwt = opts.callbacks!.jwt as (a: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown>>
    const out = await jwt({ token: { sub: 's' }, user: { id: 'u' } })
    expect(out.tokenVersion).toBe(0)
  })

  it('events.signOut bumps the token\'s user (the server-side revocation on sign-out)', async () => {
    const id = await mkUser(0)
    const before = (await prisma.user.findUnique({ where: { id } }))?.tokenVersion
    expect(before).toBe(0)
    const opts = buildAuthOptions(false)
    expect(opts.events).toBeDefined()
    const signOut = opts.events!.signOut as (m: { token: Record<string, unknown> }) => Promise<void>
    await signOut({ token: { id, email: 'rev@demo.test' } })
    const after = (await prisma.user.findUnique({ where: { id } }))?.tokenVersion
    expect(after).toBe(1)
    // The sub fallback works too (tokens without our custom id claim):
    await signOut({ token: { sub: id } })
    expect((await prisma.user.findUnique({ where: { id } }))?.tokenVersion).toBe(2)
    // A nameless token is a no-op (no throw, no bump of anyone):
    await signOut({ token: {} })
    expect((await prisma.user.findUnique({ where: { id } }))?.tokenVersion).toBe(2)
  })
})
