/**
 * Stock variance watch (issue #359 / REC-1) — src/backend/modules/intel/
 * engine.ts computeStockVarianceFindings: the deterministic rule that raises
 * a count session's beyond-threshold book-vs-physical gaps into the anomaly
 * scan's Alert feed.
 *
 * Pure engine (same idiom as the other §16/§29 rules): the caller scopes the
 * window; the rule is documented thresholds and nothing else. Pinned
 * invariants:
 *
 *   · THRESHOLD — a line fires only when BOTH legs hold: |variance| ≥ 1
 *     whole unit (absolute materiality — sub-unit gaps are rounding) AND
 *     |variance| > 10% of the expected (book) figure (relative
 *     materiality — 3 bags off a 300-bag book is noise, 3 off a 20-bag
 *     book is a real gap). Expected ≤ 0 satisfies the relative leg
 *     vacuously: a whole unit+ the book does not know about is always a
 *     look-worthy gap.
 *   · ONE FINDING PER SESSION — the lines are listed inside the message
 *     (capped at 5, "+N more" after), never one finding per line.
 *   · EVIDENCE + RULE KEY — the finding carries counts, the count id
 *     tail and the threshold in evidence; rule 'stock_variance_watch',
 *     severity 'warning' (the budget_category_overrun weight).
 *   · BLIND SESSIONS SAY SO — the title and message carry the blind
 *     claim (the counter never saw the book figures while counting).
 *   · VARIANCE HAS ONE DEFINITION — expected − counted, recomputed here
 *     from the two stored quantities (the pure engine never imports the
 *     repository; the numbers are the same rows).
 */
import { describe, expect, it } from 'vitest'

import {
  computeStockVarianceFindings,
  STOCK_VARIANCE_MIN_QTY,
  STOCK_VARIANCE_PCT,
  type StockVarianceCount,
} from '@/backend/modules/intel/engine'

const d = (iso: string) => new Date(iso)

const session = (over: Partial<StockVarianceCount> & { lines: StockVarianceCount['lines'] }): StockVarianceCount => ({
  countId: 'cnt-abcdefgh1234',
  countedAt: d('2026-06-10T09:00:00.000Z'),
  countedBy: 'Otieno (storekeeper)',
  blind: false,
  ...over,
})

describe('computeStockVarianceFindings — the threshold truth table', () => {
  it('fires when both legs hold: ≥ 1 whole unit AND > 10% of the book', () => {
    // 16 off a 150-bag book: 10.67% of the book, a whole-unit gap.
    const findings = computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 150, countedQty: 134 }] }),
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe('stock_variance_watch')
    expect(findings[0].severity).toBe('warning')
  })

  it('does NOT fire at exactly 10% (the watch level is beyond, not at)', () => {
    // 15 off 150 is exactly 10% — the relative leg requires strictly more.
    const at10 = computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 150, countedQty: 135 }] }),
    ])
    expect(at10).toHaveLength(0)
    const over10 = computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 150, countedQty: 134 }] }),
    ])
    expect(over10).toHaveLength(1)
  })

  it('sub-unit gaps never fire (the absolute materiality floor)', () => {
    const findings = computeStockVarianceFindings([
      // 0.5 off a 4-kg book is 12.5% — but under one whole unit: rounding.
      session({ lines: [{ materialName: 'Nails', unit: 'kg', expectedQty: 4, countedQty: 3.5 }] }),
    ])
    expect(findings).toHaveLength(0)
  })

  it('small-book whole-unit gaps: 1 off 20 is 5% (no fire); 3 off 20 is 15% (fires)', () => {
    expect(computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 20, countedQty: 19 }] }),
    ])).toHaveLength(0)
    expect(computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 20, countedQty: 17 }] }),
    ])).toHaveLength(1)
  })

  it('large-book small-relative gaps never fire (3 off a 300-bag book is 1%)', () => {
    expect(computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 300, countedQty: 297 }] }),
    ])).toHaveLength(0)
  })

  it('a zero-book line with a whole unit+ found fires (unexplained stock)', () => {
    const findings = computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Steel bar', unit: 'pc', expectedQty: 0, countedQty: 12 }] }),
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('book said zero')
  })

  it('a zero-book line with sub-unit residue does not fire', () => {
    expect(computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Steel bar', unit: 'pc', expectedQty: 0, countedQty: 0.5 }] }),
    ])).toHaveLength(0)
  })

  it('zero-variance and matched sessions raise nothing', () => {
    expect(computeStockVarianceFindings([
      session({ lines: [
        { materialName: 'Cement', unit: 'bag', expectedQty: 150, countedQty: 150 },
        { materialName: 'Nails', unit: 'kg', expectedQty: 8, countedQty: 8 },
      ] }),
    ])).toHaveLength(0)
    expect(computeStockVarianceFindings([])).toHaveLength(0)
  })

  it('the direction of the gap does not matter (book over- AND understates fire)', () => {
    const findings = computeStockVarianceFindings([
      session({ lines: [
        { materialName: 'Cement', unit: 'bag', expectedQty: 150, countedQty: 130 }, // +20 book overstates
        { materialName: 'Ballast', unit: 'tonne', expectedQty: 40, countedQty: 50 }, // −10 book understates
      ] }),
    ])
    expect(findings).toHaveLength(1) // ONE finding for the session
    expect(findings[0].message).toContain('+20')
    expect(findings[0].message).toContain('-10')
  })
})

