import { db } from '@/lib/db'
import { ok, handle, ApiError, requireUser } from '@/lib/api-helpers'
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

// POST /api/payments/[id]/mark-paid — OWNER only, takes no input.
// Only payments the owner has explicitly APPROVED can be marked PAID.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(['OWNER'])
    const { id } = await params

    const payment = await db.payment.findFirst({
      where: { id, organizationId: user.organizationId },
    })
    if (!payment) throw new ApiError(404, 'Payment not found')
    if (payment.status !== 'APPROVED') {
      throw new ApiError(422, 'Payment must be approved before it can be marked paid')
    }

    const updated = await db.payment.update({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
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
