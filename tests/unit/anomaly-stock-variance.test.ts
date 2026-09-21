/**
 * Anomaly scan wiring for the stock variance watch (issue #359 / REC-1) —
 * src/backend/modules/jobs/handlers.ts runAnomalyScan: the shared core behind
 * POST /api/ai/anomaly-scan and the §58 'anomaly_scan' job.
 *
 * The pure rule (computeStockVarianceFindings) is pinned by
 * tests/unit/intel-stock-variance.test.ts; THIS file pins the wiring — the
 * parts only the scan can get wrong:
 *
 *   · the scan fetches StockCount sessions by countedAt in a 14-day window
 *     (a session older than that is out of scope; countedAt, not createdAt —
 *     an offline count flushed late still counts from when the bags were
 *     counted);
 *   · a beyond-threshold session becomes a REAL Alert row: type 'anomaly'
 *     (RULE_ALERT_TYPE), severity 'warning', the message ending in
 *     '[rule: stock_variance_watch]' with the evidence inline — the same
 *     Alert shape as every other deterministic rule;
 *   · the finding is reported in deterministicRules and the summary counts
 *     it, so the §59 'anomaly.detected' event carries it to the bell;
 *   · an in-threshold store raises NOTHING (no alert rows, empty
 *     deterministicRules, the honest 0-finding summary naming stock-count
 *     variance among the quiet rules).
 *
 * Mocks (the established scan-adjacent idiom): '@/backend/lib/ai' (the LLM
 * seam returns an EMPTY alerts pass so only the deterministic layer speaks;
 * buildProjectDigest is stubbed to the projectId the scan keys on),
 * '@/backend/lib/db' (in-memory tables — the deterministic read surface +
 * alert.create capture) and '@/backend/modules/events/service' (emit
 * captured, never a fake DomainEvent row). The engine, the handler bodies
 * and RULE_ALERT_TYPE stay REAL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/ai', () => ({
  buildProjectDigest: vi.fn(async () => ({ projectId: 'p-1', project: { name: 'Variance Bungalow' } })),
  // The LLM pass returns no alerts — the deterministic rules must speak for
  // themselves (the exact behavior a flag-off / quiet-model deployment sees).
  llm: vi.fn(async () => ({ alerts: [], summary: '' })),
}))

vi.mock('@/backend/modules/events/service', () => ({
  emit: vi.fn(async () => undefined),
}))

vi.mock('@/backend/lib/db', () => {
  type StockCountRow = {
    id: string
    projectId: string
    countedBy: string
    countedAt: Date
    note: string | null
    blind: boolean
    status: string
    items: Array<{
      countId: string
      expectedQty: number
      countedQty: number
      inventoryItem: { materialName: string; unit: string }
    }>
  }
  type AlertRow = { id: string; projectId: string; type: string; severity: string; title: string; message: string }
  const counts = new Map<string, StockCountRow>()
  const alerts: AlertRow[] = []
  let seq = 0
  const db = {
    __reset() {
      counts.clear()
      alerts.length = 0
      seq = 0
    },
    __seedCount(over: Partial<StockCountRow> & Pick<StockCountRow, 'id' | 'countedAt' | 'items'>): StockCountRow {
      const row: StockCountRow = {
        id: over.id,
        projectId: 'p-1',
        countedBy: 'Otieno (storekeeper)',
        countedAt: over.countedAt,
        note: null,
        blind: false,
        status: 'open',
        ...over,
      }
      counts.set(row.id, row)
      return row
    },
    __alerts: alerts,
    attendance: { findMany: async () => [] },
    transaction: { findMany: async () => [] },
    phase: { findMany: async () => [] },
    boq: { findMany: async () => [] },
    purchaseOrder: { findMany: async () => [] },
    stockCount: {
      async findMany({ where }: { where: { projectId: string; countedAt?: { gte: Date } } }) {
        return [...counts.values()]
          .filter((c) => c.projectId === where.projectId)
          .filter((c) => !where.countedAt?.gte || c.countedAt.getTime() >= where.countedAt.gte.getTime())
          .sort((a, b) => b.countedAt.getTime() - a.countedAt.getTime())
          .map((c) => ({ ...c, items: c.items.map((i) => ({ ...i })) }))
      },
    },
    alert: {
      async create({ data }: { data: Omit<AlertRow, 'id'> }) {
        seq += 1
        const row: AlertRow = { id: `alt-${seq}`, ...data }
        alerts.push(row)
        return row
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { runAnomalyScan } from '@/backend/modules/jobs/handlers'
import { emit } from '@/backend/modules/events/service'

/** The stub surface (typed structurally — the mock factory's own shapes). */
interface ScanDbStub {
  __reset: () => void
  __seedCount: (over: {
    id: string
    countedAt: Date
    blind?: boolean
    items: Array<{ countId: string; expectedQty: number; countedQty: number; inventoryItem: { materialName: string; unit: string } }>
  }) => void
  __alerts: Array<{ id: string; type: string; severity: string; title: string; message: string }>
}
const stub = db as unknown as ScanDbStub

