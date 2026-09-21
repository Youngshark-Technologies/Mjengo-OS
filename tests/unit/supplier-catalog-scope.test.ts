/**
 * MD-6 (audit register, MOCK_DEMO_BASELINE §4) — supplier catalog
 * demo-editing scope, through the REAL applyAction (the
 * share-regenerate-gate.test.ts idiom: in-memory db stub, real mjengo module
 * graph so the production applier + role gates are what runs).
 *
 * THE CONTRACT:
 *   · ACTION-LAYER GATE — supplier.upsert + catalog.upsert (network-global
 *     master data) are contractor/admin-only for BUYER-side roles, enforced in
 *     lib/mjengo.applyAction's B1 gate block so every entry route inherits it
 *     (/api/actions, /api/sync outbox items, the gateways) — never UI-only
 *     hiding. supervisor/procurement/qs/finance are refused BEFORE any handler
 *     touches data (zero catalog/supplier reads or writes).
 *   · CLIENTS KEEP THEIR SEAM COPY — a client/share stamp on these actions
 *     still answers with the §24 client-seam refusal (the MD-6 gate runs
 *     after it), not a second contradictory message.
 *   · SUPPLIER PORTAL UNTOUCHED — a supplier session falls THROUGH the MD-6
 *     gate to the W5-3 pin (assertSupplierScope): own catalog item edits
 *     proceed with supplierId rewritten to the session pin; a foreign item id
 *     answers like a miss. This issue is about the CATALOG master data, not
 *     the supplier's own quote/order workflow.
 *   · READS UNAFFECTED — the unscoped roles keep the read side (supply.compare
 *     runs the same landed-cost ranking as before) and catalog reads through
 *     /api/project / /api/supplier are untouched by this gate.
 *   · INTERNAL DEFAULT — a no-stamp dispatch (jobs/node scripts) keeps the
 *     'contractor' default and still edits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  const state = {
    projects: [] as Array<Record<string, unknown>>,
    suppliers: [] as Array<Record<string, unknown>>,
    catalog: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    requests: [] as Array<Record<string, unknown>>,
    /** Write-call counters — the "zero reads/writes" pins. */
    calls: { catalogFindUnique: 0, catalogUpdate: 0, catalogCreate: 0, supplierFindUnique: 0, supplierUpdate: 0, supplierCreate: 0 },
    reset() {
      state.projects = [{ id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', createdAt: new Date('2026-01-04T09:00:00Z') }]
      state.suppliers = [
        { id: 'sup-1', businessName: 'Nairobi Hardware Centre', county: 'Nairobi', deliveryFeeBase: 250_000n, reliabilityScore: 80, responseHours: 12, deliveryZones: '', lat: -1.29, lng: 36.82 },
        { id: 'sup-2', businessName: 'Karioke Hardware', county: 'Kiambu', deliveryFeeBase: 150_000n, reliabilityScore: 70, responseHours: 24, deliveryZones: '', lat: null, lng: null },
      ]
      state.catalog = [
        { id: 'ci-1', supplierId: 'sup-1', name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 78_000n, stockQty: 500, minOrderQty: 10, category: null, brand: null, specification: null, updatedAt: new Date('2026-03-01T09:00:00Z') },
        { id: 'ci-2', supplierId: 'sup-2', name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 82_000n, stockQty: 300, minOrderQty: 20, category: null, brand: null, specification: null, updatedAt: new Date('2026-03-01T09:00:00Z') },
      ]
      state.audits = []
      state.requests = []
      state.calls = { catalogFindUnique: 0, catalogUpdate: 0, catalogCreate: 0, supplierFindUnique: 0, supplierUpdate: 0, supplierCreate: 0 }
    },
  }
  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: { id?: string } }) {
        return state.projects.find((p) => p.id === where?.id) ?? null
      },
      async findFirst() { return state.projects[0] ?? null },
    },
    supplier: {
      async findUnique({ where }: { where: { id?: string } }) {
        state.calls.supplierFindUnique += 1
        return state.suppliers.find((s) => s.id === where?.id) ?? null
      },
      async findMany() {
        // compareSuppliers' loadSuppliersWithCatalog — catalog carried inline
        return state.suppliers.map((s) => ({
          ...s,
          catalogItems: state.catalog.filter((c) => c.supplierId === s.id),
        }))
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        state.calls.supplierUpdate += 1
        const row = state.suppliers.find((s) => s.id === where.id)
        if (!row) throw new Error('Supplier not found')
        Object.assign(row, data)
        return { ...row }
      },
      async create({ data }: { data: Record<string, unknown> }) {
        state.calls.supplierCreate += 1
        const row = { id: `sup-new-${state.calls.supplierCreate}`, ...data }
        state.suppliers.push(row)
        return { ...row }
      },
    },
    catalogItem: {
      async findUnique({ where }: { where: { id?: string } }) {
        state.calls.catalogFindUnique += 1
        return state.catalog.find((c) => c.id === where?.id) ?? null
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        state.calls.catalogUpdate += 1
        const row = state.catalog.find((c) => c.id === where.id)
        if (!row) throw new Error('Catalog item not found')
        Object.assign(row, data, { updatedAt: new Date() })
        return { ...row }
      },
      async create({ data }: { data: Record<string, unknown> }) {
        state.calls.catalogCreate += 1
        const row = { id: `ci-new-${state.calls.catalogCreate}`, ...data, updatedAt: new Date() }
        state.catalog.push(row)
        return { ...row }
      },
    },
    landParcel: {
      async findMany() { return [] }, // compareSuppliers' site resolve — Nairobi default
    },
    materialRequest: {
      async findMany() { return [] }, // nextRequestCode scan — no prior requests
      async create({ data }: { data: Record<string, unknown> }) {
        state.requests ??= []
        const lines = ((data.lines as { create?: Array<Record<string, unknown>> })?.create ?? []).map((l, i) => ({ id: `ml-new-${i}`, ...l }))
        const row = { id: 'mr-new', ...data, lines }
        state.requests.push(row)
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.audits.push(data)
        return { id: `a-${state.audits.length}` }
      },
    },
  }
  return { db }
})

