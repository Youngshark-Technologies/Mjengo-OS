// Intel module — the deterministic engines (PURE functions, no DB).
//
// Every rule is documented inline with its exact thresholds so any number in
// the UI can be traced back to the rows that produced it. No fake AI mystique:
// same rows in → same numbers out. Intel describes patterns; humans decide.
//
// Rule version '1' — bump RULE_VERSION when a rule changes so history rows
// stay interpretable.

import { centsToKes, fmtKes, sumCents, type Cents } from '@/backend/lib/money'
import type {
  FindingSeverity, PriceTrendRow, ProcurementSuggestion, SupplierReliability, ReliabilityComponent,
  SupplierLike,
} from './types'

export const RULE_VERSION = '1'

/** Severity weights for the overall score (subtracted from 100). */
export const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = { info: 5, warning: 15, critical: 30 }

// Status sets shared by the rules (documented, deterministic).
export const OPEN_REQUEST_STATUSES = ['draft', 'submitted', 'approved'] as const
export const OPEN_ORDER_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering'] as const
const TERMINAL_ORDER_STATUSES = ['delivered', 'closed', 'cancelled'] as const

// ---------------- risk engine (5 rules) ----------------

export interface RiskTask { title: string; status: string; progress: number; dueDate: Date | null }
/** Phase budget is CENTS (issue #122) — budget-weighted math runs in bigint. */
export interface RiskPhase { name: string; status: string; budget: Cents; progressManual: number | null; tasks: RiskTask[] }
export interface RiskDelivery { status: string; dispatchedAt: Date | null; receivedAt: Date | null; lines: Array<{ qtyOrdered: number; qtyReceived: number }> }
export interface RiskOrder { orderCode: string; status: string; createdAt: Date; deliveries: RiskDelivery[] }
export interface RiskInput {
  now: Date
  project: { location: string; targetDate: Date }
  phases: RiskPhase[]
  transactions: Array<{ amount: Cents }>
  orders: RiskOrder[]
  priceTrends: PriceTrendRow[]
  attendances: Array<{ date: string; status: string }> // rows from the last 10 days only
}

export interface EngineFinding {
  rule: string
  severity: FindingSeverity
  title: string
  message: string
  evidence: string
  score: number
}

function phaseProgress(p: RiskPhase): number {
  // Mirrors phaseProgress() in lib/mjengo.ts exactly.
  if (p.progressManual !== null && p.progressManual !== undefined) return p.progressManual
  if (!p.tasks.length) return 0
  return Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length)
}

/**
 * Mirrors overallProgress() in lib/mjengo.ts (local copy avoids a circular
 * import). Exact in CENTS (issue #122): Σ pct·budget over Σ budget, half-up,
 * all in bigint — no float anywhere in the money weighting.
 */
export function overallProgress(phases: RiskPhase[]): number {
  const totalBudget = sumCents(phases.map((p) => p.budget))
  if (totalBudget <= 0n) return 0
  // weighted = Σ(progress% × budget) in percent-cents; the percent itself is
  // round-half-up(weighted / totalBudget) — NOT pctOf (that would rescale ×100).
  const weighted = phases.reduce((s, p) => s + BigInt(phaseProgress(p)) * p.budget, 0n)
  return Number((weighted * 2n + totalBudget) / (totalBudget * 2n))
}

/**
 * Half-up integer percent of one Cents total over another (issue #122):
 * round(part/whole × 100) computed entirely in bigint — no float, no
 * tolerance. whole ≤ 0 → 0. Exported for the sibling engines (score, jobs,
 * health) so every money ratio in the intel module shares ONE exact rule.
 */
export function pctOf(part: Cents, whole: Cents): number {
  if (whole <= 0n) return 0
  return Number((part * 200n + whole) / (whole * 2n))
}

/**
 * Half-up percent to a tenth: round(part/whole × 1000)/10 — the 1-dp trend
 * deltas. Exact in bigint.
 */
export function pctTenthsOf(part: Cents, whole: Cents): number {
  if (whole <= 0n) return 0
  return Number((part * 2000n + whole) / (whole * 2n)) / 10
}

/** KSh display for a CENTS amount (issue #122 — never bigint.toLocaleString). */
function kes(c: Cents): string {
  return fmtKes(c)
}