const DAY = 86_400_000

beforeEach(() => {
  stub.__reset()
  vi.clearAllMocks()
})

describe('runAnomalyScan — stock variance wiring (REC-1 #359)', () => {
  it('a beyond-threshold count session raises ONE anomaly Alert row with the rule key', async () => {
    stub.__seedCount({
      id: 'cnt-variance0001',
      countedAt: new Date(Date.now() - DAY),
      blind: true,
      items: [
        { countId: 'cnt-variance0001', expectedQty: 150, countedQty: 120, inventoryItem: { materialName: 'Cement', unit: 'bag' } },
        { countId: 'cnt-variance0001', expectedQty: 8, countedQty: 8, inventoryItem: { materialName: 'Nails', unit: 'kg' } },
      ],
    })

    const scan = await runAnomalyScan('p-1')

    // ONE alert for the session (not one per line), from the deterministic layer.
    expect(scan.alerts).toHaveLength(1)
    const alert = scan.alerts[0]
    expect(alert.type).toBe('anomaly') // RULE_ALERT_TYPE['stock_variance_watch']
    expect(alert.severity).toBe('warning')
    expect(alert.title).toContain('Stock count variance beyond threshold')
    expect(alert.title).toContain('(blind count)')

    // The written row carries evidence + the machine-readable rule key.
    expect(stub.__alerts).toHaveLength(1)
    expect(stub.__alerts[0].message).toContain('expected 150 bag, counted 120 bag')
    expect(stub.__alerts[0].message).toContain('20% of book')
    expect(stub.__alerts[0].message).toContain('ran BLIND')
    expect(stub.__alerts[0].message).toMatch(/\[rule: stock_variance_watch\]$/)

    // The scan result + summary report it, and the §59 event carries it.
    expect(scan.deterministicRules).toEqual(['stock_variance_watch'])
    expect(scan.summary).toContain('stock_variance_watch×1')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('p-1', 'anomaly.detected', expect.objectContaining({
      count: 1,
      deterministicRules: ['stock_variance_watch'],
      severity: 'warning',
    }))
  })

  it('an in-threshold store raises NOTHING — the honest 0-finding summary names the quiet rule', async () => {
    stub.__seedCount({
      id: 'cnt-clean000001',
      countedAt: new Date(Date.now() - DAY),
      items: [{ countId: 'cnt-clean000001', expectedQty: 150, countedQty: 148, inventoryItem: { materialName: 'Cement', unit: 'bag' } }],
    })

    const scan = await runAnomalyScan('p-1')

    expect(scan.alerts).toHaveLength(0)
    expect(stub.__alerts).toHaveLength(0)
    expect(scan.deterministicRules).toEqual([])
    expect(scan.summary).toContain('0 findings')
    expect(scan.summary).toContain('stock-count variance')
  })

  it('the window is 14 days of countedAt — an older session is out of scope', async () => {
    stub.__seedCount({
      id: 'cnt-old0000001',
      countedAt: new Date(Date.now() - 20 * DAY), // outside the window
      items: [{ countId: 'cnt-old0000001', expectedQty: 100, countedQty: 20, inventoryItem: { materialName: 'Cement', unit: 'bag' } }],
    })

    const scan = await runAnomalyScan('p-1')
    expect(scan.alerts).toHaveLength(0)
    expect(scan.deterministicRules).toEqual([])
  })
})