// The REAL mjengo (applyAction + the MD-6 SUPPLIER_MASTER role gate) against
// the in-memory db above — the share-regenerate-gate.test.ts idiom.
import { applyAction } from '@/backend/lib/mjengo'
import { db } from '@/backend/lib/db'

const dbState = (db as unknown as {
  __state: {
    catalog: Array<Record<string, unknown>>
    audits: Array<Record<string, unknown>>
    calls: Record<string, number>
    reset: () => void
  }
}).__state

/** A buyer-side catalog edit payload (the SupplierDirectory edit dialog's). */
function catalogEdit() {
  return { supplierId: 'sup-1', id: 'ci-1', name: 'Cement 50kg (32.5N)', unit: 'bag', unitPrice: 80, stockQty: 400, minOrderQty: 10 }
}

beforeEach(() => {
  dbState.reset()
})

describe('MD-6 — supplier/catalog master-data edits are contractor/admin-only (action layer)', () => {
  it('supervisor/procurement/qs/finance are refused BEFORE any handler runs — zero catalog reads or writes', async () => {
    for (const role of ['supervisor', 'procurement', 'qs', 'finance']) {
      await expect(
        applyAction('catalog.upsert', { ...catalogEdit(), __actor: 'R', __role: role }, 'p-1'),
        `role ${role}`,
      ).rejects.toThrow(/Only a contractor or admin may maintain supplier and catalog rows/)
    }
    expect(dbState.calls.catalogFindUnique).toBe(0)
    expect(dbState.calls.catalogUpdate).toBe(0)
    expect(dbState.calls.catalogCreate).toBe(0)
    expect(dbState.audits).toHaveLength(0)
  })

  it('supplier.upsert is refused the same way (the matrix case-4 pair)', async () => {
    for (const role of ['supervisor', 'procurement', 'qs', 'finance']) {
      await expect(
        applyAction('supplier.upsert', { businessName: 'New Yard', county: 'Nairobi', __actor: 'R', __role: role }, 'p-1'),
        `role ${role}`,
      ).rejects.toThrow(/Only a contractor or admin may maintain supplier and catalog rows/)
    }
    expect(dbState.calls.supplierCreate).toBe(0)
    expect(dbState.calls.supplierUpdate).toBe(0)
  })

  it('a client/share stamp keeps the §24 client-seam refusal copy, not the MD-6 one', async () => {
    for (const role of ['client', 'share_client']) {
      await expect(
        applyAction('catalog.upsert', { ...catalogEdit(), __actor: 'Mama Njeri', __role: role }, 'p-1'),
        `role ${role}`,
      ).rejects.toThrow(/stays with the site team \(spec §24\)/)
    }
    expect(dbState.calls.catalogUpdate).toBe(0)
  })

  it('contractor and admin edit succeeds — the write lands and the ledger row is written', async () => {
    for (const role of ['contractor', 'admin']) {
      const result = await applyAction('catalog.upsert', { ...catalogEdit(), __actor: 'A', __role: role }, 'p-1')
      expect(result).toMatchObject({ id: 'ci-1', name: 'Cement 50kg (32.5N)' })
    }
    expect(dbState.calls.catalogUpdate).toBe(2)
    expect(dbState.catalog[0].unitPrice).toBe(8_000n) // KSh 80 → 8000 cents
    expect(dbState.catalog[0].stockQty).toBe(400)
    expect(dbState.audits).toHaveLength(2)
  })

  it('the no-stamp internal default (contractor) still edits — jobs/scripts keep working', async () => {
    await expect(applyAction('catalog.upsert', catalogEdit(), 'p-1')).resolves.toMatchObject({ id: 'ci-1' })
    expect(dbState.calls.catalogUpdate).toBe(1)
  })

  it('new-supplier capture stays available to contractor/admin', async () => {
    const result = await applyAction(
      'supplier.upsert',
      { businessName: 'New Yard Supplies', county: 'Nairobi', __actor: 'A', __role: 'contractor' },
      'p-1',
    )
    expect(result).toMatchObject({ businessName: 'New Yard Supplies' })
    expect(dbState.calls.supplierCreate).toBe(1)
  })
})