/** KSh display for an already-converted KSh number (PriceTrendRow fields). */
function kesNum(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

const DAY_MS = 86_400_000

/**
 * Run the 5 deterministic risk rules. One finding per rule at most (sub-checks
 * are combined; the strongest severity wins).
 *
 * R1 budget_pace — spent% (transactions / phase budgets) vs overall progress%:
 *    spent − progress > 15pts → warning; > 30pts → critical.
 * R2 schedule_watch — open tasks in in_progress phases (info), overdue tasks
 *    (warning), and target date within 30d while progress < 80% (warning).
 * R3 procurement_watch — delivery discrepancies (1-2 → warning, ≥3 → critical)
 *    and orders stuck SENT/CONFIRMED > 14d from createdAt (info, ≥3 → warning).
 * R4 price_trend — Cement (tracked region for the project county) up > 5%
 *    over ~30d → warning.
 * R5 attendance_watch — absence rate over the last 10 recorded days > 20% → warning.
 */
export function computeRiskFindings(input: RiskInput): { findings: EngineFinding[]; overallScore: number } {
  const { now, project, phases, transactions, orders, priceTrends, attendances } = input
  const findings: EngineFinding[] = []

  // ---- R1 budget_pace (exact in cents — issue #122) ----
  const budgetTotal = sumCents(phases.map((p) => p.budget))
  const spent = sumCents(transactions.map((t) => t.amount))
  if (budgetTotal > 0n) {
    const spentPct = pctOf(spent, budgetTotal)
    const progressPct = overallProgress(phases)
    const lead = spentPct - progressPct
    if (lead > 30) {
      findings.push({
        rule: 'budget_pace', severity: 'critical',
        title: `Spend ${Math.round(lead)} points ahead of progress`,
        message: `${kes(spent)} spent is ${Math.round(spentPct)}% of the ${kes(budgetTotal)} budget while work completed is ${progressPct}% — the gap exceeds 30 points.`,
        evidence: `${transactions.length} transactions · ${phases.length} phases`,
        score: SEVERITY_WEIGHTS.critical,
      })
    } else if (lead > 15) {
      findings.push({
        rule: 'budget_pace', severity: 'warning',
        title: `Spend ${Math.round(lead)} points ahead of progress`,
        message: `${kes(spent)} spent is ${Math.round(spentPct)}% of the ${kes(budgetTotal)} budget while work completed is ${progressPct}% — spending is running ahead of the work recorded.`,
        evidence: `${transactions.length} transactions · ${phases.length} phases`,
        score: SEVERITY_WEIGHTS.warning,
      })
    }
  }

  // ---- R2 schedule_watch ----
  {
    const activePhases = phases.filter((p) => p.status === 'in_progress')
    const openTasks = activePhases.flatMap((p) => p.tasks.filter((t) => t.status !== 'done').map((t) => ({ phase: p.name, task: t })))
    const overdue = phases.flatMap((p) => p.tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < now))
    const daysToTarget = Math.ceil((project.targetDate.getTime() - now.getTime()) / DAY_MS)
    const progressPct = overallProgress(phases)
    const parts: string[] = []
    const evidence: string[] = []
    let severity: FindingSeverity = 'info'
    let title = 'Schedule on track'

    if (overdue.length > 0) {
      severity = 'warning'
      title = `${overdue.length} task${overdue.length > 1 ? 's' : ''} past due`
      parts.push(`${overdue.length} task${overdue.length > 1 ? 's are' : ' is'} past the due date and not done (${overdue.slice(0, 3).map((t) => t.title).join('; ')}${overdue.length > 3 ? '…' : ''})`)
      evidence.push(`${overdue.length} overdue tasks`)
    }
    if (openTasks.length > 0) {
      const byPhase = new Map<string, number>()
      for (const { phase } of openTasks) byPhase.set(phase, (byPhase.get(phase) ?? 0) + 1)
      const phaseList = Array.from(byPhase.entries()).map(([name, n]) => `${n} in ${name}`).join(', ')
      parts.push(`${openTasks.length} open task${openTasks.length > 1 ? 's' : ''} in the active phase${activePhases.length > 1 ? 's' : ''} (${phaseList})`)
      evidence.push(`${openTasks.length} open tasks · ${activePhases.length} in-progress phases`)
      if (severity === 'info') title = `${openTasks.length} open tasks in the active phase`
    }
    if (daysToTarget >= 0 && daysToTarget <= 30 && progressPct < 80) {
      if (severity !== 'warning') severity = 'warning'
      if (title === 'Schedule on track') title = `Target date in ${daysToTarget} days at ${progressPct}% progress`
      parts.push(`the target date is ${daysToTarget} days away while progress is ${progressPct}% (under 80%)`)
      evidence.push(`target ${project.targetDate.toISOString().slice(0, 10)} · progress ${progressPct}%`)
    }

    if (parts.length > 0) {
      findings.push({
        rule: 'schedule_watch', severity,
        title,
        message: `Schedule watch: ${parts.join('; ')}.`,
        evidence: evidence.join(' · '),
        score: SEVERITY_WEIGHTS[severity],
      })
    }
  }

  // ---- R3 procurement_watch ----
  {
    const discrepancies = orders.flatMap((o) => o.deliveries.filter((d) => d.status === 'discrepancy').map((d) => ({ order: o, delivery: d })))
    const stuck = orders.filter(
      (o) => (o.status === 'sent' || o.status === 'confirmed') && now.getTime() - o.createdAt.getTime() > 14 * DAY_MS,
    )
    const parts: string[] = []
    const evidence: string[] = []
    let severity: FindingSeverity | null = null
    let title = 'Procurement watch'

    if (discrepancies.length > 0) {
      severity = discrepancies.length >= 3 ? 'critical' : 'warning'
      title = `${discrepancies.length} delivery discrepanc${discrepancies.length > 1 ? 'ies' : 'y'} on record`
      const details = discrepancies.slice(0, 2).map(({ order, delivery }) => {
        const counts = delivery.lines.map((l) => `${Math.round(l.qtyReceived)}/${Math.round(l.qtyOrdered)}`).join(', ')
        return `${order.orderCode} (${counts} received/ordered)`
      })
      parts.push(`${discrepancies.length} deliver${discrepancies.length > 1 ? 'ies' : 'y'} closed with a quantity discrepancy (${details.join('; ')})`)
      evidence.push(`${discrepancies.length} discrepancy deliveries · ${orders.length} orders`)
    }
    if (stuck.length > 0) {
      const stuckSev: FindingSeverity = stuck.length >= 3 ? 'warning' : 'info'
      if (severity === null || SEVERITY_WEIGHTS[stuckSev] > SEVERITY_WEIGHTS[severity]) severity = stuckSev
      parts.push(`${stuck.length} order${stuck.length > 1 ? 's are' : ' is'} stuck in ${stuck[0].status.toUpperCase()} for more than 14 days (${stuck.map((o) => o.orderCode).join(', ')})`)
      evidence.push(`${stuck.length} orders > 14d in sent/confirmed`)
      if (title === 'Procurement watch') title = `${stuck.length} order${stuck.length > 1 ? 's' : ''} awaiting supplier action`
    }

    if (severity !== null && parts.length > 0) {
      findings.push({
        rule: 'procurement_watch', severity,
        title,
        message: `Procurement watch: ${parts.join('; ')}.`,
        evidence: evidence.join(' · '),
        score: SEVERITY_WEIGHTS[severity],
      })
    }
  }

  // ---- R4 price_trend (Cement, tracked region closest to the project county) ----
  {
    const cementRows = priceTrends.filter((r) => r.materialName.toLowerCase().includes('cement'))
    if (cementRows.length > 0) {
      const loc = project.location.toLowerCase()
      const inCounty = cementRows.find((r) => loc.includes(r.region.toLowerCase()))
      const row = inCounty ?? cementRows.reduce((best, r) => (r.pointCount > best.pointCount ? r : best), cementRows[0])
      if (row.deltaPct !== null && row.deltaPct > 5) {
        findings.push({
          rule: 'price_trend', severity: 'warning',
          title: `Cement price up ${row.deltaPct.toFixed(1)}%`,
          message: `Cement in ${row.region} moved from ${kesNum(row.previous ?? 0)} to ${kesNum(row.current)} per unit over the last ~30 days (more than +5%). Consider scheduling orders early — this is a market trend, not a prediction.`,
          evidence: `${row.materialName} · ${row.region} · ${row.pointCount} price points`,
          score: SEVERITY_WEIGHTS.warning,
        })
      }
    }
  }

  // ---- R5 attendance_watch (last 10 days) ----
  {
    if (attendances.length > 0) {
      const absent = attendances.filter((a) => a.status === 'absent').length
      const rate = (absent / attendances.length) * 100
      if (rate > 20) {
        findings.push({
          rule: 'attendance_watch', severity: 'warning',
          title: `Absence rate ${Math.round(rate)}% over the last 10 days`,
          message: `${absent} of ${attendances.length} attendance rows in the last 10 days are absent — above the 20% watch level. Crew size or motivation may need attention.`,
          evidence: `${attendances.length} attendance rows · ${absent} absent`,
          score: SEVERITY_WEIGHTS.warning,
        })
      }
    }
  }

  const penalty = findings.reduce((s, f) => s + SEVERITY_WEIGHTS[f.severity], 0)
  const overallScore = Math.max(0, 100 - penalty)
  return { findings, overallScore }
}

