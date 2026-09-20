'use client'

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import type { ProjectSummary, WorkerWithAttendance } from '@/backend/lib/mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Avatar, AvatarFallback } from '@/frontend/ui/avatar'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/frontend/ui/alert-dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Textarea } from '@/frontend/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/frontend/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import {
  AddWorkerDialog, EditWorkerDialog,
  type AddWorkerPayload, type EditWorkerPayload, type EditWorkerData,
} from '@/frontend/mjengo/worker-dialogs'
import { downloadCSV, attendanceCSV, projectFilePrefix } from '@/frontend/mjengo/export-utils'
import {
  Users, LogIn, LogOut, Phone, Smartphone, MapPin, Wallet, UserPlus, BadgeCheck, Pencil, Download,
  ShieldCheck, CircleAlert, AlertTriangle, ClipboardList, ClipboardCheck, Loader2, ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, timeEAT, dateShort } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import type { TranslateFn } from '@/frontend/i18n/types'

// ---------------- shared bits ----------------

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

const STATUS_LABELS: Record<string, string> = {
  present: 'Present', half_day: 'Half day', absent: 'Absent', excused: 'Excused',
}

/** Display label for an attendance status (t(`fundis.status.${s}`)). The
 *  STATUS_LABELS map above is the KNOWN-STATUS GUARD only — its EN values
 *  never render; every dispatch label resolves the localized dict twin
 *  (issue #125: dispatch STATUS_LABELS moved into the dicts). */
function statusLabel(status: string | null | undefined, t: TranslateFn): string {
  return status && STATUS_LABELS[status] ? t(`fundis.status.${status}`) : t('fundis.noRecord')
}

const EXCEPTION_REASONS: Array<{ value: string; label: string }> = [
  { value: 'phone_damaged', label: 'Phone damaged' },
  { value: 'battery_dead', label: 'Battery dead' },
  { value: 'network', label: 'Network issue' },
  { value: 'forgot', label: 'Worker forgot' },
  { value: 'new_worker', label: 'New worker' },
  { value: 'emergency', label: 'Emergency' },
  { value: 'other', label: 'Other' },
]

function reasonLabel(v?: string | null, t?: TranslateFn): string {
  const r = EXCEPTION_REASONS.find((r) => r.value === v)
  // With a translator (W7 · issue #79) the reason renders in the active
  // locale where it reaches users — toasts + the exception dialog; the bare
  // English label remains the fallback for badge/table call sites.
  if (t) return r ? t(`fundis.exc.${r.value}`) : (v || t('fundis.verif.exception'))
  return r?.label ?? (v || 'Exception')
}

