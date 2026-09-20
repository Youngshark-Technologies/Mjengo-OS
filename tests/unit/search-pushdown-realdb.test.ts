/**
 * Issue #163 / audit API-12 — the /api/search SQL pushdown, verified on a
 * REAL SQLite database (the tests/helpers/db.ts harness: full migration
 * history applied by the real `prisma migrate deploy`, real PrismaClient,
 * real LIKE in the query engine).
 *
 * The issue's parity requirement: "in-memory results vs new mechanism on
 * the shared fixture set". This file runs the REAL route handler over a
 * seeded fixture set and compares, query by query, against a frozen
 * replica of the OLD algorithm (fetch the ≤300 most-recent RAW rows per
 * table, filter in memory with toLowerCase().includes, slice 5) — the
 * pre-#163 route, kept here as the oracle:
 *
 *   · PARITY: for the battery of queries over tables with ≤300 rows, the
 *     pushdown returns EXACTLY the old algorithm's (group, id) pairs in
 *     the same order — same matches, same recent-first ordering, same
 *     group order. Result shapes are pinned key-by-key in the stub suite;
 *     this file pins WHICH rows come back from the real engine.
 *   · THE IMPROVEMENT (why the pushdown was taken): with 320+ projects,
 *     the OLD raw-recency window honestly missed a unique name on the
 *     oldest row — the API-12 silent-miss failure mode. The pushdown
 *     finds it (the window now caps matches, not raw rows).
 *   · THE CEILING THAT REMAINS: 320 matches for one query → the take-300
 *     bound truncates → the response carries the honest `note`.
 *   · THE DECISION'S LINCHPIN, pinned on the real engine: Prisma
 *     `contains` on SQLite compiles to LIKE with its default ASCII
 *     case-insensitivity (row 'AbC vIlLaS', needle 'abc villas' → match).
 *     If a Prisma upgrade ever changes that, this fails and the route
 *     header's claim is false.
 *   · SANITIZE IS LOAD-BEARING, pinned on the real engine: a raw
 *     contains 'a%z' DOES match 'abczeta' (Prisma does NOT escape LIKE
 *     wildcards on SQLite) — the ROUTE strips % / _ first, so q='a%z'
 *     finds nothing.
 *   · Client-role pinning on the real engine: scoped tables stay scoped
 *     through the pushdown (a worker under another project never leaks
 *     into a pinned client's Workers group), and parity holds for the
 *     pinned path too.
 *
 * Route handlers authenticate through withGuard → the REAL
 * getSessionFromReq → next-auth getToken — mocked here (the
 * upload-confirm-realdb.test.ts idiom); the route, route-kit, the REAL
 * token-bucket store and the REAL engine all run. One distinct principal
 * email per test keeps the 60/min search bucket per-test.
 */
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

const tokenState: { token: Record<string, unknown> | null } = { token: null }
vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => tokenState.token),
}))
// Issue #181 (SEC-15): the guard now proves every session against
// User.tokenVersion. This file's tokens are FIXTURES (mocked getToken,
// synthetic principal ids) — the fixture means "a valid, unrevoked
// session", so the revocation seam is mocked to exactly that. The seam
// itself is pinned end-to-end on a REAL JWE + real user rows in
// session-revocation.test.ts.
vi.mock('@/backend/lib/session-revocation', async () => {
  const actual = await vi.importActual<typeof import('@/backend/lib/session-revocation')>(
    '@/backend/lib/session-revocation',
  )
  return { ...actual, sessionTokenIsRevoked: vi.fn(async () => false) }
})

import { GET as searchGet } from '@/app/api/search/route'
import { disposeRealDb, getRealTestDb } from '../helpers/db'

const { prisma } = getRealTestDb()
afterAll(disposeRealDb)

// ------------------------------------------------------------------ fixture

const BASE_WINDOW = new Date('2026-02-01T00:00:00Z').getTime() // the 320-row set (older)
const BASE_MAIN = new Date('2026-03-01T00:00:00Z').getTime() // the battery rows (newest)

const START = new Date('2026-01-06T08:00:00Z')
const TARGET = new Date('2026-12-18T17:00:00Z')