// ---------------- anti-fraud attendance engine (spec §16, rules R6/R7) ----------------
//
// Doc A §16: track who checked a worker in, the method and every edit
// (original → corrected value + reason). "Supervisor repeatedly checks in
// workers who are absent" is the pattern to surface — flagged FOR REVIEW,
// never auto-accusing anyone. These rules run from the anomaly scan job
// (B4-INTEL) and write Alert rows; they are NOT part of computeRiskFindings
// (which stays 5-rule so existing RiskAssessment history stays comparable).

/** One attendance row as the fraud rules see it (last 14 days, worker name joined). */
export interface AttendanceAuditRow {
  date: string // YYYY-MM-DD (EAT calendar date, as stored)
  status: string // present, absent, half_day, excused
  workerId: string
  workerName: string
  recordedBy: string | null // who created the record (name/role)
  isOverride: boolean // overrideLog is set (the record was edited after the fact)
}

/** Weekend history BEFORE the 14-day window — the site's idle baseline. */
export interface WeekendBaseline {
  rows: number // weekend attendance rows on record (older than the window)
  present: number // of those, rows marked present
}

export interface AttendanceFraudInput {
  now: Date
  /** Attendance rows from the last 14 days (caller scopes the window). */
  rows: AttendanceAuditRow[]
  /** Weekend rows OLDER than the 14-day window, for the idle baseline. */
  weekendBaseline: WeekendBaseline
}

/** ISO calendar weekday of a YYYY-MM-DD string (0=Sun … 6=Sat). */
function isoWeekday(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay()
}

const OVERRIDE_MAX_COUNT = 5 // more than 5 overrides in 14 days → warning
const OVERRIDE_MAX_RATIO = 0.3 // >30% of the recorder's records → warning (needs ≥4 records)
const WEEKEND_MIN_HISTORY = 4 // weekend rows needed before "site normally idle" is claimed
const WEEKEND_IDLE_RATE = 0.1 // <10% historical weekend present-rate = normally idle
const WEEKEND_GHOST_DAYS = 2 // more than 2 weekend-present days in 14 days = outlier

/**
 * R6/R7 — attendance anti-fraud, deterministic:
 *
 * R6 attendance_override_pattern — per recorder (Attendance.recordedBy), rows
 * from the last 14 days: overrides > 5, OR overrides > 30% of that recorder's
 * records (with ≥4 records so 1-of-2 noise cannot fire) → warning with counts,
 * recorder name and sample dates.
 *
 * R7 weekend_ghost_pattern — workers marked present on Sat/Sun more than 2×
 * in the last 14 days, while the site is normally idle on weekends
 * (historical weekend present-rate < 10%, from ≥4 prior weekend rows —
 * with less history the baseline is unknown and the rule honestly skips).
 * Info severity: a watch, not an accusation.
 */
