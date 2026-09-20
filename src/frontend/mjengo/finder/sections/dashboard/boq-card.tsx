'use client'

// BOQ entity card (spec §28 — the chain head: BOQ → Material Requirement →
// RFQ → …). Fed by data.boq (BoqSlice): versioned BOQs with lines and
// estimated totals, "New BOQ" with dynamic line rows, per-BOQ "Add line",
// "Approve" and "Generate material request" (boq.to_request → MR draft,
// toast shows the requestCode + points to the Requests section). The DERIVED
// per-material required-vs-purchased view ("BOQ-lite") stays below it in the
// dashboard — both views are useful and labeled separately.
//
// #203: under each BOQ's estimates table, the LINEAGE "BOQ vs actual" table
// (progress prop — dashboard-section computes it with the pure
// supply/insights boqProgress): estimated / requested / ordered / delivered /
// consumed / remaining per BOQ line, walked over the FK stamps
// (boqLineId/requestLineId) — never name matching. It renders only when a
// line of THIS BOQ has actual activity; unlinked (legacy/name-only) request
// lines are listed separately at the bottom with the BOQ-lite honesty.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Check, ClipboardList, FileStack, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { fmtQty, formatKes } from '../requests/bits'
import type { BoqRow } from '@/backend/modules/inventory/types'
import type { BoqProgressResult, BoqProgressRow } from '@/backend/modules/supply/types'

interface DraftLine {
  key: number
  materialName: string
  unit: string
  qty: string
  estUnitPrice: string
  category: string
}

let lineKey = 0
function newDraftLine(): DraftLine {
  lineKey += 1
  return { key: lineKey, materialName: '', unit: '', qty: '', estUnitPrice: '', category: '' }
}

function BoqStatusBadge({ status }: { status: string }) {
  const t = useT()
  if (status === 'approved') {
    return <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> {t('finder.boq.status.approved')}</Badge>
  }
  if (status === 'superseded') {
    return <Badge className="border-0 gap-1 bg-stone-200 text-stone-600 hover:bg-stone-200">{t('finder.boq.status.superseded')}</Badge>
  }
  return <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100">{t('finder.boq.status.draft')}</Badge>
}

/**
 * #203: one lineage row's remaining cell — SIGNED (negative = overrun of the
 * estimate-of-record), with the overrun surfaced as a badge instead of being
 * floored away (the BOQ-lite display floor is deliberately NOT applied here:
 * quantity-overrun visibility is the point of the lineage view).
 */
function ProgressRemaining({ row }: { row: BoqProgressRow }) {
  const t = useT()
  if (row.remaining < 0) {
    return (
      <span className="flex items-center justify-end gap-1.5 font-semibold tabular-nums text-orange-700">
        {fmtQty(row.remaining)}
        <Badge className="border-0 bg-orange-100 text-[9px] font-normal text-orange-800 hover:bg-orange-100">{t('finder.boq.progress.overrun')}</Badge>
      </span>
    )
  }
  return <span className="font-semibold tabular-nums text-stone-900">{fmtQty(row.remaining)}</span>
}

