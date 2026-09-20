'use client'

// Copilot → Documents panel (issue #153 — the /api/ai/extract-document
// consumer surface). The document-intelligence decision flow finally gets its
// operator surface: AI extracts a DRAFT (POST), a human APPROVES or REJECTS it
// (PUT — the "AI assists, humans decide" gate), and every verdict lands in the
// audit ledger (kind 'document' — visible in the Evidence tab, and in the Admin
// audit log for admins).
//
// Data: GET /api/ai/extract-document?projectId&reviewStatus=pending through
// the pure client module next door (copilot/document-review.ts) — the request
// shapes and error surfacing are pinned in tests/unit/document-review-client.test.ts.
//
// Role gating mirrors the route family's shared policy (rate-limit.ts
// AI_ROUTE_ROLES = contractor/admin/supervisor): the Copilot tab itself is only
// in those roles' tab sets (permissions.ts ROLE_TABS), and this panel ALSO
// fails closed with a locked card when the session role is not on the route's
// allowlist — never trust navigation alone (the audit-tab posture).

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/frontend/ui/table'
import {
  FileText, Loader2, Lock, ScanText, CheckCircle2, XCircle, ExternalLink,
  RefreshCcw, ScrollText, ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, dateShort, timeEAT } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import {
  fetchDocumentQueue,
  extractDocumentDraft,
  reviewDocumentDraft,
  type ReviewQueueDocument,
} from './document-review'

/** The route family's role allowlist (mirrors AI_ROUTE_ROLES in rate-limit.ts). */
const AI_REVIEW_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']

/** Attachment.category values the upload surface can stamp (types.ts DOCUMENT_CATEGORIES). */
const DOC_CATEGORIES = ['contract', 'drawing', 'permit', 'receipt', 'boq', 'invoice', 'quote', 'other'] as const