describe('computeStockVarianceFindings — the finding shape', () => {
  it('one finding per SESSION: offending lines listed inside (capped at 5, +N after)', () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({
      materialName: `Material ${i + 1}`, unit: 'bag', expectedQty: 100, countedQty: 50,
    }))
    const findings = computeStockVarianceFindings([session({ lines })])
    expect(findings).toHaveLength(1)
    expect(findings[0].title).toContain('7 line(s)')
    // The five listed + the honest "+2 more line(s)".
    expect(findings[0].message).toContain('Material 5')
    expect(findings[0].message).not.toContain('Material 6:')
    expect(findings[0].message).toContain('+2 more line(s)')
  })

  it('carries the date, the counter, the count id tail and the threshold in the record', () => {
    const findings = computeStockVarianceFindings([
      session({ lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 100, countedQty: 80 }] }),
    ])
    const f = findings[0]
    expect(f.message).toContain('2026-06-10')
    expect(f.message).toContain('Otieno (storekeeper)')
    expect(f.message).toContain('20% of book')
    expect(f.evidence).toContain('1 of 1 line(s) beyond threshold')
    expect(f.evidence).toContain(`count ${'cnt-abcdefgh1234'.slice(-6)}`)
    expect(f.evidence).toContain(`≥ ${STOCK_VARIANCE_MIN_QTY} unit`)
    expect(f.evidence).toContain(`> ${Math.round(STOCK_VARIANCE_PCT * 100)}% of book`)
    expect(f.score).toBe(15) // SEVERITY_WEIGHTS.warning
  })

  it('blind sessions say so in title, message and evidence', () => {
    const findings = computeStockVarianceFindings([
      session({ blind: true, lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 100, countedQty: 80 }] }),
    ])
    expect(findings[0].title).toContain('(blind count)')
    expect(findings[0].message).toContain('ran BLIND')
    expect(findings[0].evidence).toContain('· blind')
  })

  it('two sessions in the window raise one finding each', () => {
    const findings = computeStockVarianceFindings([
      session({ countId: 'cnt-first000001', lines: [{ materialName: 'Cement', unit: 'bag', expectedQty: 100, countedQty: 80 }] }),
      session({ countId: 'cnt-second00002', countedAt: d('2026-06-17T09:00:00.000Z'), lines: [{ materialName: 'Ballast', unit: 'tonne', expectedQty: 30, countedQty: 20 }] }),
    ])
    expect(findings).toHaveLength(2)
    expect(findings.every((f) => f.rule === 'stock_variance_watch')).toBe(true)
  })

  it('the thresholds are the documented ones', () => {
    expect(STOCK_VARIANCE_MIN_QTY).toBe(1)
    expect(STOCK_VARIANCE_PCT).toBe(0.1)
  })
})