export function computeAttendanceFraudFindings(input: AttendanceFraudInput): EngineFinding[] {
  const { rows, weekendBaseline } = input
  const findings: EngineFinding[] = []

  // ---- R6 override abuse, grouped by who recorded the rows ----
  const byRecorder = new Map<string, { records: number; overrides: number; dates: string[] }>()
  for (const r of rows) {
    const recorder = (r.recordedBy ?? '').trim()
    if (!recorder) continue
    const agg = byRecorder.get(recorder) ?? { records: 0, overrides: 0, dates: [] }
    agg.records += 1
    if (r.isOverride) {
      agg.overrides += 1
      agg.dates.push(r.date)
    }
    byRecorder.set(recorder, agg)
  }
  for (const [recorder, agg] of byRecorder) {
    const ratio = agg.records > 0 ? agg.overrides / agg.records : 0
    const overCount = agg.overrides > OVERRIDE_MAX_COUNT
    const overRatio = agg.records >= 4 && ratio > OVERRIDE_MAX_RATIO
    if (overCount || overRatio) {
      const sample = agg.dates.slice(0, 5).join(', ') + (agg.dates.length > 5 ? ` +${agg.dates.length - 5} more` : '')
      findings.push({
        rule: 'attendance_override_pattern', severity: 'warning',
        title: `${agg.overrides} attendance overrides by ${recorder} in 14 days`,
        message: `${recorder} recorded ${agg.records} attendance rows in the last 14 days and ${agg.overrides} of them carry an override log (edited after the fact — original → corrected value + reason stored on each row). Override dates: ${sample}. Doc A §16 flags a recorder who repeatedly edits check-ins for review — this is a pattern to verify, not an accusation.`,
        evidence: `${agg.overrides} of ${agg.records} rows by ${recorder} overridden · ${Math.round(ratio * 100)}% · sample ${agg.dates.slice(0, 3).join(', ') || '—'}`,
        score: SEVERITY_WEIGHTS.warning,
      })
    }
  }

  // ---- R7 weekend ghost workers ----
  if (weekendBaseline.rows >= WEEKEND_MIN_HISTORY) {
    const idleRate = weekendBaseline.present / weekendBaseline.rows
    if (idleRate < WEEKEND_IDLE_RATE) {
      const perWorker = new Map<string, { name: string; dates: string[] }>()
      for (const r of rows) {
        const dow = isoWeekday(r.date)
        if (dow !== 0 && dow !== 6) continue // Sat=6, Sun=0
        if (r.status !== 'present') continue
        const agg = perWorker.get(r.workerId) ?? { name: r.workerName, dates: [] }
        agg.dates.push(r.date)
        perWorker.set(r.workerId, agg)
      }
      const ghosts = Array.from(perWorker.entries())
        .filter(([, agg]) => agg.dates.length > WEEKEND_GHOST_DAYS)
        .map(([workerId, agg]) => ({ workerId, name: agg.name, dates: agg.dates }))
      if (ghosts.length > 0) {
        const list = ghosts.map((g) => `${g.name} (${g.dates.length}×: ${g.dates.slice(0, 3).join(', ')})`).join('; ')
        findings.push({
          rule: 'weekend_ghost_pattern', severity: 'info',
          title: `${ghosts.length} worker(s) present on idle weekends`,
          message: `This site is normally idle on weekends (${weekendBaseline.present} of ${weekendBaseline.rows} historical weekend rows present, under 10%), but in the last 14 days: ${list}. Weekend check-ins on an idle site are worth verifying — wages are paid per recorded day.`,
          evidence: `${ghosts.length} worker(s) over ${WEEKEND_GHOST_DAYS} weekend-present days · baseline ${weekendBaseline.present}/${weekendBaseline.rows} weekend rows`,
          score: SEVERITY_WEIGHTS.info,
        })
      }
    }
  }

  return findings
}

// ---------------- cost control engine (spec §29, rules R8/R9) ----------------

export type CostCategory = 'materials' | 'labour' | 'transport' | 'professional_fees' | 'other'

/** BOQ-derived materials estimate (latest Boq version), Σ qty × estUnitPrice. */
export interface BoqEstimate {
  version: number
  status: string
  estTotal: Cents // Σ BoqLine.qty × estUnitPrice (cents — issue #122)
}

export interface CostVarianceInput {
  /** Overall phase progress 0–100 (same basis as risk rule R1). */
  progressPct: number
  /** Σ Phase.budget — the budget source of truth (mirrors the wallet rollup). CENTS. */
  phaseBudgetTotal: Cents
  /** Latest BOQ estimate if one exists (BoqLine.estUnitPrice is on file). CENTS. */
  boq: BoqEstimate | null
  /** Spend grouped into the 5 §29 categories, from Transaction rows. CENTS. */
  spendByCategory: Record<CostCategory, Cents>
}

const CATEGORY_BUDGET_BASIS = {
  materials: 'materials',
  labour: 'non-materials allowance',
  transport: 'non-materials allowance',
  professional_fees: 'non-materials allowance',
  other: 'non-materials allowance',
} as const

