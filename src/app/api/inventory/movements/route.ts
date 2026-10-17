import { z } from 'zod'
import type { StockMovement } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, parseQuery, requireUser, ApiError } from '@/lib/api-helpers'
import type { MovementType, StockMovementDTO } from '@/lib/types'
import { MOVEMENT_TYPE_VALUES } from '@/lib/types'

export const dynamic = 'force-dynamic'

type MovementWithRefs = StockMovement & { site: { name: string }; material: { name: string } }

function toMovementDTO(movement: MovementWithRefs): StockMovementDTO {
  return {
    id: movement.id,
    siteId: movement.siteId,
    siteName: movement.site.name,
    materialName: movement.material.name,
    type: movement.type as MovementType,
    quantity: movement.quantity,
    reason: movement.reason,
    createdAt: movement.createdAt.toISOString(),
  }
}

const querySchema = z.object({
  siteId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const createSchema = z
  .object({
    siteId: z.string().min(1, 'siteId is required'),
    materialId: z.string().min(1, 'materialId is required'),
    type: z.enum(MOVEMENT_TYPE_VALUES),
    quantity: z.coerce.number().finite('quantity must be a finite number'),
    reason: z.string().default(''),
  })
  .refine(v => v.type === 'ADJUST' || v.quantity > 0, {
    message: 'quantity must be > 0 for IN/OUT movements',
    path: ['quantity'],
  })
  .refine(v => v.type !== 'ADJUST' || v.quantity >= 0, {
    message: 'quantity must be >= 0 for ADJUST movements',
    path: ['quantity'],
  })

// GET /api/inventory/movements?siteId=&limit=50 — movement ledger, newest first.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId, limit } = parseQuery(req, querySchema)

    const movements = await db.stockMovement.findMany({
      where: { organizationId: user.organizationId, ...(siteId ? { siteId } : {}) },
      include: {
        site: { select: { name: true } },
        material: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return ok(movements.map(toMovementDTO))
  })
}

// POST /api/inventory/movements — record IN/OUT/ADJUST and apply it to the stock level.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    const site = await db.site.findFirst({
      where: { id: body.siteId, organizationId: user.organizationId },
      select: { id: true, name: true },
    })
    if (!site) throw new ApiError(404, 'Site not found')

    const material = await db.material.findFirst({
      where: { id: body.materialId, organizationId: user.organizationId },
      select: { id: true, name: true, unit: true },
    })
    if (!material) throw new ApiError(404, 'Material not found')

    const movement = await db.$transaction(async tx => {
      // findOrCreate the (site, material) stock level; upsert keeps it race-safe.
      const level = await tx.stockLevel.upsert({
        where: {
          siteId_materialId: { siteId: site.id, materialId: material.id },
        },
        create: {
          organizationId: user.organizationId,
          siteId: site.id,
          materialId: material.id,
          quantity: 0,
        },
        update: {},
      })

      let nextQuantity: number
      if (body.type === 'IN') {
        nextQuantity = level.quantity + body.quantity
      } else if (body.type === 'OUT') {
        if (level.quantity < body.quantity) {
          throw new ApiError(
            422,
            `Insufficient stock: ${material.name} at ${site.name} has ${level.quantity} ${material.unit}, cannot remove ${body.quantity}`,
          )
        }
        nextQuantity = level.quantity - body.quantity
      } else {
        nextQuantity = body.quantity
      }

      await tx.stockLevel.update({
        where: { id: level.id },
        data: { quantity: nextQuantity },
      })

      return tx.stockMovement.create({
        data: {
          organizationId: user.organizationId,
          siteId: site.id,
          materialId: material.id,
          type: body.type,
          quantity: body.quantity,
          reason: body.reason,
          userId: user.id,
        },
        include: {
          site: { select: { name: true } },
          material: { select: { name: true } },
        },
      })
    })

    return ok(toMovementDTO(movement), 201)
  })
}
