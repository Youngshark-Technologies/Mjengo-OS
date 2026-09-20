import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import type { MjengoSessionUser } from '@/backend/lib/auth'
import { isInternalError } from './error-redaction'
import { devFallbackSecretCandidates } from '@/backend/lib/nextauth-fallback-secret'
// Issue #181 (SEC-15): server-side revocation — every session decoded here
// is checked against the user's CURRENT tokenVersion before it becomes a
// GuardSession. One seam, inherited by every guarded route + route-kit's
// publicRoute session decode + the health detail gate.
import { sessionTokenIsRevoked } from './session-revocation'

export type GuardSession = { user: MjengoSessionUser } | null

/**
 * JWT-decode the next-auth session straight off the request cookie — and
 * (issue #181, SEC-15) prove it is not revoked: the decoded token's
 * tokenVersion claim is compared against the user's current row via
 * lib/session-revocation.ts; a mismatch (the row moved after this token
 * was minted — a sign-out, an incident-response bump, the future
 * password/role/pin-change surfaces) reads as signed out. A token with
 * NO claim reads as version 0 (minted pre-#181 — the deploy itself
 * invalidates nobody); a deleted user, a nameless token or a failed
 * lookup all fail closed (see the revocation module header).
 */
export async function getSessionFromReq(req: NextRequest): Promise<GuardSession> {
  // v4's own precedence: options.secret (NEXTAUTH_SECRET) ?? NEXTAUTH_SECRET
  // env ?? AUTH_SECRET alias — the guard verifies with the SAME secret the
  // route handler would have resolved (a dev who sets only AUTH_SECRET was
  // previously in the same #94 failure mode).
  const envSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET
  let token = await getToken({ req, secret: envSecret })
  // Issue #94 (dev quickstart): with no NEXTAUTH_SECRET, next-auth mints
  // sessions on its internal fallback secret while getToken(undefined)
  // cannot decode them — logged in, but every guarded API 401s. In dev we
  // mirror v4's derivation (see nextauth-fallback-secret.ts) and accept the
  // same tokens. Production is untouched: the #74 boot guard already fails
  // closed there, and candidates() is empty without the env secret anyway.
  // SEC-2: "dev" means an EXPLICIT development/test runtime — on any other
  // runtime (staging/preview/unset NODE_ENV) the deterministic fallback is
  // publicly derivable, so candidates() stays empty and such tokens are
  // unauthenticated (401) here.
  if (!token?.email && !envSecret) {
    for (const candidate of devFallbackSecretCandidates(req)) {
      token = await getToken({ req, secret: candidate })
      if (token?.email) break
    }
  }
  if (!token?.email) return null
  // Issue #181: the revocation check — the ONLY additional work a valid
  // session now costs (one PK-point read). Runs AFTER the decode succeeded
  // so garbage cookies stay free, and BEFORE the session is shaped so every
  // consumer (withGuard 401, publicRoute's null session, the health detail
  // gate) sees a revoked token exactly as a signed-out one.
  if (await sessionTokenIsRevoked(token)) return null
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

/** 401 — the caller must sign in (owner APIs). */
export function unauthorized() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
}

/** 403 — signed in but the role is not permitted for this operation. */
export function forbidden(role?: string) {
  return NextResponse.json(
    { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
    { status: 403 },
  )
}

// ---------------- internal-error redaction (S-SEC) ----------------

// isInternalError moved to the leaf module ./error-redaction.ts (issue #202:
// the error sink needs the same rule WITHOUT importing the auth machinery);
// re-exported here so guard.ts stays its historical home for importers.
export { isInternalError }

/**
 * Honest error message for a response body: the appliers' own single-line
 * Error messages (business rules) pass through; Prisma/framework internals
 * are replaced with `fallback` (full detail still goes to the server log).
 */
export function safeErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && !isInternalError(e) ? e.message : fallback
}

// ---------------- role allowlists (F-MONEY: finance role lands, spec §36/§38) ----

/**
 * Roles that may operate the finance / wallet surface (spec §38 wallet API,
 * payment execution, journals). Finance owns the queue; admin is superuser.
 */
export const FINANCE_ROLES: readonly string[] = ['finance', 'admin']

/** Roles that may execute payments on behalf of the payer queue (incl. the client). */
export const PAYMENT_ROLES: readonly string[] = ['finance', 'admin', 'client']

/** Every known staff/finance/supplier role (defensive: unknown roles still fail closed). */
export const KNOWN_ROLES: readonly string[] = [
  'contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs',
  'supplier',
]

/**
 * Roles that operate the owner app (W1-PERM, spec §7 role matrix).
 * Mirrored client-side by src/shared/permissions.ts OWNER_ROLES — keep in sync.
 * `client` is intentionally absent: it boots the client surface, not the owner app.
 * `supplier` (W5-3) is intentionally absent too: it boots the SupplierPortal
 * surface (its own scoped reads via /api/supplier), never the owner app.
 */
export const OWNER_ROLES: readonly string[] = [
  'contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance',
]

// ---------------- supplier pinning (W5-3 — mirrors the client pin) ----------------

/**
 * The supplier-role tenant pin: the Supplier row a supplier session is
 * ALLOWED to touch, taken ONLY from the session (server-stamped at login;
 * payload copies are never trusted). Null = a supplier account with no link —
 * callers fail closed (403 "no supplier linked"), exactly like a client
 * session with no projectId.
 */
export function sessionSupplierId(session: NonNullable<GuardSession>): string | null {
  if (session.user.role !== 'supplier') return null
  const id = session.user.supplierId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

type GuardedHandler<C> = (
  req: NextRequest,
  session: NonNullable<GuardSession>,
  ctx: C,
) => Promise<NextResponse> | NextResponse

/**
 * Uniform server-side guard for owner APIs:
 * no session → 401 'Sign in required'; optional role allowlist → 403.
 * The wrapped handler receives the route context (Next 16 dynamic-route
 * `{ params }`) so guarded handlers can read path segments.
 */
export function withGuard<C = unknown>(handler: GuardedHandler<C>, opts?: { roles?: readonly string[] }) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const session = await getSessionFromReq(req)
    if (!session) return unauthorized()
    if (opts?.roles && !opts.roles.includes(session.user.role)) {
      return forbidden(session.user.role)
    }
    return handler(req, session, ctx)
  }
}
