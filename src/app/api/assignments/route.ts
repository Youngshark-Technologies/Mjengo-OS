import { z } from 'zod'
import { NextResponse } from 'next/server'
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
// MJG-072 — optional page/pageSize pagination (see GET below).
const querySchema = z.object({
  siteId: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  status: z.preprocess(v => (v === '' ? undefined : v), z.enum(ASSIGNMENT_STATUS_VALUES).optional()),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

const createSchema = z.object({
  workerId: z.string().min(1, 'workerId is required'),
  siteId: z.string().min(1, 'siteId is required'),
  startDate: optionalDate,
})

// GET /api/assignments?siteId=&status=[&page=&pageSize=] — postings, newest first.
// MJG-072: with page, returns that slice and an org-filtered X-Total-Count
// header; without page params the legacy behavior (array, take: 500, no
// header) is unchanged. id tiebreaker keeps slices deterministic on ties.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId, status, page, pageSize } = parseQuery(req, querySchema)

    const where: Prisma.AssignmentWhereInput = {
      organizationId: user.organizationId,
      ...(siteId ? { siteId } : {}),
      ...(status ? { status } : {}),
    }
    // pageSize only applies when page is present; no params → legacy take: 500.
    const paged = page !== undefined
    const take = paged ? (pageSize ?? 25) : 500

    const [assignments, total] = await Promise.all([
      db.assignment.findMany({
        where,
        include: { worker: true, site: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: paged ? (page - 1) * take : undefined,
        take,
      }),
      paged ? db.assignment.count({ where }) : Promise.resolve(0),
    ])

    const rows = assignments.map(toAssignmentDTO)
    if (!paged) return ok(rows)
    return NextResponse.json(
      { data: rows },
      { headers: { 'X-Total-Count': String(total) } },
    )
  })
}

// POST /api/assignments — assign an org worker to an org site.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(undefined, { orgType: ['CONSTRUCTOR'] })
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
