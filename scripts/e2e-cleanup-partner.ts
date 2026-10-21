// MJG-035 — remove E2E partner-journey demo data from the runtime DB.
// Deletes the seeded E2E organizations (cascade removes their users, sites,
// materials, suppliers, POs, sessions). Reversible pattern per MJG-019 kit.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main(): Promise<void> {
  const before = await db.organization.count()

  // Unlink first: E2E partner orgs referenced by Supplier.partnerOrganizationId
  // (SetNull fires per-row; batch-deleting both orgs in one statement can race).
  const e2eOrgIds = await db.organization.findMany({
    where: { name: { startsWith: 'E2E ' } },
    select: { id: true },
  })
  const unlinked = await db.supplier.updateMany({
    where: { partnerOrganizationId: { in: e2eOrgIds.map(o => o.id) } },
    data: { partnerOrganizationId: null },
  })

  // Bottom-up delete: Restrict edges (PO→Supplier, POItem→Material,
  // DeliveryItem→Material, Evidence→Reporter, Payment→Recorder) fire
  // immediately, so a single Organization deleteMany can cascade into a
  // partially-invalid state mid-statement. Children first, org last.
  const orgIds = e2eOrgIds.map(o => o.id)
  const where = { organizationId: { in: orgIds } }
  await db.payment.deleteMany({ where })
  await db.delivery.deleteMany({ where })
  await db.purchaseOrder.deleteMany({ where })
  await db.stockMovement.deleteMany({ where })
  await db.stockLevel.deleteMany({ where })
  await db.attendance.deleteMany({ where })
  await db.assignment.deleteMany({ where })
  await db.evidenceReport.deleteMany({ where })
  await db.milestone.deleteMany({ where })
  await db.worker.deleteMany({ where })
  await db.material.deleteMany({ where })
  await db.supplier.deleteMany({ where })
  await db.site.deleteMany({ where })
  await db.user.deleteMany({ where })

  const deleted = await db.organization.deleteMany({
    where: { name: { startsWith: 'E2E ' } },
  })
  const after = await db.organization.count()
  console.log(
    `[e2e-cleanup] suppliers unlinked=${unlinked.count} organizations before=${before} deleted=${deleted.count} after=${after}`,
  )
  const residual = await db.organization.count({ where: { name: { startsWith: 'E2E ' } } })
  console.log(`[e2e-cleanup] residual E2E orgs=${residual} (0 required)`)
  if (residual !== 0) process.exit(1)
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error('[e2e-cleanup] FAILED:', e)
    await db.$disconnect()
    process.exit(1)
  })
