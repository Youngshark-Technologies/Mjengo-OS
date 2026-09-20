/**
 * Status-ladder CHECK constraints through the REAL engine (issue #129 /
 * DB-10) — the Prisma-writer companion of the direct-SQL pins in
 * db-integrity-constraints.test.ts.
 *
 * Migration 19 rebuilds the ladder-carrying tables with CHECK constraints
 * (the Supabase design's vocabularies, divergences documented in the
 * migration header). The direct-SQL suite proves every CHECK against raw
 * INSERT/UPDATE statements; THIS file proves the guarantee holds for the
 * writer production actually uses — the generated Prisma client on a
 * database deployed by the real `prisma migrate deploy` chain (00→19).
 * Pinned:
 *
 *  · a typo'd ladder value on a high-value state machine (project, task,
 *    attendance, milestone, invoice, stock movement, user, notification)
 *    is REJECTED through prisma.*.create — the issue's "a wrong-value
 *    insert throws at the DB level" — while the LEGAL value of the same
 *    ladder lands and reads back (the constraint never over-rejects);
 *  · a typo'd UPDATE is rejected and the row is untouched (re-read proves
 *    the legal value survived);
 *  · the #206 withdrawal rungs (Approval.decision 'withdrawn',
 *    PurchaseOrder.status 'cancelled') are legal — the CHECKs carry the
 *    extended SQLite vocabulary, not just the Supabase draft's;
 *  · the seed-chain shapes (the exact ladder values prisma/seed*.ts
 *    writes) all land — the "seed chain runs clean against the
 *    constrained schema" acceptance criterion, pinned at row level;
 *  · the migration-14 ledger lifecycle still works end-to-end with the
 *    status CHECK live: born pending → posted (balance-gated) → reversed,
 *    and a wrong postedRole is refused by the CHECK even on a legal
 *    pending birth.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject, seedWorker } from '../helpers/db'
import { postLedgerTransaction, reverseLedgerTransaction } from '@/backend/modules/ledger/service'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

/**
 * One probe = one high-value ladder. `create(ladderValue)` builds a full
 * legal row with the ladder column set to the given value; the test runs
 * it with the legal value (must land) and the typo (must be rejected by
 * the named CHECK), then attacks the landed row with a typo'd UPDATE.
 */
