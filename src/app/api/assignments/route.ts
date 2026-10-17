import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok,
  handle,
  parseBody,
  parseQuery,
  requireUser,
  optionalDate,
  findOrgRecord,
} from '@/lib/api-helpers'
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

// Empty-string query params (e.g. ?siteId=&status=) are treated as absent.
const querySchema = z.object({
  siteId: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  status: z.preprocess(v => (v === '' ? undefined : v), z.enum(ASSIGNMENT_STATUS_VALUES).optional()),
})

const createSchema = z.object({
  workerId: z.string().min(1, 'workerId is required'),
  siteId: z.string().min(1, 'siteId is required'),
  startDate: optionalDate,
})

// GET /api/assignments?siteId=&status= — postings, newest first.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId, status } = parseQuery(req, querySchema)

    const assignments = await db.assignment.findMany({
      where: {
        organizationId: user.organizationId,
        ...(siteId ? { siteId } : {}),
        ...(status ? { status } : {}),
      },
      include: { worker: true, site: true },
      orderBy: { createdAt: 'desc' },
    })

    return ok(assignments.map(toAssignmentDTO))
  })
}

// POST /api/assignments — assign an org worker to an org site.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    await findOrgRecord(db.worker, body.workerId, user.organizationId, 'Worker')
    await findOrgRecord(db.site, body.siteId, user.organizationId, 'Site')

    const assignment = await db.assignment.create({
      data: {
        organizationId: user.organizationId,
        workerId: body.workerId,
        siteId: body.siteId,
        status: 'ASSIGNED',
        startDate: body.startDate ?? new Date(),
      },
      include: { worker: true, site: true },
    })

    return ok(toAssignmentDTO(assignment), 201)
  })
}
