import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { handle, ok, parseBody, ApiError } from '@/lib/api-helpers'
import { hashPassword, createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'
import type { SessionUser } from '@/lib/types'

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z
    .email('A valid email address is required')
    .transform(v => v.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  organizationName: z.string().trim().min(1, 'Organization name is required'),
})

export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = await parseBody(req, registerSchema)
    const email = body.email

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'An account with this email already exists')

    const passwordHash = hashPassword(body.password)

    let created: { user: SessionUser }
    try {
      created = await db.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: body.organizationName },
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
