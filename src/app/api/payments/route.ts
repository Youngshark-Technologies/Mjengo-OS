import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, parseQuery, requireUser, findOrgRecord } from '@/lib/api-helpers'
import {
  PAYMENT_CATEGORY_VALUES,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUS_VALUES,
} from '@/lib/types'
import type { PaymentDTO, PaymentCategory, PaymentMethod, PaymentStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

type PaymentRow = Prisma.PaymentGetPayload<{
  include: {
    site: true
    milestone: true
    purchaseOrder: true
    recordedBy: true
    approvedBy: true
  }
}>

function toPaymentDTO(row: PaymentRow): PaymentDTO {
  return {
    id: row.id,
    siteId: row.siteId,
    siteName: row.site.name,
    purchaseOrderId: row.purchaseOrderId,
    milestoneId: row.milestoneId,
    milestoneName: row.milestone?.name ?? null,
    category: row.category as PaymentCategory,
    method: row.method as PaymentMethod,
    amount: row.amount,
    status: row.status as PaymentStatus,
    reference: row.reference,
    notes: row.notes,
    recordedByName: row.recordedBy.name,
    approvedByName: row.approvedBy?.name ?? null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

// Empty-string query params (e.g. ?siteId=&status=) are treated as absent.
// MJG-072 — optional page/pageSize pagination: page >= 1, pageSize 1..100
// (default 25). WITHOUT these params the endpoint keeps its legacy behavior
// (single array, take: 500, no X-Total-Count header).
const querySchema = z.object({
  siteId: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  status: z.preprocess(v => (v === '' ? undefined : v), z.enum(PAYMENT_STATUS_VALUES).optional()),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

const createSchema = z.object({
  siteId: z.string().min(1, 'siteId is required'),
  purchaseOrderId: z.string().min(1, 'purchaseOrderId cannot be empty').optional(),
  milestoneId: z.string().min(1, 'milestoneId cannot be empty').optional(),
  category: z.enum(PAYMENT_CATEGORY_VALUES).default('MATERIAL'),
  method: z.enum(PAYMENT_METHOD_VALUES).default('MPESA'),
  amount: z.number().positive('amount must be greater than 0'),
  reference: z.string().optional(),
  notes: z.string().optional(),
})

// GET /api/payments?siteId=&status=[&page=&pageSize=] — ledger, newest first.
// MJG-072: with page, the response carries an org-filtered X-Total-Count and
// returns that slice (skip=(page-1)*pageSize, take=pageSize); the id
// tiebreaker keeps slices deterministic when createdAt ties (same ms).
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { siteId, status, page, pageSize } = parseQuery(req, querySchema)

    const where: Prisma.PaymentWhereInput = {
      organizationId: user.organizationId,
      ...(siteId ? { siteId } : {}),
      ...(status ? { status } : {}),
    }
    // pageSize only applies when page is present; no params → legacy take: 500.
    const paged = page !== undefined
    const take = paged ? (pageSize ?? 25) : 500

    const [payments, total] = await Promise.all([
      db.payment.findMany({
        where,
        include: {
          site: true,
          milestone: true,
          purchaseOrder: true,
          recordedBy: true,
          approvedBy: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: paged ? (page - 1) * take : undefined,
        take,
      }),
      paged ? db.payment.count({ where }) : Promise.resolve(0),
    ])

    const rows = payments.map(toPaymentDTO)
    if (!paged) return ok(rows)
    return NextResponse.json(
      { data: rows },
      { headers: { 'X-Total-Count': String(total) } },
    )
  })
}

// POST /api/payments — OWNER/SUPERVISOR record a payment. It always starts PENDING;
// approval is a separate, explicit human decision by the org owner.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(['OWNER', 'SUPERVISOR'], { orgType: ['CONSTRUCTOR'] })
    const body = await parseBody(req, createSchema)

    await findOrgRecord(db.site, body.siteId, user.organizationId, 'Site')
    if (body.purchaseOrderId) {
      await findOrgRecord(db.purchaseOrder, body.purchaseOrderId, user.organizationId, 'Purchase order')
    }
    if (body.milestoneId) {
      await findOrgRecord(db.milestone, body.milestoneId, user.organizationId, 'Milestone')
    }

    const payment = await db.payment.create({
      data: {
        organizationId: user.organizationId,
        siteId: body.siteId,
        purchaseOrderId: body.purchaseOrderId ?? null,
        milestoneId: body.milestoneId ?? null,
        category: body.category,
        method: body.method,
        amount: body.amount,
        status: 'PENDING',
        reference: body.reference ?? '',
        notes: body.notes ?? '',
        recordedById: user.id, // the acting session user — never inferred, never defaulted
      },
      include: {
        site: true,
        milestone: true,
        purchaseOrder: true,
        recordedBy: true,
        approvedBy: true,
      },
    })

    return ok(toPaymentDTO(payment), 201)
  })
}
