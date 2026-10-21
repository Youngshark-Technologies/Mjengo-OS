import { z } from 'zod'
import type { Milestone } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, requireUser, findOrgRecord } from '@/lib/api-helpers'
import type { MilestoneDTO, MilestoneStatus } from '@/lib/types'
import { MILESTONE_STATUS_VALUES } from '@/lib/types'

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

const patchSchema = z.object({
  status: z.enum(MILESTONE_STATUS_VALUES),
})

// PATCH /api/milestones/[id] — update milestone status.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params
    const body = await parseBody(req, patchSchema)

    const milestone = await findOrgRecord(db.milestone, id, user.organizationId, 'Milestone')

    const updated = await db.milestone.update({
      where: { id: milestone.id },
      data: { status: body.status },
      include: { site: { select: { name: true } } },
    })

    return ok(toMilestoneDTO(updated))
  })
}
