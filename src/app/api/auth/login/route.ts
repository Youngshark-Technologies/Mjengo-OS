import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { handle, ok, parseBody, ApiError } from '@/lib/api-helpers'
import { verifyPassword, createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'
import { checkRateLimit, recordRateLimit, resetRateLimit } from '@/lib/rate-limit'
import type { Role, SessionUser } from '@/lib/types'

const loginSchema = z.object({
  email: z
    .email('A valid email address is required')
    .transform(v => v.trim().toLowerCase()),
  password: z.string().min(1, 'Password is required'),
})

// MJG-043 — best-effort client identity for rate limiting. Behind a proxy,
// the first entry of x-forwarded-for is the original client.
function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return 'local'
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = await parseBody(req, loginSchema)
    const email = body.email

    // MJG-043 — throttle before any credential work: 30 attempts / 15 min per
    // IP (credential stuffing), 8 attempts / 15 min per email (targeted
    // brute-force on one account).
    const ip = clientIp(req)
    const ipBudget = checkRateLimit(`login:ip:${ip}`, 30, 15 * 60_000)
    const emailBudget = checkRateLimit(`login:email:${email.toLowerCase()}`, 8, 15 * 60_000)
    if (!ipBudget.ok || !emailBudget.ok) {
      throw new ApiError(429, 'Too many attempts — try again later')
    }

    // Same 401 message for unknown email and wrong password — no user enumeration.
    const user = await db.user.findUnique({
      where: { email },
      include: { organization: { select: { name: true, type: true } } },
    })
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      // A failed attempt counts against both budgets.
      recordRateLimit(`login:ip:${ip}`)
      recordRateLimit(`login:email:${email.toLowerCase()}`)
      throw new ApiError(401, 'Invalid email or password')
    }

    const sessionUser: SessionUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as Role,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
      organizationType: user.organization.type as SessionUser['organizationType'],
    }

    const { token, expiresAt } = await createSession(user.id)

    // MJG-054 — best-effort pruning of expired sessions; login must never
    // fail because housekeeping could not run.
    await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined)

    // Success forgives the per-account budget (wrong-password lockout) but the
    // per-IP budget stays — one success must not excuse IP-wide throttling.
    resetRateLimit(`login:email:${email}`)

    const res = ok(sessionUser)
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))
    return res
  })
}