/** ids the assertions need, filled by beforeAll. */
let pa = '' // 'AbC vIlLaS' — Westlands location, the case-fold linchpin row
let pb = '' // 'Harbour Court' — the pinned-scope exclusion row
let oldestWindow = '' // 'window-project-000' — beyond any 300-recent-raw window
let edgeWindow = '' // 'window-project-024' — the oldest row INSIDE the old raw window
let newestWindow = '' // 'window-project-319'
let kamauA = '' // worker under pa
let parA = ''
let supId = ''
let reqA = ''
let poA = ''
let txnA = ''
let invA = ''
let ntfA = ''
let catId = ''

beforeAll(async () => {
  // The four battery projects — the NEWEST rows (so the old algorithm's
  // 300-recent-raw window contains them and parity is exact).
  const mk = (data: Record<string, unknown>) =>
    prisma.project.create({
      data: { budget: 5_000_000_00n, startDate: START, targetDate: TARGET, ...data } as never,
    })
  pa = (await mk({ name: 'AbC vIlLaS', client: 'Alpha Client', location: 'Westlands', createdAt: new Date(BASE_MAIN) })).id
  pb = (await mk({ name: 'Harbour Court', client: 'Beta Client', location: 'Mombasa', createdAt: new Date(BASE_MAIN + 60_000) })).id
  await mk({ name: 'abczeta', client: 'Gamma Client', location: 'Nairobi', createdAt: new Date(BASE_MAIN + 120_000) })
  await mk({ name: 'a%b estate', client: 'Delta Client', location: 'Kiambu', createdAt: new Date(BASE_MAIN + 180_000) })

  // The 320-row window set (older) — every name matches 'window-project'.
  await prisma.$transaction(
    Array.from({ length: 320 }, (_, i) =>
      prisma.project.create({
        data: {
          name: `window-project-${String(i).padStart(3, '0')}`,
          client: 'Window Client',
          location: 'Windowland',
          budget: 1_000_000_00n,
          startDate: START,
          targetDate: TARGET,
          createdAt: new Date(BASE_WINDOW + i * 60_000),
        },
      }),
    ),
  )
  oldestWindow = (await prisma.project.findFirstOrThrow({ where: { name: 'window-project-000' } })).id
  edgeWindow = (await prisma.project.findFirstOrThrow({ where: { name: 'window-project-024' } })).id
  newestWindow = (await prisma.project.findFirstOrThrow({ where: { name: 'window-project-319' } })).id

  // The other nine source tables, one battery row each (all under pa except
  // the global supplier/catalog and pb's scope-exclusion worker).
  supId = (
    await prisma.supplier.create({
      data: { businessName: 'Westlands Hardware', county: 'Nairobi', town: 'Westlands', createdAt: new Date(BASE_MAIN) },
    })
  ).id
  catId = (
    await prisma.catalogItem.create({
      data: { supplierId: supId, name: 'Cement 50kg', brand: 'Simba', specification: '42.5N bag', unit: 'bag', unitPrice: 85_000n, createdAt: new Date(BASE_MAIN) },
    })
  ).id
  parA = (
    await prisma.landParcel.create({
      data: { projectId: pa, plotNumber: 'LR 209/123', county: 'Nairobi', town: 'Westlands', status: 'verified', createdAt: new Date(BASE_MAIN) },
    })
  ).id
  kamauA = (
    await prisma.worker.create({
      data: { projectId: pa, name: 'Kamau Njoroge', role: 'Foreman', phone: '0700000001', dailyRate: 80_000n },
    })
  ).id
  await prisma.worker.create({
    data: { projectId: pb, name: 'Kamau Rival', role: 'Driller', phone: '0700000002', dailyRate: 70_000n },
  })
  reqA = (
    await prisma.materialRequest.create({
      data: { projectId: pa, requestCode: 'MR-1042', requestedByRole: 'supervisor', requestedByName: 'Sup One', status: 'submitted', createdAt: new Date(BASE_MAIN) },
    })
  ).id
  poA = (
    await prisma.purchaseOrder.create({
      data: { projectId: pa, orderCode: 'PO-2026-000012', supplierId: supId, subtotal: 85_000n, deliveryFee: 0n, total: 85_000n, status: 'sent', createdByRole: 'procurement', createdAt: new Date(BASE_MAIN) },
    })
  ).id
  txnA = (
    await prisma.transaction.create({
      data: { projectId: pa, type: 'material', amount: 85_000n, reference: 'MPESA-ABC123', note: 'Cement delivery', date: new Date(BASE_MAIN), createdAt: new Date(BASE_MAIN) },
    })
  ).id
  invA = (
    await prisma.invoice.create({
      data: { projectId: pa, invoiceCode: 'INV-2026-000031', status: 'submitted', total: 85_000n, createdAt: new Date(BASE_MAIN) },
    })
  ).id
  ntfA = (
    await prisma.notification.create({
      data: { projectId: pa, kind: 'system', title: 'Cement delivered', body: 'The cement delivery arrived on site', createdAt: new Date(BASE_MAIN) },
    })
  ).id
})

