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
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser()
    if (user.role !== 'OWNER') {
      throw new ApiError(403, 'Only the organization owner can approve payments')
    }
    const { id } = await params
    const body = await parseBody(req, decisionSchema)

    const payment = await db.payment.findFirst({
      where: { id, organizationId: user.organizationId },
    })
    if (!payment) throw new ApiError(404, 'Payment not found')
    if (payment.status !== 'PENDING') {
      throw new ApiError(422, 'Payment has already been processed')
    }

    const updated = await db.payment.update({
      where: { id: payment.id },
      data: {
        status: body.decision,
        approvedById: user.id, // the acting session user — never inferred, never defaulted
        approvedAt: new Date(),
      },
      include: {
        site: true,
        milestone: true,
        purchaseOrder: true,
        recordedBy: true,
        approvedBy: true,
      },
    })

    return ok(toPaymentDTO(updated))
  })
}
