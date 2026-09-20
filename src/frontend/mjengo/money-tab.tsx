'use client'

import { useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Checkbox } from '@/frontend/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { RadioGroup, RadioGroupItem } from '@/frontend/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Textarea } from '@/frontend/ui/textarea'
import type { ProjectPayload } from '@/backend/lib/mjengo'
import type { PaymentRequestRow } from '@/backend/modules/wallet/types'
import { EMPTY_FINANCE_SLICE } from '@/backend/modules/wallet/types'
import type { DrawPackLink } from '@/backend/modules/drawpack/service'
import { DrawPackViewer } from '@/frontend/mjengo/draw-pack-viewer'
import { WalletPostureBanner } from '@/frontend/mjengo/wallet-posture-banner'
import { useT } from '@/frontend/i18n/provider'
import {
  Banknote, BookOpen, Camera, Check, CheckCheck, FileCheck2, Hourglass, ImageOff, Link2, Loader2, Lock, Minus, Plus, Send, ShieldCheck, Sparkles, TrendingUp, Wallet, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, dateShort } from '@/frontend/lib/format'

type MilestoneRow = ProjectPayload['milestones'][number]
type VariationRow = ProjectPayload['variations'][number]
type PhotoRow = ProjectPayload['photos'][number]

const LOCKED_STATUSES = ['locked', 'evidence_submitted', 'release_requested']

function parseEvidenceIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function previewReference(method: string): string {
  const prefix = method === 'bank' ? 'BANK' : method === 'card' ? 'CARD' : 'MPESA'
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}-${suffix}`
}

// ---------------- status badges ----------------

function MilestoneStatusBadge({ status }: { status: string }) {
  const t = useT()
  if (status === 'released')
    return <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> {t('money.msStatus.released')}</Badge>
  if (status === 'rejected')
    return <Badge className="border-0 bg-rose-100 text-rose-800 gap-1 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> {t('money.msStatus.rejected')}</Badge>
  if (status === 'release_requested')
    return <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> {t('money.msStatus.release_requested')}</Badge>
  if (status === 'evidence_submitted')
    return <Badge className="border-0 bg-stone-800 text-stone-50 gap-1 hover:bg-stone-800"><Camera className="h-3 w-3" aria-hidden /> {t('money.msStatus.evidence_submitted')}</Badge>
  return <Badge className="border-0 bg-stone-100 text-stone-600 gap-1 hover:bg-stone-100"><Lock className="h-3 w-3" aria-hidden /> {t('money.msStatus.locked')}</Badge>
}

function VariationStatusBadge({ status }: { status: string }) {
  const t = useT()
  if (status === 'approved')
    return <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> {t('money.varStatus.approved')}</Badge>
  if (status === 'rejected')
    return <Badge className="border-0 bg-rose-100 text-rose-800 gap-1 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> {t('money.varStatus.rejected')}</Badge>
  return <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> {t('money.varStatus.awaiting')}</Badge>
}

// ---------------- milestone stepper ----------------

function StepperNode({ state, index }: { state: 'done' | 'current' | 'todo'; index: number }) {
  if (state === 'done')
    return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600" aria-hidden><Check className="h-3 w-3 text-white" /></span>
  if (state === 'current')
    return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-amber-500 bg-white text-[10px] font-bold text-amber-600" aria-hidden>{index + 1}</span>
  return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-200 text-[10px] font-bold text-stone-400" aria-hidden>{index + 1}</span>
}

function MilestoneStepper({ m }: { m: MilestoneRow }) {
  const t = useT()
  const rejected = m.status === 'rejected'
  const doneCount =
    m.status === 'released' ? 4
    : rejected || m.status === 'release_requested' ? 3
    : m.status === 'evidence_submitted' ? 2
    : 1
  const steps = [
    { label: t('money.step.locked'), note: t('money.step.lockedNote') },
    { label: t('money.step.evidence'), note: m.status === 'locked' ? t('money.step.evidenceNoteAttach') : t('money.step.evidenceNote') },
    { label: t('money.step.request'), note: m.requestedAt ? dateShort(m.requestedAt) : null },
  ]
  const finalStep = rejected
    ? { label: t('money.step.rejected'), note: m.decidedAt ? `${dateShort(m.decidedAt)}${m.decidedBy ? ` · ${m.decidedBy}` : ''}` : null }
    : { label: t('money.step.released'), note: m.releasedAt ? dateShort(m.releasedAt) : t('money.step.clientApproves') }

  return (
    <ol className="space-y-0 text-xs" aria-label={t('money.stepperAria', { name: m.name })}>
      {steps.map((s, i) => {
        const state = i < doneCount ? 'done' : i === doneCount ? 'current' : 'todo'
        return (
          <li key={s.label} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <StepperNode state={state} index={i} />
              <span className={`w-0.5 flex-1 min-h-4 ${i < doneCount && i < steps.length - 1 ? 'bg-emerald-500' : 'bg-stone-200'}`} aria-hidden />
            </div>
            <div className="pb-4 pt-[-2px]">
              <p className={`font-medium leading-5 ${state === 'done' ? 'text-stone-800' : state === 'current' ? 'text-amber-700' : 'text-stone-400'}`}>{s.label}</p>
              {s.note && <p className="text-[11px] text-stone-400">{s.note}</p>}
            </div>
          </li>
        )
      })}
      <li className="flex gap-2.5">
        {rejected ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rose-600" aria-hidden><X className="h-3 w-3 text-white" /></span>
        ) : (
          <StepperNode state={m.status === 'released' ? 'done' : 'todo'} index={3} />
        )}
        <div>
          <p className={`font-medium leading-5 ${rejected ? 'text-rose-700' : m.status === 'released' ? 'text-stone-800' : 'text-stone-400'}`}>{finalStep.label}</p>
          {finalStep.note && <p className="text-[11px] text-stone-400">{finalStep.note}</p>}
        </div>
      </li>
    </ol>
  )
}

// ---------------- evidence thumbnails ----------------

function EvidenceThumb({ photo }: { photo: PhotoRow | undefined }) {
  const t = useT()
  if (!photo) {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 bg-stone-50" title={t('money.thumb.goneTitle')}>
        <ImageOff className="h-4 w-4 text-stone-400" aria-hidden />
        <span className="sr-only">{t('money.thumb.goneSr')}</span>
      </span>
    )
  }
  return (
    <a
      href={photo.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block h-12 w-12 overflow-hidden rounded-md border border-stone-200 transition hover:border-amber-500"
      title={photo.caption ?? t('money.thumb.title')}
      aria-label={t('money.thumb.aria', { caption: photo.caption ?? t('money.thumb.alt') })}
    >
      <img src={photo.url} alt={photo.caption ?? t('money.thumb.alt')} className="h-full w-full object-cover" loading="lazy" />
    </a>
  )
}

// ---------------- payment request + ledger bits (F-MONEY) ----------------

function PaymentRequestStatusBadge({ status }: { status: string }) {
  const t = useT()
  if (status === 'paid')
    return <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100"><CheckCheck className="h-3 w-3" aria-hidden /> {t('money.prStatus.paid')}</Badge>
  if (status === 'approved')
    return <Badge className="border-0 bg-sky-100 text-sky-800 gap-1 hover:bg-sky-100"><Banknote className="h-3 w-3" aria-hidden /> {t('money.prStatus.approved')}</Badge>
  if (status === 'rejected')
    return <Badge className="border-0 bg-rose-100 text-rose-800 gap-1 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> {t('money.prStatus.rejected')}</Badge>
  return <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> {t('money.prStatus.pending')}</Badge>
}

// Method labels render through the dict (money.prMethod.*); the value
// strings are stored data and never change.
const PR_METHODS: Array<{ value: string; key: string }> = [
  { value: 'mpesa', key: 'money.prMethod.mpesa' },
  { value: 'bank', key: 'money.prMethod.bank' },
  { value: 'cash', key: 'money.prMethod.cash' },
  { value: 'card', key: 'money.prMethod.card' },
  { value: 'wallet', key: 'money.prMethod.wallet' },
]

/** Escrow projection vs ledger-derived balance — the honesty chip (spec §39). */
function EscrowConsistencyChip({ escrow }: { escrow: NonNullable<ProjectPayload['finance']['escrow']> }) {
  const t = useT()
  if (escrow.consistent) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100">
          <BookOpen className="h-3 w-3" aria-hidden /> {t('money.escrow.consistent')}
        </Badge>
        <span className="text-[11px] text-stone-400">
          {t('money.escrow.consistentNote', { derived: formatKES(escrow.derived), projected: formatKES(escrow.projected) })}
        </span>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100">
        <ShieldCheck className="h-3 w-3" aria-hidden /> {t('money.escrow.drift', { amount: formatKES(Math.abs(escrow.drift)) })}
      </Badge>
      <span className="text-[11px] text-amber-700">
        {t('money.escrow.driftNote', { derived: formatKES(escrow.derived), projected: formatKES(escrow.projected) })}
      </span>
    </div>
  )
}

// ---------------- main tab ----------------

/** Mirrors the server bound (lib/money-bounds MAX_MONEY_KES) for friendly pre-flight errors. */
const MAX_SINGLE_MONEY_KES = 1_000_000_000

export function MoneyTab() {
  const { data, dispatch, online, outbox, viewMode, actionBusy, clientRole, shareToken, enqueuePendingNetwork } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const sessionRole = String(session?.user?.role ?? '')
  const busy = actionBusy !== null

  // W4-1: the immutable evidence pack of a released milestone, opened in the
  // DrawPackViewer (fetched read-only through the share token).
  const [packTarget, setPackTarget] = useState<DrawPackLink | null>(null)

  // W6-1: the milestone whose AI draw review is currently running (spinner
  // state for the "Run AI review" affordance; null when idle).
  const [aiReviewBusyId, setAiReviewBusyId] = useState<string | null>(null)

  // top-up dialog
  const [topupOpen, setTopupOpen] = useState(false)
  const [tAmount, setTAmount] = useState('')
  const [tMethod, setTMethod] = useState('mpesa')

  // milestone create dialog
  const [msOpen, setMsOpen] = useState(false)
  const [msName, setMsName] = useState('')
  const [msAmount, setMsAmount] = useState('')
  const [msPhase, setMsPhase] = useState('none')

  // evidence dialog
  const [evidenceTarget, setEvidenceTarget] = useState<MilestoneRow | null>(null)
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set())

  // request-release confirmation
  const [releaseTarget, setReleaseTarget] = useState<MilestoneRow | null>(null)

  // reject dialog (milestone or variation)
  const [rejectTarget, setRejectTarget] = useState<{ kind: 'milestone' | 'variation'; id: string; title: string } | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  // approve confirmation — releases escrow money / changes the budget; one
  // deliberate click (Reject already asks for a note; Approve gets a confirm)
  const [approveConfirm, setApproveConfirm] = useState<{ kind: 'milestone' | 'variation'; id: string; title: string; amount: number } | null>(null)

  // variation create dialog
  const [vOpen, setVOpen] = useState(false)
  const [vTitle, setVTitle] = useState('')
  const [vDesc, setVDesc] = useState('')
  const [vSign, setVSign] = useState<1 | -1>(1)
  const [vAmount, setVAmount] = useState('')
  const [vPhase, setVPhase] = useState('none')

  // payment request create dialog (F-MONEY)
  const [prOpen, setPrOpen] = useState(false)
  const [prDesc, setPrDesc] = useState('')
  const [prAmount, setPrAmount] = useState('')
  const [prPayee, setPrPayee] = useState('')
  const [prMethod, setPrMethod] = useState('mpesa')
  const [prLink, setPrLink] = useState('none')

  // payment request reject dialog
  const [prReject, setPrReject] = useState<PaymentRequestRow | null>(null)
  const [prNote, setPrNote] = useState('')

  // payment request approve confirm
  const [prApprove, setPrApprove] = useState<PaymentRequestRow | null>(null)

  const refPreview = useMemo(() => previewReference(tMethod), [topupOpen, tMethod])

  if (!data) return null
  const isClient = viewMode === 'client'
  const clientName = data.project.client
  // Stale persisted payloads (pre-F-MONEY) may lack the finance slice — fall
  // back to the empty slice until the next payload refresh lands.
  const finance = data.finance ?? EMPTY_FINANCE_SLICE
  // Real decider surfaces: a logged-in client-role user, or finance/admin
  // sessions. Share-link visitors are read-only for payment requests (their
  // allowlist covers milestones/variations), and contractors see the clearly
  // labelled "acting as client" demo flow — the server records the true actor.
  const isFinanceSession = !isClient && (sessionRole === 'finance' || sessionRole === 'admin')
  const isContractorActing = !isClient && !isFinanceSession
  const canDecideRequests = (isClient && clientRole && !shareToken) || isFinanceSession || isContractorActing

  const balance = data.escrow?.balance ?? 0
  const lockedAmount = data.milestones
    .filter((m) => LOCKED_STATUSES.includes(m.status))
    .reduce((s, m) => s + m.amount, 0)
  const releasedAmount = data.milestones
    .filter((m) => m.status === 'released')
    .reduce((s, m) => s + m.amount, 0)
  const pendingCount = data.milestones.filter((m) => m.status === 'release_requested').length

  // W4-1 draw packs: link rows ride on the payload (stale persisted payloads
  // pre-W4-1 may lack them — fall back to empty until the next refresh).
  const drawPacks = data.drawPacks ?? []
  const packFor = (milestoneId: string) => drawPacks.find((p) => p.milestoneId === milestoneId) ?? null
  // The token that serves the pack: the share-link session's own token, or
  // the project's token on owner/preview surfaces (the payload carries it).
  const packToken = shareToken ?? data.project.shareToken

  // W6-1: the AI surface is flag-gated (payload intel slice; stale persisted
  // payloads may lack it — fail closed to hidden). Clients never see the
  // trigger (they read notes through the pack viewer; running a review is
  // contractor/admin work, enforced server-side).
  const aiFlagOn = !isClient && data.intel?.flags?.ai === true

  /** Verdict label for toasts (the three sanitized values the parse emits). */
  const aiVerdictLabel = (verdict: string) =>
    t(verdict === 'consistent' || verdict === 'escalate' ? `aiReview.verdict.${verdict}` : 'aiReview.verdict.advisory')

  const photoById = (id: string) => data.photos.find((p) => p.id === id)
  const phaseName = (phaseId: string | null) =>
    phaseId ? data.phases.find((p) => p.id === phaseId)?.name ?? null : null

  const offlineNote = t('field.savedQueued', { count: outbox.length })

  // ---------------- handlers ----------------

  async function topUp() {
    const amount = Number(tAmount)
    if (!tAmount || Number.isNaN(amount) || amount <= 0) { toast.error(t('money.error.topupAmount')); return }
    if (amount > MAX_SINGLE_MONEY_KES) { toast.error(t('money.error.topupTooLarge')); return }
    const ok = await dispatch('escrow.topup', { amount, method: tMethod }, `Escrow top-up ${formatKES(amount)}`)
    if (ok) {
      toast.success(online ? t('money.topupOk', { amount: formatKES(amount) }) : offlineNote)
      setTopupOpen(false); setTAmount('')
    } else toast.error(t('money.topupFailed'))
  }

  async function createMilestone() {
    const amount = Number(msAmount)
    if (!msName.trim()) { toast.error(t('money.error.msName')); return }
    if (!msAmount || Number.isNaN(amount) || amount <= 0) { toast.error(t('money.error.msAmount')); return }
    const ok = await dispatch('milestone.create', {
      name: msName.trim(), amount, phaseId: msPhase === 'none' ? undefined : msPhase,
    }, `Milestone: ${msName.trim()}`)
    if (ok) {
      toast.success(online ? t('money.milestoneLocked', { name: msName.trim(), amount: formatKES(amount) }) : offlineNote)
      setMsOpen(false); setMsName(''); setMsAmount(''); setMsPhase('none')
    } else toast.error(t('money.milestoneFailed'))
  }

  async function attachEvidence() {
    if (!evidenceTarget) return
    if (!selectedPhotos.size) { toast.error(t('money.error.selectPhoto')); return }
    const ok = await dispatch('milestone.evidence', {
      id: evidenceTarget.id, photoIds: Array.from(selectedPhotos),
    }, `Evidence on ${evidenceTarget.name}`)
    if (ok) {
      toast.success(online ? t('money.evidenceAttached', { count: selectedPhotos.size, name: evidenceTarget.name }) : offlineNote)
      setEvidenceTarget(null)
    } else toast.error(t('money.evidenceFailed'))
  }

  async function requestRelease() {
    if (!releaseTarget) return
    const ok = await dispatch('milestone.requestRelease', { id: releaseTarget.id }, `Release request: ${releaseTarget.name}`)
    if (ok) {
      toast.success(online ? t('money.releaseRequested', { name: clientName }) : offlineNote)
      setReleaseTarget(null)
    } else toast.error(t('money.releaseFailed'))
  }

  async function decideMilestone(m: MilestoneRow, decision: 'approve' | 'reject') {
    // confirm: true (issue #172 / SEC-3r) — the SERVER demands this explicit
    // flag for money decisions dispatched from a share link (the dialog the
    // user just clicked through is the intent). Harmless extra field on the
    // session paths (client-role / owner), which the appliers ignore.
    const ok = await dispatch('milestone.decide', {
      id: m.id, decision, by: clientName, confirm: true,
      note: decision === 'reject' && rejectNote.trim() ? rejectNote.trim() : undefined,
    }, `Milestone ${decision}: ${m.name}`)
    if (ok) {
      toast.success(decision === 'approve'
        ? t('money.milestoneApproved', { amount: formatKES(m.amount) })
        : t('money.milestoneRejected', { name: m.name }))
      setRejectTarget(null); setRejectNote('')
      setApproveConfirm(null)
    } else {
      toast.error(decision === 'approve'
        ? t('money.approveFailed')
        : t('money.rejectFailed'))
    }
  }

  async function submitVariation() {
    const amount = Number(vAmount)
    if (!vTitle.trim() || !vDesc.trim()) { toast.error(t('money.error.varFields')); return }
    if (!vAmount || Number.isNaN(amount) || amount <= 0) { toast.error(t('money.error.varAmount')); return }
    const budgetImpact = vSign * amount
    const ok = await dispatch('variation.submit', {
      title: vTitle.trim(), description: vDesc.trim(), budgetImpact,
      phaseId: vPhase === 'none' ? undefined : vPhase,
    }, `Variation: ${vTitle.trim()}`)
    if (ok) {
      toast.success(online ? t('money.variationSubmitted', { name: clientName }) : offlineNote)
      setVOpen(false); setVTitle(''); setVDesc(''); setVAmount(''); setVPhase('none')
    } else toast.error(t('money.variationFailed'))
  }

  async function decideVariation(v: VariationRow, decision: 'approve' | 'reject') {
    // confirm: true (issue #172 / SEC-3r) — same gate as decideMilestone.
    const ok = await dispatch('variation.decide', {
      id: v.id, decision, by: clientName, confirm: true,
      note: decision === 'reject' && rejectNote.trim() ? rejectNote.trim() : undefined,
    }, `Variation ${decision}: ${v.title}`)
    if (ok) {
      toast.success(decision === 'approve'
        ? (v.budgetImpact >= 0 ? t('money.variationIncreased', { amount: formatKES(Math.abs(v.budgetImpact)) }) : t('money.variationReduced', { amount: formatKES(Math.abs(v.budgetImpact)) }))
        : t('money.variationRejected', { title: v.title }))
      setRejectTarget(null); setRejectNote('')
      setApproveConfirm(null)
    } else toast.error(t('money.decisionFailed'))
  }

  // ---------------- payment request handlers (F-MONEY) ----------------

  async function createPaymentRequest() {
    const amount = Number(prAmount)
    if (!prDesc.trim()) { toast.error(t('money.error.prDesc')); return }
    if (!prAmount || Number.isNaN(amount) || amount <= 0) { toast.error(t('money.error.prAmount')); return }
    if (!prPayee.trim()) { toast.error(t('money.error.prPayee')); return }
    const related: { relatedEntityType?: string; relatedEntityId?: string } = {}
    if (prLink !== 'none') {
      const [kind, id] = prLink.split(':')
      related.relatedEntityType = kind
      related.relatedEntityId = id
    }
    const ok = await dispatch('payment.request', {
      description: prDesc.trim(), amount, payee: prPayee.trim(), method: prMethod, ...related,
    }, `Payment request: ${formatKES(amount)} to ${prPayee.trim()}`)
    if (ok) {
      toast.success(online ? t('money.prSubmitted') : offlineNote)
      setPrOpen(false); setPrDesc(''); setPrAmount(''); setPrPayee(''); setPrMethod('mpesa'); setPrLink('none')
    } else toast.error(t('money.prFailed'))
  }

  async function decidePaymentRequest(pr: PaymentRequestRow, decision: 'approve' | 'reject', note?: string) {
    const ok = await dispatch('payment.decide', {
      id: pr.id, decision, note: note?.trim() || undefined,
    }, `Payment request ${decision}: ${pr.requestCode}`)
    if (ok) {
      toast.success(decision === 'approve'
        ? t('money.prApproved', { code: pr.requestCode, amount: formatKES(pr.amount) })
        : t('money.prRejected', { code: pr.requestCode }))
      setPrReject(null); setPrNote('')
      setPrApprove(null)
    } else {
      toast.error(t('money.prDecisionFailed'))
    }
  }

  // ---------------- W6-1: AI draw review ----------------

  /**
   * Run one advisory AI review of a released milestone's frozen draw pack.
   * Deliberately NOT the offline outbox path: the vision + LLM calls run
   * server-side against the provider, so an offline queue would only defer
   * a review of evidence that keeps moving — the honest state is "needs a
   * connection now". The direct /api/actions fetch (not dispatch()) is so
   * the honest server error — flag off, provider unavailable, provider
   * failure — reaches the toast verbatim instead of dying in a console.
   */
  async function runAiReview(m: MilestoneRow) {
    const pack = packFor(m.id)
    if (!pack) return
    if (!online) {
      toast.error(t('aiReview.needsOnline'))
      // #150: remember the intent — the refusal keeps its hard stop, the
      // worklist carries the reminder (remind-only; see use-mjengo #150).
      enqueuePendingNetwork({ kind: 'ai.drawReview', labelKey: 'netlist.kind.aiReview', context: { name: m.name }, tab: 'money' })
      return
    }
    const live = useMjengo.getState().data
    if (!live) return
    setAiReviewBusyId(m.id)
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ai.drawReview',
          payload: { drawPackId: pack.id },
          projectId: live.project.id,
        }),
      })
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean
        error?: string
        result?: { verdict?: string; findingsCount?: number }
      } | null
      if (res.ok && json?.ok && json.result) {
        toast.success(t('aiReview.runOk', {
          verdict: aiVerdictLabel(String(json.result.verdict ?? 'advisory')),
          count: json.result.findingsCount ?? 0,
        }))
        // Open the pack viewer — it fetches the pack fresh through the share
        // token, note included (latest wins).
        setPackTarget(pack)
      } else {
        // Honest failure states: flag off, pack not found, provider
        // unavailable, provider failure — the server message is the copy.
        const errText = typeof json?.error === 'string' && json.error.trim() ? json.error.trim() : t('aiReview.runFailedFallback')
        toast.error(`${t('aiReview.runFailed')} — ${errText}`)
      }
    } catch {
      toast.error(t('aiReview.runNetwork'))
    } finally {
      setAiReviewBusyId(null)
    }
  }

  async function payRequest(pr: PaymentRequestRow) {
    // Money action — online only; the fresh payload after dispatch carries the
    // ledger ref for the honest toast.
    if (!online) {
      toast.error(t('money.payNeedsOnline'))
      // #150: the hard stop keeps its honesty; the worklist keeps the memory
      // (a "remind me" entry, NOT a queued payment — the remind-only call).
      enqueuePendingNetwork({ kind: 'payment.pay', labelKey: 'netlist.kind.moneyPay', context: { code: pr.requestCode }, tab: 'money' })
      return
    }
    const ok = await dispatch('payment.pay', { id: pr.id }, `Pay ${pr.requestCode}`)
    if (ok) {
      const fresh = useMjengo.getState().data?.finance?.paymentRequests.find((p) => p.id === pr.id)
      const ledgerRef = fresh?.ledgerRef
      toast.success(ledgerRef
        ? t('money.prPaidRef', { code: pr.requestCode, amount: formatKES(pr.amount), payee: pr.payee, ref: ledgerRef })
        : t('money.prPaid', { code: pr.requestCode, amount: formatKES(pr.amount), payee: pr.payee }))
    } else {
      toast.error(t('money.payBlocked'))
    }
  }

  // ---------------- render ----------------

  return (
    <div className="space-y-6">
      {/* W4-1 print isolation — only #draw-pack-print-root is visible on paper */}
      <style>{`@media print { body * { visibility: hidden !important; } #draw-pack-print-root, #draw-pack-print-root * { visibility: visible !important; } #draw-pack-print-root { position: fixed !important; inset: 0 !important; overflow: visible !important; background: white !important; } }`}</style>

      {/* #123 (FE-2): simulated-rails posture at the SURFACE — persistent,
          dismissible per project, re-arms when the posture changes. The
          honest inline notes inside the dialogs stay exactly as they are. */}
      <WalletPostureBanner projectId={data.project.id} />

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label={t('money.kpiAria')}>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Wallet className="h-3.5 w-3.5" aria-hidden /> {t('money.kpi.escrow')}</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{formatKES(balance)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{t('money.kpi.escrowHeld', { name: data.project.name })}</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Lock className="h-3.5 w-3.5" aria-hidden /> {t('money.kpi.locked')}</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{formatKES(lockedAmount)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{t('money.kpi.lockedNote', { count: data.milestones.filter((m) => LOCKED_STATUSES.includes(m.status)).length })}</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Banknote className="h-3.5 w-3.5" aria-hidden /> {t('money.kpi.released')}</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{formatKES(releasedAmount)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{t('money.kpi.releasedNote')}</p></CardContent>
        </Card>
        <Card className={`shadow-sm ${pendingCount > 0 ? 'border-amber-300' : 'border-stone-200'}`}>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Hourglass className="h-3.5 w-3.5" aria-hidden /> {t('money.kpi.pending')}</CardDescription>
            <CardTitle className="text-2xl font-bold tabular-nums text-stone-900">{pendingCount}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{t('money.kpi.pendingNote', { name: clientName })}</p></CardContent>
        </Card>
      </section>

      {/* Escrow wallet card */}
      <Card className="border-stone-800 bg-stone-950 text-stone-50 shadow-md">
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> {t('money.wallet.title')}
            </p>
            <p className="pt-1 text-4xl font-bold tabular-nums text-stone-50">{formatKES(balance)}</p>
            <p className="pt-1.5 text-xs text-stone-400">
              {t('money.wallet.note')}
            </p>
          </div>
          {!isClient && (
            <Button
              onClick={() => setTopupOpen(true)}
              disabled={busy}
              className="min-h-11 gap-1.5 bg-amber-500 text-base font-semibold text-stone-950 hover:bg-amber-400"
              aria-label={t('money.wallet.topupAria')}
            >
              <Plus className="h-4 w-4" aria-hidden /> {t('money.wallet.topup')}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Milestones */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900">{t('money.milestones.title')}</CardTitle>
            <CardDescription>
              {t('money.milestones.desc')}
            </CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setMsOpen(true)} aria-label={t('money.milestones.newAria')}>
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('money.milestones.new')}</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.milestones.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <Lock className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">{t('money.milestones.empty')}</p>
              <p className="pt-1 text-xs text-stone-500">{t('money.milestones.emptyDesc')}</p>
              {!isClient && (
                <Button size="sm" className="mt-4 min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" onClick={() => setMsOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> {t('money.milestones.create')}
                </Button>
              )}
            </div>
          ) : (
            <div className="max-h-96 space-y-4 overflow-y-auto pr-2 -mr-2" role="region" aria-label={t('money.milestones.regionAria')}>
              {data.milestones.map((m) => {
                const evidence = parseEvidenceIds(m.evidencePhotoIds)
                const phName = phaseName(m.phaseId)
                const awaiting = m.status === 'release_requested'
                const canAttach = !isClient && ['locked', 'evidence_submitted'].includes(m.status)
                const canRequest = !isClient && m.status === 'evidence_submitted'
                const insufficient = awaiting && balance < m.amount
                return (
                  <div
                    key={m.id}
                    className={`rounded-lg border bg-white p-4 ${awaiting ? 'border-amber-300' : 'border-stone-200'}`}
                  >
                    <div className="grid gap-4 md:grid-cols-[190px minmax(0,1fr)]">
                      <MilestoneStepper m={m} />
                      <div className="min-w-0 space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-stone-900">{m.name}</p>
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              {phName && <Badge variant="outline" className="text-[10px]">{phName}</Badge>}
                              <span className="text-xs text-stone-400">{t('money.milestones.created', { date: dateShort(m.createdAt) })}</span>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <span className="text-base font-bold tabular-nums text-stone-900">{formatKES(m.amount)}</span>
                            <MilestoneStatusBadge status={m.status} />
                          </div>
                        </div>

                        {/* decision history */}
                        {m.decidedBy && (
                          <p className={`rounded-md px-2.5 py-1.5 text-xs ${m.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                            {m.status === 'rejected' ? t('money.rejectedBy', { name: m.decidedBy }) : t('money.decidedBy', { name: m.decidedBy })}
                            {m.decidedAt ? ` · ${dateShort(m.decidedAt)}` : ''}
                            {m.decisionNote ? ` — “${m.decisionNote}”` : ''}
                          </p>
                        )}

                        {/* W4-1: the immutable evidence pack of this release —
                            the frozen bundle a diaspora client keeps/forwards,
                            served read-only through the share token. */}
                        {m.status === 'released' && packFor(m.id) && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11 gap-1.5 border-amber-200 bg-amber-50/50 text-amber-900 hover:bg-amber-50 hover:text-amber-900"
                              onClick={() => setPackTarget(packFor(m.id))}
                              aria-label={t('drawPack.aria', { milestone: m.name })}
                            >
                              <FileCheck2 className="h-4 w-4" aria-hidden /> {t('drawPack.view')}
                              <span className="hidden font-mono text-[10px] text-amber-700 sm:inline">
                                {formatKES(packFor(m.id)!.amount)} · {packFor(m.id)!.ledgerRef}
                              </span>
                            </Button>
                            {/* W6-1: run the advisory AI review of this frozen
                                pack — hidden when the ai flag is off (or the
                                viewer is a client surface); the server refuses
                                honestly regardless. */}
                            {aiFlagOn && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="min-h-11 gap-1.5"
                                disabled={busy || aiReviewBusyId === m.id}
                                onClick={() => void runAiReview(m)}
                                aria-label={t('aiReview.runAria', { milestone: m.name })}
                                data-testid={`run-ai-review-${m.id}`}
                              >
                                {aiReviewBusyId === m.id
                                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                  : <Sparkles className="h-4 w-4" aria-hidden />}
                                {aiReviewBusyId === m.id ? t('aiReview.running') : t('aiReview.run')}
                              </Button>
                            )}
                          </div>
                        )}

                        {/* evidence photos */}
                        <div>
                          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{t('money.milestones.evidence', { count: evidence.length })}</p>
                          {evidence.length === 0 ? (
                            <p className="pt-1 text-xs text-stone-400">{t('money.milestones.noEvidence')}</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5 pt-1.5">
                              {evidence.map((pid) => <EvidenceThumb key={pid} photo={photoById(pid)} />)}
                            </div>
                          )}
                        </div>

                        {/* owner actions */}
                        {(canAttach || canRequest) && (
                          <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                            {canAttach && (
                              <Button
                                size="sm" variant="outline" className="min-h-11 gap-1.5"
                                onClick={() => { setEvidenceTarget(m); setSelectedPhotos(new Set(evidence)) }}
                                aria-label={t('money.milestones.attachAria', { name: m.name })}
                              >
                                <Camera className="h-4 w-4" aria-hidden /> {evidence.length ? t('money.milestones.attachMore') : t('money.milestones.attach')}
                              </Button>
                            )}
                            {canRequest && (
                              <Button
                                size="sm"
                                className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
                                disabled={busy || evidence.length === 0}
                                title={evidence.length === 0 ? t('money.milestones.attachFirstTitle') : undefined}
                                onClick={() => setReleaseTarget(m)}
                                aria-label={t('money.milestones.requestAria', { amount: formatKES(m.amount), name: m.name })}
                              >
                                <Send className="h-4 w-4" aria-hidden /> {t('money.milestones.request')}
                              </Button>
                            )}
                          </div>
                        )}

                        {/* client decision panel — F3: only the CLIENT decides.
                            The owner view shows the honest wait state instead of
                            acting-as-client buttons (the server rejects them). */}
                        {awaiting && isClient && (
                          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                              {t('money.milestones.clientDecides', { name: clientName })}
                            </p>
                            <p className="text-xs text-stone-600">
                              {t('money.milestones.escrowLabel')}: <span className="font-semibold tabular-nums">{formatKES(balance)}</span>
                              {' '}· {t('money.milestones.releaseLabel')}: <span className="font-semibold tabular-nums">{formatKES(m.amount)}</span>
                              {insufficient && (
                                <Badge className="ml-2 border-0 bg-rose-100 text-rose-800 hover:bg-rose-100">{t('money.milestones.insufficient')}</Badge>
                              )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm" className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                                disabled={busy || insufficient}
                                onClick={() => setApproveConfirm({ kind: 'milestone', id: m.id, title: m.name, amount: m.amount })}
                                aria-label={t('money.milestones.approveAria', { amount: formatKES(m.amount), name: m.name })}
                              >
                                <Check className="h-4 w-4" aria-hidden /> {t('money.milestones.approve')}
                              </Button>
                              <Button
                                size="sm" variant="outline" className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                                disabled={busy}
                                onClick={() => { setRejectTarget({ kind: 'milestone', id: m.id, title: m.name }); setRejectNote('') }}
                                aria-label={t('money.milestones.rejectAria', { name: m.name })}
                              >
                                <X className="h-4 w-4" aria-hidden /> {t('money.rejectWithNote')}
                              </Button>
                            </div>
                          </div>
                        )}
                        {awaiting && !isClient && (
                          <p className="rounded-md bg-stone-50 px-2.5 py-1.5 text-xs text-stone-500">
                            <Hourglass className="mr-1 inline h-3.5 w-3.5 text-amber-600" aria-hidden />
                            {t('money.awaitingOwner', { name: clientName })}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Variations */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900"><TrendingUp className="h-5 w-5 text-amber-600" aria-hidden /> {t('money.variations.title')}</CardTitle>
            <CardDescription>{t('money.variations.desc')}</CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setVOpen(true)} aria-label={t('money.variations.newAria')}>
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('money.variations.new')}</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.variations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <TrendingUp className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">{t('money.variations.empty')}</p>
              <p className="pt-1 text-xs text-stone-500">{t('money.variations.emptyDesc')}</p>
            </div>
          ) : (
            <div className="max-h-96 space-y-3 overflow-y-auto pr-2 -mr-2" role="region" aria-label={t('money.variations.regionAria')}>
              {data.variations.map((v) => {
                const positive = v.budgetImpact >= 0
                const phName = phaseName(v.phaseId)
                return (
                  <div key={v.id} className="rounded-lg border border-stone-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-stone-900">{v.title}</p>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {phName && <Badge variant="outline" className="text-[10px]">{phName}</Badge>}
                          <span className="text-xs text-stone-400">
                            {v.submittedBy ? `${t('money.byLine', { name: v.submittedBy })} · ` : ''}{dateShort(v.createdAt)}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className={`text-sm font-bold tabular-nums ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {positive ? '+' : '−'}{formatKES(Math.abs(v.budgetImpact))}
                        </span>
                        <VariationStatusBadge status={v.status} />
                      </div>
                    </div>
                    <p className="pt-2 text-xs leading-relaxed text-stone-600">{v.description}</p>
                    {v.decidedBy && (
                      <p className={`mt-2 rounded-md px-2.5 py-1.5 text-xs ${v.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                        {v.status === 'rejected' ? t('money.rejectedBy', { name: v.decidedBy }) : t('money.approvedBy', { name: v.decidedBy })}
                        {v.decidedAt ? ` · ${dateShort(v.decidedAt)}` : ''}
                        {v.decisionNote ? ` — “${v.decisionNote}”` : ''}
                      </p>
                    )}
                    {v.status === 'submitted' && isClient && (
                      <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                          {t('money.variations.clientDecides', { name: clientName })}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm" className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                            disabled={busy}
                            onClick={() => setApproveConfirm({ kind: 'variation', id: v.id, title: v.title, amount: v.budgetImpact })}
                            aria-label={t('money.variations.approveAria', { title: v.title })}
                          >
                            <Check className="h-4 w-4" aria-hidden /> {t('money.approve')}
                          </Button>
                          <Button
                            size="sm" variant="outline" className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                            disabled={busy}
                            onClick={() => { setRejectTarget({ kind: 'variation', id: v.id, title: v.title }); setRejectNote('') }}
                            aria-label={t('money.variations.rejectAria', { title: v.title })}
                          >
                            <X className="h-4 w-4" aria-hidden /> {t('money.rejectWithNote')}
                          </Button>
                        </div>
                      </div>
                    )}
                    {v.status === 'submitted' && !isClient && (
                      <p className="mt-3 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs text-stone-500">
                        <Hourglass className="mr-1 inline h-3.5 w-3.5 text-amber-600" aria-hidden />
                        {t('money.awaitingOwner', { name: clientName })}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment requests — request → approval → payment, every payout ledgered (F-MONEY) */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
              <Banknote className="h-5 w-5 text-amber-600" aria-hidden /> {t('money.pr.title')}
              {finance.paymentRequests.length > 0 && (
                <Badge className="border-0 bg-stone-100 text-stone-600">{finance.paymentRequests.length}</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {t('money.pr.desc', {
                budget: formatKES(finance.budget),
                committed: formatKES(finance.committed),
                spent: formatKES(finance.spent),
                remaining: formatKES(finance.remaining),
              })}
            </CardDescription>
          </div>
          {!isClient && (
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setPrOpen(true)} aria-label={t('money.pr.newAria')}>
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('money.pr.new')}</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {finance.paymentRequests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <Banknote className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">{t('money.pr.empty')}</p>
              <p className="pt-1 text-xs text-stone-500">
                {t('money.pr.emptyDesc')}
              </p>
            </div>
          ) : (
            <div className="max-h-96 space-y-3 overflow-y-auto pr-2 -mr-2" role="region" aria-label={t('money.pr.regionAria')}>
              {finance.paymentRequests.map((pr) => {
                const relatedLabel =
                  pr.relatedEntityType === 'milestone'
                    ? data.milestones.find((m) => m.id === pr.relatedEntityId)?.name ?? null
                    : pr.relatedEntityType === 'invoice'
                      ? data.invoices.invoices.find((i) => i.id === pr.relatedEntityId)?.invoiceCode ?? null
                      : null
                const methodKey = PR_METHODS.find((m) => m.value === pr.method)?.key
                const methodLabel = methodKey ? t(methodKey) : pr.method
                return (
                  <div key={pr.id} className={`rounded-lg border bg-white p-4 ${pr.status === 'pending' ? 'border-amber-300' : 'border-stone-200'}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-900">
                          <span className="font-mono text-xs text-stone-500">{pr.requestCode}</span>
                          <span className="truncate">{pr.description}</span>
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <span className="text-xs text-stone-500">{t('money.pr.to', { payee: pr.payee })}</span>
                          <Badge variant="outline" className="text-[10px]">{methodLabel}</Badge>
                          {relatedLabel && <Badge variant="outline" className="text-[10px]">↔ {relatedLabel}</Badge>}
                          <span className="text-xs text-stone-400">{t('money.byLine', { name: pr.requestedByName })} · {dateShort(pr.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="text-base font-bold tabular-nums text-stone-900">{formatKES(pr.amount)}</span>
                        <PaymentRequestStatusBadge status={pr.status} />
                      </div>
                    </div>

                    {/* decision history */}
                    {pr.decidedBy && (
                      <p className={`mt-2 rounded-md px-2.5 py-1.5 text-xs ${pr.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                        {pr.status === 'rejected' ? t('money.rejectedBy', { name: pr.decidedBy }) : t('money.approvedBy', { name: pr.decidedBy })}
                        {pr.decidedAt ? ` · ${dateShort(pr.decidedAt)}` : ''}
                        {pr.decisionNote ? ` — “${pr.decisionNote}”` : ''}
                      </p>
                    )}

                    {/* ledger column — the payment's double-entry reference */}
                    {(pr.status === 'paid' || pr.ledgerRef) && (
                      <p className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs text-stone-500">
                        <BookOpen className="h-3.5 w-3.5 text-stone-400" aria-hidden />
                        {t('money.pr.ledger')} <span className="font-mono font-medium text-stone-700">{pr.ledgerRef ?? '—'}</span>
                        {pr.paidAt ? ` · ${t('money.pr.paidOn', { date: dateShort(pr.paidAt) })}` : ''}
                      </p>
                    )}

                    {/* decision panel (role-appropriate) */}
                    {pr.status === 'pending' && (
                      <div className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                          {isClient && clientRole
                            ? t('money.pr.yourDecision', { name: clientName })
                            : isFinanceSession
                              ? t('money.pr.financeQueue')
                              : t('money.pr.actingAsClient')}
                        </p>
                        {canDecideRequests ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm" className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                              disabled={busy}
                              onClick={() => setPrApprove(pr)}
                              aria-label={t('money.pr.approveAria', { code: pr.requestCode })}
                            >
                              <Check className="h-4 w-4" aria-hidden /> {t('money.approve')}
                            </Button>
                            <Button
                              size="sm" variant="outline" className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                              disabled={busy}
                              onClick={() => { setPrReject(pr); setPrNote('') }}
                              aria-label={t('money.pr.rejectAria', { code: pr.requestCode })}
                            >
                              <X className="h-4 w-4" aria-hidden /> {t('money.rejectWithNote')}
                            </Button>
                          </div>
                        ) : (
                          <p className="text-xs text-stone-500">
                            {t('money.pr.clientDecides', { name: clientName })}
                          </p>
                        )}
                      </div>
                    )}

                    {/* pay action for approved requests */}
                    {pr.status === 'approved' && canDecideRequests && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
                        <Button
                          size="sm" className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
                          disabled={busy || (pr.method === 'wallet' && balance < pr.amount)}
                          onClick={() => void payRequest(pr)}
                          aria-label={t('money.pr.payAria', { amount: formatKES(pr.amount), code: pr.requestCode })}
                        >
                          <Banknote className="h-4 w-4" aria-hidden /> {t('money.pr.pay', { amount: formatKES(pr.amount) })}
                        </Button>
                        {pr.method === 'wallet' && balance < pr.amount && (
                          <Badge className="border-0 bg-rose-100 text-rose-800 hover:bg-rose-100">{t('money.milestones.insufficient')}</Badge>
                        )}
                        <span className="text-[11px] text-stone-400">
                          {t('money.pr.simulatedNote')}
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ledger — the double-entry source of truth (spec §39, F-MONEY) */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <BookOpen className="h-5 w-5 text-stone-700" aria-hidden /> {t('money.ledger.title')}
            <Badge variant="outline" className="text-[10px] font-mono">{t('money.ledger.recent', { count: finance.ledger.transactions.length })}</Badge>
          </CardTitle>
          <CardDescription>
            {t('money.ledger.desc')}
          </CardDescription>
          <div className="pt-2">
            {finance.escrow ? (
              <EscrowConsistencyChip escrow={finance.escrow} />
            ) : (
              <span className="text-[11px] text-stone-400">{t('money.ledger.noEscrow')}</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {finance.ledger.transactions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <BookOpen className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">{t('money.ledger.empty')}</p>
              <p className="pt-1 text-xs text-stone-500">{t('money.ledger.emptyDesc')}</p>
            </div>
          ) : (
            <div className="max-h-96 space-y-3 overflow-y-auto pr-2 -mr-2" role="region" aria-label={t('money.ledger.regionAria')}>
              {finance.ledger.transactions.map((txn) => {
                const debits = txn.entries.filter((e) => e.side === 'debit')
                const credits = txn.entries.filter((e) => e.side === 'credit')
                const debitTotal = debits.reduce((s, e) => s + e.amount, 0)
                const creditTotal = credits.reduce((s, e) => s + e.amount, 0)
                const balanced = Math.abs(debitTotal - creditTotal) < 1
                return (
                  <div key={txn.id} className="rounded-lg border border-stone-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-stone-900">
                          <span className="font-mono text-xs text-stone-500">{txn.ref}</span>
                          <span className="truncate">{txn.description}</span>
                        </p>
                        <p className="pt-0.5 text-xs text-stone-400">
                          {dateShort(txn.occurredAt)} · {t('money.ledger.postedBy', { name: txn.postedBy, role: txn.postedRole })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {txn.status === 'reversed' && (
                          <Badge className="border-0 bg-stone-200 text-stone-700 hover:bg-stone-200">{txn.reversalOfRef ? t('money.ledger.reversedBy', { ref: txn.reversalOfRef }) : t('money.ledger.reversed')}</Badge>
                        )}
                        <Badge className={`border-0 gap-1 ${balanced ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : 'bg-rose-100 text-rose-800 hover:bg-rose-100'}`}>
                          <CheckCheck className="h-3 w-3" aria-hidden /> {balanced ? t('money.ledger.balanced') : t('money.ledger.unbalanced')}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      <div className="rounded-md bg-rose-50/60 px-2.5 py-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-700">{t('money.ledger.debits', { total: formatKES(debitTotal) })}</p>
                        {debits.map((e, i) => (
                          <p key={i} className="text-xs text-stone-600"><span className="font-mono text-[10px] text-stone-500">{e.accountCode}</span> {formatKES(e.amount)}</p>
                        ))}
                      </div>
                      <div className="rounded-md bg-emerald-50/60 px-2.5 py-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">{t('money.ledger.credits', { total: formatKES(creditTotal) })}</p>
                        {credits.map((e, i) => (
                          <p key={i} className="text-xs text-stone-600"><span className="font-mono text-[10px] text-stone-500">{e.accountCode}</span> {formatKES(e.amount)}</p>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <p className="pt-3 text-[11px] text-stone-400">
            {t('money.ledger.accounts', { list: finance.ledger.accounts.map((a) => `${a.code} (${formatKES(a.balance)})`).join(' · ') || t('money.ledger.noneYet') })}
          </p>
        </CardContent>
      </Card>

      {/* ---------------- Top-up dialog ---------------- */}
      <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.topup.title')}</DialogTitle>
            <DialogDescription>{t('money.topup.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="topup-amount">{t('money.topup.amount')}</Label>
              <Input id="topup-amount" type="number" min="1" max={MAX_SINGLE_MONEY_KES} value={tAmount} onChange={(e) => setTAmount(e.target.value)} placeholder={t('money.topup.ph')} inputMode="numeric" />
              {Number(tAmount) > 0 && (
                <p className="text-xs text-stone-500">
                  {t('money.topup.preview', { amount: formatKES(Number(tAmount)), balance: formatKES(balance + Number(tAmount)) })}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('money.topup.method')}</Label>
              <RadioGroup value={tMethod} onValueChange={setTMethod} className="grid grid-cols-3 gap-2" aria-label={t('money.topup.methodAria')}>
                {[
                  { value: 'mpesa', label: t('money.topup.mpesa') },
                  { value: 'bank', label: t('money.topup.bank') },
                  { value: 'card', label: t('money.topup.card') },
                ].map((opt) => (
                  <label
                    key={opt.value}
                    htmlFor={`method-${opt.value}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-3 text-sm text-stone-700 transition has-[[data-state=checked]]:border-amber-500 has-[[data-state=checked]]:bg-amber-50"
                  >
                    <RadioGroupItem value={opt.value} id={`method-${opt.value}`} />
                    {opt.label}
                  </label>
                ))}
              </RadioGroup>
            </div>
            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              {t('money.topup.note', { ref: refPreview })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopupOpen(false)}>{t('money.cancel')}</Button>
            <Button onClick={() => void topUp()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Plus className="h-4 w-4" aria-hidden /> {t('money.wallet.topup')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- New milestone dialog ---------------- */}
      <Dialog open={msOpen} onOpenChange={setMsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.ms.title')}</DialogTitle>
            <DialogDescription>{t('money.ms.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="ms-name">{t('money.ms.name')}</Label>
              <Input id="ms-name" value={msName} onChange={(e) => setMsName(e.target.value)} placeholder={t('money.ms.namePh')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ms-amount">{t('money.topup.amount')}</Label>
              <Input id="ms-amount" type="number" min="1" value={msAmount} onChange={(e) => setMsAmount(e.target.value)} placeholder={t('money.topup.ph')} inputMode="numeric" />
              {Number(msAmount) > 0 && (
                <p className="text-xs text-stone-500">{t('money.ms.lockPreview', { amount: formatKES(Number(msAmount)) })}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('money.ms.phase')}</Label>
              <Select value={msPhase} onValueChange={setMsPhase}>
                <SelectTrigger aria-label={t('money.ms.phaseAria')}><SelectValue placeholder={t('mat.ph.optional')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('money.ms.noPhase')}</SelectItem>
                  {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMsOpen(false)}>{t('money.cancel')}</Button>
            <Button onClick={() => void createMilestone()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Plus className="h-4 w-4" aria-hidden /> {t('money.milestones.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Attach evidence dialog ---------------- */}
      <Dialog open={evidenceTarget !== null} onOpenChange={(open) => { if (!open) setEvidenceTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.ev.title')}</DialogTitle>
            <DialogDescription>
              {evidenceTarget ? t('money.ev.desc', { name: evidenceTarget.name }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            {data.photos.length === 0 ? (
              <p className="rounded-md bg-stone-50 p-3 text-xs text-stone-500">{t('money.ev.noPhotos')}</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-2" role="region" aria-label={t('money.ev.photosAria')}>
                {data.photos.map((p) => {
                  const checked = selectedPhotos.has(p.id)
                  return (
                    <label
                      key={p.id}
                      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-2 transition ${checked ? 'border-amber-500 bg-amber-50' : 'border-stone-200 hover:border-stone-300'}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const next = new Set(selectedPhotos)
                          if (v) next.add(p.id); else next.delete(p.id)
                          setSelectedPhotos(next)
                        }}
                        aria-label={t('money.ev.selectAria', { caption: p.caption ?? t('money.ev.sitePhoto') })}
                      />
                      <img src={p.url} alt="" className="h-11 w-11 shrink-0 rounded-md border border-stone-200 object-cover" loading="lazy" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-stone-800">{p.caption ?? t('money.ev.sitePhoto')}</span>
                        <span className="block text-[11px] text-stone-400">{p.phaseName ?? t('money.ev.noPhase')} · {dateShort(p.createdAt)}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-stone-400">{t('money.ev.selected', { count: selectedPhotos.size })}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvidenceTarget(null)}>{t('money.cancel')}</Button>
            <Button onClick={() => void attachEvidence()} disabled={busy || selectedPhotos.size === 0} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Camera className="h-4 w-4" aria-hidden /> {selectedPhotos.size > 0 ? t('money.ev.attachCount', { count: selectedPhotos.size }) : t('money.ev.attach')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Request release confirmation ---------------- */}
      <Dialog open={releaseTarget !== null} onOpenChange={(open) => { if (!open) setReleaseTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.rel.title')}</DialogTitle>
            <DialogDescription>
              {releaseTarget
                ? t('money.rel.desc', { name: releaseTarget.name, amount: formatKES(releaseTarget.amount), client: clientName })
                : ''}
            </DialogDescription>
          </DialogHeader>
          {releaseTarget && (
            <div className="grid gap-4 py-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                  {t('money.rel.evidence', { count: parseEvidenceIds(releaseTarget.evidencePhotoIds).length })}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {parseEvidenceIds(releaseTarget.evidencePhotoIds).map((pid) => (
                    <EvidenceThumb key={pid} photo={photoById(pid)} />
                  ))}
                </div>
              </div>
              <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                {t('money.rel.note', { client: clientName })}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseTarget(null)}>{t('money.cancel')}</Button>
            <Button onClick={() => void requestRelease()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Send className="h-4 w-4" aria-hidden /> {t('money.milestones.request')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Reject-with-note dialog (milestone / variation) ---------------- */}
      <Dialog open={rejectTarget !== null} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.rej.title')}</DialogTitle>
            <DialogDescription>
              {rejectTarget?.kind === 'milestone'
                ? t('money.rej.msDesc', { title: rejectTarget?.title ?? '' })
                : t('money.rej.varDesc', { title: rejectTarget?.title ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reject-note">{t('money.rej.note')}</Label>
              <Textarea id="reject-note" rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder={t('money.rej.notePh')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>{t('money.cancel')}</Button>
            <Button
              onClick={() => {
                if (!rejectTarget) return
                const m = data.milestones.find((x) => x.id === rejectTarget.id)
                const v = data.variations.find((x) => x.id === rejectTarget.id)
                if (rejectTarget.kind === 'milestone' && m) void decideMilestone(m, 'reject')
                if (rejectTarget.kind === 'variation' && v) void decideVariation(v, 'reject')
              }}
              disabled={busy}
              className="min-h-11 gap-1.5 border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              variant="outline"
            >
              <X className="h-4 w-4" aria-hidden /> {t('money.rej.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Approve confirmation (milestone release / variation) ---------------- */}
      <Dialog open={approveConfirm !== null} onOpenChange={(open) => { if (!open) setApproveConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">
              {approveConfirm?.kind === 'milestone' ? t('money.appr.msTitle') : t('money.appr.varTitle')}
            </DialogTitle>
            <DialogDescription>
              {approveConfirm?.kind === 'milestone'
                ? t('money.appr.msDesc', { amount: formatKES(approveConfirm.amount), title: approveConfirm.title })
                : approveConfirm
                  ? (approveConfirm.amount >= 0
                      ? t('money.appr.varIncrease', { amount: formatKES(Math.abs(approveConfirm.amount)), title: approveConfirm.title })
                      : t('money.appr.varReduce', { amount: formatKES(Math.abs(approveConfirm.amount)), title: approveConfirm.title }))
                  : ''}
            </DialogDescription>
          </DialogHeader>
          <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
            {t('money.appr.note')}
          </p>
          {/* Issue #172 (SEC-3r): on the share-link surface this confirmation
              dialog is exactly what the server's confirm flag demands — say
              so, so the step reads as security, not friction. Owner/
              client-role sessions never see the line. */}
          {Boolean(shareToken) && (
            <p className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">
              <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('money.appr.shareNote')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveConfirm(null)}>{t('money.cancel')}</Button>
            <Button
              onClick={() => {
                if (!approveConfirm) return
                const m = approveConfirm.kind === 'milestone' ? data.milestones.find((x) => x.id === approveConfirm.id) : undefined
                const v = approveConfirm.kind === 'variation' ? data.variations.find((x) => x.id === approveConfirm.id) : undefined
                if (m) void decideMilestone(m, 'approve')
                if (v) void decideVariation(v, 'approve')
              }}
              disabled={busy}
              className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Check className="h-4 w-4" aria-hidden /> {t('money.appr.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- New variation dialog ---------------- */}
      <Dialog open={vOpen} onOpenChange={setVOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.var.title')}</DialogTitle>
            <DialogDescription>{t('money.var.desc', { client: clientName })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="v-title">{t('money.var.titleLabel')}</Label>
              <Input id="v-title" value={vTitle} onChange={(e) => setVTitle(e.target.value)} placeholder={t('money.var.titlePh')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-desc">{t('money.var.descLabel')}</Label>
              <Textarea id="v-desc" rows={3} value={vDesc} onChange={(e) => setVDesc(e.target.value)} placeholder={t('money.var.descPh')} />
            </div>
            <div className="space-y-2">
              <Label>{t('money.var.impact')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button" variant="outline"
                  className={`min-h-11 gap-1.5 ${vSign === 1 ? 'border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-50' : 'text-stone-600'}`}
                  onClick={() => setVSign(1)} aria-pressed={vSign === 1} aria-label={t('money.var.extraAria')}
                >
                  <Plus className="h-4 w-4" aria-hidden /> {t('money.var.extraCost')}
                </Button>
                <Button
                  type="button" variant="outline"
                  className={`min-h-11 gap-1.5 ${vSign === -1 ? 'border-rose-500 bg-rose-50 text-rose-700 hover:bg-rose-50' : 'text-stone-600'}`}
                  onClick={() => setVSign(-1)} aria-pressed={vSign === -1} aria-label={t('money.var.savingAria')}
                >
                  <Minus className="h-4 w-4" aria-hidden /> {t('money.var.saving')}
                </Button>
              </div>
              <Input
                id="v-amount" type="number" min="1" value={vAmount}
                onChange={(e) => setVAmount(e.target.value)} placeholder={t('money.var.amountPh')} inputMode="numeric"
                aria-label={t('money.var.amountAria')}
              />
              {Number(vAmount) > 0 && (
                <p className={`text-xs font-medium ${vSign === 1 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {t('money.var.impactPreview', { sign: vSign === 1 ? '+' : '−', amount: formatKES(Number(vAmount)) })}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('money.ms.phase')}</Label>
              <Select value={vPhase} onValueChange={setVPhase}>
                <SelectTrigger aria-label={t('money.ms.phaseAria')}><SelectValue placeholder={t('mat.ph.optional')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('money.ms.noPhase')}</SelectItem>
                  {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVOpen(false)}>{t('money.cancel')}</Button>
            <Button onClick={() => void submitVariation()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Send className="h-4 w-4" aria-hidden /> {t('money.var.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- New payment request dialog (F-MONEY) ---------------- */}
      <Dialog open={prOpen} onOpenChange={setPrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.prDlg.title')}</DialogTitle>
            <DialogDescription>
              {t('money.prDlg.desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="pr-desc">{t('money.prDlg.what')}</Label>
              <Input id="pr-desc" value={prDesc} onChange={(e) => setPrDesc(e.target.value)} placeholder={t('money.prDlg.whatPh')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pr-amount">{t('money.topup.amount')}</Label>
                <Input id="pr-amount" type="number" min="1" value={prAmount} onChange={(e) => setPrAmount(e.target.value)} placeholder={t('money.prDlg.amountPh')} inputMode="numeric" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pr-payee">{t('money.prDlg.payee')}</Label>
                <Input id="pr-payee" value={prPayee} onChange={(e) => setPrPayee(e.target.value)} placeholder={t('money.prDlg.payeePh')} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('money.topup.method')}</Label>
              <Select value={prMethod} onValueChange={setPrMethod}>
                <SelectTrigger aria-label={t('money.topup.methodAria')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PR_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{t(m.key)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('money.prDlg.link')}</Label>
              <Select value={prLink} onValueChange={setPrLink}>
                <SelectTrigger aria-label={t('money.prDlg.linkAria')}><SelectValue placeholder={t('money.prDlg.noLink')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('money.prDlg.noLink')}</SelectItem>
                  {data.milestones.map((m) => (
                    <SelectItem key={`milestone:${m.id}`} value={`milestone:${m.id}`}>{t('money.prDlg.milestone', { name: m.name })}</SelectItem>
                  ))}
                  {data.invoices.invoices.map((i) => (
                    <SelectItem key={`invoice:${i.id}`} value={`invoice:${i.id}`}>{t('money.prDlg.invoice', { code: i.invoiceCode })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              {t('money.prDlg.note')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrOpen(false)}>{t('money.cancel')}</Button>
            <Button onClick={() => void createPaymentRequest()} disabled={busy} className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700">
              <Plus className="h-4 w-4" aria-hidden /> {t('money.prDlg.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- PR reject with note ---------------- */}
      <Dialog open={prReject !== null} onOpenChange={(open) => { if (!open) setPrReject(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.prRej.title')}</DialogTitle>
            <DialogDescription>
              {prReject ? t('money.prRej.desc', { code: prReject.requestCode, amount: formatKES(prReject.amount), payee: prReject.payee }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="pr-note">{t('money.prRej.note')}</Label>
              <Textarea id="pr-note" rows={3} value={prNote} onChange={(e) => setPrNote(e.target.value)} placeholder={t('money.prRej.notePh')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrReject(null)}>{t('money.cancel')}</Button>
            <Button
              onClick={() => { if (prReject) void decidePaymentRequest(prReject, 'reject', prNote) }}
              disabled={busy}
              className="min-h-11 gap-1.5 border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              variant="outline"
            >
              <X className="h-4 w-4" aria-hidden /> {t('money.rej.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- PR approve confirmation ---------------- */}
      <Dialog open={prApprove !== null} onOpenChange={(open) => { if (!open) setPrApprove(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('money.prAppr.title')}</DialogTitle>
            <DialogDescription>
              {prApprove ? t('money.prAppr.desc', { amount: formatKES(prApprove.amount), payee: prApprove.payee, code: prApprove.requestCode }) : ''}
            </DialogDescription>
          </DialogHeader>
          <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
            {t('money.prAppr.note')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrApprove(null)}>{t('money.cancel')}</Button>
            <Button
              onClick={() => { if (prApprove) void decidePaymentRequest(prApprove, 'approve') }}
              disabled={busy}
              className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Check className="h-4 w-4" aria-hidden /> {t('money.appr.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- W4-1: evidence draw pack viewer ---------------- */}
      {packTarget && packToken && (
        <DrawPackViewer
          open
          onClose={() => setPackTarget(null)}
          packId={packTarget.id}
          shareToken={packToken}
          milestoneName={packTarget.milestoneName}
        />
      )}
    </div>
  )
}
