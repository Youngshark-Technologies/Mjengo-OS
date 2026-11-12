import { z } from 'zod'
import { db } from '@/lib/db'
import { handle, ok, parseQuery, requireUser } from '@/lib/api-helpers'
import type { PartnerOrgDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

// MJG-035 — partner organization directory. Constructors browse partner orgs
// (suppliers / logistics companies that registered on MjengoOS) so they can
// link their supplier records to the partner's real organization. Partner orgs
// are platform-level entities (not tenant-scoped): only names, ids and types
// are exposed — no contact details beyond the org name.

const querySchema = z.object({
  type: z.enum(['SUPPLIER', 'LOGISTICS']).default('SUPPLIER'),
})

export async function GET(req: Request) {
  return handle(async () => {
    await requireUser(['OWNER', 'SUPERVISOR'])

    const query = parseQuery(req, querySchema)

    const partners = await db.organization.findMany({
      where: { type: query.type },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, type: true },
    })

    const dtos: PartnerOrgDTO[] = partners.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type as PartnerOrgDTO['type'],
    }))
    return ok(dtos)
  })
}
