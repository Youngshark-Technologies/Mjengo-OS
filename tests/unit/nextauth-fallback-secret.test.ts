/**
 * Issue #94 — dev quickstart without NEXTAUTH_SECRET: the guard must verify
 * the SAME tokens next-auth v4 mints on its internal fallback secret.
 *
 * Three families of proof:
 *  1. GOLDEN — the mirror in nextauth-fallback-secret.ts produces
 *     byte-identical secrets to next-auth's OWN createSecret/parseUrl/
 *     detectOrigin (imported straight from node_modules) for the same
 *     inputs. If a next-auth upgrade changes v4's derivation, this fails
 *     and the mirror must be revisited.
 *  2. CANDIDATE GATING — no fallback when an env secret exists
 *     (NEXTAUTH_SECRET or the AUTH_SECRET alias) or on ANY runtime other
 *     than an explicit development/test (SEC-2: production, staging, and an
 *     unset NODE_ENV all fail closed, with ONE loud console.error).
 *  3. END-TO-END — a REAL JWE minted with next-auth/jwt `encode` on a
 *     fallback candidate is decoded by guard.getSessionFromReq (both cookie
 *     variants: http and https login), plus the unchanged env-secret path
 *     and the honest-null paths (incl. the SEC-2 non-dev rejection).
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NextRequest, NextResponse } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
// next-auth's own machinery — the golden source of truth. The package
// `exports` map blocks subpath imports ("./core/lib/utils" etc.), so the
// v4 internals are loaded by FILE URL straight out of node_modules (CJS
// interop). It is still THEIR code — that is the point of a golden test.
const naModule = (p: string) =>
  import(pathToFileURL(join(process.cwd(), 'node_modules/next-auth', p)).href)
// 'next-auth/jwt' is an official subpath export — safe to import directly.
import { encode } from 'next-auth/jwt'
import { buildAuthOptions } from '@/backend/lib/auth'
// Issue #181 (SEC-15): the guard now proves every decoded session against
// the user's CURRENT tokenVersion (lib/session-revocation.ts → db). This
// file's SUBJECT is secret verification, not revocation — the db is mocked
// to a standing user row at version 0 so pre-#181-style claims (no
// tokenVersion → read as 0) verify as UNrevoked, exactly what these
// secret-path assertions mean to prove. Revocation itself has its own
// suite (session-revocation.test.ts).
vi.mock('@/backend/lib/db', () => ({
  db: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        tokenVersion: 0,
      })),
    },
  },
}))
import { getSessionFromReq, withGuard } from '@/backend/lib/guard'
import {
  detectOriginMirror,
  devFallbackSecretCandidates,
  fallbackSecret,
  isDevRuntime,
  parseUrlMirror,
} from '@/backend/lib/nextauth-fallback-secret'

// Silence dev quickstart warnings during these tests.
vi.spyOn(console, 'warn').mockImplementation(() => {})
// SEC-2: the non-dev rejection path logs ONE loud console.error — capture it
// (and keep the suite output clean).
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

const REAL_SECRET = 'x'.repeat(64)

/** The v4 default URL used when detectOrigin resolves nothing. */
const v4DefaultUrl = parseUrlMirror(undefined)

/** A fake NextRequest with a session cookie header. */
function reqWithCookie(token: string, name = 'next-auth.session-token'): NextRequest {
  return new NextRequest('http://localhost:3000/api/projects', {
    headers: { cookie: `${name}=${token}` },
  })
}

/** Reset every env var this feature reads — the fresh-cloner baseline. */
function cleanEnv() {
  delete process.env.NEXTAUTH_SECRET
  delete process.env.AUTH_SECRET
  delete process.env.NEXTAUTH_URL
  delete process.env.VERCEL
  delete process.env.AUTH_TRUST_HOST
}

afterEach(() => {
  vi.unstubAllEnvs()
  cleanEnv()
  errorSpy.mockClear()
})

// ----------------------------------------------------------------- golden

