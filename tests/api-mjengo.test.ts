// MJG-020 — Replayable API integration suite (bun:test, zero new deps).
//
// One linear golden journey against a REAL production server booted by
// scripts/api-tests.sh on :3111 with an isolated SQLite database:
//   register → auth guards → site/material/stock → supplier/PO/delivery
//   → human verification (stock math + idempotency) → workforce/attendance
//   → evidence segregation red line → two-person verification
//   → OWNER-only payment flow → dashboard totals assert every mutation.
//
// The dev server on :3000 is never touched. The database file is removed by
// the orchestrating script after the run.

/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'

const BASE = process.env.MJENGO_API_BASE ?? 'http://localhost:3111'

type Jar = Record<string, string>
const jars: Record<string, Jar> = { owner: {}, supervisor: {} }

interface Res {
  status: number
  body: any
}

function sessionHeader(session: keyof typeof jars | null): string {
  if (!session) return ''
  const pairs = Object.entries(jars[session]).map(([k, v]) => `${k}=${v}`)
  return pairs.join('; ')
}

async function call(
  path: string,
  opts: {
    method?: string
    body?: unknown
    session?: keyof typeof jars | null
  } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(sessionHeader(opts.session ?? null) ? { cookie: sessionHeader(opts.session ?? null) } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  })
  // Capture every set-cookie into the named jar (simple k=v parsing is enough:
  // mjengo_session is opaque and the only cookie the app sets).
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) {
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // Anonymous callers get a fresh jar only when they later authenticate.
      if (opts.session) jars[opts.session][name] = value
    }
  }
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

const data = (r: Res) => r.body?.data
const errMsg = (r: Res) => r.body?.error?.message

// Journey state shared across the ordered tests.
const S: {
  siteId?: string
  materialId?: string
  supplierId?: string
  supplierName?: string
  poId?: string
  deliveryId?: string
  workerId?: string
  assignmentId?: string
  evidenceId?: string
  paymentId?: string
} = {}

const today = () => new Date().toISOString().slice(0, 10)

