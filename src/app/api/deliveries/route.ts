import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  ApiError,
  findOrgRecord,
  handle,
  ok,
  parseBody,
  parseQuery,
  requireUser,
} from '@/lib/api-helpers'
import {
  DELIVERY_STATUS_VALUES,
  type DeliveryDTO,
  type DeliveryStatus,
  type MaterialUnit,
} from '@/lib/types'

// ─── DTO mapping ──────────────────────────────────────────────────────────────
// NOTE: Delivery carries verifiedById but no verifiedBy relation in the schema,
// so verifier names are resolved with a separate org-scoped User query.

const deliveryInclude = {
  items: { include: { material: true } },
  site: true,
  supplier: true,
  // MJG-016: deliveries created against a PO may carry no explicit supplier;
  // the PO's supplier is the display fallback (also repairs legacy rows).
  purchaseOrder: { include: { supplier: true } },
} satisfies Prisma.DeliveryInclude

type DeliveryWithRelations = Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>

function toDeliveryDTO(delivery: DeliveryWithRelations, verifiedByName: string | null): DeliveryDTO {
  return {
    id: delivery.id,
    siteId: delivery.siteId,
    siteName: delivery.site.name,
    purchaseOrderId: delivery.purchaseOrderId,
    // MJG-016: explicit supplier wins, then the linked PO's supplier, then null.
    supplierName: delivery.supplier?.name ?? delivery.purchaseOrder?.supplier?.name ?? null,
    status: delivery.status as DeliveryStatus,
    deliveredAt: delivery.deliveredAt.toISOString(),
    verifiedByName,
    verifiedAt: delivery.verifiedAt ? delivery.verifiedAt.toISOString() : null,
    notes: delivery.notes,
    items: delivery.items.map(item => ({
      materialId: item.materialId,
      materialName: item.material.name,
      unit: item.material.unit as MaterialUnit,
      quantityDelivered: item.quantityDelivered,
      quantityAccepted: item.quantityAccepted,
    })),
  }
}

async function verifierNameMap(ids: (string | null)[], organizationId: string): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => id !== null))]
  if (uniqueIds.length === 0) return new Map()
  const verifiers = await db.user.findMany({
    where: { organizationId, id: { in: uniqueIds } },
    select: { id: true, name: true },
  })
  return new Map(verifiers.map(v => [v.id, v.name]))
}

// ─── Validation ───────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  siteId: z.string().min(1).optional(),
  status: z.enum(DELIVERY_STATUS_VALUES).optional(),
})

const deliveryItemSchema = z.object({
  materialId: z.string().min(1, 'materialId is required'),
  quantityDelivered: z.number().positive('quantityDelivered must be greater than 0'),
})

const createDeliverySchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
  purchaseOrderId: z.union([z.string().min(1), z.literal('')]).nullish().transform(v => (v ? v : null)),
  supplierId: z.union([z.string().min(1), z.literal('')]).nullish().transform(v => (v ? v : null)),
  notes: z.string().nullish().transform(v => v ?? ''),
  items: z.array(deliveryItemSchema).min(1, 'At least one item is required'),
})

// ─── GET /api/deliveries — list deliveries, optional siteId/status filters ────

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const query = await parseQuery(req, listQuerySchema)

    const deliveries = await db.delivery.findMany({
      where: {
        organizationId: user.organizationId,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: deliveryInclude,
      orderBy: { createdAt: 'desc' },
    })

    const names = await verifierNameMap(deliveries.map(d => d.verifiedById), user.organizationId)
    return ok(deliveries.map(d => toDeliveryDTO(d, (d.verifiedById && names.get(d.verifiedById)) || null)))
  })
}

// ─── POST /api/deliveries — anyone records an incoming delivery ───────────────

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR', 'WORKER'])
    const body = await parseBody(req, createDeliverySchema)

    // Org-ownership checks (404 keeps cross-tenant ids indistinguishable).
    await findOrgRecord(db.site, body.siteId, user.organizationId, 'Site')
    let poSupplierId: string | null = null
    if (body.purchaseOrderId) {
      // MJG-016: the PO is loaded anyway for the ownership check — capture its
      // supplier so the delivery denormalizes it when none is explicitly given.
      const po = await findOrgRecord(db.purchaseOrder, body.purchaseOrderId, user.organizationId, 'Purchase order')
      poSupplierId = po.supplierId
    }
    if (body.supplierId) {
      await findOrgRecord(db.supplier, body.supplierId, user.organizationId, 'Supplier')
    }

    const materialIds = [...new Set(body.items.map(item => item.materialId))]
    const materials = await db.material.findMany({
      where: { organizationId: user.organizationId, id: { in: materialIds } },
      select: { id: true },
    })
    if (materials.length !== materialIds.length) {
      throw new ApiError(404, 'Material not found')
    }

    const delivery = await db.delivery.create({
      data: {
        organizationId: user.organizationId,
        siteId: body.siteId,
        purchaseOrderId: body.purchaseOrderId,
        // MJG-016: explicit supplier wins; otherwise inherit the PO's supplier.
        supplierId: body.supplierId ?? poSupplierId,
        status: 'PENDING',
        notes: body.notes,
        items: {
          create: body.items.map(item => ({
            materialId: item.materialId,
            quantityDelivered: item.quantityDelivered,
          })),
        },
      },
      include: deliveryInclude,
    })
    return ok(toDeliveryDTO(delivery, null), 201)
  })
}
