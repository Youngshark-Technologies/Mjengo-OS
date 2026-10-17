import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, ApiError, parseBody, requireUser } from '@/lib/api-helpers'
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

const decisionSchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED']),
})

// POST /api/evidence/[id]/verify — HUMAN decision only (OWNER/SUPERVISOR).
// No auto-approval, no timers, no defaults: a named person signs the verdict.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR'])
    const { id } = await params
    const body = await parseBody(req, decisionSchema)

    const evidence = await db.evidenceReport.findFirst({
      where: { id, organizationId: user.organizationId },
    })
    if (!evidence) throw new ApiError(404, 'Evidence report not found')
    if (evidence.status !== 'REPORTED') {
      throw new ApiError(422, 'Evidence has already been processed')
    }
    // Segregation of duties: whoever reported the evidence can never verify it.
    if (evidence.reportedById === user.id) {
      throw new ApiError(
        403,
        'Segregation of duties: the reporter cannot verify their own evidence — another supervisor must review it',
      )
    }

    const updated = await db.evidenceReport.update({
      where: { id: evidence.id },
      data: {
        status: body.decision,
        verifiedById: user.id, // the acting session user — never inferred, never defaulted
        verifiedAt: new Date(),
      },
      include: { site: true, milestone: true, reportedBy: true, verifiedBy: true },
    })

    return ok(toEvidenceDTO(updated))
  })
}
