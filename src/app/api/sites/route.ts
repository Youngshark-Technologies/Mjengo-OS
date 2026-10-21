import { z } from 'zod'
import type { Site } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, parseQuery, requireUser, optionalDate } from '@/lib/api-helpers'
import type { SiteDTO, SiteStatus } from '@/lib/types'
import { SITE_STATUS_VALUES } from '@/lib/types'

export const dynamic = 'force-dynamic'

function toSiteDTO(site: Site): SiteDTO {
  return {
    id: site.id,
    name: site.name,
    location: site.location,
    status: site.status as SiteStatus,
    startDate: site.startDate ? site.startDate.toISOString() : null,
    targetEndDate: site.targetEndDate ? site.targetEndDate.toISOString() : null,
    createdAt: site.createdAt.toISOString(),
  }
}

const querySchema = z.object({
  status: z.enum(SITE_STATUS_VALUES).optional(),
})

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  location: z.string().min(1, 'location is required'),
  status: z.enum(SITE_STATUS_VALUES).default('PLANNING'),
  startDate: optionalDate,
  targetEndDate: optionalDate,
})

// GET /api/sites?status=ACTIVE — list sites, newest first.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { status } = parseQuery(req, querySchema)

    const sites = await db.site.findMany({
      where: { organizationId: user.organizationId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    })

    return ok(sites.map(toSiteDTO))
  })
}

// POST /api/sites — create a site (any role).
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    const site = await db.site.create({
      data: {
        organizationId: user.organizationId,
        name: body.name,
        location: body.location,
        status: body.status,
        startDate: body.startDate,
        targetEndDate: body.targetEndDate,
        createdById: user.id,
      },
    })

    return ok(toSiteDTO(site), 201)
  })
}
