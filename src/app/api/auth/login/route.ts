import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { handle, ok, parseBody, ApiError } from '@/lib/api-helpers'
import { verifyPassword, createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'
import type { Role, SessionUser } from '@/lib/types'

const loginSchema = z.object({
  email: z
    .email('A valid email address is required')
    .transform(v => v.trim().toLowerCase()),
  password: z.string().min(1, 'Password is required'),
})

export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = await parseBody(req, loginSchema)
    const email = body.email

    // Same 401 message for unknown email and wrong password — no user enumeration.
    const user = await db.user.findUnique({
      where: { email },
      include: { organization: { select: { name: true } } },
    })
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw new ApiError(401, 'Invalid email or password')
    }

    const sessionUser: SessionUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as Role,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
    }

    const { token, expiresAt } = await createSession(user.id)
    const res = ok(sessionUser)
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt))
    return res
  })
}
