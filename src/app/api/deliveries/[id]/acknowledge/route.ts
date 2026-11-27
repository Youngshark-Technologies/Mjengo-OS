import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, handle, ok, requireUser } from '@/lib/api-helpers'
import type { DeliveryStatus, POStatus, PartnerDeliveryTaskDTO } from '@/lib/types'

// MJG-036 (b) — logistics-side acknowledgment of a delivery task.
// Guard: LOGISTICS org session AND the delivery must be assigned to exactly
// this org (foreign/unknown ids → 404, keeping cross-tenant ids
// indistinguishable). Acknowledgment is a transport-lifecycle stamp ONLY:
// it never changes Delivery.status and NEVER creates StockMovements — the
// constructor's human verify flow (single stock apply) stays untouched.
// Idempotency: the write is predicated on acknowledgedAt IS NULL; a losing
// concurrent write updates 0 rows → 409 (same pattern as payment approve).

const taskInclude = {
  site: { select: { name: true } },
  purchaseOrder: { select: { status: true } },
  organization: { select: { name: true } },
} satisfies Prisma.DeliveryInclude

type DeliveryWithRelations = Prisma.DeliveryGetPayload<{ include: typeof taskInclude }>

function toDeliveryTaskDTO(delivery: DeliveryWithRelations): PartnerDeliveryTaskDTO {
  return {
    id: delivery.id,
    siteId: delivery.siteId,
    siteName: delivery.site.name,
    purchaseOrderId: delivery.purchaseOrderId,
    purchaseOrderStatus: (delivery.purchaseOrder?.status as POStatus) ?? null,
    constructorName: delivery.organization.name,
    status: delivery.status as DeliveryStatus,
    deliveredAt: delivery.deliveredAt.toISOString(),
    acknowledgedAt: delivery.acknowledgedAt ? delivery.acknowledgedAt.toISOString() : null,
    notes: delivery.notes,
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser()
    if (user.organizationType !== 'LOGISTICS') {
      throw new ApiError(403, 'The partner portal is available to logistics organizations')
    }

    const delivery = await db.delivery.findFirst({
      where: { id, carrierOrganizationId: user.organizationId },
      select: { id: true, acknowledgedAt: true },
    })
    if (!delivery) throw new ApiError(404, 'Delivery not found')

    const result = await db.delivery.updateMany({
      where: { id: delivery.id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedById: user.id },
    })
    if (result.count === 0) {
      throw new ApiError(409, 'Delivery task has already been acknowledged')
    }

    const updated = await db.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
      include: taskInclude,
    })
    return ok(toDeliveryTaskDTO(updated))
  })
}