/**
 * R8 — budget variance by category (§29 "budget overruns"), deterministic:
 * a category spending > 110% of its budget slice → warning with category,
 * spent, budget and pct — and an HONEST statement of the budget basis:
 *
 *  · materials: the latest BOQ estimate (Σ qty × estUnitPrice) when a BOQ is
 *    on file — the one category the schema actually budgets. Without a BOQ,
 *    the fallback slice is the phase budgets pro-rated by progress.
 *  · labour / transport / professional_fees / other: NO per-category budget
 *    exists anywhere in the schema — the honest comparison envelope is the
 *    non-materials phase-budget allowance (Σ phases − BOQ materials) pro-rated
 *    by phase progress, i.e. the expected non-materials spend to date. A single
 *    category crossing 110% of that envelope has consumed the whole allowance.
 *
 * CostCategory grouping of Transaction rows (see the handler): type 'material'
 * → materials, 'wage' → labour, 'transport' → transport, a costCode naming a
 * professional service → professional_fees, everything else → other.
 */
export function computeCostVarianceFindings(input: CostVarianceInput): EngineFinding[] {
  const { progressPct, phaseBudgetTotal, spendByCategory } = input
  const findings: EngineFinding[] = []
  if (phaseBudgetTotal <= 0n) return findings

  const boqEst = input.boq !== null && input.boq.estTotal > 0n ? input.boq : null
  // Pro-rate the budget slices by progress, exactly in cents (half-up).
  const progressClamped = Math.max(0, Math.min(100, Math.round(progressPct)))
  const prorated = (total: Cents): Cents =>
    progressClamped === 0 ? 0n : (total * BigInt(progressClamped) + 50n) / 100n
  const materialsBudget = boqEst ? boqEst.estTotal : prorated(phaseBudgetTotal)
  const nonMaterialsAllowance = boqEst
    ? prorated(phaseBudgetTotal - boqEst.estTotal > 0n ? phaseBudgetTotal - boqEst.estTotal : 0n)
    : prorated(phaseBudgetTotal)
  const basisBoq = boqEst
    ? `budget basis: BOQ v${boqEst.version} (${boqEst.status}) materials estimate ${kes(boqEst.estTotal)} (Σ BoqLine qty × estUnitPrice)`
    : `budget basis: no BOQ on file — phase budgets ${kes(phaseBudgetTotal)} pro-rated by ${Math.round(progressPct)}% progress`

  for (const category of Object.keys(spendByCategory) as CostCategory[]) {
    const spent = spendByCategory[category] ?? 0n
    if (spent <= 0n) continue
    const budget = category === 'materials' ? materialsBudget : nonMaterialsAllowance
    if (budget <= 0n) continue
    const pct = pctOf(spent, budget)
    if (pct > 110) {
      const basis =
        category === 'materials'
          ? basisBoq
          : boqEst
            ? `budget basis: NO per-category budget exists in the schema — compared against the non-materials phase-budget allowance to date (Σ phases ${kes(phaseBudgetTotal)} − BOQ materials ${kes(boqEst.estTotal)}, pro-rated by ${Math.round(progressPct)}% progress)`
            : `budget basis: NO per-category budget exists in the schema — compared against the phase budgets pro-rated by ${Math.round(progressPct)}% progress`
      findings.push({
        rule: 'budget_category_overrun', severity: 'warning',
        title: `${category} spend at ${Math.round(pct)}% of its budget slice`,
        message: `${category} spend is ${kes(spent)} against a budget slice of ${kes(budget)} — ${Math.round(pct)}%, above the 110% watch level. ${basis}. Review the transactions behind the number before acting.`,
        evidence: `category ${category} · spent ${kes(spent)} · budget ${kes(budget)} · ${Math.round(pct)}% · ${CATEGORY_BUDGET_BASIS[category]}`,
        score: SEVERITY_WEIGHTS.warning,
      })
    }
  }
  return findings
}

/** One purchase order as the duplicate rule sees it (lines = PO line names). */
export interface DuplicateOrderRow {
  orderCode: string
  createdAt: Date
  total: Cents // PO.total (cents — issue #122)
  status: string
  /** True when the order is terminal (delivered/closed) or a delivery was received. */
  delivered: boolean
  lines: Array<{ name: string; lineTotal: Cents }>
}

/** Both POs must exceed KES 10,000 — the cents form of the rule threshold. */
const DUPLICATE_MIN_TOTAL: Cents = 1_000_000n
const DUPLICATE_WINDOW_DAYS = 7 // ordered within 7 days of each other
const DUPLICATE_MAX_FINDINGS = 3 // cap so one noisy material cannot spam the alert feed

/**
 * R9 — duplicate purchase watch (§29), deterministic: two PurchaseOrders
 * naming the SAME material (normalized line-name match, the same matcher the
 * procurement cover check uses — PO lines carry the material names from the
 * originating MaterialRequestLine), both over KES 10,000, created within 7
 * days, and NOT both already delivered → info watch with both PO codes, the
 * material and the dates. Info severity: double orders are often legitimate
 * (top-ups, split deliveries) — this is a watch, humans decide.
 */
