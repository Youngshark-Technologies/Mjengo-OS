import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, ApiError, parseBody, requireUser } from '@/lib/api-helpers'
import { ASSIGNMENT_STATUS_VALUES } from '@/lib/types'
import type { AssignmentDTO, AssignmentStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

type AssignmentRow = Prisma.AssignmentGetPayload<{ include: { worker: true; site: true } }>

function toAssignmentDTO(row: AssignmentRow): AssignmentDTO {
  return {
    id: row.id,
    workerId: row.workerId,
    workerName: row.worker.name,
    trade: row.worker.trade as AssignmentDTO['trade'],
    siteId: row.siteId,
    siteName: row.site.name,
    status: row.status as AssignmentStatus,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate ? row.endDate.toISOString() : null,
  }
}

const patchSchema = z.object({
  status: z.enum(ASSIGNMENT_STATUS_VALUES),
})

// PATCH /api/assignments/[id] — move an assignment through ASSIGNED → ACTIVE → COMPLETED.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params
    const body = await parseBody(req, patchSchema)

    const existing = await db.assignment.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true },
    })
    if (!existing) throw new ApiError(404, 'Assignment not found')

    const assignment = await db.assignment.update({
      where: { id: existing.id },
      data: {
        status: body.status,
        endDate: body.status === 'COMPLETED' ? new Date() : null,
      },
      include: { worker: true, site: true },
    })

    return ok(toAssignmentDTO(assignment))
  })
}
