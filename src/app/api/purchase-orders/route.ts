import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  ApiError,
  findOrgRecord,
  handle,
  ok,
  optionalDate,
  parseBody,
  parseQuery,
  requireUser,
} from '@/lib/api-helpers'
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

const listQuerySchema = z.object({
  siteId: z.string().min(1).optional(),
  status: z.enum(PO_STATUS_VALUES).optional(),
})

const poItemSchema = z.object({
  materialId: z.string().min(1, 'materialId is required'),
  quantity: z.number().positive('quantity must be greater than 0'),
  unitCost: z.number().min(0, 'unitCost must be 0 or greater'),
})

const createPOSchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
  supplierId: z.string().min(1, 'supplierId is required'),
  expectedDate: optionalDate,
  notes: z.string().nullish().transform(v => v ?? ''),
  items: z.array(poItemSchema).min(1, 'At least one item is required'),
})

// ─── GET /api/purchase-orders — list POs, optional siteId/status filters ──────

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const query = await parseQuery(req, listQuerySchema)

    const purchaseOrders = await db.purchaseOrder.findMany({
      where: {
        organizationId: user.organizationId,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: poInclude,
      orderBy: { createdAt: 'desc' },
    })
    return ok(purchaseOrders.map(toPurchaseOrderDTO))
  })
}

// ─── POST /api/purchase-orders — create DRAFT order with line items ───────────

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR'])
    const body = await parseBody(req, createPOSchema)

    // Org-ownership checks (404 keeps cross-tenant ids indistinguishable).
    await findOrgRecord(db.site, body.siteId, user.organizationId, 'Site')
    await findOrgRecord(db.supplier, body.supplierId, user.organizationId, 'Supplier')

    const materialIds = [...new Set(body.items.map(item => item.materialId))]
    const materials = await db.material.findMany({
      where: { organizationId: user.organizationId, id: { in: materialIds } },
      select: { id: true },
    })
    if (materials.length !== materialIds.length) {
      throw new ApiError(404, 'Material not found')
    }

    const purchaseOrder = await db.purchaseOrder.create({
      data: {
        organizationId: user.organizationId,
        siteId: body.siteId,
        supplierId: body.supplierId,
        status: 'DRAFT',
        expectedDate: body.expectedDate,
        notes: body.notes,
        items: {
          create: body.items.map(item => ({
            materialId: item.materialId,
            quantity: item.quantity,
            unitCost: item.unitCost,
          })),
        },
      },
      include: poInclude,
    })
    return ok(toPurchaseOrderDTO(purchaseOrder), 201)
  })
}