export function computeDuplicatePurchaseFindings(orders: DuplicateOrderRow[]): EngineFinding[] {
  const eligible = orders.filter((o) => o.total > DUPLICATE_MIN_TOTAL)
  const matchesMaterial = (a: string, b: string): boolean => {
    const na = a.toLowerCase().replace(/\s+/g, ' ').trim()
    const nb = b.toLowerCase().replace(/\s+/g, ' ').trim()
    return na === nb || (na.length > 3 && nb.includes(na)) || (nb.length > 3 && na.includes(nb))
  }
  const findings: EngineFinding[] = []
  const seen = new Set<string>()
  for (let i = 0; i < eligible.length && findings.length < DUPLICATE_MAX_FINDINGS; i++) {
    for (let j = i + 1; j < eligible.length && findings.length < DUPLICATE_MAX_FINDINGS; j++) {
      const a = eligible[i]
      const b = eligible[j]
      const daysApart = Math.abs(a.createdAt.getTime() - b.createdAt.getTime()) / DAY_MS
      if (daysApart > DUPLICATE_WINDOW_DAYS) continue
      if (a.delivered && b.delivered) continue // both already delivered → not a live duplicate
      const material = a.lines.find((la) => b.lines.some((lb) => matchesMaterial(la.name, lb.name)))
      if (!material) continue
      const key = [a.orderCode, b.orderCode].sort().join('+')
      if (seen.has(key)) continue
      seen.add(key)
      const days = Math.round(daysApart * 10) / 10
      findings.push({
        rule: 'duplicate_purchase_watch', severity: 'info',
        title: `Possible duplicate purchase — ${material.name}`,
        message: `${a.orderCode} (${kes(a.total)}, ${a.createdAt.toISOString().slice(0, 10)}, ${a.status}) and ${b.orderCode} (${kes(b.total)}, ${b.createdAt.toISOString().slice(0, 10)}, ${b.status}) both order ${material.name}, ${days} day${days === 1 ? '' : 's'} apart, and at least one has not been delivered yet. Double orders are sometimes legitimate (top-up or split delivery) — confirm with procurement before acting (Doc A §29 duplicate purchases).`,
        evidence: `${a.orderCode} + ${b.orderCode} · ${material.name} · ${days}d apart · both > ${kes(DUPLICATE_MIN_TOTAL)}`,
        score: SEVERITY_WEIGHTS.info,
      })
    }
  }
  return findings
}

// ---------------- stock variance engine (REC-1, issue #359) ----------------

/**
 * One counted line as the variance rule sees it (variance has ONE definition:
 * expected − counted, modules/inventory/repository.countVariance — the same
 * numbers are recomputed here from the two stored quantities so the engine
 * stays pure and db-free).
 */
export interface StockVarianceLine {
  materialName: string
  unit: string
  expectedQty: number
  countedQty: number
}

/** One count session as the variance rule sees it (caller scopes the window). */
export interface StockVarianceCount {
  countId: string
  countedAt: Date
  countedBy: string
  /** REC-1 (#359): the session ran blind — a stronger evidential claim. */
  blind: boolean
  lines: StockVarianceLine[]
}

/** Absolute materiality floor: a gap under one whole unit is rounding, not shrinkage. */
export const STOCK_VARIANCE_MIN_QTY = 1
/** Relative materiality: the gap must exceed 10% of the book (expected) figure. */
export const STOCK_VARIANCE_PCT = 0.1
/** Cap on lines listed inside one finding's message (feed spam guard). */
const STOCK_VARIANCE_MAX_LINES = 5

/**
 * REC-1 — stock variance watch, deterministic: for every count session in
 * the caller's window, a counted line whose |variance| (expected − counted)
 * is ≥ 1 whole unit AND > 10% of the expected quantity raises ONE warning
 * finding for the session listing the offending lines. When expected ≤ 0
 * the relative leg is vacuously satisfied — a whole unit or more of stock
 * the book does not know about is always worth a look. Zero-variance and
 * noise-level sessions raise nothing.
 *
 * Warning severity (the budget_category_overrun weight): a book/physical
 * gap is money-adjacent shrinkage — possible loss, theft or unlogged
 * usage, never an accusation. Posting the count's adjustments does not
 * erase the discrepancy event, so posted and open sessions are treated
 * the same. Blind sessions say so in the message: the counter never saw
 * the book figures while counting, which makes the gap harder to explain
 * away as anchoring.
 */
export function computeStockVarianceFindings(counts: StockVarianceCount[]): EngineFinding[] {
  const findings: EngineFinding[] = []
  for (const c of counts) {
    const offending = c.lines.filter((line) => {
      const variance = line.expectedQty - line.countedQty
      const abs = Math.abs(variance)
      if (abs < STOCK_VARIANCE_MIN_QTY) return false
      if (line.expectedQty > 0 && abs <= line.expectedQty * STOCK_VARIANCE_PCT) return false
      return true
    })
    if (offending.length === 0) continue
    const listed = offending.slice(0, STOCK_VARIANCE_MAX_LINES)
    const detail = listed
      .map((line) => {
        const variance = line.expectedQty - line.countedQty
        const pct = line.expectedQty > 0 ? ` (${Math.round((Math.abs(variance) / line.expectedQty) * 100)}% of book)` : ' (book said zero)'
        return `${line.materialName}: expected ${line.expectedQty.toLocaleString('en-US')} ${line.unit}, counted ${line.countedQty.toLocaleString('en-US')} ${line.unit}, variance ${variance > 0 ? '+' : ''}${variance.toLocaleString('en-US')}${pct}`
      })
      .join('; ')
    const more = offending.length > listed.length ? ` +${offending.length - listed.length} more line(s)` : ''
    findings.push({
      rule: 'stock_variance_watch', severity: 'warning',
      title: `Stock count variance beyond threshold — ${offending.length} line(s)${c.blind ? ' (blind count)' : ''}`,
      message: `The ${c.countedAt.toISOString().slice(0, 10)} count by ${c.countedBy}${c.blind ? ' ran BLIND (the counter never saw the book figures until after saving)' : ''} found book-vs-physical gaps beyond the watch level (≥ ${STOCK_VARIANCE_MIN_QTY} whole unit and > ${Math.round(STOCK_VARIANCE_PCT * 100)}% of the expected quantity): ${detail}${more}. A gap this size is possible loss, theft or unlogged usage — verify the count and the movements before acting (issue #359 / REC-1).`,
      evidence: `${offending.length} of ${c.lines.length} line(s) beyond threshold · count ${c.countId.slice(-6)}${c.blind ? ' · blind' : ''} · threshold ≥ ${STOCK_VARIANCE_MIN_QTY} unit and > ${Math.round(STOCK_VARIANCE_PCT * 100)}% of book`,
      score: SEVERITY_WEIGHTS.warning,
    })
  }
  return findings
}

