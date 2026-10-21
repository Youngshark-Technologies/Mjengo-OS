import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { handle, ok, ApiError, requireUser } from '@/lib/api-helpers'
import type { MaterialUnit, POStatus, PartnerPurchaseOrderDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// MJG-035 — partner portal: a SUPPLIER organization's view of the purchase
// orders addressed to it. Visibility rules:
//   - only POs whose supplier record is LINKED to this organization;
//   - only POs that actually left the constructor's desk: DRAFT never leaves
//     the constructor org (SENT / RECEIVED / CANCELLED are visible);
//   - read-only: the constructor's human workflow (verify delivery, pay)
//     remains untouched in this phase (MJG-036 tracks accept/acknowledge).

const poInclude = {
  items: { include: { material: true } },
  site: true,
  supplier: { include: { organization: { select: { name: true } } } },
} satisfies Prisma.PurchaseOrderInclude

type PurchaseOrderWithRelations = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>

function toPartnerPODTO(po: PurchaseOrderWithRelations): PartnerPurchaseOrderDTO {
  const total = po.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
  return {
    id: po.id,
    siteId: po.siteId,
    siteName: po.site.name,
    supplierId: po.supplierId,
    supplierName: po.supplier.name,
    status: po.status as POStatus,
    orderDate: po.orderDate.toISOString(),
    expectedDate: po.expectedDate ? po.expectedDate.toISOString() : null,
    notes: po.notes,
    total,
    organizationName: po.supplier.organization.name,
    items: po.items.map(item => ({
      materialId: item.materialId,
      quantity: item.quantity,
      unitCost: item.unitCost,
      materialName: item.material.name,
      unit: item.material.unit as MaterialUnit,
    })),
  }
}

export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    if (user.organizationType !== 'SUPPLIER') {
      throw new ApiError(403, 'The partner portal is available to supplier organizations')
    }

    // Supplier records across ALL constructor orgs that point at this partner org.
    const linkedSupplierIds = await db.supplier.findMany({
      where: { partnerOrganizationId: user.organizationId },
      select: { id: true },
    })

    if (linkedSupplierIds.length === 0) return ok([])

    const pos = await db.purchaseOrder.findMany({
      where: {
        supplierId: { in: linkedSupplierIds.map(s => s.id) },
        status: { not: 'DRAFT' },
      },
      orderBy: { orderDate: 'desc' },
      include: poInclude,
    })

    return ok(pos.map(toPartnerPODTO))
  })
}