const PROBES: ReadonlyArray<{
  label: string
  table: string
  column: string
  legal: string
  typo: string
  checkName: string
  create: (ladderValue: string) => Promise<{ id: string }>
  readBack: (id: string) => Promise<string>
}> = [
  {
    label: 'Project.status',
    table: 'Project',
    column: 'status',
    legal: 'on_hold',
    typo: 'on-hold',
    checkName: 'Project_status_check',
    create: async (status) => ({
      id: (await prisma.project.create({ data: { name: 'Ladder P', client: 'C', location: 'N', budget: 1n, startDate: new Date(), targetDate: new Date(), status } })).id,
    }),
    readBack: async (id) => (await prisma.project.findUniqueOrThrow({ where: { id } })).status,
  },
  {
    label: 'Task.priority',
    table: 'Task',
    column: 'priority',
    legal: 'urgent',
    typo: 'urgent!',
    checkName: 'Task_priority_check',
    create: async (priority) => {
      const project = await seedProject(prisma)
      const phase = await prisma.phase.create({ data: { projectId: project.id, name: 'F', order: 1, budget: 1n } })
      return { id: (await prisma.task.create({ data: { phaseId: phase.id, title: 'T', priority } })).id }
    },
    readBack: async (id) => (await prisma.task.findUniqueOrThrow({ where: { id } })).priority ?? '',
  },
  {
    label: 'Attendance.method',
    table: 'Attendance',
    column: 'method',
    legal: 'kiosk_pin',
    typo: 'gps',
    checkName: 'Attendance_method_check',
    create: async (method) => {
      const project = await seedProject(prisma)
      const worker = await seedWorker(prisma, project.id)
      return { id: (await prisma.attendance.create({ data: { workerId: worker.id, projectId: project.id, date: '2026-09-18', wage: 1n, method } })).id }
    },
    readBack: async (id) => (await prisma.attendance.findUniqueOrThrow({ where: { id } })).method,
  },
  {
    label: 'Milestone.status',
    table: 'Milestone',
    column: 'status',
    legal: 'release_requested',
    typo: 'release-requested',
    checkName: 'Milestone_status_check',
    create: async (status) => {
      const project = await seedProject(prisma)
      return { id: (await prisma.milestone.create({ data: { projectId: project.id, name: 'M', amount: 1n, status } })).id }
    },
    readBack: async (id) => (await prisma.milestone.findUniqueOrThrow({ where: { id } })).status,
  },
  {
    label: 'Invoice.status',
    table: 'Invoice',
    column: 'status',
    legal: 'paid',
    typo: 'payed',
    checkName: 'Invoice_status_check',
    create: async (status) => {
      const project = await seedProject(prisma)
      return { id: (await prisma.invoice.create({ data: { invoiceCode: `INV-LADDER-${Math.random().toString(36).slice(2, 8)}`, projectId: project.id, status } })).id }
    },
    readBack: async (id) => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).status,
  },
  {
    label: 'User.role',
    table: 'User',
    column: 'role',
    legal: 'procurement',
    typo: 'admim',
    checkName: 'User_role_check',
    create: async (role) => ({
      id: (await prisma.user.create({ data: { email: `ladder-${Math.random().toString(36).slice(2, 10)}@demo.test`, passwordHash: 'x', name: 'L', role } })).id,
    }),
    readBack: async (id) => (await prisma.user.findUniqueOrThrow({ where: { id } })).role,
  },
  {
    label: 'Notification.channel',
    table: 'Notification',
    column: 'channel',
    legal: 'whatsapp',
    typo: 'whatsaap',
    checkName: 'Notification_channel_check',
    create: async (channel) => {
      const project = await seedProject(prisma)
      return { id: (await prisma.notification.create({ data: { projectId: project.id, kind: 'system', title: 't', body: 'b', channel } })).id }
    },
    readBack: async (id) => (await prisma.notification.findUniqueOrThrow({ where: { id } })).channel,
  },
  {
    label: 'StockMovement.type',
    table: 'StockMovement',
    column: 'type',
    legal: 'transferred_in',
    typo: 'transfer_in',
    checkName: 'StockMovement_type_check',
    create: async (type) => {
      const project = await seedProject(prisma)
      const item = await prisma.inventoryItem.create({ data: { projectId: project.id, materialName: 'Cement', unit: 'bag' } })
      return { id: (await prisma.stockMovement.create({ data: { projectId: project.id, inventoryItemId: item.id, type, quantity: 5, recordedBy: 'test' } })).id }
    },
    readBack: async (id) => (await prisma.stockMovement.findUniqueOrThrow({ where: { id } })).type,
  },
]