function categoryKey(category: string | null): string {
  return (DOC_CATEGORIES as readonly string[]).includes(category ?? '')
    ? `copilot.docs.cat.${category}`
    : 'copilot.docs.cat.other'
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Total with currency honesty: KES (or unlabeled) renders as KSh, anything else keeps its printed code. */
function formatTotal(total: number | null, currency: string | null): string {
  if (total === null || total === undefined) return '—'
  if (!currency || currency.toUpperCase() === 'KES') return formatKES(total)
  return `${total.toLocaleString('en-KE')} ${currency}`
}

export function DocumentsPanel({ online }: { online: boolean }) {
  const { data, enqueuePendingNetwork } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const [docs, setDocs] = useState<ReviewQueueDocument[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The attachment an extract/review is in flight for (button spinners). */
  const [busyId, setBusyId] = useState<string | null>(null)

  const projectId = data?.project.id ?? null
  const role = String(session?.user?.role ?? '')
  const canReview = AI_REVIEW_ROLES.includes(role)
  const isAdmin = role === 'admin'

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    const res = await fetchDocumentQueue(projectId, 'pending')
    if (res.ok) {
      setDocs(res.documents)
      setSelectedId((prev) =>
        prev && res.documents.some((d) => d.id === prev) ? prev : (res.documents[0]?.id ?? null),
      )
    } else {
      // res.error null → network-level failure; the localized generic copy.
      setError(res.error)
      setDocs(null)
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    if (canReview) void load()
    else setLoading(false)
  }, [canReview, load])

  if (!data) return null

  // Fail closed: a session outside the route's role allowlist gets the locked
  // card, never a queue read (mirrors the audit-tab posture — tab visibility
  // alone is not trusted).
  if (!canReview) {
    return (
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="py-16 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-stone-100 flex items-center justify-center" aria-hidden>
            <Lock className="w-7 h-7 text-stone-400" />
          </div>
          <div className="max-w-md">
            <h2 className="text-lg font-semibold text-stone-900">{t('copilot.docs.lockedTitle')}</h2>
            <p className="mt-1.5 text-sm text-stone-500 leading-relaxed">
              {t('copilot.docs.lockedBody')}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const selected = docs?.find((d) => d.id === selectedId) ?? null

  async function runExtract(doc: ReviewQueueDocument) {
    if (!online) {
      toast.error(t('copilot.docs.toast.needOnline'))
      // #150: document AI is server-side — the refusal keeps a reminder.
      enqueuePendingNetwork({ kind: 'copilot.docs', labelKey: 'netlist.kind.docs', context: { file: doc.fileName }, tab: 'copilot' })
      return
    }
    setBusyId(doc.id)
    try {
      const res = await extractDocumentDraft(doc.id)
      if (res.ok) {
        toast.success(t('copilot.docs.toast.extracted', { confidence: Math.round((res.confidence ?? 0) * 100) }))
        await load() // the draft + reset reviewStatus land on the row
      } else {
        // Honest failure (scanned PDF, unreadable file, environment limits) —
        // the server's reason is surfaced, never swallowed.
        toast.error(res.error ?? t('copilot.docs.toast.extractFailed'))
      }
    } finally {
      setBusyId(null)
    }
  }

  async function decide(doc: ReviewQueueDocument, decision: 'approved' | 'rejected') {
    if (!online) {
      toast.error(t('copilot.docs.toast.needOnline'))
      // #150: the review decision needs the server — remind, never queue.
      enqueuePendingNetwork({ kind: 'copilot.docsReview', labelKey: 'netlist.kind.docsReview', context: { file: doc.fileName }, tab: 'copilot' })
      return
    }
    setBusyId(doc.id)
    try {
      const res = await reviewDocumentDraft(doc.id, decision)
      if (res.ok) {
        toast.success(decision === 'approved' ? t('copilot.docs.toast.approved', { file: doc.fileName }) : t('copilot.docs.toast.rejected', { file: doc.fileName }))
        await load() // the verdict leaves the pending queue
      } else {
        toast.error(res.error ?? t('copilot.docs.toast.decideFailed'))
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* ---------- the pending queue ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-600" aria-hidden /> {t('copilot.docs.queueTitle')}
          </CardTitle>
          <CardDescription>
            {t('copilot.docs.queueDesc', {
              project: data.project.name,
              count: docs?.length ?? 0,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5 min-h-9" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCcw className="w-4 h-4" aria-hidden />}
              {t('copilot.docs.refresh')}
            </Button>
            {!online && (
              <Badge className="gap-1 bg-amber-100 text-amber-800 border-0"><Lock className="w-3 h-3" aria-hidden /> {t('copilot.offlineBadge')}</Badge>
            )}
          </div>

          {loading && docs === null && (
            <p className="text-sm text-stone-400" role="status">{t('copilot.docs.loading')}</p>
          )}

          {!loading && error !== null && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm" role="alert">
              <p className="font-semibold text-amber-900">{t('copilot.docs.loadFailed')}</p>
              <p className="text-xs text-amber-800 mt-0.5 break-words">
                {error ?? t('copilot.docs.errorGeneric')}
              </p>
              <Button variant="outline" size="sm" className="mt-2 gap-1.5 min-h-9" onClick={() => void load()}>
                <RefreshCcw className="w-3.5 h-3.5" aria-hidden /> {t('copilot.docs.retry')}
              </Button>
            </div>
          )}

          {!loading && error === null && docs !== null && docs.length === 0 && (
            <div className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-8 text-center">
              {t('copilot.docs.emptyQueue')}
            </div>
          )}

          {docs !== null && docs.length > 0 && (
            <ul className="space-y-2 max-h-[28rem] overflow-y-auto pr-1 list-none" aria-label={t('copilot.docs.queueTitle')}>
              {docs.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(doc.id)}
                    aria-current={selectedId === doc.id}
                    className={`w-full text-left rounded-lg border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                      selectedId === doc.id ? 'border-amber-400 bg-amber-50/60' : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] capitalize bg-stone-50">{t(categoryKey(doc.category))}</Badge>
                          <span className="text-sm font-medium text-stone-800 truncate">{doc.title || doc.fileName}</span>
                        </span>
                        <span className="block text-[11px] text-stone-500 mt-1 truncate">
                          {doc.fileName} · {formatSize(doc.sizeBytes)} · {dateShort(doc.createdAt)} {timeEAT(doc.createdAt)}
                        </span>
                        <span className="block text-[11px] text-stone-400 mt-0.5">
                          {doc.extraction
                            ? t('copilot.docs.draftReady', { model: doc.extractionModel ?? '?', confidence: Math.round((doc.extractionConfidence ?? 0) * 100) })
                            : t('copilot.docs.noDraft')}
                        </span>
                      </span>
                      {doc.extraction ? (
                        <ScanText className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden />
                      ) : (
                        <FileText className="w-4 h-4 text-stone-300 shrink-0 mt-0.5" aria-hidden />
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-stone-400 leading-relaxed">{t('copilot.docs.queueNote')}</p>
        </CardContent>
      </Card>

      {/* ---------- the draft + the human gate ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
            <ScanText className="w-5 h-5 text-amber-600" aria-hidden /> {t('copilot.docs.draftTitle')}
          </CardTitle>
          <CardDescription>{t('copilot.docs.draftDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!selected ? (
            <div className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-8 text-center">
              {t('copilot.docs.emptyDraft')}
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px] capitalize bg-stone-50">{t(categoryKey(selected.category))}</Badge>
                  <span className="text-sm font-semibold text-stone-900 truncate">{selected.title || selected.fileName}</span>
                  <a
                    href={selected.storageKey}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-amber-700 underline decoration-amber-300 hover:text-amber-800"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden /> {t('copilot.docs.viewFile')}
                  </a>
                </div>
                <p className="text-[11px] text-stone-500 mt-1.5">
                  {t('copilot.docs.uploadedBy', { by: selected.uploadedBy, date: dateShort(selected.createdAt) })}
                </p>
              </div>

              {selected.extraction ? (
                <div className="space-y-3" aria-live="polite">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5">
                      <p className="text-sm font-bold text-stone-900 capitalize">{selected.extraction.docType}</p>
                      <p className="text-[10px] text-stone-500 uppercase tracking-wide">{t('copilot.docs.f.docType')}</p>
                    </div>
                    <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5">
                      <p className="text-sm font-bold text-stone-900 truncate" title={selected.extraction.supplier ?? undefined}>
                        {selected.extraction.supplier ?? '—'}
                      </p>
                      <p className="text-[10px] text-stone-500 uppercase tracking-wide">{t('copilot.docs.f.supplier')}</p>
                    </div>
                    <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5">
                      <p className="text-sm font-bold text-stone-900 tabular-nums">{formatTotal(selected.extraction.total, selected.extraction.currency)}</p>
                      <p className="text-[10px] text-stone-500 uppercase tracking-wide">{t('copilot.docs.f.total')}</p>
                    </div>
                  </div>

                  {selected.extraction.lines.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-stone-200">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="text-xs text-stone-500">{t('copilot.docs.f.line')}</TableHead>
                            <TableHead className="text-right text-xs text-stone-500">{t('copilot.docs.f.qty')}</TableHead>
                            <TableHead className="text-right text-xs text-stone-500">{t('copilot.docs.f.unitPrice')}</TableHead>
                            <TableHead className="text-right text-xs text-stone-500">{t('copilot.docs.f.total')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selected.extraction.lines.map((line, i) => (
                            <TableRow key={i}>
                              <TableCell className="text-sm text-stone-800">{line.description}</TableCell>
                              <TableCell className="text-right text-sm tabular-nums text-stone-600">{line.qty ?? '—'}</TableCell>
                              <TableCell className="text-right text-sm tabular-nums text-stone-600">{line.unitPrice ?? '—'}</TableCell>
                              <TableCell className="text-right text-sm tabular-nums text-stone-600">{line.total ?? '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  {selected.extraction.notes && (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      {t('copilot.docs.f.notes')}: <span className="italic">“{selected.extraction.notes}”</span>
                    </p>
                  )}

                  <p className="text-[11px] text-stone-400">
                    {t('copilot.docs.draftMeta', {
                      model: selected.extractionModel ?? '?',
                      confidence: Math.round((selected.extractionConfidence ?? 0) * 100),
                    })}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-stone-500">{t('copilot.docs.noDraftBody')}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 min-h-9"
                    disabled={!online || busyId === selected.id}
                    onClick={() => void runExtract(selected)}
                  >
                    {busyId === selected.id ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ScanText className="w-4 h-4" aria-hidden />}
                    {busyId === selected.id ? t('copilot.docs.extracting') : t('copilot.docs.extract')}
                  </Button>
                </div>
              )}

              {/* The human gate — AI never approves (architecture invariant). */}
              <div className="rounded-lg border border-stone-200 p-3 space-y-3">
                <p className="text-xs font-medium text-stone-600 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-amber-600" aria-hidden />
                  {t('copilot.docs.gateTitle', { who: session?.user?.name || session?.user?.email || '' })}
                </p>
                <p className="text-[11px] text-stone-400 leading-relaxed">{t('copilot.docs.gateNote')}</p>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    size="sm"
                    className="gap-1.5 min-h-10 bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={!online || busyId === selected.id}
                    onClick={() => void decide(selected, 'approved')}
                  >
                    {busyId === selected.id ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <CheckCircle2 className="w-4 h-4" aria-hidden />}
                    {t('copilot.docs.approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 min-h-10 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                    disabled={!online || busyId === selected.id}
                    onClick={() => void decide(selected, 'rejected')}
                  >
                    <XCircle className="w-4 h-4" aria-hidden /> {t('copilot.docs.reject')}
                  </Button>
                  {selected.extraction && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 min-h-10 text-stone-500"
                      disabled={!online || busyId === selected.id}
                      title={t('copilot.docs.reextractHint')}
                      onClick={() => void runExtract(selected)}
                    >
                      {busyId === selected.id ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCcw className="w-4 h-4" aria-hidden />}
                      {t('copilot.docs.reextract')}
                    </Button>
                  )}
                </div>
              </div>

              {/* Audit verification affordance: the verdict's AuditEvent (kind
                  'document') is readable where the project trail lives. */}
              <p className="text-[11px] text-stone-400 flex flex-wrap items-center gap-1.5">
                <ScrollText className="w-3.5 h-3.5 shrink-0" aria-hidden />
                {t('copilot.docs.auditNote')}
                <button
                  type="button"
                  className="text-amber-700 underline decoration-amber-300 hover:text-amber-800"
                  onClick={() => window.dispatchEvent(new CustomEvent('mjengo:tab', { detail: { tab: 'evidence' } }))}
                >
                  {t('copilot.docs.viewEvidence')}
                </button>
                {isAdmin && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="text-amber-700 underline decoration-amber-300 hover:text-amber-800"
                      onClick={() => window.dispatchEvent(new CustomEvent('mjengo:tab', { detail: { tab: 'audit' } }))}
                    >
                      {t('copilot.docs.viewAudit')}
                    </button>
                  </>
                )}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
