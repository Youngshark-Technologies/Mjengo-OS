import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ApiError, findOrgRecord, handle, ok, parseBody, requireUser } from '@/lib/api-helpers'
import { PO_STATUS_VALUES, type MaterialUnit, type POStatus, type PurchaseOrderDTO } from '@/lib/types'

// ─── DTO mapping ──────────────────────────────────────────────────────────────

const poInclude = {
  items: { include: { material: true } },
  site: true,
  supplier: true,
} satisfies Prisma.PurchaseOrderInclude

type PurchaseOrderWithRelations = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>

function toPurchaseOrderDTO(po: PurchaseOrderWithRelations): PurchaseOrderDTO {
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
    items: po.items.map(item => ({
      materialId: item.materialId,
      quantity: item.quantity,
      unitCost: item.unitCost,
      materialName: item.material.name,
      unit: item.material.unit as MaterialUnit,
    })),
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

const patchPOSchema = z.object({
  status: z.enum(PO_STATUS_VALUES),
})

// Explicit finite-state machine: anything not listed here is a 422.
const ALLOWED_TRANSITIONS: Record<POStatus, POStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
}

// ─── PATCH /api/purchase-orders/[id] — guarded status transition ──────────────

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser(['OWNER', 'SUPERVISOR'])
    const body = await parseBody(req, patchPOSchema)

    const po = await findOrgRecord(db.purchaseOrder, id, user.organizationId, 'Purchase order')

    const currentStatus = po.status as POStatus
    if (!ALLOWED_TRANSITIONS[currentStatus].includes(body.status)) {
      throw new ApiError(422, `Invalid status transition from ${currentStatus} to ${body.status}`)
    }

    const updated = await db.purchaseOrder.update({
      where: { id: po.id },
      data: { status: body.status },
      include: poInclude,
    })
    return ok(toPurchaseOrderDTO(updated))
  })
}
