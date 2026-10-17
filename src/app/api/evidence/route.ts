import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, parseQuery, requireUser, findOrgRecord } from '@/lib/api-helpers'
import { EVIDENCE_STATUS_VALUES } from '@/lib/types'
import type { EvidenceDTO, EvidenceStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

type EvidenceRow = Prisma.EvidenceReportGetPayload<{
  include: { site: true; milestone: true; reportedBy: true; verifiedBy: true }
}>

function toEvidenceDTO(row: EvidenceRow): EvidenceDTO {
  return {
    id: row.id,
    siteId: row.siteId,
    siteName: row.site.name,
    milestoneId: row.milestoneId,
    milestoneName: row.milestone?.name ?? null,
    title: row.title,
    description: row.description,
    photoUrl: row.photoUrl,
    status: row.status as EvidenceStatus,
    reportedById: row.reportedById,
    reportedByName: row.reportedBy.name,
    verifiedById: row.verifiedById,
    verifiedByName: row.verifiedBy?.name ?? null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

// Empty-string query params (e.g. ?siteId=&status=) are treated as absent.
const querySchema = z.object({
  siteId: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  status: z.preprocess(v => (v === '' ? undefined : v), z.enum(EVIDENCE_STATUS_VALUES).optional()),
})

const createSchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
  milestoneId: z.string().min(1, 'milestoneId cannot be empty').optional(),
  title: z.string().trim().min(3, 'title must be at least 3 characters'),
  description: z.string().optional(),
  photoUrl: z
    .string()
    .regex(/^https?:\/\/\S+$/i, 'photoUrl must be an http(s) URL')
    .optional(),
})

// GET /api/evidence?siteId=&status= — evidence feed, newest first.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId, status } = parseQuery(req, querySchema)

    const evidence = await db.evidenceReport.findMany({
      where: {
        organizationId: user.organizationId,
        ...(siteId ? { siteId } : {}),
        ...(status ? { status } : {}),
      },
      include: { site: true, milestone: true, reportedBy: true, verifiedBy: true },
      orderBy: { createdAt: 'desc' },
    })

    return ok(evidence.map(toEvidenceDTO))
  })
}

// POST /api/evidence — any crew member can report field evidence. Human verification happens later.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    await findOrgRecord(db.site, body.siteId, user.organizationId, 'Site')
    if (body.milestoneId) {
      await findOrgRecord(db.milestone, body.milestoneId, user.organizationId, 'Milestone')
    }

    const evidence = await db.evidenceReport.create({
      data: {
        organizationId: user.organizationId,
        siteId: body.siteId,
        milestoneId: body.milestoneId ?? null,
        title: body.title,
        description: body.description ?? '',
        photoUrl: body.photoUrl ?? null,
        status: 'REPORTED',
        reportedById: user.id,
      },
      include: { site: true, milestone: true, reportedBy: true, verifiedBy: true },
    })

    return ok(toEvidenceDTO(evidence), 201)
  })
}
