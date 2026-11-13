import { db } from '@/lib/db'
import { ApiError, handle, ok, requireUser } from '@/lib/api-helpers'

// MJG-036 (c) — supplier partner acknowledges a purchase order.
// Visibility mirrors GET /api/partner/purchase-orders (MJG-035): the PO's
// supplier record must be LINKED to this partner organization and the PO must
// have actually left the constructor's desk (DRAFT is private to the
// constructor → indistinguishable 404). Read-only for the partner except this
// stamp: acknowledgedAt / acknowledgedByOrganizationId. The PO status FSM
// (PATCH /api/purchase-orders/[id]) and the constructor's payment flow remain
// untouched. Idempotency: write predicated on acknowledgedAt IS NULL — a
// losing concurrent write updates 0 rows → 409 (same pattern as payment
// approve, MJG-063).

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser()
    if (user.organizationType !== 'SUPPLIER') {
      throw new ApiError(403, 'The partner portal is available to supplier organizations')
    }

    const po = await db.purchaseOrder.findFirst({
      where: {
        id,
        status: { not: 'DRAFT' },
        supplier: { partnerOrganizationId: user.organizationId },
      },
      select: { id: true, status: true, acknowledgedAt: true },
    })
    if (!po) throw new ApiError(404, 'Purchase order not found')

    const result = await db.purchaseOrder.updateMany({
      where: { id: po.id, acknowledgedAt: null },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedByOrganizationId: user.organizationId,
      },
    })
    if (result.count === 0) {
      throw new ApiError(409, 'Purchase order has already been acknowledged')
    }

    return ok({
      id: po.id,
      status: po.status,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedByOrganizationId: user.organizationId,
    })
  })
}