// ---------------- price trend engine ----------------

/** unitPrice is CENTS (issue #122); trend rows convert to KSh numbers at the output. */
export interface PricePointLike { materialName: string; region: string; unitPrice: Cents; recordedAt: Date; source: string }

/**
 * Group price points by material+region and compute the trend rows:
 * latest price, the most recent point recorded ≥30 days ago ("previous"),
 * the % delta between them and the chronological sparkline series.
 */
export function computePriceTrends(points: PricePointLike[], now: Date): PriceTrendRow[] {
  const groups = new Map<string, PricePointLike[]>()
  for (const p of points) {
    const key = `${p.materialName}\u0000${p.region}`
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }
  const cutoff = new Date(now.getTime() - 30 * DAY_MS)
  const rows: PriceTrendRow[] = []
  for (const arr of groups.values()) {
    const chronological = [...arr].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
    const latest = chronological[chronological.length - 1]
    // "previous" = the most recent point recorded at least 30 days ago
    const prevPoint = [...chronological].reverse().find((p) => p.recordedAt.getTime() <= cutoff.getTime())
    // Exact cents delta (issue #122): (latest − previous)/previous in bigint,
    // half-up to a tenth of a percent; KSh numbers only in the output row.
    const deltaPct =
      prevPoint && prevPoint.unitPrice > 0n ? pctTenthsOf(latest.unitPrice - prevPoint.unitPrice, prevPoint.unitPrice) : null
    rows.push({
      materialName: latest.materialName,
      region: latest.region,
      current: centsToKes(latest.unitPrice),
      previous: prevPoint ? centsToKes(prevPoint.unitPrice) : null,
      deltaPct,
      points: chronological.slice(-12).map((p) => ({ t: p.recordedAt.toISOString(), price: centsToKes(p.unitPrice) })),
      lastRecordedAt: latest.recordedAt.toISOString(),
      source: latest.source,
      pointCount: chronological.length,
    })
  }
  return rows.sort((a, b) => a.materialName.localeCompare(b.materialName) || a.region.localeCompare(b.region))
}

// ---------------- procurement suggestions (spec §19, lite) ----------------

export interface SuggestionDoc {
  code: string // request or order code
  kind: 'request' | 'order'
  status: string
  lines: Array<{ materialName: string; qty: number; unit: string }>
}

/**
 * Deterministic cover check: for every price-tracked material, is there an
 * OPEN request line or OPEN PO line that names it (name containment either
 * way — "Cement 50kg" matches "Cement 50kg (32.5N)")? Uncovered materials get
 * a plain-language suggestion. Nothing is auto-created — humans decide.
 */
export function computeSuggestions(trackedMaterials: string[], docs: SuggestionDoc[]): ProcurementSuggestion[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const matches = (a: string, b: string) => {
    const na = norm(a)
    const nb = norm(b)
    return na === nb || (na.length > 3 && nb.includes(na)) || (nb.length > 3 && na.includes(nb))
  }
  return trackedMaterials
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((materialName) => {
      const covers: string[] = []
      for (const doc of docs) {
        for (const line of doc.lines) {
          if (matches(materialName, line.materialName)) {
            covers.push(`${doc.code} (${doc.status}) · ${Math.round(line.qty)} ${line.unit}`)
            break
          }
        }
      }
      if (covers.length > 0) {
        return {
          materialName,
          status: 'covered' as const,
          coverDetail: covers.slice(0, 2).join(' · ') + (covers.length > 2 ? ` +${covers.length - 2} more` : ''),
          hint: 'Open request or PO already names this material.',
        }
      }
      return {
        materialName,
        status: 'uncovered' as const,
        coverDetail: null,
        hint: `No open request or PO covers ${materialName} — consider requesting quotes.`,
      }
    })
}

// ---------------- supplier reliability engine (spec §16) ----------------

export interface SupplierOrderHistory {
  status: string
  createdAt: Date
  deliveries: Array<{ status: string; dispatchedAt: Date | null; receivedAt: Date | null; lines: Array<{ qtyOrdered: number; qtyReceived: number }> }>
}

/**
 * Reliability from ACTUAL platform transaction history — there are NO
 * anonymous ratings anywhere in this computation (Finder spec §16).
 *
 * Components (weights sum to 1):
 *  · deliveryAccuracy 35% — avg qtyReceived/qtyOrdered over the supplier's
 *    delivery lines (over-delivery caps at 100).
 *  · onTime            20% — share of deliveries received within 3 days of
 *    dispatch (OrderDelivery has no stored ETA — 3 days is the documented proxy).
 *  · completion        20% — delivered+closed / terminal orders (delivered,
 *    closed, cancelled). In-flight orders don't count either way.
 *  · disputes          15% — 100 − 25 per DISCREPANCY delivery (floor 0).
 *  · response          10% — from Supplier.responseHours: ≤6h → 100, 48h+ → 25,
 *    linear between.
 *
 * A component with no data contributes a NEUTRAL 50 at its full weight, so a
 * supplier with little history trends toward 50 instead of 0 or 100. A supplier
 * with ZERO orders is held at exactly 50 with an honest note.
 */
