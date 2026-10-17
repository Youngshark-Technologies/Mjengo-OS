import { z } from 'zod'
import type { Material } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, fail, handle, parseBody, requireUser } from '@/lib/api-helpers'
import type { MaterialDTO, MaterialUnit } from '@/lib/types'
import { MATERIAL_UNIT_VALUES } from '@/lib/types'

export const dynamic = 'force-dynamic'

function toMaterialDTO(material: Material): MaterialDTO {
  return {
    id: material.id,
    name: material.name,
    unit: material.unit as MaterialUnit,
    category: material.category,
    unitCost: material.unitCost,
  }
}

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  unit: z.enum(MATERIAL_UNIT_VALUES),
  category: z.string().min(1).default('GENERAL'),
  unitCost: z.coerce.number().finite().min(0, 'unitCost must be >= 0').default(0),
})

// GET /api/materials — list materials, alphabetical.
export async function GET() {
  return handle(async () => {
    const user = await requireUser()

    const materials = await db.material.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: 'asc' },
    })

    return ok(materials.map(toMaterialDTO))
  })
}

// POST /api/materials — create a material (name unique within org → 409).
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    const duplicate = await db.material.findFirst({
      where: { organizationId: user.organizationId, name: body.name },
      select: { id: true },
    })
    if (duplicate) {
      return fail(409, `Material "${body.name}" already exists`)
    }

    const material = await db.material.create({
      data: {
        organizationId: user.organizationId,
        name: body.name,
        unit: body.unit,
        category: body.category,
        unitCost: body.unitCost,
      },
    })

    return ok(toMaterialDTO(material), 201)
  })
}