describe('migration 19 ladder CHECKs through the real Prisma writer', () => {
  it.each(PROBES)('$label — legal "$legal" lands, typo "$typo" rejected at insert AND update, row never lies', async (p) => {
    // 1) The legal value persists and reads back exactly.
    const { id } = await p.create(p.legal)
    expect(await p.readBack(id)).toBe(p.legal)

    // 2) The typo'd CREATE is rejected by the DB — through Prisma.
    await expect(p.create(p.typo)).rejects.toThrow()

    // 3) The typo'd UPDATE on the existing row is rejected (raw handle
    //    names the CHECK — the Prisma error wrapper is engine-version
    //    dependent), and the row is untouched.
    expect(() =>
      sqlite.prepare(`UPDATE "${p.table}" SET "${p.column}" = ? WHERE "id" = ?`).run(p.typo, id),
    ).toThrow(new RegExp(`CHECK constraint failed: ${p.checkName}`))
    expect(await p.readBack(id)).toBe(p.legal)
  })

  it('Approval.decision "withdrawn" lands (#206) but "settled" is refused — the approval chain stays honest', async () => {
    const project = await seedProject(prisma)
    const approval = await prisma.approval.create({
      data: { projectId: project.id, entityType: 'request', entityId: 'seeded-request', approverRole: 'client', approverName: 'C', decision: 'withdrawn' },
    })
    expect(approval.decision).toBe('withdrawn')
    expect(() =>
      sqlite.prepare(`UPDATE "Approval" SET "decision" = 'settled' WHERE "id" = ?`).run(approval.id),
    ).toThrow(/CHECK constraint failed: Approval_decision_check/)
    // The live supply engine's short form AND the seeded long form are both legal.
    for (const entityType of ['request', 'material_request']) {
      await expect(
        prisma.approval.create({ data: { projectId: project.id, entityType, entityId: `e-${entityType}`, approverRole: 'supervisor', approverName: 'S' } }),
      ).resolves.toBeTruthy()
    }
  })

  it('PurchaseOrder.status "pending-approval" is refused; the nine-rung ladder including "cancelled" (#206) lands', async () => {
    const project = await seedProject(prisma)
    const supplier = await prisma.supplier.create({ data: { businessName: 'Ladder Supplier', county: 'Nairobi' } })
    const po = await prisma.purchaseOrder.create({
      data: { orderCode: `PO-LADDER-${Math.random().toString(36).slice(2, 8)}`, projectId: project.id, supplierId: supplier.id, subtotal: 1n, total: 1n, createdByRole: 'contractor', status: 'cancelled' },
    })
    expect(po.status).toBe('cancelled')
    expect(() =>
      sqlite.prepare(`UPDATE "PurchaseOrder" SET "status" = 'pending-approval' WHERE "id" = ?`).run(po.id),
    ).toThrow(/CHECK constraint failed: PurchaseOrder_status_check/)
  })

  it('the seed-chain ladder shapes all land (the "seed chain runs clean" criterion, row level)', async () => {
    // The exact ladder values prisma/seed*.ts writes, one row per family —
    // if a future vocabulary edit forgets the seeds, this pin names the
    // table before the seed script does.
    const project = await seedProject(prisma, { name: 'Seed Shapes' })
    const worker = await seedWorker(prisma, project.id)

    await prisma.project.update({ where: { id: project.id }, data: { clientType: 'diaspora', status: 'active' } })
    await prisma.attendance.create({ data: { workerId: worker.id, projectId: project.id, date: '2026-09-19', wage: 80000n, status: 'absent', method: 'ussd', verification: 'verified', exceptionReason: 'network' } })
    await prisma.transaction.create({ data: { projectId: project.id, type: 'wage', amount: 1n, method: 'mpesa', date: new Date() } })
    await prisma.auditEvent.create({ data: { projectId: project.id, kind: 'wage', actor: 'A', role: 'foreman', summary: 's' } })
    await prisma.milestone.create({ data: { projectId: project.id, name: 'Seed M', amount: 1n, status: 'evidence_submitted' } })
    await prisma.variationOrder.create({ data: { projectId: project.id, title: 'V', description: 'd', budgetImpact: 1n, status: 'approved' } })
    await prisma.notification.create({ data: { projectId: project.id, kind: 'recap', title: 't', body: 'b', channel: 'in_app', deliveryStatus: 'sent' } })
    await prisma.user.create({ data: { email: `seed-shape-${Math.random().toString(36).slice(2, 8)}@demo.test`, passwordHash: 'x', name: 'S', role: 'qs' } })
    await prisma.projectTeam.create({ data: { projectId: project.id, name: 'T', role: 'client_rep' } })
    const parcel = await prisma.landParcel.create({ data: { projectId: project.id, plotNumber: 'LR 2/2', county: 'Kiambu', tenureType: 'leasehold', status: 'searching' } })
    await prisma.titleSearch.create({ data: { parcelId: parcel.id, searchRef: 'CS-2', transcriptionMatch: 'mismatch', status: 'received' } })
    await prisma.ledgerAccount.create({ data: { code: `LADDER:${Math.random().toString(36).slice(2, 8)}`, name: 'L', kind: 'asset', normalSide: 'debit', ownerType: 'platform' } })
    await prisma.walletAccount.create({ data: { code: `W-${Math.random().toString(36).slice(2, 7)}`, label: 'L', ownerType: 'project', ownerId: project.id, status: 'active' } })
    await prisma.paymentRequest.create({
      data: { requestCode: `PR-LADDER-${Math.random().toString(36).slice(2, 8)}`, projectId: project.id, requestedByRole: 'finance', requestedByName: 'F', description: 'd', amount: 1n, payee: 'P', method: 'bank', status: 'approved', relatedEntityType: 'wages' },
    })
    await prisma.boq.create({ data: { projectId: project.id, name: 'B', status: 'approved' } })
    await prisma.jobRecord.create({ data: { type: 'anomaly_scan', status: 'done' } })
    await prisma.attachment.create({
      data: { entityType: 'document', entityId: 'seed-shape', fileName: 'f.pdf', storageKey: '/docs/f.pdf', uploadedBy: 'seed@demo.test', category: 'receipt', reviewStatus: 'approved' },
    })
    await prisma.trustDigest.create({
      data: { projectId: project.id, lang: 'sw', windowStart: new Date(), windowEnd: new Date(), text: 't', textHash: 'h', audioStatus: 'unavailable' },
    })
    await prisma.aiInsight.create({
      data: { projectId: project.id, targetType: 'site_photo', targetId: 'sp-1', kind: 'duplicate', source: 'dhash', severity: 'critical', detail: '{}' },
    })
    // AiReviewNote (verdict/confidence) needs a DrawPack parent — its ladder
    // is pinned in the direct-SQL suite; every other seed family is here.
  })

  it('the migration-14 ledger lifecycle still runs end-to-end with the status CHECK live', async () => {
    const project = await seedProject(prisma, { name: 'Ledger Lifecycle' })
    const posted = await postLedgerTransaction({
      projectId: project.id,
      ref: `LADDER-${Date.now()}`,
      description: 'ladder lifecycle probe',
      postedBy: 'Test',
      postedRole: 'finance',
      lines: [
        { accountCode: 'CASH_MPESA', side: 'debit', amount: 100n, memo: 'm' },
        { accountCode: `ESCROW:${project.id}`, side: 'credit', amount: 100n, memo: 'm' },
      ],
    })
    expect(posted.status).toBe('posted')
    const reversal = await reverseLedgerTransaction(posted.id, 'ladder probe reversal', 'Test', 'finance')
    // DB-11 (#133): the original row is never touched — 'reversed' is DERIVED
    // from the reversal row's reversalOfId link (the ledger-realdb contract —
    // reversal is a NEW transaction, never an edit).
    const untouched = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { id: posted.id } })
    expect(untouched.status).toBe('posted')
    expect(untouched.reversalRef).toBeNull()
    const derived = await prisma.ledgerTransaction.findUnique({ where: { reversalOfId: posted.id } })
    expect(derived?.id).toBe(reversal.id)
    expect(reversal.status).toBe('posted')
    expect(reversal.reversalOfId).toBe(posted.id)
    // A wrong postedRole is refused by the CHECK even on a legal pending birth.
    await expect(
      prisma.ledgerTransaction.create({
        data: { ref: `LADDER-BAD-${Date.now()}`, description: 'bad role', postedBy: 'T', postedRole: 'manager', status: 'pending' },
      }),
    ).rejects.toThrow()
    // Raw-SQL oracle: the CHECK is the reason (not a trigger).
    expect(() =>
      sqlite.prepare(`INSERT INTO "LedgerTransaction" ("id","ref","description","postedBy","postedRole","status","createdAt") VALUES ('lt-bad-role','R-BAD','d','T','manager','pending',CURRENT_TIMESTAMP)`).run(),
    ).toThrow(/CHECK constraint failed: LedgerTransaction_postedRole_check/)
  })
})