describe('the mirror is byte-identical to next-auth v4.24 (golden tests)', () => {
  it('fallbackSecret === v4 createSecret for the same url + authOptions (both cookie variants)', async () => {
    cleanEnv()
    const { createSecret } = await naModule('core/lib/utils.js')
    // v4 createSecret only hashes when options.secret is unset — pin both
    // authOptions variants exactly as the minting side would build them.
    for (const secureCookies of [false, true]) {
      const authOptions = buildAuthOptions(secureCookies)
      const theirs = createSecret({ authOptions, url: v4DefaultUrl })
      const ours = fallbackSecret(authOptions, v4DefaultUrl)
      expect(ours).toBe(theirs)
    }
  })

  it('parseUrlMirror matches v4 parseUrl for the default and a set NEXTAUTH_URL', async () => {
    cleanEnv()
    // v4's parseUrl module (default export) — loaded by file URL.
    const v4ParseUrl = (await naModule('utils/parse-url.js')).default
    const { origin, host, path, base } = v4ParseUrl(undefined)
    expect(parseUrlMirror(undefined)).toStrictEqual({ origin, host, path, base })

    const pinned = 'https://app.example.com/api/auth'
    const v4Pinned = v4ParseUrl(pinned)
    expect(parseUrlMirror(pinned)).toStrictEqual({
      origin: v4Pinned.origin,
      host: v4Pinned.host,
      path: v4Pinned.path,
      base: v4Pinned.base,
    })
  })

  it('detectOriginMirror matches v4 detectOrigin across the env matrix', async () => {
    const v4DetectOrigin = (await naModule('utils/detect-origin.js')).detectOrigin
    const cases: Array<[string | undefined, string | undefined, string | undefined]> = [
      // [NEXTAUTH_URL, VERCEL/AUTH_TRUST_HOST, expected-env]
      [undefined, undefined, undefined],
      ['https://pinned.example', undefined, 'https://pinned.example'],
      [undefined, '1', 'https://proxy.example'],
      [undefined, '', undefined],
    ]
    for (const [nextauthUrl, trustHost] of cases) {
      cleanEnv()
      if (nextauthUrl) vi.stubEnv('NEXTAUTH_URL', nextauthUrl)
      if (trustHost) vi.stubEnv('AUTH_TRUST_HOST', trustHost)
      const theirs = v4DetectOrigin('proxy.example', 'https')
      const ours = detectOriginMirror('proxy.example', 'https')
      expect(ours).toBe(theirs)
      if (nextauthUrl) vi.unstubAllEnvs()
    }
  })
})

// -------------------------------------------------------------- gating

