import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z, ZodSchema } from 'zod'
import { db } from '@/lib/db'
import { SESSION_COOKIE } from '@/lib/auth'
import type { Role, SessionUser } from '@/lib/types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function ok(data: unknown, status = 200) {
  return NextResponse.json({ data }, { status })
}

export function fail(status: number, message: string) {
  return NextResponse.json({ error: { message } }, { status })
}

// Uniform error envelope for every route handler body.
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.message)
    console.error('[api] unexpected error:', err)
    return fail(500, 'Internal server error')
  }
}

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    throw new ApiError(400, `${where}${first?.message ?? 'Invalid request body'}`)
  }
  return parsed.data
}

export function parseQuery<T>(req: Request, schema: ZodSchema<T>): T {
  const url = new URL(req.url)
  const obj: Record<string, string> = {}
  url.searchParams.forEach((v, k) => { obj[k] = v })
  const parsed = schema.safeParse(obj)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    throw new ApiError(400, `${where}${first?.message ?? 'Invalid query parameters'}`)
  }
  return parsed.data
}

// Loads the session user (joined with organization) from the httpOnly cookie.
// Throws 401 when missing/expired. Pass roles to enforce server-side authorization.
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) throw new ApiError(401, 'Authentication required')

  const session = await db.session.findUnique({
    where: { token },
    include: { user: { include: { organization: { select: { name: true } } } } },
  })
  if (!session) throw new ApiError(401, 'Session is invalid — sign in again')
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined)
    throw new ApiError(401, 'Session expired — sign in again')
  }

  const { user } = session
  const sessionUser: SessionUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role as Role,
    organizationId: user.organizationId,
    organizationName: user.organization.name,
  }
  if (roles && !roles.includes(sessionUser.role)) {
    throw new ApiError(403, `This action requires role: ${roles.join(' or ')}`)
  }
  return sessionUser
}

// Fetches an org-scoped row by id or throws 404. Prevents cross-tenant access.
export async function findOrgRecord<T>(
  model: { findFirst: (args: { where: Record<string, unknown> }) => Promise<T | null> },
  id: string,
  organizationId: string,
  label = 'Record',
): Promise<T> {
  const row = await model.findFirst({ where: { id, organizationId } })
  if (!row) throw new ApiError(404, `${label} not found`)
  return row
}

export const idSchema = z.string().min(1, 'id is required')
// Accepts absent key (outer z.optional when wrapped), explicit null, '' or an ISO date/datetime string.
export const optionalDate = z
  .union([
    z.string().datetime({ offset: true }),
    z.string().date(),
    z.literal(''),
    z.null(),
  ])
  .optional()
  .transform(v => (v ? new Date(v) : null))