const RELIABILITY_WEIGHTS: Array<Omit<ReliabilityComponent, 'value' | 'detail'>> = [
  { key: 'deliveryAccuracy', label: 'Delivery accuracy', weight: 0.35 },
  { key: 'onTime', label: 'On-time (≤3d)', weight: 0.2 },
  { key: 'completion', label: 'Order completion', weight: 0.2 },
  { key: 'disputes', label: 'Dispute-free', weight: 0.15 },
  { key: 'response', label: 'Response speed', weight: 0.1 },
]

export function computeReliability(supplier: SupplierLike, orders: SupplierOrderHistory[]): SupplierReliability {
  const deliveries = orders.flatMap((o) => o.deliveries)
  const lines = deliveries.flatMap((d) => d.lines)

  // delivery accuracy
  let deliveryAccuracy: number | null = null
  let accDetail = 'No delivery lines yet'
  if (lines.length > 0) {
    const avg = lines.reduce((s, l) => s + Math.min(1, l.qtyOrdered > 0 ? l.qtyReceived / l.qtyOrdered : 0), 0) / lines.length
    deliveryAccuracy = Math.round(avg * 100)
    accDetail = `Avg ${Math.round(lines.reduce((s, l) => s + l.qtyReceived, 0))}/${Math.round(lines.reduce((s, l) => s + l.qtyOrdered, 0))} units across ${lines.length} line${lines.length > 1 ? 's' : ''}`
  }

  // on-time: received within 3 days of dispatch
  const received = deliveries.filter((d) => d.receivedAt && d.dispatchedAt)
  let onTime: number | null = null
  let onTimeDetail = 'No received deliveries yet'
  if (received.length > 0) {
    const ok = received.filter((d) => (d.receivedAt as Date).getTime() - (d.dispatchedAt as Date).getTime() <= 3 * DAY_MS).length
    onTime = Math.round((ok / received.length) * 100)
    onTimeDetail = `${ok}/${received.length} received within 3 days of dispatch`
  }

  // completion over terminal orders only
  const terminal = orders.filter((o) => (TERMINAL_ORDER_STATUSES as readonly string[]).includes(o.status))
  let completion: number | null = null
  let compDetail = 'No finished orders yet'
  if (terminal.length > 0) {
    const done = terminal.filter((o) => o.status === 'delivered' || o.status === 'closed').length
    completion = Math.round((done / terminal.length) * 100)
    compDetail = `${done}/${terminal.length} orders delivered or closed`
  }

  // disputes
  const discrepancies = deliveries.filter((d) => d.status === 'discrepancy').length
  let disputes: number | null = null
  let dispDetail = 'No deliveries to dispute yet'
  if (deliveries.length > 0) {
    disputes = Math.max(0, 100 - 25 * discrepancies)
    dispDetail = discrepancies === 0 ? 'No discrepancy deliveries' : `${discrepancies} discrepancy deliver${discrepancies > 1 ? 'ies' : 'y'} (−25 each)`
  }

  // response speed from the recorded responseHours
  const h = supplier.responseHours
  const response = Math.max(25, Math.min(100, Math.round(100 - (h - 6) * (75 / 42))))
  const respDetail = h <= 6 ? `Responds within ${h}h` : `~${h}h average response`

  const values: Record<ReliabilityComponent['key'], { value: number | null; detail: string }> = {
    deliveryAccuracy: { value: deliveryAccuracy, detail: accDetail },
    onTime: { value: onTime, detail: onTimeDetail },
    completion: { value: completion, detail: compDetail },
    disputes: { value: disputes, detail: dispDetail },
    response: { value: response, detail: respDetail },
  }

  const components: ReliabilityComponent[] = RELIABILITY_WEIGHTS.map((w) => ({ ...w, value: values[w.key].value, detail: values[w.key].detail }))

  const noOrders = orders.length === 0
  const score = noOrders
    ? 50
    : Math.max(0, Math.min(100, Math.round(components.reduce((s, c) => s + c.weight * (c.value ?? 50), 0))))

  const note = noOrders
    ? 'No orders yet — held neutral at 50. This score uses actual platform transaction history only, never anonymous ratings.'
    : `From ${orders.length} order${orders.length > 1 ? 's' : ''} and ${deliveries.length} deliver${deliveries.length === 1 ? 'y' : 'ies'} on the platform.`

  return {
    supplierId: supplier.id,
    businessName: supplier.businessName,
    county: supplier.county,
    score,
    storedScore: supplier.reliabilityScore,
    responseHours: supplier.responseHours,
    ordersCount: orders.length,
    deliveriesCount: deliveries.length,
    discrepanciesCount: discrepancies,
    components,
    note,
  }
}

// ---------------- digest aggregation ----------------

export interface DigestCounts {
  pendingApprovals: number
  inTransitOrders: number
  discrepancies: number
}

/** ISO date of the Monday of the week containing `d` (digest weekStart convention). */
export function mondayOf(d: Date): string {
  const date = new Date(d)
  const dow = (date.getDay() + 6) % 7 // Monday = 0
  date.setDate(date.getDate() - dow)
  return date.toISOString().slice(0, 10)
}
