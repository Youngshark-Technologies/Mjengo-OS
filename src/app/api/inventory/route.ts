import { z } from 'zod'
import type { StockLevel } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseQuery, requireUser } from '@/lib/api-helpers'
import type { MaterialUnit, StockLevelDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  siteId: z.string().min(1).optional(),
})

type StockLevelWithRefs = StockLevel & { site: { name: string }; material: { name: string; unit: string; unitCost: number } }

function toStockLevelDTO(level: StockLevelWithRefs): StockLevelDTO {
  return {
    id: level.id,
    siteId: level.siteId,
    siteName: level.site.name,
    materialId: level.materialId,
    materialName: level.material.name,
    unit: level.material.unit as MaterialUnit,
    unitCost: level.material.unitCost,
    quantity: level.quantity,
    updatedAt: level.updatedAt.toISOString(),
  }
}

// GET /api/inventory?siteId=... — stock levels (with material + site), by material name.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId } = parseQuery(req, querySchema)

    const levels = await db.stockLevel.findMany({
      where: { organizationId: user.organizationId, ...(siteId ? { siteId } : {}) },
      include: {
        site: { select: { name: true } },
        material: { select: { name: true, unit: true, unitCost: true } },
      },
      orderBy: { material: { name: 'asc' } },
    })

    return ok(levels.map(toStockLevelDTO))
  })
}