export function BoqCard({ canManage, progress }: { canManage: boolean; progress: BoqProgressResult }) {
  const { data, dispatch, online, outbox, actionBusy } = useMjengo()
  const t = useT()
  const [createOpen, setCreateOpen] = useState(false)
  const [boqName, setBoqName] = useState('')
  const [draftLines, setDraftLines] = useState<DraftLine[]>([newDraftLine()])
  const [addLineTarget, setAddLineTarget] = useState<BoqRow | null>(null)
  const [addLine, setAddLine] = useState({ materialName: '', unit: '', qty: '', estUnitPrice: '', category: '' })
  const busy = actionBusy !== null
  const offlineNote = t('field.savedQueued', { count: outbox.length })
  const boqs = data?.boq.boqs ?? []

  if (!data) return null

  function openCreate() {
    setBoqName('')
    setDraftLines([newDraftLine()])
    setCreateOpen(true)
  }

  async function createBoq() {
    const lines = draftLines
      .filter((l) => l.materialName.trim())
      .map((l) => ({
        materialName: l.materialName.trim(),
        unit: l.unit.trim() || 'unit',
        qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
        estUnitPrice: Number(l.estUnitPrice) >= 0 ? Number(l.estUnitPrice) : 0,
        ...(l.category.trim() ? { category: l.category.trim() } : {}),
      }))
    if (!boqName.trim()) { toast.error(t('finder.boq.toast.name')); return }
    if (!lines.length) { toast.error(t('finder.boq.toast.lines')); return }
    if (lines.some((l) => !(l.qty > 0))) { toast.error(t('finder.boq.toast.qty')); return }
    const ok = await dispatch('boq.create', { name: boqName.trim(), lines }, t('finder.boq.audit.created', { name: boqName.trim() }))
    if (ok) {
      toast.success(online ? t('finder.boq.toast.created', { name: boqName.trim(), count: lines.length }) : offlineNote)
      setCreateOpen(false)
    } else toast.error(t('finder.boq.toast.createFailed'))
  }

  async function saveAddLine() {
    if (!addLineTarget) return
    const qty = Number(addLine.qty)
    if (!addLine.materialName.trim()) { toast.error(t('finder.boq.toast.materialName')); return }
    if (!(qty > 0)) { toast.error(t('finder.boq.toast.qtyPositive')); return }
    const ok = await dispatch('boq.line.upsert', {
      boqId: addLineTarget.id,
      materialName: addLine.materialName.trim(),
      unit: addLine.unit.trim() || 'unit',
      qty,
      estUnitPrice: Number(addLine.estUnitPrice) >= 0 ? Number(addLine.estUnitPrice) : 0,
      ...(addLine.category.trim() ? { category: addLine.category.trim() } : {}),
    }, t('finder.boq.audit.lineAdded', { name: addLine.materialName.trim() }))
    if (ok) {
      toast.success(online ? t('finder.boq.toast.lineAdded', { name: addLineTarget.name }) : offlineNote)
      setAddLineTarget(null)
    } else toast.error(t('finder.boq.toast.addLineFailed'))
  }

  async function approve(boq: BoqRow) {
    const ok = await dispatch('boq.approve', { id: boq.id }, t('finder.boq.audit.approved', { name: boq.name }))
    if (ok) toast.success(online ? t('finder.boq.toast.approved', { name: boq.name }) : offlineNote)
    else toast.error(t('finder.boq.toast.approveFailed'))
  }

  async function generateRequest(boq: BoqRow) {
    const ok = await dispatch('boq.to_request', { id: boq.id }, t('finder.boq.audit.mr', { name: boq.name }))
    if (ok) {
      // The store refreshed synchronously on dispatch — find the new draft MR
      // (its notes reference this BOQ) so the toast can show the requestCode.
      const fresh = useMjengo.getState().data
      const created = fresh?.supply.requests.find(
        (r) => r.status === 'draft' && (r.notes ?? '').includes(`From BOQ "${boq.name}"`),
      )
      toast.success(
        t('finder.boq.toast.mrGenerated', { code: created?.requestCode ?? t('finder.boq.audit.mr', { name: boq.name }), name: boq.name }),
        { duration: 7000 },
      )
    } else toast.error(t('finder.boq.toast.mrFailed'))
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <FileStack className="h-5 w-5 text-amber-600" aria-hidden /> {t('finder.boq.title')}
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{boqs.length}</Badge>
          </CardTitle>
          <CardDescription>
            {t('finder.boq.desc')}
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={openCreate} aria-label={t('finder.boq.newAria')}>
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('finder.boq.new')}</span>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {boqs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-xs text-stone-500">
            {t('finder.boq.empty')}
          </p>
        ) : (
          <div className="space-y-3">
            {boqs.map((boq) => (
              <div key={boq.id} className="rounded-lg border border-stone-200">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-stone-800">
                      <span className="truncate">{boq.name}</span>
                      <Badge variant="outline" className="text-[10px] text-stone-500">v{boq.version}</Badge>
                      <BoqStatusBadge status={boq.status} />
                    </p>
                    <p className="text-[11px] text-stone-500">
                      {t(boq.lines.length === 1 ? 'finder.boq.linesOne' : 'finder.boq.linesMany', { count: boq.lines.length, total: formatKes(boq.total) })}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button
                        size="sm" variant="outline" className="h-8 min-h-8 gap-1 px-2 text-xs" disabled={busy}
                        onClick={() => { setAddLineTarget(boq); setAddLine({ materialName: '', unit: '', qty: '', estUnitPrice: '', category: '' }) }}
                        aria-label={t('finder.boq.addLineAria', { name: boq.name })}
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden /> {t('finder.boq.addLine')}
                      </Button>
                      {boq.status === 'draft' && (
                        <Button
                          size="sm" className="h-8 min-h-8 gap-1 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700" disabled={busy}
                          onClick={() => void approve(boq)}
                          aria-label={t('finder.boq.approveAria', { name: boq.name })}
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden /> {t('finder.boq.approve')}
                        </Button>
                      )}
                      <Button
                        size="sm" variant={boq.status === 'approved' ? 'default' : 'ghost'}
                        className={`h-8 min-h-8 gap-1 px-2 text-xs ${boq.status === 'approved' ? 'bg-amber-600 text-white hover:bg-amber-700' : 'text-stone-600'}`}
                        disabled={busy || boq.status !== 'approved' || boq.lines.length === 0}
                        onClick={() => void generateRequest(boq)}
                        aria-label={t('finder.boq.generateAria', { name: boq.name })}
                        title={boq.status !== 'approved' ? t('finder.boq.approveFirst') : t('finder.boq.createsDraft')}
                      >
                        <ClipboardList className="h-3.5 w-3.5" aria-hidden /> {t('finder.boq.generate')}
                      </Button>
                    </div>
                  )}
                </div>
                {boq.lines.length > 0 && (
                  <div className="overflow-x-auto border-t border-stone-100">
                    <table className="w-full min-w-[480px] text-sm">
                      <caption className="sr-only">{t('finder.boq.caption', { name: boq.name })}</caption>
                      <thead>
                        <tr className="bg-stone-50/70 text-left text-[11px] uppercase tracking-wide text-stone-400">
                          <th scope="col" className="px-3 py-1.5 font-medium">{t('finder.boq.col.material')}</th>
                          <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.col.qty')}</th>
                          <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.col.estUnit')}</th>
                          <th scope="col" className="px-3 py-1.5 text-right font-medium">{t('finder.boq.col.estTotal')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {boq.lines.map((line) => (
                          <tr key={line.id} className="border-t border-stone-100">
                            <td className="px-3 py-1.5 text-stone-700">
                              {line.materialName}
                              {line.category && <Badge variant="outline" className="ml-1.5 text-[9px] font-normal text-stone-400">{line.category}</Badge>}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{line.qty} <span className="text-[10px] text-stone-400">{line.unit}</span></td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-stone-600">{line.estUnitPrice > 0 ? formatKes(line.estUnitPrice) : '—'}</td>
                            <td className="px-3 py-1.5 text-right font-medium tabular-nums text-stone-800">{line.estUnitPrice > 0 ? formatKes(line.qty * line.estUnitPrice) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* #203: the lineage BOQ-vs-actual table — per line, traced
                    through the request/PO/delivery links (not names). Rendered
                    only when this BOQ has actual downstream activity, so a
                    fresh estimate list stays clean. */}
                {(() => {
                  const rows = progress.rows.filter((r) => r.boqId === boq.id)
                  const active = rows.some((r) => r.requested > 0 || r.ordered > 0 || r.delivered > 0 || r.consumed > 0)
                  if (!active) return null
                  return (
                    <div className="overflow-x-auto border-t border-stone-100">
                      <table className="w-full min-w-[560px] text-xs">
                        <caption className="sr-only">{t('finder.boq.progress.caption', { name: boq.name })}</caption>
                        <thead>
                          <tr className="bg-stone-50/70 text-left text-[10px] uppercase tracking-wide text-stone-400">
                            <th scope="col" className="px-3 py-1.5 font-medium">{t('finder.boq.progress.col.material')}</th>
                            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.progress.col.estimated')}</th>
                            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.progress.col.requested')}</th>
                            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.progress.col.ordered')}</th>
                            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.progress.col.delivered')}</th>
                            <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('finder.boq.progress.col.consumed')}</th>
                            <th scope="col" className="px-3 py-1.5 text-right font-medium">{t('finder.boq.progress.col.remaining')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.boqLineId} className="border-t border-stone-100">
                              <td className="px-3 py-1.5 text-stone-700">
                                {row.materialName} <span className="text-[10px] text-stone-400">{row.unit}</span>
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{fmtQty(row.estimated)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{fmtQty(row.requested)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{fmtQty(row.ordered)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{fmtQty(row.delivered)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{fmtQty(row.consumed)}</td>
                              <td className="px-3 py-1.5 text-right"><ProgressRemaining row={row} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="px-3 pb-2 pt-1 text-[10px] leading-snug text-stone-400">{t('finder.boq.progress.desc')}</p>
                    </div>
                  )
                })()}
              </div>
            ))}
          </div>
        )}
        {/* #203: live request lines with NO BOQ lineage (legacy or manually
            created) — listed honestly instead of being name-matched onto BOQ
            lines. The BOQ-lite table below stays their view. */}
        {progress.unlinked.length > 0 && (
          <div className="mt-3 rounded-lg border border-dashed border-stone-300 bg-stone-50/50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              {t('finder.boq.progress.unlinkedTitle', { count: progress.unlinked.length })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {progress.unlinked.slice(0, 5).map((l) => (
                <li key={`${l.requestId}:${l.materialName}`} className="text-[11px] text-stone-500">
                  <span className="font-mono">{l.requestCode}</span> — {l.materialName} · {fmtQty(l.qty)} {l.unit}
                </li>
              ))}
            </ul>
            {progress.unlinked.length > 5 && (
              <p className="mt-1 text-[10px] text-stone-400">{t('finder.boq.progress.unlinkedMore', { count: progress.unlinked.length - 5 })}</p>
            )}
            <p className="mt-1.5 text-[10px] leading-snug text-stone-400">{t('finder.boq.progress.unlinkedDesc')}</p>
          </div>
        )}
      </CardContent>

      {/* ---- new BOQ dialog (name + dynamic lines) ---- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('finder.boq.createTitle')}</DialogTitle>
            <DialogDescription>
              {t('finder.boq.createDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="boq-name">{t('finder.boq.nameLabel')}</Label>
              <Input id="boq-name" value={boqName} onChange={(e) => setBoqName(e.target.value)} placeholder={t('finder.boq.namePh')} />
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('finder.boq.linesLabel')}</p>
              {draftLines.map((line, i) => (
                <div key={line.key} className="space-y-1.5 rounded-lg border border-stone-200 px-2 py-2">
                  <div className="grid grid-cols-[1fr_4rem_4.5rem_5.5rem_auto] items-center gap-1.5">
                    <Input
                      value={line.materialName}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, materialName: e.target.value } : l)))}
                      placeholder={t('finder.boq.lineMaterialPh', { n: i + 1 })}
                      aria-label={t('finder.boq.lineNameAria', { n: i + 1 })}
                      className="h-8 text-xs"
                    />
                    <Input
                      value={line.unit}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, unit: e.target.value } : l)))}
                      placeholder={t('finder.boq.lineUnitPh')}
                      aria-label={t('finder.boq.lineUnitAria', { n: i + 1 })}
                      className="h-8 text-xs"
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={line.qty}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, qty: e.target.value } : l)))}
                      placeholder={t('finder.boq.lineQtyPh')}
                      aria-label={t('finder.boq.lineQtyAria', { n: i + 1 })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={line.estUnitPrice}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, estUnitPrice: e.target.value } : l)))}
                      placeholder={t('finder.boq.linePricePh')}
                      aria-label={t('finder.boq.linePriceAria', { n: i + 1 })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                    <Button
                      type="button" variant="ghost" size="sm"
                      className="h-8 w-8 min-h-8 p-0 text-stone-400 hover:text-rose-600"
                      onClick={() => setDraftLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== line.key) : ls))}
                      aria-label={t('finder.boq.lineRemoveAria', { n: i + 1 })}
                      disabled={draftLines.length === 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                  <Input
                    value={line.category}
                    onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, category: e.target.value } : l)))}
                    placeholder={t('finder.boq.categoryPh')}
                    aria-label={t('finder.boq.categoryAria', { n: i + 1 })}
                    className="h-8 text-xs"
                  />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="h-8 min-h-8 gap-1 text-xs" onClick={() => setDraftLines((ls) => [...ls, newDraftLine()])}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> {t('finder.boq.addLine')}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('dialog.expense.cancel')}</Button>
            <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void createBoq()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} {t('finder.boq.createBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- add line dialog ---- */}
      <Dialog open={Boolean(addLineTarget)} onOpenChange={(v) => !v && setAddLineTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('finder.boq.addLineTitle', { name: addLineTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('finder.boq.addLineDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="bl-material">{t('finder.boq.materialLabel')}</Label>
              <Input id="bl-material" value={addLine.materialName} onChange={(e) => setAddLine({ ...addLine, materialName: e.target.value })} placeholder={t('finder.boq.materialPh')} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bl-unit">{t('finder.boq.unitLabel')}</Label>
                <Input id="bl-unit" value={addLine.unit} onChange={(e) => setAddLine({ ...addLine, unit: e.target.value })} placeholder={t('finder.boq.unitPh')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bl-qty">{t('finder.boq.qtyLabel')}</Label>
                <Input id="bl-qty" type="number" inputMode="decimal" min={0} value={addLine.qty} onChange={(e) => setAddLine({ ...addLine, qty: e.target.value })} placeholder="5" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bl-price">{t('finder.boq.estLabel')}</Label>
                <Input id="bl-price" type="number" inputMode="decimal" min={0} value={addLine.estUnitPrice} onChange={(e) => setAddLine({ ...addLine, estUnitPrice: e.target.value })} placeholder="2200" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bl-category">{t('finder.boq.catLabel')}</Label>
              <Input id="bl-category" value={addLine.category} onChange={(e) => setAddLine({ ...addLine, category: e.target.value })} placeholder={t('finder.boq.catPh')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddLineTarget(null)}>{t('dialog.expense.cancel')}</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void saveAddLine()}>{t('finder.boq.addLine')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
