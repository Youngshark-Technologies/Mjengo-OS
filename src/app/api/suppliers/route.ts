import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { handle, ok, parseBody, requireUser } from '@/lib/api-helpers'
import type { SupplierDTO } from '@/lib/types'

// ─── DTO mapping ──────────────────────────────────────────────────────────────

type SupplierRow = Prisma.SupplierGetPayload<{ include: { partnerOrganization: { select: { name: true } } } }>

function toSupplierDTO(supplier: SupplierRow): SupplierDTO {
  return {
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    email: supplier.email,
    category: supplier.category,
    partnerOrganizationId: supplier.partnerOrganizationId,
    partnerOrganizationName: supplier.partnerOrganization?.name ?? null,
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

const createSupplierSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  phone: z.string().trim().nullish().transform(v => (v && v.length > 0 ? v : null)),
  email: z.union([z.email(), z.literal('')]).nullish().transform(v => (v ? v : null)),
  category: z.string().trim().min(1, 'category cannot be empty').default('GENERAL'),
})

// ─── GET /api/suppliers — list suppliers for the org (name asc) ───────────────

export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    const suppliers = await db.supplier.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: 'asc' },
      include: { partnerOrganization: { select: { name: true } } },
    })
    return ok(suppliers.map(toSupplierDTO))
  })
}

// ─── POST /api/suppliers — create a supplier (MJG-033: OWNER/SUPERVISOR, ──────
// ─── consistent with the purchase-order create that consumes suppliers) ──────

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR'], { orgType: ['CONSTRUCTOR'] })
    const body = await parseBody(req, createSupplierSchema)

    const supplier = await db.supplier.create({
      data: {
        organizationId: user.organizationId,
        name: body.name,
        phone: body.phone,
        email: body.email,
        category: body.category,
      },
      include: { partnerOrganization: { select: { name: true } } },
    })
    return ok(toSupplierDTO(supplier), 201)
  })
}
