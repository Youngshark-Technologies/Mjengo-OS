import type { Shipment } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ApiError, handle, ok, optionalDate, parseBody, requireUser } from '@/lib/api-helpers'
import type { POStatus, ShipmentDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// MJG-036 (c) — supplier partner shipment log. A SUPPLIER partner org logs
// carrier/tracking facts against a purchase order it can see (MJG-035 rules:
// supplier record LINKED to this org; DRAFT never left the constructor →
// indistinguishable 404). Logging rides a live order: the PO FSM must be
// SENT or RECEIVED — CANCELLED is a terminal dead order → 422. Shipments are
// a partner-side log: no stock, no PO status change, no payment effect.

function toShipmentDTO(shipment: Shipment): ShipmentDTO {
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

// ─── Validation ───────────────────────────────────────────────────────────────
// .strict() rejects unknown fields outright (silent stripping would hide typos
// like `trakingNo`); optionalDate accepts ISO date/datetime, '' or null.

const createShipmentSchema = z
  .object({
    carrierName: z.string().min(1, 'carrierName is required'),
    trackingNo: z.string().nullish().transform(v => (v && v.length > 0 ? v : null)),
    shippedAt: optionalDate,
    estimatedArrival: optionalDate,
    notes: z.string().nullish().transform(v => (v && v.length > 0 ? v : null)),
  })
  .strict()

async function findVisiblePartnerPO(id: string, partnerOrganizationId: string) {
  return db.purchaseOrder.findFirst({
    where: {
      id,
      status: { not: 'DRAFT' },
      supplier: { partnerOrganizationId },
    },
    select: { id: true, status: true },
  })
}

// ─── POST /api/partner/purchase-orders/[id]/shipments — log a shipment ────────

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser()
    if (user.organizationType !== 'SUPPLIER') {
      throw new ApiError(403, 'The partner portal is available to supplier organizations')
    }
    const body = await parseBody(req, createShipmentSchema)

    const po = await findVisiblePartnerPO(id, user.organizationId)
    if (!po) throw new ApiError(404, 'Purchase order not found')

    const status = po.status as POStatus
    if (status !== 'SENT' && status !== 'RECEIVED') {
      throw new ApiError(
        422,
        `Shipments can only be logged against a SENT or RECEIVED purchase order (current status: ${status})`,
      )
    }

    const shipment = await db.shipment.create({
      data: {
        purchaseOrderId: po.id,
        organizationId: user.organizationId, // tenancy anchor: the logging supplier org
        carrierName: body.carrierName,
        trackingNo: body.trackingNo,
        shippedAt: body.shippedAt,
        estimatedArrival: body.estimatedArrival,
        notes: body.notes,
      },
    })
    return ok(toShipmentDTO(shipment), 201)
  })
}

// ─── GET /api/partner/purchase-orders/[id]/shipments — own log, newest first ──

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params
    const user = await requireUser()
    if (user.organizationType !== 'SUPPLIER') {
      throw new ApiError(403, 'The partner portal is available to supplier organizations')
    }

    const po = await findVisiblePartnerPO(id, user.organizationId)
    if (!po) throw new ApiError(404, 'Purchase order not found')

    const shipments = await db.shipment.findMany({
      where: { purchaseOrderId: po.id, organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return ok(shipments.map(toShipmentDTO))
  })
}