describe('candidate gating — the fallback never runs when it must not', () => {
  it('NEXTAUTH_SECRET set → no candidates (env behavior untouched)', () => {
    cleanEnv()
    vi.stubEnv('NEXTAUTH_SECRET', REAL_SECRET)
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
  })

  it('AUTH_SECRET alias set → no candidates (same v4 precedence)', () => {
    cleanEnv()
    vi.stubEnv('AUTH_SECRET', REAL_SECRET)
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
  })

  it('production runtime → no candidates even with nothing set (fail closed)', () => {
    cleanEnv()
    vi.stubEnv('NODE_ENV', 'production')
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
  })

  it('dev quickstart (nothing set) → candidates exist and are distinct', () => {
    cleanEnv()
    const candidates = devFallbackSecretCandidates(reqWithCookie('x'))
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(new Set(candidates).size).toBe(candidates.length)
    expect(candidates[0]).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ----------------------------------------------- SEC-2: non-dev runtimes

describe('SEC-2 — the fallback is dev/test ONLY (explicit runtime check)', () => {
  const savedNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  })

  it('isDevRuntime: only explicit development/test count', () => {
    for (const runtime of ['development', 'test']) {
      process.env.NODE_ENV = runtime
      expect(isDevRuntime()).toBe(true)
    }
    for (const runtime of ['production', 'staging', 'preview', '']) {
      process.env.NODE_ENV = runtime
      expect(isDevRuntime()).toBe(false)
    }
    delete process.env.NODE_ENV
    expect(isDevRuntime()).toBe(false)
  })

  it('NODE_ENV unset → no candidates + ONE loud console.error naming NEXTAUTH_SECRET', () => {
    cleanEnv()
    delete process.env.NODE_ENV
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
    // A second consult of the same runtime stays SILENT (once per process).
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = String(errorSpy.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('NEXTAUTH_SECRET')
    expect(line).toMatch(/openssl rand -hex 32/)
  })

  it('a non-dev runtime with a custom name (staging) → no candidates, fail closed', () => {
    cleanEnv()
    process.env.NODE_ENV = 'staging'
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
    expect(errorSpy).toHaveBeenCalled()
  })

  it('a dev/test consult resets the once-guard — the NEXT non-dev consult warns again', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
    process.env.NODE_ENV = 'test'
    expect(devFallbackSecretCandidates(reqWithCookie('x')).length).toBeGreaterThanOrEqual(2)
    process.env.NODE_ENV = 'production'
    expect(devFallbackSecretCandidates(reqWithCookie('x'))).toStrictEqual([])
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })
})

// --------------------------------------------------------- end-to-end

describe('guard.getSessionFromReq verifies real fallback-minted tokens (#94)', () => {
  const claims = {
    sub: 'user-1',
    email: 'demo@mjengo.test',
    name: 'Demo Contractor',
    role: 'contractor',
  }

  it('http-login variant: token minted on the fallback secret decodes to a session', async () => {
    cleanEnv()
    const candidates = devFallbackSecretCandidates(reqWithCookie('x'))
    const token = await encode({ token: claims, secret: candidates[0], maxAge: 60 })
    const session = await getSessionFromReq(reqWithCookie(token))
    expect(session).not.toBeNull()
    expect(session?.user.email).toBe(claims.email)
    expect(session?.user.role).toBe('contractor')
    expect(session?.user.id).toBe('user-1')
  })

  it('https-login variant: the buildAuthOptions(true) candidate also verifies', async () => {
    cleanEnv()
    const candidates = devFallbackSecretCandidates(reqWithCookie('x'))
    const token = await encode({ token: claims, secret: candidates[1], maxAge: 60 })
    const session = await getSessionFromReq(reqWithCookie(token))
    expect(session?.user.email).toBe(claims.email)
  })

  it('env secret path unchanged: a token minted with NEXTAUTH_SECRET still verifies', async () => {
    cleanEnv()
    vi.stubEnv('NEXTAUTH_SECRET', REAL_SECRET)
    const token = await encode({ token: claims, secret: REAL_SECRET, maxAge: 60 })
    const session = await getSessionFromReq(reqWithCookie(token))
    expect(session?.user.email).toBe(claims.email)
  })

  it('no fallback attempt when the env secret is set: fallback-minted token is rejected', async () => {
    cleanEnv()
    // Simulate a session minted BEFORE the operator set a real secret.
    const token = await encode({ token: claims, secret: fallbackSecret(buildAuthOptions(false), v4DefaultUrl), maxAge: 60 })
    vi.stubEnv('NEXTAUTH_SECRET', REAL_SECRET)
    const session = await getSessionFromReq(reqWithCookie(token))
    expect(session).toBeNull()
  })

  it('garbage cookie → null session, no throw', async () => {
    cleanEnv()
    const session = await getSessionFromReq(reqWithCookie('not-a-jwe'))
    expect(session).toBeNull()
  })

  it('SEC-2: NODE_ENV=production → a fallback-minted token is UNAUTHENTICATED (null session)', async () => {
    cleanEnv()
    const savedNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      // Minted exactly like a dev quickstart session (the forgeable key is
      // derivable from public source) — on a non-dev runtime it must NOT
      // verify: the guard treats it as no session (401 posture).
      const secret = fallbackSecret(buildAuthOptions(false), v4DefaultUrl)
      const token = await encode({ token: { ...claims, role: 'admin' }, secret, maxAge: 60 })
      const session = await getSessionFromReq(reqWithCookie(token))
      expect(session).toBeNull()
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNodeEnv
    }
  })

  it('withGuard: the fixed session actually reaches the handler (200, not 401)', async () => {
    cleanEnv()
    const candidates = devFallbackSecretCandidates(reqWithCookie('x'))
    const token = await encode({ token: claims, secret: candidates[0], maxAge: 60 })
    const handler = withGuard(async (_req, session) =>
      NextResponse.json({ email: session.user.email }),
    )
    const res = await handler(reqWithCookie(token), undefined)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ email: claims.email })
  })
})
