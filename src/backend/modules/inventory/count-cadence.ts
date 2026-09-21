// Count cadence (issue #359 / REC-1) — ONE server-owned definition of "is a
// recurring stock count due?".
//
// The cadence model is deliberately minimal and honest:
//
//   · The ONLY stored fact is Project.countIntervalDays (whole days, null =
//     no cadence — the pre-#359 contract where counts happen whenever
//     someone runs one). There is no Schedule row and no cron: a schedule
//     row would need its own writer, its own drift (nextCountDue goes stale
//     the moment a count lands early or late) and its own backfill. Instead
//     nextCountDue is DERIVED ON READ from the rows that already exist:
//     the project's latest StockCount.countedAt + the interval.
//   · NO COUNT YET + a cadence set ⇒ the first count is due NOW. A store
//     that promised a weekly count and has never counted is overdue, not
//     "scheduled for someday".
//   · The latest count is by countedAt (the physical count time), not
//     createdAt — a backdated count recorded late was still the last time
//     bags were physically counted.
//
// Pure module by design (no db import): the repository computes the state at
// the payload boundary; the derivation is the contract.

/** Bounds for a sane cadence when SETTING it (service validates the same). */
export const COUNT_CADENCE_MIN_DAYS = 1
export const COUNT_CADENCE_MAX_DAYS = 365

/** One day in milliseconds — the derivation's only unit. */
const DAY_MS = 86_400_000

export interface CountCadenceInput {
  /** Project.countIntervalDays — null means no cadence (everything off). */
  intervalDays: number | null
  /** The project's latest StockCount.countedAt — null when none was ever run. */
  lastCountAt: Date | null
  /** "Now" — injected so tests (and only tests) control the clock. */
  now: Date
}

/** The derived cadence state, serialized into the inventory slice. */
export interface CountCadence {
  /** The configured interval in days (null = no cadence). */
  intervalDays: number | null
  /** When the last physical count happened (null = never counted). */
  lastCountAt: string | null
  /**
   * When the next count is due: lastCountAt + interval. Null when no
   * cadence is set. A set cadence with no count yet has no meaningful
   * timestamp — the first count is due immediately (due = true).
   */
  nextDueAt: string | null
  /** Is a count due right now? Always false when no cadence is set. */
  due: boolean
  /** Whole days past due (0 when not due / no cadence). */
  overdueDays: number
}

/**
 * Derive the store's count-cadence state. One definition, computed on read.
 */
export function countCadenceState(input: CountCadenceInput): CountCadence {
  const { intervalDays, lastCountAt, now } = input
  if (intervalDays == null || intervalDays <= 0) {
    // No cadence (or a nonsense interval the setter should have refused):
    // the honest answer is "nothing is due", never a fake schedule.
    return { intervalDays: null, lastCountAt: isoOrNull(lastCountAt), nextDueAt: null, due: false, overdueDays: 0 }
  }
  if (lastCountAt == null) {
    // A cadence is promised but no count exists — the first one is due now.
    return { intervalDays, lastCountAt: null, nextDueAt: null, due: true, overdueDays: 0 }
  }
  const nextDueMs = lastCountAt.getTime() + intervalDays * DAY_MS
  const due = now.getTime() >= nextDueMs
  return {
    intervalDays,
    lastCountAt: lastCountAt.toISOString(),
    nextDueAt: new Date(nextDueMs).toISOString(),
    due,
    overdueDays: due ? Math.floor((now.getTime() - nextDueMs) / DAY_MS) : 0,
  }
}

function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

/**
 * Validate + normalise an interval payload for inventory.count.schedule:
 * null/undefined clears the cadence; a number (or numeric string — payloads
 * arrive as JSON and leniency here is honest) must be a WHOLE day count
 * inside [COUNT_CADENCE_MIN_DAYS, COUNT_CADENCE_MAX_DAYS]. Booleans and
 * other types refuse outright (true must never silently become 1 day).
 * Shared by the action tests and the service (one definition of "sane
 * cadence").
 */
export function parseCountIntervalDays(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error(
      `inventory.count.schedule: intervalDays must be a whole number of days between ${COUNT_CADENCE_MIN_DAYS} and ${COUNT_CADENCE_MAX_DAYS} (or null to clear the cadence)`,
    )
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < COUNT_CADENCE_MIN_DAYS || n > COUNT_CADENCE_MAX_DAYS) {
    throw new Error(
      `inventory.count.schedule: intervalDays must be a whole number of days between ${COUNT_CADENCE_MIN_DAYS} and ${COUNT_CADENCE_MAX_DAYS} (or null to clear the cadence)`,
    )
  }
  return n
}
