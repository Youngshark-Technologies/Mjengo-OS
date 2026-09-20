// Server-side session revocation (issue #181 / audit SEC-15) — the seam
// that lets this app kill a JWT session BEFORE its 30-day expiry.
//
// WHY THIS EXISTS: sessions are 30-day JWTs (the offline-first product
// posture, issue #78 — field devices may be offline for days and must not
// be forced through re-auth). Sign-out historically only cleared the
// client cookie: the JWT itself stayed valid, and a stolen token had NO
// server-side kill switch — unacceptable for a money-moving app.
//
// THE MECHANISM (per-user token version, see migration 20_token_version
// for the why-not-a-jti-table decision):
//   · at sign-in, the jwt callback (auth.ts) embeds `tokenVersion` in the
//     JWT, read from the User row;
//   · on EVERY guarded request, getSessionFromReq (guard.ts) compares the
//     token's claim against the CURRENT User.tokenVersion — a token that
//     is behind the row predates a revocation and the session is rejected
//     (401 at every guarded route, inherited from the single guard seam);
//   · bumping the row invalidates EVERY session the user has: sign-out
//     does it (next-auth v4's events.signOut hook — the decoded token is
//     available server-side there), incident response does it with one
//     UPDATE (SECURITY.md), and the future password/role/pin-change
//     surfaces MUST do it (none exists yet — honest scope).
//
// COST: one PK-point read (findUnique on the User id, select tokenVersion)
// per authenticated request — the same order as the queries the guarded
// routes run anyway, on a single-node SQLite deployment. No cache layer:
// a revocation check that lags a TTL is a weaker revocation check, and
// the app is single-process per DB file (DEPLOYMENT.md §7.2) so an
// in-process cache could not serve a second instance anyway.
//
// FAILURE POSTURE — FAIL CLOSED: a token whose user id cannot be read, a
// user row that no longer exists (deleted users lose their sessions — a
// bonus), or a lookup that THROWS (DB error) all read as REVOKED. A
// revocation seam that fails open during DB trouble is a bypass, not a
// safety net; a down DB breaks every guarded route's own queries anyway.
// The DB-error path logs one warn line (the DB is already the incident).
//
// BACKWARD COMPATIBILITY: tokens minted before this feature carry NO
// tokenVersion claim — they read as version 0, and every existing User
// row is born at 0, so the deploy itself invalidates nobody (the
// offline-PWA rule: deploys must not force field re-auth). The first
// bump after the deploy revokes them.

import { db } from './db'
import { log } from './log'

/** The claims the revocation check reads off a decoded session JWT. */
export interface SessionVersionClaims {
  /** The user id our jwt callback stamps (next-auth's raw fallback). */
  id?: string | number | null
  /** next-auth's subject — the fallback when `id` is absent. */
  sub?: string | number | null
  /** The token version embedded at sign-in; ABSENT = minted pre-#181 = 0. */
  tokenVersion?: number | null
}

/**
 * The user id a session token carries (our jwt callback's `id`, else
 * next-auth's `sub'), as a string; empty string when the token names no
 * user at all (such a token cannot be revocation-checked).
 */
export function sessionUserId(token: SessionVersionClaims): string {
  return String(token.id ?? token.sub ?? '')
}

/**
 * Is this decoded session JWT revoked (or unverifiable)? True means the
 * guard must treat the request as signed out. Pure decision over the
 * token claims + the CURRENT User.tokenVersion row; every failure mode
 * reads as revoked (fail closed — see the module header).
 */
export async function sessionTokenIsRevoked(token: SessionVersionClaims): Promise<boolean> {
  const userId = sessionUserId(token)
  if (!userId) return true // no user named — cannot verify, fail closed
  const claimedVersion = typeof token.tokenVersion === 'number' ? token.tokenVersion : 0
  let currentVersion: number
  try {
    const row = await db.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
    if (!row) return true // user deleted → every session they ever had is dead
    currentVersion = row.tokenVersion
  } catch (e) {
    log.warn('auth', 'Session revocation check failed — treating the session as revoked (fail closed)', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    })
    return true
  }
  return claimedVersion !== currentVersion
}

/**
 * Revoke EVERY session for one user: increment their tokenVersion. This is
 * the one-line incident-response primitive (SECURITY.md's "revoke all
 * sessions for user X") and the seam the bump points call — sign-out
 * (next-auth events.signOut), the future password-change and
 * role/project-pin-change surfaces. NEVER THROWS: a failed bump is logged
 * loudly (it is security-relevant) but must not take the caller down with
 * it — v4's signOut path clears the cookie regardless, and the next
 * successful bump still revokes. Returns true when the row moved.
 */
export async function bumpUserTokenVersion(userId: string): Promise<boolean> {
  try {
    const row = await db.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    })
    log.info('auth', 'Session revocation: bumped user tokenVersion (all their sessions are now invalid)', {
      userId,
      tokenVersion: row.tokenVersion,
    })
    return true
  } catch (e) {
    log.error('auth', 'Session revocation bump FAILED — sessions for this user remain valid until the next successful bump', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}
