import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { handle, ok, parseBody, ApiError } from '@/lib/api-helpers'
import { hashPassword, createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import type { OrganizationType, SessionUser } from '@/lib/types'
import { ORGANIZATION_TYPE_VALUES } from '@/lib/types'

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z
    .email('A valid email address is required')
    .transform(v => v.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  organizationName: z.string().trim().min(1, 'Organization name is required'),
  // MJG-035 — partner self-registration: a SUPPLIER or LOGISTICS organization
  // registers exactly like a constructor; only the org type differs.
  organizationType: z.enum(ORGANIZATION_TYPE_VALUES).default('CONSTRUCTOR'),
})

// MJG-043 — same client-IP extraction as the login route.
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
    // MJG-043 — throttle mass account creation before any processing:
    // 20 registrations / hour per IP.
    const ip = clientIp(req)
    if (!checkRateLimit(`register:ip:${ip}`, 20, 60 * 60_000).ok) {
      throw new ApiError(429, 'Too many registration attempts — try again later')
    }

    const body = await parseBody(req, registerSchema)
    const email = body.email

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'An account with this email already exists')

    const passwordHash = hashPassword(body.password)

    let created: { user: SessionUser }
    try {
      created = await db.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: body.organizationName, type: body.organizationType },
        })
        const user = await tx.user.create({
          data: {
            name: body.name,
            email,
            passwordHash,
            role: 'OWNER',
            organizationId: organization.id,
          },
        })
        const sessionUser: SessionUser = {
          id: user.id,
          name: user.name,
          email: user.email,
          role: 'OWNER',
          organizationId: organization.id,
          organizationName: organization.name,
          organizationType: body.organizationType as OrganizationType,
        }
        return { user: sessionUser }
      })
    } catch (err) {
      // Defense in depth: email has a DB-level unique constraint.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(409, 'An account with this email already exists')
      }
      throw err
    }

    const { token, expiresAt } = await createSession(created.user.id)
    const res = ok(created.user)
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))
    return res
  })
}
