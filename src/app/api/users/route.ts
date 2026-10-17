import { z } from 'zod'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { handle, ok, parseBody, requireUser, ApiError } from '@/lib/api-helpers'
import { ROLE_VALUES } from '@/lib/types'
import type { Role } from '@/lib/types'

// GET /api/users — org member directory (any member).
export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    const members = await db.user.findMany({
      where: { organizationId: user.organizationId },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    })
    return ok(
      members.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role as Role,
        createdAt: m.createdAt.toISOString(),
      })),
    )
  })
}

const createMemberSchema = z.object({
  name: z.string().min(1, 'name is required'),
  email: z.string().email('a valid email is required'),
  password: z.string().min(8, 'password must be at least 8 characters'),
  role: z.enum(['SUPERVISOR', 'WORKER']),
})

// POST /api/users — OWNER adds members to their organization (server-enforced).
export async function POST(req: Request) {
  return handle(async () => {
    const owner = await requireUser(['OWNER'])
    const body = await parseBody(req, createMemberSchema)
    const email = body.email.trim().toLowerCase()

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) throw new ApiError(409, 'An account with this email already exists')
    if (!ROLE_VALUES.includes(body.role as Role)) throw new ApiError(400, 'Invalid role')

    const member = await db.user.create({
      data: {
        name: body.name.trim(),
        email,
        passwordHash: hashPassword(body.password),
        role: body.role,
        organizationId: owner.organizationId,
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    })
    return ok(
      {
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role as Role,
        createdAt: member.createdAt.toISOString(),
      },
      201,
    )
  })
}