// ------------------------------------------------- the OLD algorithm (oracle)

const MAX_SCAN = 300
const MAX_PER_GROUP = 5

/** The pre-#163 route, frozen: ≤300 most-recent RAW rows per table, then
 *  the in-memory toLowerCase().includes filter, then the group mapping —
 *  reduced to ordered (group, id) pairs (shapes pinned in the stub suite). */
async function oldAlgorithmPairs(raw: string, projectId: string | null): Promise<Array<[string, string]>> {
  const q = raw.replace(/[%_]/g, ' ').trim().toLowerCase()
  const scope = projectId ? { projectId } : {}
  const [projects, parcels, workers, suppliers, catalogItems, requests, orders, transactions, invoices, notifications] =
    await Promise.all([
      projectId
        ? prisma.project.findMany({ where: { id: projectId } })
        : prisma.project.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.landParcel.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.worker.findMany({ where: { ...scope }, take: MAX_SCAN }),
      prisma.supplier.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.catalogItem.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.materialRequest.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.purchaseOrder.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.transaction.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.invoice.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
      prisma.notification.findMany({ where: { ...scope }, orderBy: { createdAt: 'desc' }, take: MAX_SCAN }),
    ])

  const has = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(q)
  const pairs: Array<[string, string]> = []
  const add = (group: string, rows: Array<Record<string, unknown>>, fields: string[]) => {
    for (const r of rows.filter((r) => fields.some((f) => has(r[f]))).slice(0, MAX_PER_GROUP)) {
      pairs.push([group, String(r.id)])
    }
  }
  add('Projects', projects as unknown as Array<Record<string, unknown>>, ['name', 'client', 'location'])
  add('Land parcels', parcels as unknown as Array<Record<string, unknown>>, ['plotNumber', 'county', 'town'])
  add('Workers', workers as unknown as Array<Record<string, unknown>>, ['name', 'role'])
  add('Suppliers', suppliers as unknown as Array<Record<string, unknown>>, ['businessName', 'county', 'town'])
  add('Catalog items', catalogItems as unknown as Array<Record<string, unknown>>, ['name', 'brand', 'specification'])
  add('Requests', requests as unknown as Array<Record<string, unknown>>, ['requestCode'])
  add('Purchase orders', orders as unknown as Array<Record<string, unknown>>, ['orderCode'])
  add('Transactions', transactions as unknown as Array<Record<string, unknown>>, ['reference', 'note'])
  add('Invoices', invoices as unknown as Array<Record<string, unknown>>, ['invoiceCode'])
  add('Notifications', notifications as unknown as Array<Record<string, unknown>>, ['title', 'body'])
  return pairs
}

// ----------------------------------------------------------------- the route

let principalSeq = 0

function contractorSession(): void {
  principalSeq += 1
  tokenState.token = {
    id: `u-${principalSeq}`,
    email: `foreman+search${principalSeq}@test.dev`,
    name: 'Foreman',
    role: 'contractor',
    projectId: null,
  }
}

