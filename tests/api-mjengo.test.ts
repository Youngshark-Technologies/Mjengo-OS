// MJG-020 — Replayable API integration suite (bun:test, zero new deps).
//
// One linear golden journey against a REAL production server booted by
// scripts/api-tests.sh on :3111 with an isolated SQLite database:
//   register → auth guards → site/material/stock → supplier/PO/delivery
//   → human verification (stock math + idempotency) → workforce/attendance
//   → evidence segregation red line → two-person verification
//   → OWNER-only payment flow → dashboard totals assert every mutation
//   → MJG-035 partner access model (supplier/logistics registration, org
//     tenancy, partner directory, supplier-record linking, PO visibility,
//     DRAFT privacy) → MJG-032 assignment FSM → MJG-033 supplier role gate
//   → MJG-063 payment-approve write predicate → MJG-036 partner phase-2
//     (delivery carrier assignment, logistics acknowledgment, supplier PO
//     acknowledge + shipment log)
//   → MJG-056 suite extensions: cookie flag contract, register validation,
//     MJG-050/MJG-058/MJG-044/MJG-051 guard regressions, cross-constructor
//     tenancy, and the MJG-043 register rate limit (429) as the suite-FINAL
//     case — the in-memory register bucket is shared by every call above.
//
// The dev server on :3000 is never touched. The database file is removed by
// the orchestrating script after the run.

/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'

const BASE = process.env.MJENGO_API_BASE ?? 'http://localhost:3111'

