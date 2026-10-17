import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, ApiError, parseBody, parseQuery, requireUser, findOrgRecord } from '@/lib/api-helpers'
import { ATTENDANCE_STATUS_VALUES } from '@/lib/types'
import type { AttendanceDTO, AttendanceStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

type AttendanceRow = Prisma.AttendanceGetPayload<{ include: { worker: true; site: true } }>

function toAttendanceDTO(row: AttendanceRow): AttendanceDTO {
  return {
    id: row.id,
    workerId: row.workerId,
    workerName: row.worker.name,
    siteId: row.siteId,
    siteName: row.site.name,
    date: row.date.toISOString().slice(0, 10),
    status: row.status as AttendanceStatus,
    hoursWorked: row.hoursWorked,
  }
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be formatted YYYY-MM-DD')
  .refine(v => !Number.isNaN(new Date(`${v}T00:00:00.000Z`).getTime()), 'date must be a real calendar day')

// 'YYYY-MM-DD' → exact UTC midnight (attendance days are normalized to UTC).
function utcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

// Empty-string query params (e.g. ?siteId=&date=) are treated as absent.
const querySchema = z.object({
  siteId: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  date: z.preprocess(v => (v === '' ? undefined : v), dateSchema.optional()),
})

const entrySchema = z.object({
  workerId: z.string().min(1, 'workerId is required'),
  status: z.enum(ATTENDANCE_STATUS_VALUES),
  hoursWorked: z.number().min(0, 'hoursWorked cannot be negative').default(8),
})

const createSchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
  date: dateSchema,
  entries: z.array(entrySchema).min(1, 'at least one attendance entry is required'),
})

// GET /api/attendance?siteId=&date=YYYY-MM-DD — day sheet for a site (defaults to today UTC).
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId, date } = parseQuery(req, querySchema)

    const dayStart = utcMidnight(date ?? todayUtc())
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

    const attendance = await db.attendance.findMany({
      where: {
        organizationId: user.organizationId,
        ...(siteId ? { siteId } : {}),
        date: { gte: dayStart, lt: dayEnd },
      },
      include: { worker: true, site: true },
      orderBy: [{ worker: { name: 'asc' } }, { siteId: 'asc' }],
    })

    return ok(attendance.map(toAttendanceDTO))
  })
}

// POST /api/attendance — OWNER/SUPERVISOR submit a day sheet; upserts per worker/site/day.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR'])
    const body = await parseBody(req, createSchema)

    await findOrgRecord(db.site, body.siteId, user.organizationId, 'Site')

    const workerIds = [...new Set(body.entries.map(entry => entry.workerId))]
    const workers = await db.worker.findMany({
      where: { organizationId: user.organizationId, id: { in: workerIds } },
      select: { id: true },
    })
    if (workers.length !== workerIds.length) throw new ApiError(404, 'Worker not found')

    const date = utcMidnight(body.date)
    const rows = await db.$transaction(
      body.entries.map(entry =>
        db.attendance.upsert({
          where: {
            workerId_siteId_date: {
              workerId: entry.workerId,
              siteId: body.siteId,
              date,
            },
          },
          create: {
            organizationId: user.organizationId,
            siteId: body.siteId,
            workerId: entry.workerId,
            date,
            status: entry.status,
            hoursWorked: entry.hoursWorked,
          },
          update: {
            status: entry.status,
            hoursWorked: entry.hoursWorked,
          },
          include: { worker: true, site: true },
        }),
      ),
    )

    return ok(rows.map(toAttendanceDTO), 201)
  })
}
