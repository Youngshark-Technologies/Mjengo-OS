import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, handle, ok, requireUser } from '@/lib/api-helpers'
import type { DeliveryStatus, POStatus, PartnerDeliveryTaskDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// MJG-036 (b) — logistics partner portal: delivery tasks assigned to this
// organization. A constructor picks the carrier at delivery creation
// (Delivery.carrierOrganizationId — a deliberate cross-org reference, like
// partner PO visibility). Read-only listing here; the only partner-side write
// is the acknowledgment below, which NEVER touches the constructor's
// human delivery-verification / stock flow.

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

// ─── GET /api/partner/delivery-tasks — newest first, take 500 ─────────────────

export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    if (user.organizationType !== 'LOGISTICS') {
      throw new ApiError(403, 'The partner portal is available to logistics organizations')
    }

    const deliveries = await db.delivery.findMany({
      where: { carrierOrganizationId: user.organizationId },
      include: taskInclude,
      orderBy: { createdAt: 'desc' },
      take: 500,
    })

    return ok(deliveries.map(toDeliveryTaskDTO))
  })
}
