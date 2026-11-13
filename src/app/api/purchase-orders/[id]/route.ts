import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ApiError, findOrgRecord, handle, ok, parseBody, requireUser } from '@/lib/api-helpers'
import {
  PO_STATUS_VALUES,
  type MaterialUnit,
  type POStatus,
  type PurchaseOrderDetailDTO,
  type PurchaseOrderDTO,
  type ShipmentDTO,
} from '@/lib/types'

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
    acknowledgedAt: po.acknowledgedAt ? po.acknowledgedAt.toISOString() : null,
    acknowledgedByOrganizationId: po.acknowledgedByOrganizationId,
    items: po.items.map(item => ({
      materialId: item.materialId,
      quantity: item.quantity,
      unitCost: item.unitCost,
      materialName: item.material.name,
      unit: item.material.unit as MaterialUnit,
    })),
  }
}

// MJG-036 — detail view adds the partner-ack org name and the supplier's
// shipment log (newest first, bounded) to the shared PO mapping.
const poDetailInclude = {
  ...poInclude,
  acknowledgedByOrganization: { select: { name: true } },
  shipments: { orderBy: { createdAt: 'desc' as const }, take: 50 },
} satisfies Prisma.PurchaseOrderInclude

type PurchaseOrderDetailRelations = Prisma.PurchaseOrderGetPayload<{ include: typeof poDetailInclude }>

function toShipmentDTO(shipment: PurchaseOrderDetailRelations['shipments'][number]): ShipmentDTO {
  return {
    id: shipment.id,
    purchaseOrderId: shipment.purchaseOrderId,
    organizationId: shipment.organizationId,
    carrierName: shipment.carrierName,
    trackingNo: shipment.trackingNo,
    shippedAt: shipment.shippedAt ? shipment.shippedAt.toISOString() : null,
    estimatedArrival: shipment.estimatedArrival ? shipment.estimatedArrival.toISOString() : null,
    notes: shipment.notes,
    createdAt: shipment.createdAt.toISOString(),
  }
}

function toPurchaseOrderDetailDTO(po: PurchaseOrderDetailRelations): PurchaseOrderDetailDTO {
  return {
    ...toPurchaseOrderDTO(po),
    acknowledgedByOrganizationName: po.acknowledgedByOrganization?.name ?? null,
    shipments: po.shipments.map(toShipmentDTO),
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
    const user = await requireUser(['OWNER', 'SUPERVISOR'], { orgType: ['CONSTRUCTOR'] })
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

// ─── GET /api/purchase-orders/[id] — org-scoped detail incl. partner ack/log ──

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser()

    const po = await findOrgRecord(db.purchaseOrder, id, user.organizationId, 'Purchase order')

    const full = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: po.id },
      include: poDetailInclude,
    })
    return ok(toPurchaseOrderDetailDTO(full))
  })
}
