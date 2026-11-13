import { z } from 'zod'
import { db } from '@/lib/db'
import { handle, ok, parseBody, ApiError, requireUser, findOrgRecord } from '@/lib/api-helpers'
import type { SupplierDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// MJG-035 — link a supplier record to a partner organization (or unlink with null).
// The partner org must exist and be a SUPPLIER-type organization; constructors
// keep their supplier records, partners get PO visibility through this link.

const patchSchema = z.object({
  partnerOrganizationId: z.union([z.string().min(1), z.literal(''), z.null()])
    .transform(v => (v ? v : null)),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR'], { orgType: ['CONSTRUCTOR'] })
    const { id } = await params
    const body = await parseBody(req, patchSchema)

    const supplier = await findOrgRecord(
      db.supplier,
      id,
      user.organizationId,
      'Supplier',
    )

    if (body.partnerOrganizationId) {
      const partner = await db.organization.findUnique({
        where: { id: body.partnerOrganizationId },
        select: { id: true, type: true },
      })
      if (!partner) throw new ApiError(404, 'Partner organization not found')
      if (partner.type !== 'SUPPLIER') {
        throw new ApiError(422, 'Only SUPPLIER organizations can be linked to a supplier record')
      }
    }

    const updated = await db.supplier.update({
      where: { id: supplier.id },
      data: { partnerOrganizationId: body.partnerOrganizationId },
      include: { partnerOrganization: { select: { name: true } } },
    })

    const dto: SupplierDTO = {
      id: updated.id,
      name: updated.name,
      phone: updated.phone,
      email: updated.email,
      category: updated.category,
      partnerOrganizationId: updated.partnerOrganizationId,
      partnerOrganizationName: updated.partnerOrganization?.name ?? null,
    }
    return ok(dto)
  })
}