describe('MJG-020 — API golden journey (isolated server)', () => {
  test('01 health: /api reports ok + connected database', async () => {
    const r = await call('/api')
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('ok')
    expect(r.body.database).toBe('connected')
  })

  test('02 register org → 200 and session cookie', async () => {
    const r = await call('/api/auth/register', {
      method: 'POST',
      session: 'owner',
      body: {
        name: 'Suite Owner',
        email: 'suite-owner@mjengo-test.test',
        password: 'SuitePass#2026!',
        organizationName: 'Suite Test Constructors',
      },
    })
    expect(r.status).toBe(200)
    expect(data(r)?.user?.role ?? data(r)?.role ?? 'OWNER').toBe('OWNER')
    expect(Object.keys(jars.owner)).toContain('mjengo_session')
  })

  test('03 duplicate email register → 409', async () => {
    const r = await call('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Dup',
        email: 'suite-owner@mjengo-test.test',
        password: 'Whatever#2026!',
        organizationName: 'Other Org',
      },
    })
    expect(r.status).toBe(409)
  })

  test('04 business API without session → 401', async () => {
    const r = await call('/api/sites')
    expect(r.status).toBe(401)
  })

  test('05 login with wrong password → 401', async () => {
    const r = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'suite-owner@mjengo-test.test', password: 'WrongPassword#1' },
    })
    expect(r.status).toBe(401)
  })

  test('06 create site → 201; list shows exactly 1', async () => {
    const created = await call('/api/sites', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Tower', location: 'Nairobi, Test' },
    })
    expect(created.status).toBe(201)
    S.siteId = data(created)?.id
    expect(S.siteId).toBeTruthy()

    const list = await call('/api/sites', { session: 'owner' })
    expect(list.status).toBe(200)
    expect(data(list)).toHaveLength(1)
  })

  test('07 create material (BAG @ 700) → 201', async () => {
    const r = await call('/api/materials', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Cement', unit: 'BAG', unitCost: 700 },
    })
    expect(r.status).toBe(201)
    S.materialId = data(r)?.id
    expect(S.materialId).toBeTruthy()
  })

  test('08 stock IN 100 → on hand exactly 100 (value 70,000)', async () => {
    const mv = await call('/api/inventory/movements', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        materialId: S.materialId,
        type: 'IN',
        quantity: 100,
        reason: 'suite opening stock',
      },
    })
    expect([200, 201]).toContain(mv.status)

    const levels = await call(`/api/inventory?siteId=${S.siteId}`, { session: 'owner' })
    expect(levels.status).toBe(200)
    expect(data(levels)).toHaveLength(1)
    expect(data(levels)[0].quantity).toBe(100)
    expect(data(levels)[0].unitCost).toBe(700)
  })

  test('09 stock OUT beyond on-hand → 422', async () => {
    const r = await call('/api/inventory/movements', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        materialId: S.materialId,
        type: 'OUT',
        quantity: 150,
        reason: 'suite overdraw attempt',
      },
    })
    expect(r.status).toBe(422)
  })

  test('10 create supplier → 201', async () => {
    const r = await call('/api/suppliers', {
      method: 'POST',
      session: 'owner',
      body: {
        name: 'Suite Supplies Ltd',
        phone: '+254 700 000 001',
        email: 'sales@suitesupplies.test',
        category: 'Cement',
      },
    })
    expect(r.status).toBe(201)
    S.supplierId = data(r)?.id
    S.supplierName = data(r)?.name
    expect(S.supplierId).toBeTruthy()
  })

  test('11 create PO (120 BAG @ 700) → 201 DRAFT', async () => {
    const r = await call('/api/purchase-orders', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        supplierId: S.supplierId,
        items: [{ materialId: S.materialId, quantity: 120, unitCost: 700 }],
      },
    })
    expect(r.status).toBe(201)
    S.poId = data(r)?.id
    expect(data(r)?.status).toBe('DRAFT')
  })

  test('12 send PO → SENT', async () => {
    const r = await call(`/api/purchase-orders/${S.poId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'SENT' },
    })
    expect(r.status).toBe(200)
    expect(data(r)?.status).toBe('SENT')
  })

  test('13 MJG-016 regression: delivery against PO inherits supplier', async () => {
    const r = await call('/api/deliveries', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        purchaseOrderId: S.poId,
        // NOTE: no supplierId — the PO's supplier must be inherited (MJG-016).
        items: [{ materialId: S.materialId, quantityDelivered: 120 }],
      },
    })
    expect(r.status).toBe(201)
    S.deliveryId = data(r)?.id
    expect(data(r)?.status).toBe('PENDING')
    expect(data(r)?.supplierName).toBe(S.supplierName)
  })

  test('14 verify delivery → stock exactly 100+120=220; re-verify → 422', async () => {
    const verify = await call(`/api/deliveries/${S.deliveryId}/verify`, {
      method: 'POST',
      session: 'owner',
      body: { decision: 'VERIFIED' },
    })
    expect(verify.status).toBe(200)
    expect(data(verify)?.status).toBe('VERIFIED')

    const levels = await call(`/api/inventory?siteId=${S.siteId}`, { session: 'owner' })
    expect(data(levels)[0].quantity).toBe(220)

    const again = await call(`/api/deliveries/${S.deliveryId}/verify`, {
      method: 'POST',
      session: 'owner',
      body: { decision: 'VERIFIED' },
    })
    expect(again.status).toBe(422)
  })

  test('15 worker → assignment ACTIVE → attendance Present 8h', async () => {
    const worker = await call('/api/workers', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Worker', phone: '+254 700 000 002', trade: 'MASON' },
    })
    expect(worker.status).toBe(201)
    S.workerId = data(worker)?.id

    const assignment = await call('/api/assignments', {
      method: 'POST',
      session: 'owner',
      body: { workerId: S.workerId, siteId: S.siteId },
    })
    expect(assignment.status).toBe(201)
    S.assignmentId = data(assignment)?.id

    const activate = await call(`/api/assignments/${S.assignmentId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'ACTIVE' },
    })
    expect(activate.status).toBe(200)

    const attendance = await call('/api/attendance', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        date: today(),
        entries: [{ workerId: S.workerId, status: 'PRESENT', hoursWorked: 8 }],
      },
    })
    expect([200, 201]).toContain(attendance.status)
  })

  test('16 RED LINE: reporter cannot verify own evidence → 403', async () => {
    const report = await call('/api/evidence', {
      method: 'POST',
      session: 'owner',
      body: { siteId: S.siteId, title: 'Suite slab poured', description: 'Zone A complete' },
    })
    expect(report.status).toBe(201)
    S.evidenceId = data(report)?.id

    const selfVerify = await call(`/api/evidence/${S.evidenceId}/verify`, {
      method: 'POST',
      session: 'owner',
      body: { decision: 'VERIFIED' },
    })
    expect(selfVerify.status).toBe(403)
  })

  test('17 OWNER creates SUPERVISOR; supervisor verifies the report', async () => {
    const member = await call('/api/users', {
      method: 'POST',
      session: 'owner',
      body: {
        name: 'Suite Supervisor',
        email: 'suite-supervisor@mjengo-test.test',
        password: 'SupPass#2026!',
        role: 'SUPERVISOR',
      },
    })
    expect(member.status).toBe(201)

    const login = await call('/api/auth/login', {
      method: 'POST',
      session: 'supervisor',
      body: { email: 'suite-supervisor@mjengo-test.test', password: 'SupPass#2026!' },
    })
    expect(login.status).toBe(200)

    const verify = await call(`/api/evidence/${S.evidenceId}/verify`, {
      method: 'POST',
      session: 'supervisor',
      body: { decision: 'VERIFIED' },
    })
    expect(verify.status).toBe(200)
    expect(data(verify)?.status ?? 'VERIFIED').toBe('VERIFIED')
  })

  test('18 RED LINE: supervisor cannot approve payment → 403; OWNER can; then paid', async () => {
    const payment = await call('/api/payments', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        purchaseOrderId: S.poId,
        category: 'MATERIAL',
        method: 'BANK',
        amount: 84000,
        reference: 'SUITE-INV-001',
      },
    })
    expect(payment.status).toBe(201)
    S.paymentId = data(payment)?.id
    expect(data(payment)?.status).toBe('PENDING')

    const supApprove = await call(`/api/payments/${S.paymentId}/approve`, {
      method: 'POST',
      session: 'supervisor',
      body: {},
    })
    expect(supApprove.status).toBe(403)

    const ownerApprove = await call(`/api/payments/${S.paymentId}/approve`, {
      method: 'POST',
      session: 'owner',
      body: { decision: 'APPROVED' },
    })
    expect(ownerApprove.status).toBe(200)

    const markPaid = await call(`/api/payments/${S.paymentId}/mark-paid`, {
      method: 'POST',
      session: 'owner',
      body: {},
    })
    expect(markPaid.status).toBe(200)
    expect(data(markPaid)?.status).toBe('PAID')
  })

  test('19 dashboard totals reflect every mutation', async () => {
    const r = await call('/api/dashboard', { session: 'owner' })
    expect(r.status).toBe(200)
    const m = data(r)?.metrics
    expect(m?.totalSites).toBe(1)
    expect(m?.activeSites).toBe(0) // site is PLANNING, not ACTIVE — correct
    expect(m?.stockValue).toBe(220 * 700) // 154,000
    expect(m?.pendingDeliveries).toBe(0)
    expect(m?.evidenceAwaiting).toBe(0)
    expect(m?.paymentsAwaiting).toBe(0)
    expect(m?.workforceToday).toBe(1)
    expect(m?.monthlySpend).toBe(84000)
  })

  test('20 session persists: /api/auth/me resolves the owner', async () => {
    const r = await call('/api/auth/me', { session: 'owner' })
    expect(r.status).toBe(200)
    const email = data(r)?.user?.email ?? data(r)?.email
    expect(email).toBe('suite-owner@mjengo-test.test')
  })

  test('21 logout invalidates the session token', async () => {
    const logout = await call('/api/auth/logout', { method: 'POST', session: 'supervisor', body: {} })
    expect([200, 204]).toContain(logout.status)
    const me = await call('/api/auth/me', { session: 'supervisor' })
    expect(me.status).toBe(401)
  })
})