function clientSession(projectId: string): void {
  principalSeq += 1
  tokenState.token = {
    id: `u-${principalSeq}`,
    email: `client+search${principalSeq}@test.dev`,
    name: 'Client',
    role: 'client',
    projectId,
  }
}

async function searchBody(raw: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await searchGet(
    new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(raw)}`),
    undefined,
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function pairsOf(body: Record<string, unknown>): Array<[string, string]> {
  const groups = (body.groups as Array<{ group: string; items: Array<{ id: string }> }>) ?? []
  return groups.flatMap((g) => g.items.map((it) => [g.group, it.id] as [string, string]))
}

// -------------------------------------------------------------------- tests

describe('GET /api/search — #163 SQL pushdown on the real engine (API-12)', () => {
  it('PARITY: the pushdown returns exactly the old in-memory algorithm’s rows, query for query', async () => {
    contractorSession()
    // The battery: every source table, exact/substring/mixed-case/no-match
    // and a wildcard-carrying query. None matches the 320-row window set,
    // so the old raw-recency window contains every battery row and the
    // comparison is exact — same pairs, same order.
    const battery = [
      'westlands', // project (location) + parcel (town) + supplier (businessName)
      'abc villas', // mixed-case row, lowercased needle
      'VILLAS', // uppercase needle — LIKE folds ASCII case
      'harbour',
      'foreman', // worker role
      'mr-1042', // requestCode
      'po-2026', // orderCode
      'mpesa-abc', // transaction reference (case fold)
      'inv-2026', // invoiceCode
      'cement', // catalog name + transaction note + notification title/body
      'nonexistent-zz', // no match anywhere
      'a%z', // wildcard needle — sanitized to 'a z' before the LIKE
    ]
    for (const q of battery) {
      const expected = await oldAlgorithmPairs(q, null)
      const { status, body } = await searchBody(q)
      expect(status, `query '${q}'`).toBe(200)
      expect(body.ok, `query '${q}'`).toBe(true)
      expect(pairsOf(body), `parity for '${q}'`).toEqual(expected)
    }

    // spot-check the battery actually exercised all ten groups (a parity
    // pass over empty results would otherwise be vacuous)
    const { body: spot } = await searchBody('cement')
    expect(pairsOf(spot)).toEqual([
      ['Catalog items', catId],
      ['Transactions', txnA],
      ['Notifications', ntfA],
    ])
    const { body: westlands } = await searchBody('westlands')
    expect(pairsOf(westlands)).toEqual([
      ['Projects', pa],
      ['Land parcels', parA],
      ['Suppliers', supId],
    ])
  })

  it('THE IMPROVEMENT: a unique name on the OLDEST row — beyond the old 300-raw-row window — is found', async () => {
    contractorSession()
    // 324 projects exist; the OLD algorithm's raw window is the 300 newest
    // (the window set rows 319..20) — 'window-project-000' is the OLDEST
    // row and was honestly missed (the API-12 silent exact-match miss).
    const oldPairs = await oldAlgorithmPairs('window-project-000', null)
    expect(oldPairs).toEqual([]) // the old mechanism missed it

    const { status, body } = await searchBody('window-project-000')
    expect(status).toBe(200)
    expect(pairsOf(body)).toEqual([['Projects', oldestWindow]]) // the pushdown finds it
    expect(body.note).toBeUndefined() // one match — the cap never bit
  })

  it('the old-window edge row stays findable by both mechanisms (parity at the boundary)', async () => {
    contractorSession()
    // 324 projects: the old raw window = 4 battery rows + window rows
    // 319..24 — so p-024 is the OLDEST row the old algorithm could see.
    // Parity must hold exactly there (the boundary), while p-000 (two
    // tests up) is the beyond-window row only the pushdown finds.
    const oldPairs = await oldAlgorithmPairs('window-project-024', null)
    expect(oldPairs).toEqual([['Projects', edgeWindow]])
    const { status, body } = await searchBody('window-project-024')
    expect(status).toBe(200)
    expect(pairsOf(body)).toEqual(oldPairs) // parity at the edge
    expect(pairsOf(body)).toEqual([['Projects', edgeWindow]])
  })

  it('THE CEILING THAT REMAINS: 320 matches → the 300-match cap truncates + the honest note', async () => {
    contractorSession()
    const { status, body } = await searchBody('window-project')
    expect(status).toBe(200)
    const pairs = pairsOf(body)
    expect(pairs).toHaveLength(5) // MAX_PER_GROUP
    expect(pairs[0]).toEqual(['Projects', newestWindow]) // newest 5 shown, recent-first
    expect(pairs.map(([, id]) => id)).not.toContain(oldestWindow) // beyond the 300-match cap
    expect(body.note).toBe(
      'Match cap reached — at least one table has 300+ matches for this query; refine it to see older matches',
    )
  })

  it('THE LINCHPIN: Prisma contains on SQLite is ASCII case-insensitive (probe promoted to a CI pin)', async () => {
    contractorSession()
    // If a Prisma upgrade ever changes LIKE semantics, this fails and the
    // route header's "ASCII case-insensitive by default" claim is false.
    const direct = await prisma.project.findMany({
      where: { name: { contains: 'abc villas' } },
      select: { id: true },
    })
    expect(direct.map((r) => r.id)).toEqual([pa])

    // …and through the route: 'VILLAS' (uppercased needle) finds the row
    const { status, body } = await searchBody('VILLAS')
    expect(status).toBe(200)
    expect(pairsOf(body)).toEqual([['Projects', pa]])
  })

  it('SANITIZE IS LOAD-BEARING: a raw % needle wildcards in LIKE — the ROUTE strips it first', async () => {
    contractorSession()
    // Direct engine probe: contains 'a%z' DOES match 'abczeta' — Prisma
    // does NOT escape LIKE wildcards on SQLite.
    const wild = await prisma.project.findMany({
      where: { name: { contains: 'a%z' } },
      select: { name: true },
    })
    expect(wild.map((r) => r.name)).toContain('abczeta')

    // Through the route: q='a%z' is sanitized to 'a z' BEFORE the pushdown
    // — no project contains 'a z', so the wildcard cannot act as one.
    const { status, body } = await searchBody('a%z')
    expect(status).toBe(200)
    expect(pairsOf(body)).toEqual([])
    expect(body.q).toBe('a%z') // the RAW query echoes back unchanged
  })

  it('response shape on the real engine: ok/q/scopedTo/groups, no note when the cap never bites', async () => {
    contractorSession()
    const { body } = await searchBody('harbour')
    expect(Object.keys(body).sort()).toEqual(['groups', 'ok', 'q', 'scopedTo'])
    expect(body.q).toBe('harbour')
    expect(body.scopedTo).toBeNull()
    expect(pairsOf(body)).toEqual([['Projects', pb]])
  })

  it('client-role pinning survives the pushdown: scoped tables stay scoped, parity holds for the pinned path', async () => {
    clientSession(pa)
    // 'kamau' matches workers under BOTH pa (Kamau Njoroge) and pb (Kamau
    // Rival) — a pinned client must see only their own project's worker.
    const oldPairs = await oldAlgorithmPairs('kamau', pa)
    expect(oldPairs).toEqual([['Workers', kamauA]]) // the old algorithm scoped it…
    const { status, body } = await searchBody('kamau')
    expect(status).toBe(200)
    expect(body.scopedTo).toBe(pa)
    expect(pairsOf(body)).toEqual([['Workers', kamauA]]) // …and so does the pushdown

    // the pinned project itself is searched by id + LIKE; another
    // project's name ('Harbour Court') is invisible to this session
    const { body: harbourBody } = await searchBody('harbour')
    expect(pairsOf(harbourBody)).toEqual([])
    expect(harbourBody.scopedTo).toBe(pa)

    // parity for a multi-group pinned query (project + parcel + the
    // GLOBAL supplier table, which was never project-scoped)
    const expected = await oldAlgorithmPairs('westlands', pa)
    expect(expected).toEqual([
      ['Projects', pa],
      ['Land parcels', parA],
      ['Suppliers', supId],
    ])
    const { body: westlandsBody } = await searchBody('westlands')
    expect(pairsOf(westlandsBody)).toEqual(expected)
  })
})