describe('MD-6 — the supplier portal (W5-3 pin) is untouched', () => {
  it('a supplier session edits its OWN catalog item — supplierId rewritten to the session pin', async () => {
    const payload = { ...catalogEdit(), supplierId: 'sup-2', __actor: 'Nairobi Hardware Centre', __role: 'supplier', __supplierId: 'sup-1' }
    const result = await applyAction('catalog.upsert', payload, 'p-1')
    expect(result).toMatchObject({ id: 'ci-1', name: 'Cement 50kg (32.5N)' })
    // The forged payload copy was ignored — the row is ci-1 (sup-1's own).
    expect(dbState.calls.catalogUpdate).toBe(1)
    expect(dbState.catalog[0].stockQty).toBe(400)
  })

  it('a supplier session on a FOREIGN item id answers like a miss — the byte-identical error, zero writes', async () => {
    await expect(
      applyAction('catalog.upsert', { ...catalogEdit(), id: 'ci-2', __actor: 'Nairobi Hardware Centre', __role: 'supplier', __supplierId: 'sup-1' }, 'p-1'),
    ).rejects.toThrow('Catalog item not found')
    await expect(
      applyAction('catalog.upsert', { ...catalogEdit(), id: 'ci-x', __actor: 'Nairobi Hardware Centre', __role: 'supplier', __supplierId: 'sup-1' }, 'p-1'),
    ).rejects.toThrow('Catalog item not found')
    expect(dbState.calls.catalogUpdate).toBe(0)
  })

  it('a supplier session CANNOT reach supplier.upsert (not on SUPPLIER_ACTIONS — the pin refuses it)', async () => {
    await expect(
      applyAction('supplier.upsert', { id: 'sup-1', businessName: 'Renamed', __actor: 'S', __role: 'supplier', __supplierId: 'sup-1' }, 'p-1'),
    ).rejects.toThrow(/Suppliers answer their own quotes/)
    expect(dbState.calls.supplierUpdate).toBe(0)
  })
})

describe('MD-6 — reads and the rest of the supply loop are unaffected', () => {
  it('an unscoped role (procurement) still runs the read-side supply.compare ranking', async () => {
    const result = (await applyAction(
      'supply.compare',
      { materialName: 'Cement 50kg (32.5N)', qty: 100, __actor: 'P', __role: 'procurement' },
      'p-1',
    )) as { rows?: Array<{ supplierId?: string }> }
    expect(result.rows.length).toBeGreaterThan(0)
    expect(dbState.calls.catalogUpdate).toBe(0)
    // The comparison read every supplier row — proof the read path still runs.
    expect(result.rows.map((r) => r.supplierId)).toContain('sup-1')
  })

  it('the gate never fires for non-master-data supply actions (request.create, procurement role)', async () => {
    // request.create is the procurement officer's daily act — a write, but
    // nowhere near the MD-6 gate (the materialRequest stub is in the factory).
    const result = await applyAction(
      'request.create',
      { lines: [{ materialName: 'Cement 50kg (32.5N)', unit: 'bag', qty: 100 }], __actor: 'P', __role: 'procurement' },
      'p-1',
    )
    expect(result).toMatchObject({ id: 'mr-new', requestCode: 'MR-1001', lineCount: 1 })
    expect(dbState.calls.catalogUpdate).toBe(0)
  })
})
