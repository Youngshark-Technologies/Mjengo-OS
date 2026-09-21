/**
 * Count cadence (issue #359 / REC-1) — src/backend/modules/inventory/
 * count-cadence.ts: the derived "is a recurring stock count due?" state.
 *
 * Same idiom as tests/unit/inventory-lowstock.test.ts: a PURE module (no db
 * import) whose rule is the single definition shared by the payload boundary
 * (loadInventorySlice) and the UI. Pinned invariants:
 *
 *   · NO CADENCE, NOTHING DUE — intervalDays null (the pre-#359 contract)
 *     means no derivation at all, even with counts on record; a nonsense
 *     interval (≤ 0) degrades to off, never a fake schedule.
 *   · CADENCE + NO COUNT ⇒ DUE NOW — a store that promised a weekly count
 *     and never counted is overdue, not "scheduled for someday" (there is
 *     no timestamp to add the interval to, so due is true with no nextDueAt).
 *   · DERIVED ON READ — nextDueAt = lastCountAt + interval (whole days);
 *     not due before that instant, due at/after it; overdueDays counts whole
 *     days past due and is 0 otherwise.
 *   · LAST COUNT IS BY countedAt — the physical count time (the caller
 *     reads the max), which the module consumes as a Date it never derives.
 *   · SETTER VALIDATION (parseCountIntervalDays) — null/undefined/''
 *     clears; whole days in [1, 365] pass; fractional, zero, negative,
 *     over-cap, NaN and garbage strings refuse with the honest error.
 */
import { describe, expect, it } from 'vitest'

import {
  COUNT_CADENCE_MAX_DAYS,
  COUNT_CADENCE_MIN_DAYS,
  countCadenceState,
  parseCountIntervalDays,
} from '@/backend/modules/inventory/count-cadence'

const d = (iso: string) => new Date(iso)
const DAY = 86_400_000

describe('countCadenceState — the derived cadence (one definition)', () => {
  it('no cadence (null) ⇒ nothing due, no schedule, even with counts on record', () => {
    const state = countCadenceState({
      intervalDays: null,
      lastCountAt: d('2026-01-01T00:00:00.000Z'),
      now: d('2026-12-31T00:00:00.000Z'),
    })
    expect(state).toEqual({
      intervalDays: null,
      lastCountAt: '2026-01-01T00:00:00.000Z',
      nextDueAt: null,
      due: false,
      overdueDays: 0,
    })
  })

  it('a nonsense interval (≤ 0) degrades to off — never a fake schedule', () => {
    for (const bad of [0, -7]) {
      const state = countCadenceState({ intervalDays: bad, lastCountAt: null, now: d('2026-06-01T00:00:00.000Z') })
      expect(state.intervalDays).toBeNull()
      expect(state.due).toBe(false)
      expect(state.nextDueAt).toBeNull()
    }
  })

  it('cadence set + no count yet ⇒ the first count is due NOW (no timestamp to derive)', () => {
    const state = countCadenceState({ intervalDays: 7, lastCountAt: null, now: d('2026-06-01T00:00:00.000Z') })
    expect(state).toEqual({ intervalDays: 7, lastCountAt: null, nextDueAt: null, due: true, overdueDays: 0 })
  })

  it('nextDueAt = lastCountAt + interval — not due before the instant, due at it', () => {
    const last = d('2026-06-01T06:30:00.000Z')
    // 1 ms before the due instant: not due.
    const before = countCadenceState({ intervalDays: 7, lastCountAt: last, now: new Date(last.getTime() + 7 * DAY - 1) })
    expect(before.due).toBe(false)
    expect(before.overdueDays).toBe(0)
    expect(before.nextDueAt).toBe(new Date(last.getTime() + 7 * DAY).toISOString())
    // Exactly at the due instant: due, zero whole days overdue.
    const at = countCadenceState({ intervalDays: 7, lastCountAt: last, now: new Date(last.getTime() + 7 * DAY) })
    expect(at.due).toBe(true)
    expect(at.overdueDays).toBe(0)
    // lastCountAt is carried through serialized.
    expect(at.lastCountAt).toBe(last.toISOString())
  })

  it('overdueDays counts WHOLE days past due (a partial day is 0, not 1)', () => {
    const last = d('2026-06-01T00:00:00.000Z')
    const dueAt = last.getTime() + 30 * DAY
    const partial = countCadenceState({ intervalDays: 30, lastCountAt: last, now: new Date(dueAt + DAY - 1) })
    expect(partial.due).toBe(true)
    expect(partial.overdueDays).toBe(0) // 23:59:59.999 past due is still day zero
    const threeDays = countCadenceState({ intervalDays: 30, lastCountAt: last, now: new Date(dueAt + 3 * DAY) })
    expect(threeDays.overdueDays).toBe(3)
    const threeAndABit = countCadenceState({ intervalDays: 30, lastCountAt: last, now: new Date(dueAt + 3 * DAY + 3600_000) })
    expect(threeAndABit.overdueDays).toBe(3)
  })

  it('a fresh count resets the clock — the weekly cadence is not due 6 days later', () => {
    const state = countCadenceState({
      intervalDays: 7,
      lastCountAt: d('2026-06-10T00:00:00.000Z'),
      now: d('2026-06-16T00:00:00.000Z'),
    })
    expect(state.due).toBe(false)
    expect(state.nextDueAt).toBe('2026-06-17T00:00:00.000Z')
  })
})

describe('parseCountIntervalDays — setter validation (the shared rule)', () => {
  it('null / undefined / empty string clear the cadence', () => {
    expect(parseCountIntervalDays(null)).toBeNull()
    expect(parseCountIntervalDays(undefined)).toBeNull()
    expect(parseCountIntervalDays('')).toBeNull()
  })

  it('whole days inside the bounds pass (numeric strings too — payload honesty)', () => {
    expect(parseCountIntervalDays(1)).toBe(1)
    expect(parseCountIntervalDays(7)).toBe(7)
    expect(parseCountIntervalDays(COUNT_CADENCE_MAX_DAYS)).toBe(COUNT_CADENCE_MAX_DAYS)
    expect(parseCountIntervalDays('30')).toBe(30)
  })

  it('refuses the dishonest values: fractional, zero, negative, over-cap, NaN, garbage', () => {
    for (const bad of [0, -1, 1.5, COUNT_CADENCE_MAX_DAYS + 1, Number.NaN, 'weekly', true]) {
      expect(() => parseCountIntervalDays(bad), `intervalDays=${String(bad)}`).toThrow(/inventory\.count\.schedule: intervalDays/)
    }
  })

  it('the bounds are the documented ones (1 day … 1 year)', () => {
    expect(COUNT_CADENCE_MIN_DAYS).toBe(1)
    expect(COUNT_CADENCE_MAX_DAYS).toBe(365)
  })
})