/** EAT "today" — mirrors the server's todayStr() so lookups match todayStatus. */
function todayEAT(): string {
  const d = new Date()
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

function initials(name: string) {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
}

function last7Days(): string[] {
  const out: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out.reverse()
}

/** Evidence-level badge: 🟢 verified · 🟡 reported · 🟠 exception · ⚪ none */
function VerificationBadge({ verification, exceptionReason, compact = false }: { verification: string | null; exceptionReason?: string | null; compact?: boolean }) {
  const t = useT()
  const cls = compact ? 'text-[9px]' : 'text-[10px]'
  if (verification === 'verified') {
    return <Badge className={`bg-emerald-100 text-emerald-800 border-0 gap-1 ${cls} hover:bg-emerald-100`} title={t('fundis.verif.verifiedTitle')}><ShieldCheck className="w-3 h-3" aria-hidden />{t('fundis.verif.verified')}</Badge>
  }
  if (verification === 'reported') {
    return <Badge className={`bg-amber-100 text-amber-800 border-0 gap-1 ${cls} hover:bg-amber-100`} title={t('fundis.verif.reportedTitle')}><CircleAlert className="w-3 h-3" aria-hidden />{t('fundis.verif.reported')}</Badge>
  }
  if (verification === 'exception') {
    return <Badge className={`bg-orange-100 text-orange-800 border-0 gap-1 ${cls} hover:bg-orange-100`} title={t('fundis.verif.exceptionTitle', { reason: reasonLabel(exceptionReason, t) })}><AlertTriangle className="w-3 h-3" aria-hidden />{t('fundis.verif.exception')}</Badge>
  }
  return <Badge className={`bg-stone-100 text-stone-500 border-0 gap-1 ${cls} hover:bg-stone-100`} title={t('fundis.verif.noneTitle')}>—</Badge>
}

/** Progress ring for the 0-100 attendance reliability score. */
function ReliabilityRing({ score }: { score: number | null }) {
  const t = useT()
  const C = 2 * Math.PI * 26
  const color = score === null ? 'stroke-stone-300'
    : score >= 80 ? 'stroke-emerald-500' : score >= 50 ? 'stroke-amber-500' : 'stroke-orange-500'
  return (
    <div
      className="relative w-16 h-16 shrink-0"
      role="img"
      aria-label={score === null ? t('fundis.ring.noHistory') : t('fundis.ring.aria', { score })}
    >
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r="26" fill="none" strokeWidth="7" className="stroke-stone-200" />
        <circle
          cx="32" cy="32" r="26" fill="none" strokeWidth="7" strokeLinecap="round"
          className={color}
          strokeDasharray={score === null ? `0 ${C}` : `${(score / 100) * C} ${C}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-stone-900 tabular-nums">
        {score === null ? '—' : score}
      </span>
    </div>
  )
}

/**
 * Labour Summary — reported vs verified presence for the remote owner.
 * Exported separately so the share view / overview can embed it.
 */
export function LabourSummaryCard({ summary, workers }: { summary: ProjectSummary; workers: WorkerWithAttendance[] }) {
  const t = useT()
  const v = summary.fundisVerified
  const r = summary.fundisReported
  const e = summary.fundisException
  const recorded = v + r + e
  const rate = recorded > 0 ? Math.round((v / recorded) * 100) : null
  const weekWages = workers.reduce((s, w) => s + w.weekEarnings, 0)

  // Attendance reliability: share of 'verified' among all non-absent records
  // in the last 30 days (uses the per-worker attendance history in the payload).
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  let nonAbsent = 0
  let verified = 0
  for (const w of workers) {
    for (const a of w.attendances) {
      if (a.status === 'absent' || a.status === 'excused') continue
      nonAbsent++
      if (a.verification === 'verified') verified++
    }
  }
  const reliability = nonAbsent > 0 ? Math.round((verified / nonAbsent) * 100) : null

  return (
    <Card className="border-stone-200 shadow-sm" aria-label={t('fundis.summary.aria')}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-stone-900 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-700" aria-hidden /> {t('fundis.summary.title')}
        </CardTitle>
        <CardDescription>{t('fundis.summary.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex flex-wrap items-center gap-2" aria-label={t('fundis.summary.todayAria')}>
            <Badge className="bg-emerald-100 text-emerald-800 border-0 gap-1 hover:bg-emerald-100"><ShieldCheck className="w-3 h-3" aria-hidden />{t('fundis.count.verified', { count: v })}</Badge>
            <Badge className="bg-amber-100 text-amber-800 border-0 gap-1 hover:bg-amber-100"><CircleAlert className="w-3 h-3" aria-hidden />{t('fundis.count.reported', { count: r })}</Badge>
            <Badge className="bg-orange-100 text-orange-800 border-0 gap-1 hover:bg-orange-100"><AlertTriangle className="w-3 h-3" aria-hidden />{t('fundis.count.exception', { count: e })}</Badge>
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <p className="text-[11px] text-stone-500">{t('fundis.summary.rateToday')}</p>
              <p className="text-lg font-bold text-stone-900 tabular-nums">{rate === null ? '—' : `${rate}%`}</p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">{t('fundis.summary.verifiedWages')}</p>
              <p className="text-lg font-bold text-emerald-700 tabular-nums">{formatKES(summary.wagesVerified)}</p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">{t('fundis.summary.pendingReview')}</p>
              <p className="text-lg font-bold text-amber-600 tabular-nums">{formatKES(summary.wagesPendingReview)}</p>
            </div>
            <div>
              <p className="text-[11px] text-stone-500">{t('fundis.summary.weekWages')}</p>
              <p className="text-lg font-bold text-stone-900 tabular-nums">{formatKES(weekWages)}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <ReliabilityRing score={reliability} />
            <div>
              <p className="text-[11px] text-stone-500">{t('fundis.summary.rate30')}</p>
              <p className="text-sm font-semibold text-stone-800 tabular-nums">
                {reliability === null ? '—' : `${reliability}/100`}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------- payroll gate result ----------------

interface PayrollResult {
  blocked: boolean
  paid?: number
  amount: number
  forced?: boolean
  date?: string
  /** Ledger transaction ref for the posted wage payout (F-MONEY). */
  ledgerRef?: string
  requiringReview?: Array<{ workerId: string; name?: string; reason?: string | null }>
  reviewAmount?: number
}

// ---------------- main tab ----------------

export function FundisTab() {
  const { data, dispatch, online, outbox, viewMode, load, enqueuePendingNetwork } = useMjengo()
  const t = useT()
  const [addOpen, setAddOpen] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [editWorker, setEditWorker] = useState<EditWorkerData | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editBusy, setEditBusy] = useState(false)

  // Daily muster
  const [musterOpen, setMusterOpen] = useState(false)
  const [musterRows, setMusterRows] = useState<Record<string, string>>({})
  const [musterBusy, setMusterBusy] = useState(false)
  const [wasMusterOpen, setWasMusterOpen] = useState(false)

  // Exception dialog
  const [exceptionFor, setExceptionFor] = useState<WorkerWithAttendance | null>(null)
  const [exReason, setExReason] = useState('')
  const [exNote, setExNote] = useState('')
  const [exBusy, setExBusy] = useState(false)

  // Override-with-reason dialog
  const [overrideFor, setOverrideFor] = useState<{ worker: WorkerWithAttendance; to: string } | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideBusy, setOverrideBusy] = useState(false)

  // Payroll gate
  const [gate, setGate] = useState<PayrollResult | null>(null)
  const [payrollBusy, setPayrollBusy] = useState(false)
  const [confirmForce, setConfirmForce] = useState(false)

  if (!data) return null
  const days = last7Days()
  const today = todayEAT()
  const isClient = viewMode === 'client'

  // Prefill muster rows whenever the dialog opens (adjust-state-during-render pattern)
  if (musterOpen !== wasMusterOpen) {
    setWasMusterOpen(musterOpen)
    if (musterOpen) {
      const rows: Record<string, string> = {}
      for (const w of data.workers) if (w.active) rows[w.id] = w.todayStatus.status ?? 'present'
      setMusterRows(rows)
    }
  }

  async function checkIn(workerId: string, workerName: string) {
    const ok = await dispatch('attendance.checkin', { workerId, toggle: 'in', method: 'app' }, t('fundis.dispatch.checkIn', { name: workerName }))
    if (ok) toast.success(online
      ? t('fundis.checkinOk', { name: workerName })
      : t('fundis.checkinQueued', { count: outbox.length }))
    else toast.error(t('fundis.checkinFailed'))
  }

  async function checkOut(workerId: string, workerName: string) {
    const ok = await dispatch('attendance.checkin', { workerId, toggle: 'out' }, t('fundis.dispatch.checkOut', { name: workerName }))
    if (ok) toast.success(t('fundis.checkoutOk', { name: workerName }))
    else toast.error(t('fundis.checkoutFailed'))
  }

  /** Status edits go through the override flow (reason required, history preserved). */
  function requestStatusChange(worker: WorkerWithAttendance, to: string) {
    if (worker.todayStatus.status === to) return
    setOverrideReason('')
    setOverrideFor({ worker, to })
  }

  async function confirmOverride() {
    if (!overrideFor) return
    const { worker, to } = overrideFor
    const reason = overrideReason.trim()
    if (!reason) return
    const attId = worker.attendances.find((a) => a.date === today)?.id
    setOverrideBusy(true)
    try {
      const ok = attId
        ? await dispatch('attendance.override', { id: attId, to, reason, by: 'Site Manager' }, t('fundis.dispatch.override', { name: worker.name, status: t(`fundis.status.${to}`) }))
        : await dispatch('attendance.record', { records: JSON.stringify([{ workerId: worker.id, status: to }]), verification: 'reported', recordedBy: 'Site Manager' }, t('fundis.dispatch.record', { name: worker.name, status: t(`fundis.status.${to}`) }))
      if (ok) {
        toast.success(t('fundis.overrideOk', { name: worker.name, status: t(`fundis.status.${to}`) }))
        setOverrideFor(null)
        setOverrideReason('')
      } else {
        toast.error(t('fundis.overrideFailed'))
      }
    } finally {
      setOverrideBusy(false)
    }
  }

  async function saveMuster() {
    const records = Object.entries(musterRows).map(([workerId, status]) => ({ workerId, status }))
    if (!records.length) return
    setMusterBusy(true)
    try {
      const ok = await dispatch(
        'attendance.record',
        { records: JSON.stringify(records), verification: 'reported', recordedBy: 'Site Manager' },
        t('fundis.dispatch.muster'),
      )
      if (ok) {
        toast.success(t('fundis.musterSaved', { count: records.length }))
        setMusterOpen(false)
      } else {
        toast.error(t('fundis.musterFailed'))
      }
    } finally {
      setMusterBusy(false)
    }
  }

  async function saveException() {
    if (!exceptionFor || !exReason) return
    setExBusy(true)
    try {
      const ok = await dispatch(
        'attendance.exception',
        { workerId: exceptionFor.id, reason: exReason, note: exNote.trim() || undefined },
        t('fundis.dispatch.exception', { name: exceptionFor.name }),
      )
      if (ok) {
        toast.success(t('fundis.exceptionLogged', { name: exceptionFor.name, reason: reasonLabel(exReason, t) }))
        setExceptionFor(null)
        setExReason('')
        setExNote('')
      } else {
        toast.error(t('fundis.exceptionFailed'))
      }
    } finally {
      setExBusy(false)
    }
  }

  /**
   * THE GATE: wages.pay (F-MONEY) — direct POST because the UI needs the blocked
   * payload (list of records requiring review) to render the warning dialog.
   * The payout posts a balanced ledger entry (costCode 'wages') through the
   * payment-provider seam — simulated rails, honestly labelled.
   */
  async function runPayroll(force = false) {
    if (!data) return
    if (!online) {
      toast.error(t('fundis.payrollNeedsOnline'))
      // #150: the hard stop keeps its honesty; the worklist keeps the memory
      // (a "remind me" entry, NOT a queued payroll — the remind-only call;
      // the period is the EAT day the payout would cover, same today rule
      // the server's payroll window uses).
      enqueuePendingNetwork({ kind: 'wages.pay', labelKey: 'netlist.kind.payroll', context: { period: todayEAT() }, tab: 'fundis' })
      return
    }
    setPayrollBusy(true)
    setGate(null)
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'wages.pay', payload: { force }, projectId: data.project.id }),
      })
      const json = await res.json()
      if (!json.ok) {
        toast.error(json.error ?? t('fundis.payrollFailed'))
        return
      }
      const result = json.result as PayrollResult
      if (result.blocked) {
        setGate(result)
      } else if ((result.paid ?? 0) > 0) {
        toast.success(
          result.forced
            ? t('fundis.payrollForced', { count: result.paid ?? 0, amount: formatKES(result.amount), ref: result.ledgerRef ?? '—' })
            : t('fundis.payrollPaid', {
                count: result.paid ?? 0,
                amount: formatKES(result.amount),
                ref: result.ledgerRef ? ` (${result.ledgerRef})` : '',
              }),
        )
      } else {
        toast.info(t('fundis.nothingToPay'))
      }
      await load()
    } catch {
      toast.error(t('fundis.payrollNetwork'))
    } finally {
      setPayrollBusy(false)
    }
  }

  async function addFundi(payload: AddWorkerPayload): Promise<boolean> {
    setAddBusy(true)
    try {
      return await dispatch('worker.create', payload, t('fundis.dispatch.addFundi', { name: payload.name }))
    } finally {
      setAddBusy(false)
    }
  }

  async function saveFundi(payload: EditWorkerPayload): Promise<boolean> {
    if (!editWorker) return false
    setEditBusy(true)
    try {
      return await dispatch('worker.update', { id: editWorker.id, ...payload }, t('fundis.dispatch.editFundi', { name: payload.name }))
    } finally {
      setEditBusy(false)
    }
  }

  function exportAttendance() {
    if (!data) return
    const filename = `${projectFilePrefix(data)}-attendance.csv`
    downloadCSV(filename, attendanceCSV(t, data))
    toast.success(t('field.exported', { file: filename }))
  }

  function openEdit(worker: WorkerWithAttendance) {
    setEditWorker({
      id: worker.id, name: worker.name, role: worker.role, phone: worker.phone,
      dailyRate: worker.dailyRate, active: worker.active, hasPin: Boolean(worker.pin),
    })
    setEditOpen(true)
  }

  const activeWorkers = data.workers.filter((w) => w.active)
  const musterStatuses = ['present', 'half_day', 'absent', 'excused'] as const
  const activeSeg: Record<string, string> = {
    present: 'bg-emerald-600 text-white',
    half_day: 'bg-amber-500 text-white',
    absent: 'bg-red-600 text-white',
    excused: 'bg-stone-700 text-white',
  }

  return (
    <div className="space-y-6">
      {/* Labour summary — reported vs verified (owner + client view) */}
      <LabourSummaryCard summary={data.summary} workers={data.workers} />

      {/* Today bar */}
      <Card className="border-stone-200 shadow-sm bg-gradient-to-r from-stone-900 to-stone-800 text-stone-100">
        <CardContent className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-5">
          <div className="flex items-center gap-6 flex-wrap">
            <div>
              <p className="text-xs text-stone-400 flex items-center gap-1"><Users className="w-3.5 h-3.5" aria-hidden /> {t('fundis.today.onSite')}</p>
              <p className="text-3xl font-bold tabular-nums">{data.summary.fundisToday}<span className="text-lg text-stone-400 font-medium">/{data.summary.fundisExpected}</span></p>
            </div>
            <div className="h-10 w-px bg-stone-700 hidden sm:block" aria-hidden />
            <div>
              <p className="text-xs text-stone-400 flex items-center gap-1"><Wallet className="w-3.5 h-3.5" aria-hidden /> {t('fundis.today.wages')}</p>
              <p className="text-xl font-bold tabular-nums text-amber-400">{formatKES(data.summary.wagesToday)}</p>
            </div>
            <div className="h-10 w-px bg-stone-700 hidden sm:block" aria-hidden />
            <div>
              <p className="text-xs text-stone-400">{t('fundis.today.unpaid')}</p>
              <p className="text-xl font-bold tabular-nums">{formatKES(data.summary.wagesUnpaid)}</p>
            </div>
          </div>
          {!isClient && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-1.5 border-stone-600 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white" onClick={() => setMusterOpen(true)}>
                <ClipboardList className="w-4 h-4" aria-hidden /> {t('fundis.muster')}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 border-stone-600 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white" onClick={() => setAddOpen(true)}>
                <UserPlus className="w-4 h-4" aria-hidden /> {t('fundis.addFundi')}
              </Button>
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => void runPayroll(false)}
                disabled={data.summary.wagesToday <= 0 || payrollBusy}
              >
                {payrollBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <BadgeCheck className="w-4 h-4" aria-hidden />}
                {t('fundis.runPayroll')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Worker cards */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" aria-label={t('fundis.crewAria')}>
        {data.workers.map((w) => {
          const ts = w.todayStatus
          const isUssd = ts.method === 'ussd'
          const present = ts.status === 'present' || ts.status === 'half_day'
          const isException = ts.verification === 'exception'
          return (
            <Card key={w.id} className={`border shadow-sm ${present ? 'border-emerald-200' : 'border-stone-200'} ${isException ? 'ring-1 ring-orange-300' : ''}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Avatar className="w-11 h-11 border border-stone-200">
                    <AvatarFallback className={present ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'}>
                      {initials(w.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-stone-900 text-sm">{w.name}</p>
                      {present && <Badge className="bg-emerald-100 text-emerald-800 border-0 text-[10px] hover:bg-emerald-100">{t('fundis.badge.onSite')}</Badge>}
                      {ts.status === 'absent' && <Badge className="bg-red-100 text-red-700 border-0 text-[10px] hover:bg-red-100">{t('fundis.status.absent')}</Badge>}
                      {ts.status === 'excused' && <Badge className="bg-stone-200 text-stone-700 border-0 text-[10px] hover:bg-stone-200">{t('fundis.status.excused')}</Badge>}
                      {!w.active && <Badge className="bg-stone-100 text-stone-500 border-0 text-[10px] hover:bg-stone-100">{t('fundis.badge.inactive')}</Badge>}
                    </div>
                    <p className="text-xs text-stone-500">{w.role} · {formatKES(w.dailyRate)}{t('fundis.perDay')}</p>
                    <p className="text-[11px] text-stone-400 flex items-center gap-1 mt-0.5">
                      <Phone className="w-3 h-3" aria-hidden /> {w.phone || t('fundis.noPhone')}
                      {w.pin && <span className="ml-1 inline-flex items-center gap-0.5 text-stone-400" title={t('fundis.hasPinTitle')}><ShieldCheck className="w-3 h-3" aria-hidden />PIN</span>}
                    </p>
                  </div>
                  {!isClient && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-11 w-11 -mr-1.5 shrink-0 text-stone-400 hover:text-stone-800 hover:bg-stone-100 sm:h-9 sm:w-9 sm:mr-0"
                      onClick={() => openEdit(w)}
                      aria-label={t('fundis.editAria', { name: w.name })}
                    >
                      <Pencil className="w-4 h-4" aria-hidden />
                    </Button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <VerificationBadge verification={ts.verification} exceptionReason={ts.exceptionReason} />
                  <span className="font-semibold text-stone-700 tabular-nums text-xs">{formatKES(ts.wage)}{ts.paid ? t('fundis.paidSuffix') : ''}</span>
                </div>

                <div className="rounded-lg bg-stone-50 border border-stone-100 px-3 py-2 text-xs flex items-center justify-between gap-2">
                  {present ? (
                    <span className="text-stone-600 flex items-center gap-1.5 flex-wrap">
                      <MapPin className="w-3.5 h-3.5 text-emerald-600" aria-hidden />
                      {t('fundis.inAt', { time: timeEAT(ts.checkIn) })}
                      {ts.checkOut ? ` · ${t('fundis.outAt', { time: timeEAT(ts.checkOut) })}` : ''}
                      {isUssd && <Badge className="bg-violet-100 text-violet-800 border-0 text-[9px] hover:bg-violet-100"><Smartphone className="w-2.5 h-2.5" aria-hidden /> USSD</Badge>}
                    </span>
                  ) : ts.status === 'absent' ? (
                    <span className="text-red-600">{t('fundis.markedAbsent')}</span>
                  ) : ts.status === 'excused' ? (
                    <span className="text-stone-500">{t('fundis.excusedNoWage')}</span>
                  ) : (
                    <span className="text-stone-400">{t('fundis.notCheckedIn')}</span>
                  )}
                  {isException && <span className="text-[10px] text-orange-700 truncate" title={ts.exceptionReason ? reasonLabel(ts.exceptionReason, t) : undefined}>{ts.exceptionReason ? reasonLabel(ts.exceptionReason, t) : t('fundis.needsReview')}</span>}
                </div>

                {!isClient && (
                  <div className="flex items-center gap-2">
                    {!ts.status || ts.status === 'absent' || ts.status === 'excused' ? (
                      <Button size="sm" className="h-9 gap-1.5 flex-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => void checkIn(w.id, w.name)}>
                        <LogIn className="w-3.5 h-3.5" aria-hidden /> {t('fundis.checkIn')}
                      </Button>
                    ) : !ts.checkOut ? (
                      <Button size="sm" variant="outline" className="h-9 gap-1.5 flex-1" onClick={() => void checkOut(w.id, w.name)}>
                        <LogOut className="w-3.5 h-3.5" aria-hidden /> {t('fundis.checkOut')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="h-9 gap-1.5 flex-1" disabled>
                        <BadgeCheck className="w-3.5 h-3.5" aria-hidden /> {t('fundis.dayClosed')}
                      </Button>
                    )}
                    <Select value={ts.status ?? undefined} onValueChange={(v) => requestStatusChange(w, v)}>
                      <SelectTrigger size="sm" className="w-28 h-9 bg-white text-xs" aria-label={t('fundis.statusAria', { name: w.name })}>
                        <SelectValue placeholder={t('fundis.statusPh')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="present">{t('fundis.status.present')}</SelectItem>
                        <SelectItem value="half_day">{t('fundis.status.half_day')}</SelectItem>
                        <SelectItem value="absent">{t('fundis.status.absent')}</SelectItem>
                        <SelectItem value="excused">{t('fundis.status.excused')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="outline"
                      className={`h-9 w-9 shrink-0 ${isException ? 'border-orange-300 text-orange-700 hover:bg-orange-50' : 'text-stone-500 hover:bg-stone-100'}`}
                      onClick={() => { setExReason(''); setExNote(''); setExceptionFor(w) }}
                      aria-label={t('fundis.exceptionAria', { name: w.name })}
                      title={t('fundis.exceptionTitle')}
                    >
                      <AlertTriangle className="w-4 h-4" aria-hidden />
                    </Button>
                  </div>
                )}
                <p className="text-[11px] text-stone-400 text-right">{t('fundis.thisWeek', { amount: formatKES(w.weekEarnings) })}</p>
              </CardContent>
            </Card>
          )
        })}
      </section>

      {/* Attendance heat table */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900">{t('fundis.attendanceTitle')}</CardTitle>
            <CardDescription>{t('fundis.attendanceDesc')}</CardDescription>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={exportAttendance} aria-label={t('fundis.exportAria')}>
            <Download className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">{t('fundis.exportCsv')}</span>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('fundis.col.fundi')}</TableHead>
                {days.map((d) => (
                  <TableHead key={d} className="text-center text-[10px]">{dateShort(d)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.workers.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium text-stone-800 whitespace-nowrap text-sm">{w.name}</TableCell>
                  {days.map((d) => {
                    const a = w.attendances.find((x) => x.date === d)
                    let cls = 'bg-stone-100 text-stone-300'
                    let label = '—'
                    if (a?.status === 'present') { cls = 'bg-emerald-100 text-emerald-700'; label = 'P' }
                    else if (a?.status === 'half_day') { cls = 'bg-amber-100 text-amber-700'; label = 'H' }
                    else if (a?.status === 'absent') { cls = 'bg-red-100 text-red-600'; label = 'A' }
                    else if (a?.status === 'excused') { cls = 'bg-stone-200 text-stone-600'; label = 'E' }
                    if (a && a.verification === 'exception') cls += ' ring-1 ring-orange-400'
                    return (
                      <TableCell key={d} className="text-center p-1">
                        <span
                          className={`inline-flex w-7 h-7 items-center justify-center rounded-md text-[11px] font-bold ${cls}`}
                          title={t('fundis.cellTitle', { name: w.name, date: dateShort(d), status: a?.status ? t(`fundis.status.${a.status}`) : t('fundis.noRecord'), verification: a?.verification ? ` (${t(`fundis.verif.${a.verification}`)})` : '' })}
                        >
                          {label}
                        </span>
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-stone-500">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-100 inline-block" aria-hidden /> {t('fundis.legend.present')}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-100 inline-block" aria-hidden /> {t('fundis.legend.half')}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 inline-block" aria-hidden /> {t('fundis.legend.absent')}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-stone-200 inline-block" aria-hidden /> {t('fundis.legend.excused')}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-stone-100 inline-block" aria-hidden /> {t('fundis.legend.none')}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded ring-1 ring-orange-400 inline-block" aria-hidden /> {t('fundis.legend.exception')}</span>
          </div>
        </CardContent>
      </Card>

      {/* Add / Edit fundi dialogs (owner only — buttons hidden in client preview) */}
      <AddWorkerDialog open={addOpen} onOpenChange={setAddOpen} onSubmit={addFundi} submitting={addBusy} />
      <EditWorkerDialog open={editOpen} onOpenChange={setEditOpen} onSubmit={saveFundi} submitting={editBusy} worker={editWorker} />

      {/* Daily muster — bulk manager record for today */}
      <Dialog open={musterOpen} onOpenChange={setMusterOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-900 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-amber-600" aria-hidden /> {t('fundis.muster.title', { date: dateShort(today) })}
            </DialogTitle>
            <DialogDescription>
              {t('fundis.muster.desc1')}<strong>{t('fundis.verif.reported')}</strong>{t('fundis.muster.desc2')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                const rows: Record<string, string> = {}
                for (const w of activeWorkers) rows[w.id] = 'present'
                setMusterRows(rows)
              }}
            >
              <ClipboardCheck className="w-4 h-4" aria-hidden /> {t('fundis.muster.allPresent')}
            </Button>
            <p className="text-[11px] text-stone-500">{t('fundis.muster.overrideNote')}</p>
          </div>

          <div className={`max-h-96 overflow-y-auto space-y-2 pr-1 ${SCROLLBAR}`} role="list" aria-label={t('fundis.muster.rollAria')}>
            {activeWorkers.map((w) => (
              <div key={w.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2" role="listitem">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <Avatar className="w-8 h-8 border border-stone-200">
                    <AvatarFallback className="bg-stone-100 text-stone-600 text-[10px]">{initials(w.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800 truncate">{w.name}</p>
                    <div className="mt-0.5"><VerificationBadge compact verification={w.todayStatus.verification} exceptionReason={w.todayStatus.exceptionReason} /></div>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-stone-100 p-1 w-full sm:w-64" role="radiogroup" aria-label={t('fundis.statusAria', { name: w.name })}>
                  {musterStatuses.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={musterRows[w.id] === s}
                      onClick={() => setMusterRows((rows) => ({ ...rows, [w.id]: s }))}
                      className={`h-9 min-h-9 rounded-md text-[11px] font-medium transition-colors ${
                        musterRows[w.id] === s ? activeSeg[s] : 'text-stone-500 hover:bg-stone-200/70'
                      }`}
                    >
                      {s === 'half_day' ? t('fundis.status.halfShort') : t(`fundis.status.${s}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMusterOpen(false)} disabled={musterBusy}>{t('fundis.cancel')}</Button>
            <Button onClick={() => void saveMuster()} disabled={musterBusy} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-28">
              {musterBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {musterBusy ? t('fundis.saving') : t('fundis.saveMuster', { count: activeWorkers.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Exception dialog — present but no check-in evidence */}
      <Dialog open={!!exceptionFor} onOpenChange={(o) => !o && setExceptionFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-600" aria-hidden /> {t('fundis.exceptionDlg.title')}
            </DialogTitle>
            <DialogDescription>
              {exceptionFor ? t('fundis.exceptionDlg.desc', { name: exceptionFor.name }) : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1">
            <div className="space-y-2">
              <Label>{t('fundis.label.reason')}</Label>
              <Select value={exReason || undefined} onValueChange={setExReason}>
                <SelectTrigger aria-label={t('fundis.exceptionReasonAria')}>
                  <SelectValue placeholder={t('fundis.selectReasonPh')} />
                </SelectTrigger>
                <SelectContent>
                  {EXCEPTION_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{reasonLabel(r.value, t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ex-note">{t('fundis.label.note')}</Label>
              <Textarea
                id="ex-note"
                value={exNote}
                onChange={(e) => setExNote(e.target.value)}
                placeholder={t('fundis.exceptionNotePh')}
                className="min-h-20 bg-white"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExceptionFor(null)} disabled={exBusy}>{t('fundis.cancel')}</Button>
            <Button onClick={() => void saveException()} disabled={exBusy || !exReason} className="gap-1.5 bg-orange-600 hover:bg-orange-700 text-white min-w-28">
              {exBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {exBusy ? t('fundis.saving') : t('fundis.logException')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Override dialog — status change with reason (append-only log) */}
      <Dialog open={!!overrideFor} onOpenChange={(o) => !o && setOverrideFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('fundis.overrideDlg.title')}</DialogTitle>
            <DialogDescription>
              {overrideFor && (
                <>
                  <strong>{overrideFor.worker.name}</strong>:{' '}
                  {statusLabel(overrideFor.worker.todayStatus.status, t)} → <strong>{t(`fundis.status.${overrideFor.to}`)}</strong>.{' '}
                  {t('fundis.overrideDlg.tail')}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="ov-reason">{t('fundis.label.reason')}</Label>
            <Input
              id="ov-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder={t('fundis.overrideReasonPh')}
              aria-invalid={!overrideReason.trim()}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideFor(null)} disabled={overrideBusy}>{t('fundis.cancel')}</Button>
            <Button onClick={() => void confirmOverride()} disabled={overrideBusy || !overrideReason.trim()} className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-28">
              {overrideBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {overrideBusy ? t('fundis.saving') : t('fundis.saveOverride')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payroll gate — records requiring verification before money moves */}
      <Dialog open={!!gate} onOpenChange={(o) => !o && setGate(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-orange-600" aria-hidden /> {t('fundis.gate.title')}
            </DialogTitle>
            <DialogDescription>
              {gate && (
                <>
                  {t('fundis.gate.desc', {
                    count: gate.requiringReview?.length ?? 0,
                    amount: formatKES(gate.amount),
                    review: formatKES(gate.reviewAmount ?? 0),
                  })}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <ul className={`max-h-48 overflow-y-auto space-y-1.5 pr-1 ${SCROLLBAR}`} aria-label={t('fundis.gate.listAria')}>
            {gate?.requiringReview?.map((r) => (
              <li key={r.workerId} className="flex items-center justify-between gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
                <span className="font-medium text-stone-800 truncate">{r.name ?? t('fundis.gate.worker')}</span>
                <span className="text-xs text-orange-700 shrink-0">{reasonLabel(r.reason, t)}</span>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-stone-500">
            {t('fundis.gate.resolve')}
          </p>

          {/* #123 (FE-2): the SAME simulated-rails posture copy the Money tab
              banner carries — shared money.posture.* keys, no divergent
              duplicate. Payroll posts on the same rails as the wallet. */}
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed"
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
            <span>
              <strong className="font-semibold">{t('money.posture.title')}</strong>
              {' — '}
              {t('money.posture.note')}
            </span>
          </p>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="gap-1.5 sm:mr-auto"
              onClick={() => { setGate(null); setMusterOpen(true) }}
            >
              <ClipboardList className="w-4 h-4" aria-hidden /> {t('fundis.gate.reviewInMuster')}
            </Button>
            <Button variant="destructive" onClick={() => setConfirmForce(true)} disabled={payrollBusy} className="gap-1.5">
              {payrollBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldAlert className="w-4 h-4" aria-hidden />}
              {t('fundis.gate.force')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Destructive confirm — paying past exceptions is a money action with audit consequences */}
      <AlertDialog open={confirmForce} onOpenChange={setConfirmForce}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('fundis.gate.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {gate ? t('fundis.gate.confirmDesc', {
                count: gate.requiringReview?.length ?? 0,
                amount: formatKES(gate.reviewAmount ?? 0),
              }) : t('fundis.gate.confirmDescNoGate')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">{t('fundis.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-red-600 hover:bg-red-700"
              onClick={() => { setGate(null); void runPayroll(true) }}
            >
              {t('fundis.gate.force')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