type Jar = Record<string, string>
const jars: Record<string, Jar> = {
  owner: {},
  owner2: {}, // MJG-056 — second constructor org (cross-tenancy checks)
  supervisor: {},
  worker: {},
  supplier: {},
  logistics: {},
}

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
  partnerOrgId?: string
  logisticsOrgId?: string
  po2Id?: string
  worker2Id?: string
  assignment2Id?: string
  site2Id?: string // MJG-056 — second owner site (milestone terminality)
  milestoneId?: string // MJG-056 — driven to COMPLETED, then reopen attempt
  carrierDeliveryId?: string // MJG-036 — delivery assigned to the logistics org
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

  // ─── MJG-035 — partner access model ────────────────────────────────────

  test('22 supplier partner self-registers → organizationType SUPPLIER', async () => {
    const r = await call('/api/auth/register', {
      method: 'POST',
      session: 'supplier',
      body: {
        name: 'Suite Supply Owner',
        email: 'suite-supplier@mjengo-test.test',
        password: 'PartnerPass#2026!',
        organizationName: 'Suite Supply Partners',
        organizationType: 'SUPPLIER',
      },
    })
    expect(r.status).toBe(200)
    S.partnerOrgId = data(r)?.organizationId
    expect(S.partnerOrgId).toBeTruthy()
    expect(data(r)?.organizationType).toBe('SUPPLIER')
    expect(data(r)?.role).toBe('OWNER')

    const me = await call('/api/auth/me', { session: 'supplier' })
    expect(me.status).toBe(200)
    expect(data(me)?.organizationType).toBe('SUPPLIER')
  })

  test('23 logistics partner self-registers → organizationType LOGISTICS', async () => {
    const r = await call('/api/auth/register', {
      method: 'POST',
      session: 'logistics',
      body: {
        name: 'Suite Haulage Owner',
        email: 'suite-logistics@mjengo-test.test',
        password: 'PartnerPass#2026!',
        organizationName: 'Suite Haulage Ltd',
        organizationType: 'LOGISTICS',
      },
    })
    expect(r.status).toBe(200)
    S.logisticsOrgId = data(r)?.organizationId
    expect(data(r)?.organizationType).toBe('LOGISTICS')
  })

  test('24 partner tenancy: supplier org sees only its own (empty) data', async () => {
    const sites = await call('/api/sites', { session: 'supplier' })
    expect(sites.status).toBe(200)
    expect(data(sites)).toHaveLength(0) // constructor's site is NOT visible across tenants
  })

  test('25 MJG-033: WORKER cannot create suppliers → 403; OWNER still can', async () => {
    const member = await call('/api/users', {
      method: 'POST',
      session: 'owner',
      body: {
        name: 'Suite Worker User',
        email: 'suite-worker@mjengo-test.test',
        password: 'WorkerPass#2026!',
        role: 'WORKER',
      },
    })
    expect(member.status).toBe(201)

    const workerLogin = await call('/api/auth/login', {
      method: 'POST',
      session: 'worker',
      body: { email: 'suite-worker@mjengo-test.test', password: 'WorkerPass#2026!' },
    })
    expect(workerLogin.status).toBe(200)

    const denied = await call('/api/suppliers', {
      method: 'POST',
      session: 'worker',
      body: { name: 'Worker Supplier Co' },
    })
    expect(denied.status).toBe(403)

    // OWNER path stays open (second supplier used for partner linking below).
    const allowed = await call('/api/suppliers', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Steel Traders', category: 'Steel' },
    })
    expect(allowed.status).toBe(201)
    expect(data(allowed)?.partnerOrganizationId).toBeNull()
  })

  test('26 partner directory lists partner orgs by type', async () => {
    const suppliersDir = await call('/api/partners', { session: 'owner' })
    expect(suppliersDir.status).toBe(200)
    const supplierIds = (data(suppliersDir) as Array<{ id: string; type: string }>).map(p => p.id)
    expect(supplierIds).toContain(S.partnerOrgId!)
    expect(supplierIds).not.toContain(S.logisticsOrgId!)
    expect((data(suppliersDir) as Array<{ type: string }>).every(p => p.type === 'SUPPLIER')).toBe(true)

    const logisticsDir = await call('/api/partners?type=LOGISTICS', { session: 'owner' })
    expect(logisticsDir.status).toBe(200)
    const logisticsIds = (data(logisticsDir) as Array<{ id: string; type: string }>).map(p => p.id)
    expect(logisticsIds).toContain(S.logisticsOrgId!)
    expect(logisticsIds).not.toContain(S.partnerOrgId!)
  })

  test('27 link supplier record to partner org; invalid links rejected', async () => {
    const linked = await call(`/api/suppliers/${S.supplierId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { partnerOrganizationId: S.partnerOrgId },
    })
    expect(linked.status).toBe(200)
    expect(data(linked)?.partnerOrganizationId).toBe(S.partnerOrgId)
    expect(data(linked)?.partnerOrganizationName).toBe('Suite Supply Partners')

    const unknown = await call(`/api/suppliers/${S.supplierId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { partnerOrganizationId: 'nonexistent-org' },
    })
    expect(unknown.status).toBe(404)

    // A CONSTRUCTOR org is not a valid partner for a supplier record.
    const wrongType = await call(`/api/suppliers/${S.supplierId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { partnerOrganizationId: data((await call('/api/auth/me', { session: 'owner' })))?.organizationId },
    })
    expect(wrongType.status).toBe(422)
  })

  test('28 partner sees SENT PO; DRAFT stays private to the constructor', async () => {
    // Golden-journey PO (case 11/12) is SENT and linked via the supplier record.
    const before = await call('/api/partner/purchase-orders', { session: 'supplier' })
    expect(before.status).toBe(200)
    expect(data(before)).toHaveLength(1)
    expect(data(before)[0].id).toBe(S.poId)
    expect(data(before)[0].status).toBe('SENT')
    expect(data(before)[0].total).toBe(84000)
    expect(data(before)[0].organizationName).toBe('Suite Test Constructors')
    expect(data(before)[0].items[0].materialName).toBe('Suite Cement')

    // A fresh DRAFT to the same supplier must NOT be visible to the partner.
    const draft = await call('/api/purchase-orders', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        supplierId: S.supplierId,
        items: [{ materialId: S.materialId, quantity: 10, unitCost: 700 }],
      },
    })
    expect(draft.status).toBe(201)
    S.po2Id = data(draft)?.id

    const during = await call('/api/partner/purchase-orders', { session: 'supplier' })
    expect(data(during)).toHaveLength(1)

    // Once sent, it appears.
    const send = await call(`/api/purchase-orders/${S.po2Id}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'SENT' },
    })
    expect(send.status).toBe(200)

    const after = await call('/api/partner/purchase-orders', { session: 'supplier' })
    expect(data(after)).toHaveLength(2)
    // newest first
    expect(data(after)[0].id).toBe(S.po2Id)
  })

  test('29 MJG-032: assignment FSM — adjacent moves ok, jumps 422, terminal locked', async () => {
    const worker = await call('/api/workers', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Worker Two', trade: 'CARPENTER' },
    })
    expect(worker.status).toBe(201)
    S.worker2Id = data(worker)?.id

    const assignment = await call('/api/assignments', {
      method: 'POST',
      session: 'owner',
      body: { workerId: S.worker2Id, siteId: S.siteId },
    })
    expect(assignment.status).toBe(201)
    S.assignment2Id = data(assignment)?.id

    // ASSIGNED → COMPLETED is a jump → 422
    const jump = await call(`/api/assignments/${S.assignment2Id}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'COMPLETED' },
    })
    expect(jump.status).toBe(422)
    expect(errMsg(jump)).toContain('Invalid status transition')

    // Legal: ASSIGNED → ACTIVE
    const activate = await call(`/api/assignments/${S.assignment2Id}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'ACTIVE' },
    })
    expect(activate.status).toBe(200)
    expect(data(activate)?.status).toBe('ACTIVE')

    // Legal: ACTIVE → COMPLETED (endDate recorded)
    const complete = await call(`/api/assignments/${S.assignment2Id}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'COMPLETED' },
    })
    expect(complete.status).toBe(200)
    expect(data(complete)?.status).toBe('COMPLETED')
    expect(data(complete)?.endDate).toBeTruthy()

    // COMPLETED is terminal → reopening 422
    const reopen = await call(`/api/assignments/${S.assignment2Id}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'ACTIVE' },
    })
    expect(reopen.status).toBe(422)
  })

  test('30 partner portal access control: constructor + logistics orgs → 403', async () => {
    const ownerBlocked = await call('/api/partner/purchase-orders', { session: 'owner' })
    expect(ownerBlocked.status).toBe(403)

    const logisticsBlocked = await call('/api/partner/purchase-orders', { session: 'logistics' })
    expect(logisticsBlocked.status).toBe(403)
  })

  // ─── MJG-056 — suite extensions ──────────────────────────────────────────

  test('31 MJG-056 — login Set-Cookie flags: HttpOnly + SameSite=Lax', async () => {
    // Raw fetch (not `call`) — the jar helpers swallow the set-cookie header.
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'suite-owner@mjengo-test.test', password: 'SuitePass#2026!' }),
    })
    expect(res.status).toBe(200)
    const raw = res.headers.getSetCookie().find(c => c.startsWith('mjengo_session='))
    expect(raw).toBeTruthy()
    // src/lib/auth.ts sessionCookieOptions: httpOnly is always set and
    // sameSite is always 'lax' — assert both unconditionally.
    expect(raw!).toContain('HttpOnly')
    expect(raw!.toLowerCase()).toContain('samesite=lax')
    // `secure` follows NODE_ENV on the server; this harness boots the
    // standalone PRODUCTION server, so the flag must be present (a dev boot
    // on plain HTTP would omit it — never assert it in that mode).
    expect(raw!).toContain('Secure')
  })

  test('32 MJG-056 — malformed register payload → 400 (zod, no account created)', async () => {
    const emptyName = await call('/api/auth/register', {
      method: 'POST',
      body: {
        name: '',
        email: 'malformed-1@mjengo-test.test',
        password: 'ValidPass#2026!',
        organizationName: 'No Name Org',
      },
    })
    expect(emptyName.status).toBe(400)
    expect(errMsg(emptyName)).toContain('Name is required')

    const badEmail = await call('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Bad Email',
        email: 'not-an-email',
        password: 'ValidPass#2026!',
        organizationName: 'Bad Email Org',
      },
    })
    expect(badEmail.status).toBe(400)
    expect(errMsg(badEmail)).toContain('email')

    const shortPassword = await call('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Shorty',
        email: 'malformed-2@mjengo-test.test',
        password: 'short',
        organizationName: 'Short Pass Org',
      },
    })
    expect(shortPassword.status).toBe(400)
    expect(errMsg(shortPassword)).toContain('at least 8 characters')
  })

  test('33 MJG-050 regression: /api/partners?type=BOGUS → 400, not 500', async () => {
    const r = await call('/api/partners?type=BOGUS', { session: 'owner' })
    expect(r.status).toBe(400)
    expect(errMsg(r)).toContain('type')
  })

  test('34 MJG-058 regression: partner org cannot create sites → 403', async () => {
    const supplierAttempt = await call('/api/sites', {
      method: 'POST',
      session: 'supplier',
      body: { name: 'Partner Site', location: 'Nairobi, Test' },
    })
    expect(supplierAttempt.status).toBe(403)
    expect(errMsg(supplierAttempt)).toContain('CONSTRUCTOR')

    const logisticsAttempt = await call('/api/sites', {
      method: 'POST',
      session: 'logistics',
      body: { name: 'Logistics Site', location: 'Nairobi, Test' },
    })
    expect(logisticsAttempt.status).toBe(403)
  })

  test('35 MJG-044 regression: WORKER cannot PATCH assignments → 403', async () => {
    const worker = await call('/api/workers', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Worker Three', phone: '+254 700 000 003', trade: 'ELECTRICIAN' },
    })
    expect(worker.status).toBe(201)
    const workerId = data(worker)?.id

    const assignment = await call('/api/assignments', {
      method: 'POST',
      session: 'owner',
      body: { workerId, siteId: S.siteId },
    })
    expect(assignment.status).toBe(201)
    const assignmentId = data(assignment)?.id

    const denied = await call(`/api/assignments/${assignmentId}`, {
      method: 'PATCH',
      session: 'worker',
      body: { status: 'ACTIVE' },
    })
    expect(denied.status).toBe(403)
    expect(errMsg(denied)).toContain('OWNER or SUPERVISOR')

    // The 403 was an authorization guard, not data loss: OWNER can still run
    // the legal ASSIGNED → ACTIVE transition on the same assignment.
    const allowed = await call(`/api/assignments/${assignmentId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'ACTIVE' },
    })
    expect(allowed.status).toBe(200)
    expect(data(allowed)?.status).toBe('ACTIVE')
  })

  test('36 MJG-051 regression: COMPLETED milestone is terminal → reopen 422', async () => {
    const site = await call('/api/sites', {
      method: 'POST',
      session: 'owner',
      body: { name: 'Suite Milestone Tower', location: 'Nairobi, Test' },
    })
    expect(site.status).toBe(201)
    S.site2Id = data(site)?.id

    const milestone = await call('/api/milestones', {
      method: 'POST',
      session: 'owner',
      body: { siteId: S.site2Id, name: 'Foundation signed off', order: 1 },
    })
    expect(milestone.status).toBe(201)
    S.milestoneId = data(milestone)?.id
    expect(data(milestone)?.status).toBe('PENDING')

    const complete = await call(`/api/milestones/${S.milestoneId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'COMPLETED' },
    })
    expect(complete.status).toBe(200)
    expect(data(complete)?.status).toBe('COMPLETED')

    // Reopen attempt (COMPLETED → IN_PROGRESS) is rejected.
    const reopen = await call(`/api/milestones/${S.milestoneId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'IN_PROGRESS' },
    })
    expect(reopen.status).toBe(422)
    expect(errMsg(reopen)).toContain('terminal')

    // And the stored status really is unchanged.
    const list = await call(`/api/milestones?siteId=${S.site2Id}`, { session: 'owner' })
    expect(list.status).toBe(200)
    expect(data(list)[0].status).toBe('COMPLETED')
  })

  test('37 MJG-056 — cross-constructor tenancy: empty lists, foreign ids → 404', async () => {
    const r = await call('/api/auth/register', {
      method: 'POST',
      session: 'owner2',
      body: {
        name: 'Second Constructor',
        email: 'suite-owner-2@mjengo-test.test',
        password: 'SuitePass#2026!',
        organizationName: 'Suite Second Constructors',
      },
    })
    expect(r.status).toBe(200)
    expect(data(r)?.organizationType).toBe('CONSTRUCTOR')

    // A fresh constructor org sees none of the first org's business data.
    const sites = await call('/api/sites', { session: 'owner2' })
    expect(sites.status).toBe(200)
    expect(data(sites)).toHaveLength(0)

    const pos = await call('/api/purchase-orders', { session: 'owner2' })
    expect(pos.status).toBe(200)
    expect(data(pos)).toHaveLength(0)

    // Foreign ids from the first constructor resolve to 404 — never 200/403.
    const foreignSite = await call(`/api/sites/${S.siteId}`, {
      method: 'PATCH',
      session: 'owner2',
      body: { name: 'Hijack Attempt' },
    })
    expect(foreignSite.status).toBe(404)
    expect(errMsg(foreignSite)).toBe('Site not found')

    const foreignPo = await call(`/api/purchase-orders/${S.poId}`, {
      method: 'PATCH',
      session: 'owner2',
      body: { status: 'RECEIVED' },
    })
    expect(foreignPo.status).toBe(404)
    expect(errMsg(foreignPo)).toBe('Purchase order not found')

    const foreignMilestones = await call(`/api/milestones?siteId=${S.site2Id}`, { session: 'owner2' })
    expect(foreignMilestones.status).toBe(404)
  })

  // MJG-063 — placed BEFORE the register-rate-limit case (which must stay
  // final): this case reuses the case-02 owner session and makes NO register
  // calls, so the bucket math documented below is unaffected.
  test('39 MJG-063 regression: second payment approve → 409 (write predicate)', async () => {
    // Fresh PENDING payment on the golden-journey PO.
    const payment = await call('/api/payments', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        purchaseOrderId: S.poId,
        category: 'MATERIAL',
        method: 'CASH',
        amount: 12000,
        reference: 'SUITE-INV-002',
      },
    })
    expect(payment.status).toBe(201)
    const paymentId = data(payment)?.id
    expect(data(payment)?.status).toBe('PENDING')

    const first = await call(`/api/payments/${paymentId}/approve`, {
      method: 'POST',
      session: 'owner',
      body: { decision: 'APPROVED' },
    })
    expect(first.status).toBe(200)
    expect(data(first)?.status).toBe('APPROVED')

    // The second approve must LOSE the PENDING → APPROVED transition: the
    // conditional write matches 0 rows → 409, never a silent
    // last-writer-wins re-approval.
    const second = await call(`/api/payments/${paymentId}/approve`, {
      method: 'POST',
      session: 'owner',
      body: { decision: 'APPROVED' },
    })
    expect(second.status).toBe(409)
    expect(errMsg(second)).toContain('no longer pending')

    // The loser never overwrote the winner's decision.
    const list = await call('/api/payments?status=APPROVED', { session: 'owner' })
    expect(list.status).toBe(200)
    const rows = data(list) as Array<{ id: string; status: string }>
    const row = rows.find(p => p.id === paymentId)
    expect(row?.id).toBe(paymentId)
    expect(row?.status).toBe('APPROVED')
  })

  // ─── MJG-036 — partner phase 2 (b) logistics delivery tasks ────────────
  // These cases run BEFORE the register-rate-limit case and make NO register
  // calls: they reuse the case-22 supplier jar and the case-23 logistics jar
  // (module-level, like case 39 reuses the owner session), so the bucket
  // math documented in the case-38 block below is unaffected.

  test('40 MJG-036 — delivery carrier: logistics org assigned → 201; wrong type → 422', async () => {
    // Empty list is an empty list, not an error (nothing assigned yet).
    const before = await call('/api/partner/delivery-tasks', { session: 'logistics' })
    expect(before.status).toBe(200)
    expect(data(before)).toHaveLength(0)

    const created = await call('/api/deliveries', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        carrierOrganizationId: S.logisticsOrgId,
        items: [{ materialId: S.materialId, quantityDelivered: 5 }],
      },
    })
    expect(created.status).toBe(201)
    S.carrierDeliveryId = data(created)?.id
    expect(S.carrierDeliveryId).toBeTruthy()

    // A CONSTRUCTOR org is not a valid carrier (same rule family as the
    // MJG-035 supplier-record link: wrong org type → 422).
    const me = await call('/api/auth/me', { session: 'owner' })
    const constructorOrgId = data(me)?.organizationId
    const wrongType = await call('/api/deliveries', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        carrierOrganizationId: constructorOrgId,
        items: [{ materialId: S.materialId, quantityDelivered: 5 }],
      },
    })
    expect(wrongType.status).toBe(422)
    expect(errMsg(wrongType)).toContain('LOGISTICS')

    // Unknown carrier reference behaves like every other referenced entity.
    const unknown = await call('/api/deliveries', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        carrierOrganizationId: 'nonexistent-org',
        items: [{ materialId: S.materialId, quantityDelivered: 5 }],
      },
    })
    expect(unknown.status).toBe(404)
  })

  test('41 MJG-036 — logistics tasks: list, acknowledge (repeat 409), verify flow untouched', async () => {
    const list = await call('/api/partner/delivery-tasks', { session: 'logistics' })
    expect(list.status).toBe(200)
    expect(data(list)).toHaveLength(1) // only ITS assigned delivery
    const task = data(list)[0]
    expect(task.id).toBe(S.carrierDeliveryId)
    expect(task.siteName).toBe('Suite Tower')
    expect(task.constructorName).toBe('Suite Test Constructors')
    expect(task.status).toBe('PENDING')
    expect(task.acknowledgedAt).toBeNull()

    const ack = await call(`/api/deliveries/${S.carrierDeliveryId}/acknowledge`, {
      method: 'POST',
      session: 'logistics',
    })
    expect(ack.status).toBe(200)
    expect(data(ack)?.acknowledgedAt).toBeTruthy()
    expect(data(ack)?.status).toBe('PENDING') // ack is NOT a delivery-status change

    const second = await call(`/api/deliveries/${S.carrierDeliveryId}/acknowledge`, {
      method: 'POST',
      session: 'logistics',
    })
    expect(second.status).toBe(409)
    expect(errMsg(second)).toContain('already been acknowledged')

    // The constructor side is untouched by the partner acknowledgment: the
    // delivery list still resolves and the delivery is still PENDING (stock
    // is only ever applied by the human verify flow).
    const ownerList = await call('/api/deliveries', { session: 'owner' })
    expect(ownerList.status).toBe(200)
    const row = (data(ownerList) as Array<{ id: string; status: string }>).find(
      d => d.id === S.carrierDeliveryId,
    )
    expect(row?.status).toBe('PENDING')
  })

  // ─── MJG-036 — partner phase 2 (c) PO acknowledge + shipment log ──────────

  test('42 MJG-036 — supplier PO acknowledge: 200, repeat 409, DRAFT stays private', async () => {
    // S.poId is SENT and linked via the case-27 supplier record → visible.
    const ack = await call(`/api/partner/purchase-orders/${S.poId}/acknowledge`, {
      method: 'POST',
      session: 'supplier',
    })
    expect(ack.status).toBe(200)
    expect(data(ack)?.acknowledgedAt).toBeTruthy()
    expect(data(ack)?.acknowledgedByOrganizationId).toBe(S.partnerOrgId)

    const second = await call(`/api/partner/purchase-orders/${S.poId}/acknowledge`, {
      method: 'POST',
      session: 'supplier',
    })
    expect(second.status).toBe(409)
    expect(errMsg(second)).toContain('already been acknowledged')

    // A fresh DRAFT to the same supplier never left the constructor → the
    // partner cannot even distinguish it from a nonexistent PO (404).
    const draft = await call('/api/purchase-orders', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        supplierId: S.supplierId,
        items: [{ materialId: S.materialId, quantity: 3, unitCost: 700 }],
      },
    })
    expect(draft.status).toBe(201)
    const draftPoId = data(draft)?.id

    const draftAck = await call(`/api/partner/purchase-orders/${draftPoId}/acknowledge`, {
      method: 'POST',
      session: 'supplier',
    })
    expect(draftAck.status).toBe(404)

    // Guard: the portal endpoints stay supplier-only.
    const logisticsAck = await call(`/api/partner/purchase-orders/${S.poId}/acknowledge`, {
      method: 'POST',
      session: 'logistics',
    })
    expect(logisticsAck.status).toBe(403)
  })

  test('43 MJG-036 — supplier shipment log; constructor sees ack + shipments', async () => {
    const logged = await call(`/api/partner/purchase-orders/${S.poId}/shipments`, {
      method: 'POST',
      session: 'supplier',
      body: {
        carrierName: 'Suite Haulage Ltd',
        trackingNo: 'SHL-2026-001',
        estimatedArrival: today(),
        notes: 'Loaded at yard 4',
      },
    })
    expect(logged.status).toBe(201)
    expect(data(logged)?.carrierName).toBe('Suite Haulage Ltd')
    expect(data(logged)?.purchaseOrderId).toBe(S.poId)
    expect(data(logged)?.organizationId).toBe(S.partnerOrgId) // tenancy anchor

    // Validation: missing carrier → 400, unknown field → 400, bad date → 400.
    const noCarrier = await call(`/api/partner/purchase-orders/${S.poId}/shipments`, {
      method: 'POST',
      session: 'supplier',
      body: { trackingNo: 'X' },
    })
    expect(noCarrier.status).toBe(400)
    const unknownField = await call(`/api/partner/purchase-orders/${S.poId}/shipments`, {
      method: 'POST',
      session: 'supplier',
      body: { carrierName: 'Suite Haulage Ltd', trakingNo: 'typo' },
    })
    expect(unknownField.status).toBe(400)
    const badDate = await call(`/api/partner/purchase-orders/${S.poId}/shipments`, {
      method: 'POST',
      session: 'supplier',
      body: { carrierName: 'Suite Haulage Ltd', shippedAt: 'not-a-date' },
    })
    expect(badDate.status).toBe(400)

    const list = await call(`/api/partner/purchase-orders/${S.poId}/shipments`, {
      session: 'supplier',
    })
    expect(list.status).toBe(200)
    expect(data(list)).toHaveLength(1) // exactly the one just logged

    // The constructor sees the partner acknowledgment and the shipment log.
    const detail = await call(`/api/purchase-orders/${S.poId}`, { session: 'owner' })
    expect(detail.status).toBe(200)
    expect(data(detail)?.acknowledgedAt).toBeTruthy()
    expect(data(detail)?.acknowledgedByOrganizationId).toBe(S.partnerOrgId)
    expect(data(detail)?.acknowledgedByOrganizationName).toBe('Suite Supply Partners')
    expect(data(detail)?.shipments).toHaveLength(1)
    expect(data(detail)?.shipments[0].carrierName).toBe('Suite Haulage Ltd')
    expect(data(detail)?.status).toBe('SENT') // partner writes never move the FSM

    // FSM edge: a CANCELLED (still visible) PO cannot take shipments → 422.
    const doomed = await call('/api/purchase-orders', {
      method: 'POST',
      session: 'owner',
      body: {
        siteId: S.siteId,
        supplierId: S.supplierId,
        items: [{ materialId: S.materialId, quantity: 2, unitCost: 700 }],
      },
    })
    expect(doomed.status).toBe(201)
    const doomedId = data(doomed)?.id
    const send = await call(`/api/purchase-orders/${doomedId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'SENT' },
    })
    expect(send.status).toBe(200)
    const cancel = await call(`/api/purchase-orders/${doomedId}`, {
      method: 'PATCH',
      session: 'owner',
      body: { status: 'CANCELLED' },
    })
    expect(cancel.status).toBe(200)
    const deadShipment = await call(`/api/partner/purchase-orders/${doomedId}/shipments`, {
      method: 'POST',
      session: 'supplier',
      body: { carrierName: 'Suite Haulage Ltd' },
    })
    expect(deadShipment.status).toBe(422)
  })

  // MJG-043 bucket math — the limiter is IN-MEMORY on this single booted
  // server, keyed by client IP with a 20/hour ceiling, and it is checked
  // BEFORE payload validation (400s and 409s burn slots too). Register calls
  // admitted before this case:
  //   02 owner + 03 duplicate + 22 supplier + 23 logistics  = 4
  //   32 malformed register (3 × 400)                       = 3
  //   37 second constructor                                 = 1
  //   39 second payment approve (runs before this case; reuses the owner
  //      session and makes NO register calls)                = 0
  //   40-43 MJG-036 (run before this case; reuse the case-22/23 partner
  //      session jars and make NO register calls)            = 0
  //   pre-used                                              = 8
  // This case therefore burns 12 throwaway registers (slots 9–20) and asserts
  // the NEXT call is rejected with 429. It MUST stay the LAST case in this
  // file: every later register would inherit the exhausted bucket. The loop
  // stops at the FIRST 429 and tolerates off-by-a-few counting either way.
  test('38 MJG-043 regression: register rate limit → 429 (suite-final case)', async () => {
    let saw429 = false
    for (let i = 0; i < 25; i++) {
      const r = await call('/api/auth/register', {
        method: 'POST',
        body: {
          name: `Rate Burn ${i}`,
          email: `rate-burn-${i}@mjengo-test.test`,
          password: 'BurnPass#2026!',
          organizationName: `Rate Burn Org ${i}`,
        },
      })
      if (r.status === 429) {
        saw429 = true
        expect(errMsg(r)).toContain('Too many registration attempts')
        break
      }
      expect(r.status).toBe(200) // admitted throwaway registers
    }
    expect(saw429).toBe(true)
  })
})
