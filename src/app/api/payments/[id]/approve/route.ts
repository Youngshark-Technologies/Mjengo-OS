import { z } from 'zod'
import { db } from '@/lib/db'
import { ok, handle, ApiError, parseBody, requireUser } from '@/lib/api-helpers'
import type { Prisma } from '@prisma/client'
import type { PaymentDTO, PaymentStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

type PaymentRow = Prisma.PaymentGetPayload<{
  include: {
    site: true
    milestone: true
    purchaseOrder: true
    recordedBy: true
    approvedBy: true
  }
}>

function toPaymentDTO(row: PaymentRow): PaymentDTO {
  return {
    id: row.id,
    siteId: row.siteId,
    siteName: row.site.name,
    purchaseOrderId: row.purchaseOrderId,
    milestoneId: row.milestoneId,
    milestoneName: row.milestone?.name ?? null,
    category: row.category as PaymentDTO['category'],
    method: row.method as PaymentDTO['method'],
    amount: row.amount,
    status: row.status as PaymentStatus,
    reference: row.reference,
    notes: row.notes,
    recordedByName: row.recordedBy.name,
    approvedByName: row.approvedBy?.name ?? null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
})

// POST /api/payments/[id]/approve — HUMAN decision, OWNER only.
// Money leaves the organization only after a named owner signs off.
// MJG-064 — the OWNER-only red line and the CONSTRUCTOR org guard are now one
// requireUser call (same shape as every other guarded route).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(['OWNER'], { orgType: ['CONSTRUCTOR'] })
    const { id } = await params
    const body = await parseBody(req, decisionSchema)

    const updated = await db.$transaction(async tx => {
      // MJG-063 — the initial read only distinguishes 404 (missing or foreign
      // org) from the conflict below. The PENDING → decision transition is
      // enforced by the WRITE predicate itself, not by this read: under
      // Postgres READ COMMITTED two concurrent approvals both saw `PENDING`
      // here, and the old `update({ where: { id } })` let the second one
      // blindly overwrite the first (last-writer-wins).
      const payment = await tx.payment.findFirst({
        where: { id, organizationId: user.organizationId },
      })
      if (!payment) throw new ApiError(404, 'Payment not found')

      // Conditional write: of two racing approvals exactly one matches
      // status: 'PENDING'; the loser updates 0 rows and gets 409.
      // (organizationId is redundant after the org-scoped read above — kept in
      // the predicate as tenancy defense-in-depth.)
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, organizationId: user.organizationId, status: 'PENDING' },
        data: {
          status: body.decision,
          approvedById: user.id, // the acting session user — never inferred, never defaulted
          approvedAt: new Date(),
        },
      })
      if (claimed.count === 0) {
        throw new ApiError(409, 'Payment is no longer pending')
      }

      const fresh = await tx.payment.findFirst({
        where: { id: payment.id, organizationId: user.organizationId },
        include: {
          site: true,
          milestone: true,
          purchaseOrder: true,
          recordedBy: true,
          approvedBy: true,
        },
      })
      if (!fresh) throw new ApiError(404, 'Payment not found') // unreachable: row was just updated in-tx
      return fresh
    })

    return ok(toPaymentDTO(updated))
  })
}
