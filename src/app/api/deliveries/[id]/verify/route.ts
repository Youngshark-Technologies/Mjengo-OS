import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ApiError, findOrgRecord, handle, ok, parseBody, requireUser } from '@/lib/api-helpers'
import type { DeliveryDTO, DeliveryStatus, MaterialUnit } from '@/lib/types'

// HUMAN VERIFICATION ONLY — stock is applied exclusively through this endpoint
// by an authenticated OWNER/SUPERVISOR session; the acting user is recorded on
// both the Delivery (verifiedById) and each StockMovement (userId).
// Idempotency: StockMovement.deliveryId is @unique, so a delivery can never
// double-apply stock even under a race with the PENDING check below.

// ─── DTO mapping ──────────────────────────────────────────────────────────────

const deliveryInclude = {
  items: { include: { material: true } },
  site: true,
  supplier: true,
} satisfies Prisma.DeliveryInclude

type DeliveryWithRelations = Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>

function toDeliveryDTO(delivery: DeliveryWithRelations, verifiedByName: string | null): DeliveryDTO {
  return {
    id: delivery.id,
    siteId: delivery.siteId,
    siteName: delivery.site.name,
    purchaseOrderId: delivery.purchaseOrderId,
    supplierName: delivery.supplier?.name ?? null,
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

// ─── Validation ───────────────────────────────────────────────────────────────

const verifySchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  accept: z
    .array(
      z.object({
        materialId: z.string().min(1, 'materialId is required'),
        quantityAccepted: z.number().min(0, 'quantityAccepted must be 0 or greater'),
      }),
    )
    .optional(),
})

// ─── POST /api/deliveries/[id]/verify — verify or reject a PENDING delivery ───

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser(['OWNER', 'SUPERVISOR'])
    const body = await parseBody(req, verifySchema)

    const delivery = await findOrgRecord(db.delivery, id, user.organizationId, 'Delivery')
    if (delivery.status !== 'PENDING') {
      throw new ApiError(422, 'Delivery has already been processed')
    }

    const items = await db.deliveryItem.findMany({ where: { deliveryId: delivery.id } })

    // Resolve accepted quantities: explicit accept entry wins, else full amount.
    const resolved = items.map(item => {
      const entry = body.accept?.find(a => a.materialId === item.materialId)
      return { item, accepted: entry ? entry.quantityAccepted : item.quantityDelivered }
    })
    if (body.decision === 'VERIFIED') {
      for (const { item, accepted } of resolved) {
        if (accepted > item.quantityDelivered) {
          throw new ApiError(422, 'Accepted quantity cannot exceed delivered quantity')
        }
      }
    }

    let updated: DeliveryWithRelations
    try {
      updated = await db.$transaction(async tx => {
        const fresh = await tx.delivery.findUnique({ where: { id: delivery.id } })
        if (!fresh || fresh.status !== 'PENDING') {
          throw new ApiError(422, 'Delivery has already been processed')
        }

        if (body.decision === 'VERIFIED') {
          // StockMovement.deliveryId is @unique → at most ONE movement may
          // reference a delivery. Per-item movements keep exact quantities;
          // the first applied item carries the deliveryId so the unique index
          // still guarantees a verified delivery can never double-apply stock
          // (single-item deliveries — the common case — attach it directly).
          const guardIndex = resolved.findIndex(r => r.accepted > 0)
          for (const [index, { item, accepted }] of resolved.entries()) {
            if (accepted > 0) {
              await tx.stockLevel.upsert({
                where: {
                  siteId_materialId: { siteId: delivery.siteId, materialId: item.materialId },
                },
                create: {
                  organizationId: user.organizationId,
                  siteId: delivery.siteId,
                  materialId: item.materialId,
                  quantity: accepted,
                },
                update: { quantity: { increment: accepted } },
              })
              await tx.stockMovement.create({
                data: {
                  organizationId: user.organizationId,
                  siteId: delivery.siteId,
                  materialId: item.materialId,
                  type: 'IN',
                  quantity: accepted,
                  reason: 'Verified delivery',
                  deliveryId: index === guardIndex ? delivery.id : null,
                  userId: user.id,
                },
              })
            }
            await tx.deliveryItem.update({
              where: { id: item.id },
              data: { quantityAccepted: accepted },
            })
          }
        }

        return tx.delivery.update({
          where: { id: delivery.id },
          data: {
            status: body.decision,
            verifiedById: user.id,
            verifiedAt: new Date(),
          },
          include: deliveryInclude,
        })
      })
    } catch (err) {
      // Concurrent verification: the @unique movement guard turns a double
      // apply into a constraint violation → report as already processed.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(409, 'Delivery has already been processed')
      }
      throw err
    }

    let verifiedByName: string | null = null
    if (updated.verifiedById) {
      const verifier = await db.user.findFirst({
        where: { id: updated.verifiedById, organizationId: user.organizationId },
        select: { name: true },
      })
      verifiedByName = verifier?.name ?? null
    }
    return ok(toDeliveryDTO(updated, verifiedByName))
  })
}
