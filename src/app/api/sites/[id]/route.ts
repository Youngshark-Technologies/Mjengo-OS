import { z } from 'zod'
import type { Site } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok,
  handle,
  parseBody,
  requireUser,
  findOrgRecord,
  optionalDate,
} from '@/lib/api-helpers'
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

const patchSchema = z.object({
  status: z.enum(SITE_STATUS_VALUES).optional(),
  name: z.string().min(1, 'name cannot be empty').optional(),
  location: z.string().min(1, 'location cannot be empty').optional(),
  // z.optional(...) wrapper keeps "absent" distinct from "" (which clears the date).
  targetEndDate: z.optional(optionalDate),
})

// PATCH /api/sites/[id] — update an org-owned site (partial).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params
    const body = await parseBody(req, patchSchema)

    const site = await findOrgRecord(db.site, id, user.organizationId, 'Site')

    const data: { status?: string; name?: string; location?: string; targetEndDate?: Date | null } = {}
    if (body.status !== undefined) data.status = body.status
    if (body.name !== undefined) data.name = body.name
    if (body.location !== undefined) data.location = body.location
    if (body.targetEndDate !== undefined) data.targetEndDate = body.targetEndDate

    const updated = await db.site.update({ where: { id: site.id }, data })

    return ok(toSiteDTO(updated))
  })
}
