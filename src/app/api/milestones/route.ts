import { z } from 'zod'
import type { Milestone } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, parseQuery, requireUser, ApiError, optionalDate } from '@/lib/api-helpers'
import type { MilestoneDTO, MilestoneStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

function toMilestoneDTO(milestone: Milestone & { site: { name: string } }): MilestoneDTO {
  return {
    id: milestone.id,
    siteId: milestone.siteId,
    siteName: milestone.site.name,
    name: milestone.name,
    status: milestone.status as MilestoneStatus,
    dueDate: milestone.dueDate ? milestone.dueDate.toISOString() : null,
    order: milestone.order,
  }
}

const querySchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
})

const createSchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
  name: z.string().min(1, 'name is required'),
  dueDate: optionalDate,
  order: z.coerce.number().int().default(0),
})

// GET /api/milestones?siteId=... — milestones for a site (required param).
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId } = parseQuery(req, querySchema)

    const site = await db.site.findFirst({
      where: { id: siteId, organizationId: user.organizationId },
      select: { id: true },
    })
    if (!site) throw new ApiError(404, 'Site not found')

    const milestones = await db.milestone.findMany({
      where: { organizationId: user.organizationId, siteId },
      include: { site: { select: { name: true } } },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    })

    return ok(milestones.map(toMilestoneDTO))
  })
}

// POST /api/milestones — create a milestone on an org-owned site.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    const site = await db.site.findFirst({
      where: { id: body.siteId, organizationId: user.organizationId },
      select: { id: true, name: true },
    })
    if (!site) throw new ApiError(404, 'Site not found')

    const milestone = await db.milestone.create({
      data: {
        organizationId: user.organizationId,
        siteId: site.id,
        name: body.name,
        dueDate: body.dueDate,
        order: body.order,
      },
      include: { site: { select: { name: true } } },
    })

    return ok(toMilestoneDTO(milestone), 201)
  })
}
