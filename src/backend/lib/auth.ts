import type { NextAuthOptions } from 'next-auth'
import type { NextRequest } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (the 'next-auth/next' barrel is
// not typed for it) — runtime signature is identical: { req, secret }.
import { getToken } from 'next-auth/jwt'
import CredentialsProvider from 'next-auth/providers/credentials'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '@/backend/lib/db'
import {
  checkLoginLockout,
  clearLoginFailures,
  clientIpFromHeaders,
  recordLoginFailure,
} from '@/backend/lib/rate-limit'
import { log } from '@/backend/lib/log'
// Issue #181 (SEC-15): the signOut event bumps the user's tokenVersion —
// server-side revocation for a money-moving app.
import { bumpUserTokenVersion } from '@/backend/lib/session-revocation'

/** Shape carried on the session (JWT → session callback). */
export interface MjengoSessionUser {
  id: string
  email: string
  name: string
  role: 'contractor' | 'client' | 'admin' | 'finance' | 'supervisor' | 'supplier' | string
  /** For client-role users: the project they are buying. Null for site team / admin. */
  projectId: string | null
  /** For supplier-role users (W5-3): the Supplier row they operate. Null for
   *  every other role — the supplier surface fails closed without it. */
  supplierId: string | null
}

declare module 'next-auth' {
  interface User {
    role?: string
    projectId?: string | null
    supplierId?: string | null
    // Issue #181 (SEC-15): authorize returns the fresh User row's token
    // version so the jwt callback can embed it in the minted token.
    tokenVersion?: number
  }
  interface Session {
    user: MjengoSessionUser
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: string
    projectId?: string | null
    supplierId?: string | null
    // Issue #181 (SEC-15): the per-user token version — embedded at
    // sign-in, compared against User.tokenVersion on every guarded
    // request (guard.ts via lib/session-revocation.ts). ABSENT on tokens
    // minted before #181 → reads as 0 (the deploy invalidates nobody).
    tokenVersion?: number
  }
}

// ---------------------------------------------------------------- scrypt passwords

/** scrypt hash, salt embedded: `<salt hex>:<hash hex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** Constant-time scrypt verification against a `salt:hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored ?? '').split(':')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const candidate = scryptSync(password, salt, expected.length)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

/**
 * Burn-hash for login-timing equalization (S-SEC): when the email does not
 * resolve to an account, one scrypt is still run against this dummy so a
 * response-timing probe cannot distinguish "no such user" from "wrong
 * password" (the failure path + lockout accounting are identical either way).
 */
const DUMMY_HASH = hashPassword('mjengo-timing-equalizer')

// ---------------------------------------------------------------- next-auth options

/**
 * Cookie policy for the credentials flow (auth hardening, preview-panel fix).
 *
 * next-auth v4 defaults are `sameSite: "lax"` — correct for top-level
 * browsing, but the sandbox preview renders the app inside an iframe: lax
 * cookies are NOT sent in cross-site iframe contexts, so sign-in silently
 * failed for preview users. Behind an https reverse proxy we therefore
 * switch to `SameSite=None; Secure` (the iframe-safe combination), keeping
 * plain `lax` for direct http://localhost dev.
 *
 * Names deliberately stay unprefixed (no __Secure-/__Host-): v4's prefixes
 * require every receiving context to be https, and the app is legitimately
 * reachable both via the https preview gateway and plain http locally —
 * unprefixed Secure cookies degrade gracefully across both.
 */
function cookieOverrides(secure: boolean): NonNullable<NextAuthOptions['cookies']> {
  const names = {
    sessionToken: 'next-auth.session-token',
    csrfToken: 'next-auth.csrf-token',
    callbackUrl: 'next-auth.callback-url',
  }
  const policy = secure
    ? { httpOnly: true, sameSite: 'none' as const, secure: true, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' }
  return {
    sessionToken: { name: names.sessionToken, options: policy },
    csrfToken: { name: names.csrfToken, options: policy },
    callbackUrl: { name: names.callbackUrl, options: policy },
  }
}

/** One-shot console warning when NEXTAUTH_URL fights the real request host. */
let warnedUrlMismatch = false
export function warnNextAuthUrlMismatch(headers: Headers): void {
  if (warnedUrlMismatch || !process.env.NEXTAUTH_URL) return
  let envHost: string | null = null
  try {
    envHost = new URL(process.env.NEXTAUTH_URL).host
  } catch {
    return // malformed env value — nothing useful to compare
  }
  const reqHost = headers.get('x-forwarded-host') ?? headers.get('host')
  if (envHost && reqHost && envHost !== reqHost) {
    warnedUrlMismatch = true
    log.warn(
      'auth',
      `NEXTAUTH_URL (${envHost}) does not match the request host (${reqHost}). ` +
        'Sign-in redirects and cookie origins will target the wrong host. ' +
        'Behind a reverse proxy leave NEXTAUTH_URL unset (next-auth derives the origin ' +
        'from x-forwarded-host/-proto), or set it to the public origin.',
      { envHost, reqHost },
    )
  }
}

/**
 * Build NextAuthOptions for the CURRENT request. `secureCookies` must reflect
 * the request's real protocol (x-forwarded-proto behind a proxy): it drives
 * both the cookie names/prefixes and the SameSite policy (see cookieOverrides).
 */
export function buildAuthOptions(secureCookies: boolean): NextAuthOptions {
  return {
    secret: process.env.NEXTAUTH_SECRET,
    useSecureCookies: secureCookies,
    cookies: cookieOverrides(secureCookies),
    session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 }, // 30 days
    providers: [
    CredentialsProvider({
      name: 'MjengoOS account',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      /**
       * Credentials sign-in with brute-force lockout (W1-SEC, Doc A §52;
       * W-AUDIT #1 hardening): the failure counter is keyed PRIMARILY by
       * EMAIL (5 failures within 15 min → 15-min lock even across rotating
       * source IPs — the IP is only a secondary tracker so a distributed
       * attack still gets per-pair throttling) — even a CORRECT password is
       * rejected during the window. Tracking runs through the env-resolved
       * store (rate-limit.ts): the shared sqlite file per host by default
       * (issue #158), in-process only when RATE_LIMIT_STORE=memory opts out.
       *
       * Lockouts are surfaced CredentialsSignin-style: authorize THROWS with
       * a clear message, which next-auth v4 encodes as the `error` param on
       * the sign-in response — the client signIn() call resolves with
       * { error: "Too many attempts — locked for 15 min" } instead of the
       * generic CredentialsSignin code.
       *
       * authorize's second arg (v4) is { query, body, headers, method } —
       * headers is the request's Headers instance, so x-forwarded-for is
       * available for the lockout key.
       */
      async authorize(credentials, req) {
        const email = credentials?.email?.trim().toLowerCase()
        const password = credentials?.password ?? ''
        if (!email || !password) return null

        const ip = clientIpFromHeaders(req?.headers)

        const lock = checkLoginLockout(email, ip)
        if (lock.locked) {
          // Checked BEFORE the user lookup: a locked source learns nothing
          // about whether the account or password is valid.
          const mins = Math.max(1, Math.ceil(lock.msLeft / 60000))
          throw new Error(`Too many attempts — locked for ${mins} min. Try again later.`)
        }

        const user = await db.user.findUnique({ where: { email } })
        if (!user || !verifyPassword(password, user.passwordHash)) {
          if (!user) verifyPassword(password, DUMMY_HASH) // S-SEC timing equalizer
          const failure = recordLoginFailure(email, ip)
          if (failure.locked) {
            // This failure tripped the 5th strike — say so immediately.
            const mins = Math.max(1, Math.ceil(failure.msLeft / 60000))
            throw new Error(`Too many attempts — locked for ${mins} min. Try again later.`)
          }
          return null
        }

        // Success resets the failure counter completely.
        clearLoginFailures(email, ip)
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          projectId: user.projectId,
          supplierId: user.supplierId,
          // Issue #181: stamped at sign-in so the guard can later prove the
          // token is not revoked (User.tokenVersion comparison).
          tokenVersion: user.tokenVersion,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role ?? 'contractor'
        token.projectId = user.projectId ?? null
        token.supplierId = user.supplierId ?? null
        token.name = user.name ?? token.name
        token.email = user.email ?? token.email
        // Issue #181 (SEC-15): the token version travels IN the JWT. The
        // `user` object here is authorize's return (the fresh User row),
        // so a minted token always carries the CURRENT version — the
        // guard's later comparison then catches any bump in between.
        token.tokenVersion = user.tokenVersion ?? 0
      }
      return token
    },
    async session({ session, token }) {
      session.user = {
        id: String(token.id ?? token.sub ?? ''),
        email: String(token.email ?? ''),
        name: String(token.name ?? ''),
        role: String(token.role ?? 'contractor'),
        projectId: token.projectId ?? null,
        supplierId: token.supplierId ?? null,
      }
      return session
    },
  },
  // Issue #181 (SEC-15): server-side revocation on sign-out. v4's default
  // sign-out only clears the client cookie — the JWT itself stayed valid
  // for its full 30-day life. The signOut event (JWT sessions: the decoded
  // token arrives as `message.token`) bumps the user's tokenVersion, so
  // every token they hold — this one, other devices', a stolen copy — is
  // rejected by the guard from the next request. bumpUserTokenVersion
  // never throws (a failed bump logs loudly; the cookie still clears —
  // the revocation then rides the next successful bump; see the module).
  events: {
    async signOut({ token }) {
      const userId = String(token?.id ?? token?.sub ?? '')
      if (userId) await bumpUserTokenVersion(userId)
    },
  },
  }
}

// ---------------------------------------------------------------- helper

/** Server-side session for a request (JWT decode) — null when signed out. */
export async function requireSession(
  req: NextRequest,
): Promise<{ user: MjengoSessionUser } | null> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.email) return null
  return {
    user: {
      id: String(token.id ?? token.sub ?? ''),
      email: String(token.email),
      name: String(token.name ?? ''),
      role: String(token.role ?? 'contractor'),
      projectId: token.projectId ?? null,
      supplierId: token.supplierId ?? null,
    },
  }
}
