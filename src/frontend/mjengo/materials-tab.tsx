'use client'

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/frontend/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/frontend/ui/tooltip'
import { Boxes, Truck, PackageMinus, Mic, Camera, Hand, Phone, Plus, PackageSearch, Download, Warehouse, AlertTriangle, ArrowLeftRight, Flame, ClipboardList, ClipboardCheck } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, dateShort } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import { downloadCSV, materialsLedgerCSV, reconciliationCSV, projectFilePrefix } from '@/frontend/mjengo/export-utils'
import { materialMatches } from '@/backend/modules/supply/compare'
import type { InventoryItemRow, StockMovementType } from '@/backend/modules/inventory/types'

function SourceBadge({ source }: { source: string }) {
  const t = useT()
  if (source === 'voice') return <Badge className="gap-1 bg-violet-100 text-violet-800 border-0 hover:bg-violet-100"><Mic className="w-3 h-3" aria-hidden /> {t('mat.source.voice')}</Badge>
  if (source === 'photo') return <Badge className="gap-1 bg-sky-100 text-sky-800 border-0 hover:bg-sky-100"><Camera className="w-3 h-3" aria-hidden /> {t('mat.source.photo')}</Badge>
  if (source === 'mpesa') return <Badge className="gap-1 bg-emerald-100 text-emerald-800 border-0 hover:bg-emerald-100"><Phone className="w-3 h-3" aria-hidden /> M-Pesa</Badge>
  return <Badge className="gap-1 bg-stone-100 text-stone-600 border-0 hover:bg-stone-100"><Hand className="w-3 h-3" aria-hidden /> {t('mat.source.manual')}</Badge>
}

export function MaterialsTab() {
  const { data, dispatch, online, outbox, viewMode } = useMjengo()
  const t = useT()
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [consumptionOpen, setConsumptionOpen] = useState(false)
  const [materialOpen, setMaterialOpen] = useState(false)
  const [materialBusy, setMaterialBusy] = useState(false)

  const [dMaterial, setDMaterial] = useState('')
  const [dQty, setDQty] = useState('')
  const [dCost, setDCost] = useState('')
  const [dSupplier, setDSupplier] = useState('')
  const [cMaterial, setCMaterial] = useState('')
  const [cQty, setCQty] = useState('')
  const [cPhase, setCPhase] = useState('')
  const [cNote, setCNote] = useState('')
  const [mName, setMName] = useState('')
  const [mUnit, setMUnit] = useState('')
  const [mPrice, setMPrice] = useState('')

  if (!data) return null
  const isClient = viewMode === 'client'
  const stockValue = data.materials.reduce((s, m) => s + m.stockValue, 0)
  const mat = (id: string) => data.materials.find((m) => m.id === id)

  function exportLedger() {
    if (!data) return
    const filename = `${projectFilePrefix(data)}-materials-ledger.csv`
    downloadCSV(filename, materialsLedgerCSV(t, data))
    toast.success(t('field.exported', { file: filename }))
  }

  async function addMaterial() {
    const unitPrice = Number(mPrice)
    if (!mName.trim() || !mUnit.trim()) { toast.error(t('mat.error.nameUnit')); return }
    if (!mPrice || Number.isNaN(unitPrice) || unitPrice < 0) { toast.error(t('mat.error.unitPrice')); return }
    setMaterialBusy(true)
    const ok = await dispatch('material.create', {
      name: mName.trim(), unit: mUnit.trim(), unitPrice,
    }, `Add material ${mName.trim()}`)
    setMaterialBusy(false)
    if (ok) {
      toast.success(online ? t('mat.materialAdded', { name: mName.trim() }) : t('field.savedQueued', { count: outbox.length }))
      setMaterialOpen(false); setMName(''); setMUnit(''); setMPrice('')
    } else {
      toast.error(t('mat.addFailed'))
    }
  }

  async function logDelivery() {
    const m = mat(dMaterial)
    const qty = Number(dQty)
    if (!m || !qty || qty <= 0) { toast.error(t('mat.error.pickQty')); return }
    const ok = await dispatch('delivery.create', {
      materialId: m.id, quantity: qty,
      unitCost: Number(dCost) > 0 ? Number(dCost) : m.unitPrice,
      supplier: dSupplier.trim() || 'Unknown supplier', source: 'manual',
    }, `Delivery: ${qty} ${m.unit} ${m.name}`)
    if (ok) {
      toast.success(online
        ? t('mat.deliveryLogged', { qty, unit: m.unit, name: m.name })
        : t('field.savedQueued', { count: outbox.length }))
      setDeliveryOpen(false); setDQty(''); setDCost(''); setDSupplier('')
    } else toast.error(t('mat.deliveryFailed'))
  }

  async function logConsumption() {
    const m = mat(cMaterial)
    const qty = Number(cQty)
    if (!m || !qty || qty <= 0) { toast.error(t('mat.error.pickQty')); return }
    const ok = await dispatch('consumption.create', {
      materialId: m.id, quantity: qty,
      phaseName: data?.phases.find((p) => p.id === cPhase)?.name ?? null,
      note: cNote.trim() || null,
    }, `Used ${qty} ${m.unit} ${m.name}`)
    if (ok) {
      toast.success(online ? t('mat.consumptionLogged') : t('field.savedQueued', { count: outbox.length }))
      setConsumptionOpen(false); setCQty(''); setCNote('')
    } else toast.error(t('mat.consumptionFailed'))
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-label={t('mat.kpiAria')}>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Truck className="w-3.5 h-3.5" aria-hidden /> {t('mat.spendToDate')}</CardDescription>
            <CardTitle className="text-2xl font-bold text-stone-900 tabular-nums">{formatKES(data.summary.materialSpend)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{t('mat.deliveriesLogged', { deliveries: data.deliveries.length, materials: data.materials.length })}</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Boxes className="w-3.5 h-3.5" aria-hidden /> {t('mat.stockValueOnSite')}</CardDescription>
            <CardTitle className="text-2xl font-bold text-stone-900 tabular-nums">{formatKES(stockValue)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{t('mat.stockValueHint')}</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><PackageMinus className="w-3.5 h-3.5" aria-hidden /> {t('mat.quickActions')}</CardDescription>
            <CardTitle className="text-base font-semibold text-stone-900 pt-1">{isClient ? t('mat.ledgerTools') : t('mat.logFieldActivity')}</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2 pt-1">
            {isClient ? (
              <p className="text-xs text-stone-400 py-2">{t('mat.clientReadonly')}</p>
            ) : (
              <>
                <Button size="sm" className="gap-1.5 flex-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => { setDMaterial(data.materials[0]?.id ?? ''); setDeliveryOpen(true) }}>
                  <Truck className="w-4 h-4" aria-hidden /> {t('mat.delivery')}
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 flex-1" onClick={() => { setCMaterial(data.materials[0]?.id ?? ''); setConsumptionOpen(true) }}>
                  <PackageMinus className="w-4 h-4" aria-hidden /> {t('mat.used')}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Site Store (spec §35) — storekeeper dashboard from the append-only
          StockMovement ledger; closing stock is derived, never stored. */}
      <SiteStoreCard />

      {/* Inventory */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900">{t('mat.inventoryLedger')}</CardTitle>
            <CardDescription>{t('mat.inventoryDesc')}</CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            {!isClient && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setMaterialOpen(true)} aria-label={t('mat.addMaterialAria')}>
                <Plus className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">{t('mat.addMaterial')}</span>
              </Button>
            )}
            <Button size="sm" variant="outline" className="gap-1.5" onClick={exportLedger} aria-label={t('mat.exportLedgerAria')}>
              <Download className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">{t('mat.exportLedger')}</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('mat.col.material')}</TableHead>
                <TableHead className="text-right">{t('mat.col.delivered')}</TableHead>
                <TableHead className="text-right">{t('mat.col.consumed')}</TableHead>
                <TableHead className="text-right">{t('mat.col.onSite')}</TableHead>
                <TableHead className="text-right">{t('mat.col.stockValue')}</TableHead>
                <TableHead className="text-right">{t('mat.col.spend')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.materials.map((m) => {
                // #207: server-owned flag (MaterialRow.lowStock, computed by
                // the ONE rule in modules/inventory/low-stock.ts against this
                // ledger's own quantities) — the old client-side recompute
                // is gone; the badge renders what the server says.
                const lowStock = m.lowStock
                return (
                  <TableRow key={m.id} className={lowStock ? 'bg-amber-50/50' : undefined}>
                    <TableCell className="font-medium text-stone-800">
                      {m.name}
                      <span className="text-xs text-stone-400 ml-1">/ {m.unit}</span>
                      {lowStock && <Badge className="ml-2 bg-amber-100 text-amber-800 border-0 text-[10px] hover:bg-amber-100">{t('mat.runningLow')}</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{m.deliveredQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-stone-500">{m.consumedQty.toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums font-semibold ${lowStock ? 'text-amber-700' : 'text-stone-800'}`}>{m.onSiteQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatKES(m.stockValue)}</TableCell>
                    <TableCell className="text-right tabular-nums text-stone-600">{formatKES(m.deliveredCost)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Delivery log */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('mat.deliveryLog')}</CardTitle>
          <CardDescription>{t('mat.deliveryLogDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto pr-2 -mr-2 space-y-2" role="region" aria-label={t('mat.deliveryLogAria')}>
            {data.deliveries.map((d) => {
              const m = data.materials.find((x) => x.id === d.materialId)
              return (
                <div key={d.id} className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white p-3">
                  <div className="w-10 h-10 rounded-lg bg-stone-100 flex items-center justify-center shrink-0" aria-hidden>
                    <Truck className="w-5 h-5 text-stone-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-stone-800">
                        {d.quantity.toLocaleString()} {m?.unit} · {m?.name}
                      </span>
                      <SourceBadge source={d.source} />
                    </div>
                    <p className="text-xs text-stone-500 truncate">
                      {d.supplier === 'Unknown supplier' ? t('mat.unknownSupplier') : d.supplier} · {dateShort(d.date)}
                      {d.rawTranscript && <TooltipProvider><Tooltip><TooltipTrigger asChild><span className="italic text-stone-400 cursor-help"> “{d.rawTranscript.slice(0, 42)}{d.rawTranscript.length > 42 ? '…' : ''}”</span></TooltipTrigger><TooltipContent className="max-w-72 text-xs"><p className="italic">“{d.rawTranscript}”</p></TooltipContent></Tooltip></TooltipProvider>}
                    </p>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-stone-700 shrink-0">{formatKES(d.totalCost)}</span>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Consumption recent */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900 flex items-center gap-2"><PackageSearch className="w-5 h-5 text-amber-600" aria-hidden /> {t('mat.recentConsumption')}</CardTitle>
          <CardDescription>{t('mat.recentConsumptionDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-72 overflow-y-auto pr-2 -mr-2 space-y-1.5">
            {data.consumptions.slice(0, 20).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm border-b border-stone-100 pb-1.5">
                <div className="min-w-0">
                  <span className="font-medium text-stone-800">{c.quantity.toLocaleString()} {c.unit} {c.materialName}</span>
                  {c.phaseName && <Badge variant="outline" className="ml-2 text-[10px]">{c.phaseName}</Badge>}
                  {c.note && <p className="text-xs text-stone-400 truncate">{c.note}</p>}
                </div>
                <span className="text-xs text-stone-400 shrink-0">{dateShort(c.date)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Delivery dialog */}
      <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('mat.dialog.delivery.title')}</DialogTitle>
            <DialogDescription>{t('mat.dialog.delivery.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2 col-span-2">
                <Label>{t('mat.label.material')}</Label>
                <Select value={dMaterial} onValueChange={(v) => { setDMaterial(v); const m = mat(v); if (m) setDCost(String(m.unitPrice)) }}>
                  <SelectTrigger><SelectValue placeholder={t('mat.ph.chooseMaterial')} /></SelectTrigger>
                  <SelectContent>
                    {data.materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} (KSh {m.unitPrice}/{m.unit})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="qty">{t('mat.label.quantity')}</Label>
                <Input id="qty" type="number" min="1" value={dQty} onChange={(e) => setDQty(e.target.value)} placeholder={t('mat.ph.qty')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cost">{t('mat.label.unitCost')}</Label>
                <Input id="cost" type="number" min="1" value={dCost} onChange={(e) => setDCost(e.target.value)} />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="supplier">{t('mat.label.supplier')}</Label>
                <Input id="supplier" value={dSupplier} onChange={(e) => setDSupplier(e.target.value)} placeholder={t('mat.ph.supplier')} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeliveryOpen(false)}>{t('mat.cancel')}</Button>
            <Button onClick={() => void logDelivery()} className="bg-amber-600 hover:bg-amber-700 text-white gap-1"><Plus className="w-4 h-4" aria-hidden /> {t('mat.logDelivery')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Consumption dialog */}
      <Dialog open={consumptionOpen} onOpenChange={setConsumptionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('mat.dialog.usage.title')}</DialogTitle>
            <DialogDescription>{t('mat.dialog.usage.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2 col-span-2">
                <Label>{t('mat.label.material')}</Label>
                <Select value={cMaterial} onValueChange={setCMaterial}>
                  <SelectTrigger><SelectValue placeholder={t('mat.ph.chooseMaterial')} /></SelectTrigger>
                  <SelectContent>
                    {data.materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} ({t('mat.onSiteQty', { qty: m.onSiteQty })})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cqty">{t('mat.label.quantityUsed')}</Label>
                <Input id="cqty" type="number" min="0.5" step="0.5" value={cQty} onChange={(e) => setCQty(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t('mat.label.phase')}</Label>
                <Select value={cPhase} onValueChange={setCPhase}>
                  <SelectTrigger><SelectValue placeholder={t('mat.ph.optional')} /></SelectTrigger>
                  <SelectContent>
                    {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="note">{t('mat.label.note')}</Label>
                <Input id="note" value={cNote} onChange={(e) => setCNote(e.target.value)} placeholder={t('mat.ph.note')} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsumptionOpen(false)}>{t('mat.cancel')}</Button>
            <Button onClick={() => void logConsumption()} className="bg-amber-600 hover:bg-amber-700 text-white gap-1"><PackageMinus className="w-4 h-4" aria-hidden /> {t('mat.logUsage')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Add material dialog */}
      <Dialog open={materialOpen} onOpenChange={setMaterialOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('mat.dialog.material.title')}</DialogTitle>
            <DialogDescription>{t('mat.dialog.material.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="mname">{t('mat.label.materialName')}</Label>
              <Input id="mname" value={mName} onChange={(e) => setMName(e.target.value)} placeholder={t('mat.ph.materialName')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="munit">{t('mat.label.unit')}</Label>
                <Input id="munit" value={mUnit} onChange={(e) => setMUnit(e.target.value)} placeholder={t('mat.ph.unit')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mprice">{t('mat.label.unitPrice')}</Label>
                <Input id="mprice" type="number" min="0" value={mPrice} onChange={(e) => setMPrice(e.target.value)} placeholder={t('mat.ph.price')} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMaterialOpen(false)} disabled={materialBusy}>{t('mat.cancel')}</Button>
            <Button onClick={() => void addMaterial()} disabled={materialBusy} className="bg-amber-600 hover:bg-amber-700 text-white gap-1">
              <Plus className="w-4 h-4" aria-hidden /> {t('mat.addMaterial')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- Site Store (spec §35) ----------------

// Form values map to INVENTORY_ACTIONS; labels render through the dict
// (mat.movement.*) — the value strings are state keys and never change.
const MOVEMENT_TYPES: Array<{ value: string; key: string }> = [
  { value: 'opening', key: 'mat.movement.opening' },
  { value: 'received', key: 'mat.movement.received' },
  { value: 'consumed', key: 'mat.movement.consumed' },
  { value: 'transfer', key: 'mat.movement.transfer' },
  { value: 'return', key: 'mat.movement.return' },
  { value: 'damage', key: 'mat.movement.damage' },
  { value: 'adjust', key: 'mat.movement.adjust' },
]

// StockMovementType (the stored enum) → dict key for the badge label.
const MOVEMENT_LABELS: Record<string, string> = {
  opening: 'mat.mtype.opening',
  received: 'mat.mtype.received',
  consumed: 'mat.mtype.consumed',
  transferred_in: 'mat.mtype.transferred_in',
  transferred_out: 'mat.mtype.transferred_out',
  returned: 'mat.mtype.returned',
  damaged: 'mat.mtype.damaged',
  adjusted: 'mat.mtype.adjusted',
}

const MOVEMENT_BADGES: Record<string, string> = {
  opening: 'bg-stone-100 text-stone-600',
  received: 'bg-emerald-100 text-emerald-800',
  consumed: 'bg-sky-100 text-sky-800',
  transferred_in: 'bg-violet-100 text-violet-800',
  transferred_out: 'bg-violet-100 text-violet-800',
  returned: 'bg-amber-100 text-amber-900',
  damaged: 'bg-orange-100 text-orange-800',
  adjusted: 'bg-teal-100 text-teal-800',
}

function MovementBadge({ type }: { type: StockMovementType | string }) {
  const t = useT()
  const key = MOVEMENT_LABELS[type]
  return (
    <Badge className={`border-0 text-[10px] hover:opacity-90 ${MOVEMENT_BADGES[type] ?? 'bg-stone-100 text-stone-600'}`}>
      {key ? t(key) : type.replace('_', ' ')}
    </Badge>
  )
}

/**
 * #207: the low-stock badge/tile consume the SERVER flag (the slice's
 * InventoryItemRow.lowStock) — this client-side heuristic was the second of
 * the two divergent recomputes the issue deleted. The rule itself lives in
 * modules/inventory/low-stock.ts and is applied at the payload boundary.
 */
function SiteStoreCard() {
  const { data, dispatch, online, outbox, viewMode, actionBusy } = useMjengo()
  const t = useT()
  const [movementOpen, setMovementOpen] = useState(false)
  const [mType, setMType] = useState('received')
  const [mItem, setMItem] = useState('')
  const [mName, setMName] = useState('')
  const [mUnit, setMUnit] = useState('')
  const [mLocation, setMLocation] = useState('Site Store')
  const [mQty, setMQty] = useState('')
  const [mCost, setMCost] = useState('')
  const [mRef, setMRef] = useState('')
  const [mNote, setMNote] = useState('')
  const [mTo, setMTo] = useState('')
  // #203: structured consumption attribution — the source request line the
  // operator picks when one is known ('none' = unattributed, the pre-#203
  // shape). Rides the payload as requestLineId; the free-text reference field
  // stays for humans.
  const [mRequestLine, setMRequestLine] = useState('none')
  // Stock reconciliation (issue #194): run-count dialog + reconciliation detail.
  const [countOpen, setCountOpen] = useState(false)
  const [countDetailId, setCountDetailId] = useState<string | null>(null)
  const [countBy, setCountBy] = useState('')
  const [countNote, setCountNote] = useState('')
  const [countQtys, setCountQtys] = useState<Record<string, string>>({})
  const busy = actionBusy !== null

  if (!data) return null
  const isClient = viewMode === 'client'
  const items = data.inventory.items
  const movements = data.inventory.movements
  const counts = data.inventory.counts
  const suppliers = data.supply.suppliers
  const incoming = data.supply.orders.filter((o) => o.status === 'delivering')
  const consumedTotal = items.reduce((s, i) => s + i.consumedQty, 0)
  const damagedTotal = items.reduce((s, i) => s + i.damagedQty, 0)
  const transfersTotal = movements.filter((m) => m.type === 'transferred_out').length
  const lowCount = items.filter((i) => i.lowStock).length
  const offlineNote = t('field.savedQueued', { count: outbox.length })

  const lastMovementByItem = new Map<string, { reference: string | null; createdAt: string; type: string }>()
  for (const m of movements) {
    if (!lastMovementByItem.has(m.inventoryItemId)) {
      lastMovementByItem.set(m.inventoryItemId, { reference: m.reference, createdAt: m.createdAt, type: m.type })
    }
  }

  const supplierName = (id: string | null) => suppliers.find((s) => s.id === id)?.businessName ?? '—'

  const isNewLine = mType === 'opening' || mType === 'received'
  const selectedItem = items.find((i) => i.id === mItem)
  // #203: candidate source request lines for the consume dialog — LIVE
  // requests only (draft/submitted/approved/converted; rejected/withdrawn
  // never sourced anything). When nothing fuzzy-matches the picked stock
  // line, ALL live lines are offered: name drift between the request and the
  // stock item is exactly the case manual attribution exists for.
  const consumeLineOptions = (() => {
    const live = data.supply.requests.filter((r) => ['draft', 'submitted', 'approved', 'converted'].includes(r.status))
    const all = live.flatMap((r) =>
      r.lines.map((l) => ({ id: l.id, requestCode: r.requestCode, materialName: l.materialName, unit: l.unit, qty: l.qty })),
    )
    if (!selectedItem) return all
    const matching = all.filter((l) => materialMatches(l.materialName, selectedItem.materialName))
    return matching.length ? matching : all
  })()

  function openMovementDialog() {
    setMType('received')
    setMItem(items[0]?.id ?? '')
    setMName(''); setMUnit(''); setMLocation('Site Store')
    setMQty(''); setMCost(''); setMRef(''); setMNote(''); setMTo('')
    setMRequestLine('none')
    setMovementOpen(true)
  }

  // ---- Stock reconciliation (issue #194) ----

  function openCountDialog() {
    setCountBy('')
    setCountNote('')
    setCountQtys({})
    setCountOpen(true)
  }

  async function saveCount() {
    if (!data) return
    if (!countBy.trim()) { toast.error(t('mat.count.error.noCounter')); return }
    const countsList: Array<{ inventoryItemId: string; countedQty: number }> = []
    let badQty = false
    for (const i of items) {
      const raw = countQtys[i.id]
      if (typeof raw !== 'string' || raw.trim() === '') continue // not counted in this session
      const countedQty = Number(raw)
      if (!Number.isFinite(countedQty) || countedQty < 0) { badQty = true; continue }
      countsList.push({ inventoryItemId: i.id, countedQty })
    }
    if (badQty) { toast.error(t('mat.count.error.badQty')); return }
    if (countsList.length === 0) { toast.error(t('mat.count.error.noLines')); return }
    // countedAt is stamped HERE (count time), not at flush time — an offline
    // count still snapshots the world the site saw when the bags were counted.
    const ok = await dispatch('inventory.count', {
      countedBy: countBy.trim(),
      countedAt: new Date().toISOString(),
      note: countNote.trim() || undefined,
      counts: countsList,
    }, `Physical stock count: ${countsList.length} lines by ${countBy.trim()}`)
    if (ok) {
      toast.success(online ? t('mat.count.saved', { count: countsList.length }) : t('field.savedQueued', { count: outbox.length }))
      setCountOpen(false)
    } else {
      toast.error(t('mat.count.failed'))
    }
  }

  function exportReconciliation() {
    if (!data) return
    const filename = `${projectFilePrefix(data)}-stock-reconciliation.csv`
    downloadCSV(filename, reconciliationCSV(t, data))
    toast.success(t('field.exported', { file: filename }))
  }

  async function postAdjustments(countId: string) {
    // The movement count is derivable client-side: one `adjusted` movement
    // per non-zero-variance line (zero-variance lines post none).
    const detail = counts.find((c) => c.id === countId)
    const toPost = detail ? detail.items.filter((line) => line.variance !== 0).length : 0
    const ok = await dispatch('inventory.count.post', { countId }, `Posted count-linked adjustments (count ${countId.slice(-6)})`)
    if (ok) {
      toast.success(online
        ? (toPost > 0 ? t('mat.count.posted', { count: toPost }) : t('mat.count.zeroVariance'))
        : t('field.savedQueued', { count: outbox.length }))
      setCountDetailId(null)
    } else {
      toast.error(t('mat.count.postFailed'))
    }
  }

  async function recordMovement() {
    const qty = Number(mQty)
    if (!(qty > 0)) { toast.error(t('mat.error.qtyPositive')); return }
    if (isNewLine && !mName.trim()) { toast.error(t('mat.error.lineName')); return }
    if (!isNewLine && !selectedItem) { toast.error(t('mat.error.pickLine')); return }
    if (mType === 'transfer' && !mTo.trim()) { toast.error(t('mat.error.transferDest')); return }

    const unit = isNewLine ? mUnit.trim() || 'unit' : selectedItem?.unit ?? ''
    const matName = isNewLine ? mName.trim() : selectedItem?.materialName ?? ''
    let payload: Record<string, unknown> = { qty }
    let label = ''
    // Toast label — presentation copy (translated); the dispatch `label`
    // below is the EN audit-trail string and stays English on purpose.
    let toastLabel = ''
    // Action names (INVENTORY_ACTIONS): 'opening' UI label → inventory.open
    let action: 'inventory.open' | 'inventory.receive' | 'inventory.consume' | 'inventory.transfer' | 'inventory.return' | 'inventory.damage' | 'inventory.adjust'
    switch (mType) {
      case 'opening':
        action = 'inventory.open'
        payload = { ...payload, materialName: mName.trim(), unit: mUnit.trim() || 'unit', location: mLocation.trim() || 'Site Store', unitCost: Number(mCost) > 0 ? Number(mCost) : undefined, note: mNote.trim() || undefined }
        label = `Opening stock: ${qty} ${mUnit.trim() || 'unit'} ${mName.trim()}`
        toastLabel = t('mat.toastLbl.opening', { qty, unit, name: mName.trim() })
        break
      case 'received':
        action = 'inventory.receive'
        payload = { ...payload, materialName: mName.trim(), unit: mUnit.trim() || 'unit', location: mLocation.trim() || 'Site Store', unitCost: Number(mCost) > 0 ? Number(mCost) : undefined, reference: mRef.trim() || undefined, note: mNote.trim() || undefined }
        label = `Received ${qty} ${mUnit.trim() || 'unit'} ${mName.trim()}`
        toastLabel = t('mat.toastLbl.received', { qty, unit, name: mName.trim() })
        break
      case 'consumed':
        action = 'inventory.consume'
        payload = { ...payload, inventoryItemId: selectedItem?.id, reference: mRef.trim() || undefined, note: mNote.trim() || undefined, requestLineId: mRequestLine !== 'none' ? mRequestLine : undefined }
        label = `Consumed ${qty} ${selectedItem?.unit} ${selectedItem?.materialName}`
        toastLabel = t('mat.toastLbl.consumed', { qty, unit, name: matName })
        break
      case 'transfer':
        action = 'inventory.transfer'
        payload = { ...payload, inventoryItemId: selectedItem?.id, toLocation: mTo.trim(), note: mNote.trim() || undefined }
        label = `Transferred ${qty} ${selectedItem?.unit} ${selectedItem?.materialName} → ${mTo.trim()}`
        toastLabel = t('mat.toastLbl.transfer', { qty, unit, name: matName, to: mTo.trim() })
        break
      case 'return':
        action = 'inventory.return'
        payload = { ...payload, inventoryItemId: selectedItem?.id, note: mNote.trim() || undefined }
        label = `Returned ${qty} ${selectedItem?.unit} ${selectedItem?.materialName}`
        toastLabel = t('mat.toastLbl.return', { qty, unit, name: matName })
        break
      case 'damage':
        action = 'inventory.damage'
        payload = { ...payload, inventoryItemId: selectedItem?.id, damageNote: mNote.trim() || 'damaged on site' }
        label = `Damaged ${qty} ${selectedItem?.unit} ${selectedItem?.materialName}`
        toastLabel = t('mat.toastLbl.damage', { qty, unit, name: matName })
        break
      default: // adjust
        action = 'inventory.adjust'
        payload = { ...payload, inventoryItemId: selectedItem?.id, reason: mNote.trim() || 'count correction' }
        label = `Adjusted ${qty} ${selectedItem?.unit} ${selectedItem?.materialName}`
        toastLabel = t('mat.toastLbl.adjust', { qty, unit, name: matName })
        break
    }

    const ok = await dispatch(action, payload, label)
    if (ok) {
      toast.success(online ? t('mat.movementUpdated', { label: toastLabel }) : offlineNote)
      setMovementOpen(false)
    } else {
      toast.error(t('mat.movementFailed'))
    }
  }

  const tiles: Array<{ labelKey: string; hintKey: string; value: string; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; warn?: boolean }> = [
    { labelKey: 'mat.store.t.lines', hintKey: 'mat.store.t.linesHint', value: String(items.length), icon: Warehouse },
    { labelKey: 'mat.store.t.low', hintKey: 'mat.store.t.lowHint', value: String(lowCount), icon: AlertTriangle, warn: true },
    { labelKey: 'mat.store.t.incoming', hintKey: 'mat.store.t.incomingHint', value: String(incoming.length), icon: Truck, warn: incoming.length > 0 },
    { labelKey: 'mat.store.t.consumed', hintKey: 'mat.store.t.consumedHint', value: consumedTotal ? consumedTotal.toLocaleString() : '0', icon: PackageMinus },
    { labelKey: 'mat.store.t.damaged', hintKey: 'mat.store.t.damagedHint', value: damagedTotal ? damagedTotal.toLocaleString() : '0', icon: Flame, warn: damagedTotal > 0 },
    { labelKey: 'mat.store.t.transfers', hintKey: 'mat.store.t.transfersHint', value: String(transfersTotal), icon: ArrowLeftRight },
  ]

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <ClipboardList className="h-5 w-5 text-amber-600" aria-hidden /> {t('mat.store.title')}
          </CardTitle>
          <CardDescription>
            {t('mat.store.desc')}
          </CardDescription>
        </div>
        {!isClient && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" disabled={busy || items.length === 0} onClick={openCountDialog} aria-label={t('mat.count.runAria')}>
              <ClipboardCheck className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('mat.count.run')}</span>
            </Button>
            <Button size="sm" className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={openMovementDialog} aria-label={t('mat.store.recordAria')}>
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('mat.store.record')}</span>
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {/* tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {tiles.map((tile) => {
            const Icon = tile.icon
            return (
              <div key={tile.labelKey} className={`rounded-lg border p-3 ${tile.warn && Number(tile.value) > 0 ? 'border-orange-200 bg-orange-50/70' : 'border-stone-200 bg-stone-50/60'}`}>
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {t(tile.labelKey)}
                </p>
                <p className="pt-1 text-xl font-bold tabular-nums text-stone-900">{tile.value}</p>
                <p className="pt-0.5 text-[10px] leading-snug text-stone-500">{t(tile.hintKey)}</p>
              </div>
            )
          })}
        </div>

        {/* stock table */}
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-xs text-stone-500">
            {t('mat.store.empty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-stone-200">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('mat.store.col.material')}</TableHead>
                  <TableHead className="text-right">{t('mat.store.col.closing')}</TableHead>
                  <TableHead>{t('mat.store.col.unit')}</TableHead>
                  <TableHead>{t('mat.store.col.location')}</TableHead>
                  <TableHead>{t('mat.store.col.supplier')}</TableHead>
                  <TableHead>{t('mat.store.col.lastRef')}</TableHead>
                  <TableHead className="text-right">{t('mat.store.col.updated')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const low = item.lowStock // #207: the server's flag, not a client recompute
                  const last = lastMovementByItem.get(item.id)
                  return (
                    <TableRow key={item.id} className={low ? 'bg-amber-50/50' : undefined}>
                      <TableCell className="font-medium text-stone-800">
                        {item.materialName}
                        {low && <Badge className="ml-2 bg-amber-100 text-amber-800 border-0 text-[10px] hover:bg-amber-100">{t('mat.store.lowStock')}</Badge>}
                      </TableCell>
                      <TableCell className={`text-right font-semibold tabular-nums ${low ? 'text-amber-700' : 'text-stone-800'}`}>{item.closingQty.toLocaleString()}</TableCell>
                      <TableCell className="text-stone-600">{item.unit}</TableCell>
                      <TableCell className="text-stone-600">{item.location}</TableCell>
                      <TableCell className="text-stone-600">{supplierName(item.supplierId)}</TableCell>
                      <TableCell className="text-stone-600">
                        {last ? (
                          <span className="flex items-center gap-1.5">
                            <MovementBadge type={last.type} />
                            {last.reference ? <span className="font-mono text-xs text-stone-500">{last.reference}</span> : <span className="text-xs text-stone-400">—</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-stone-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-stone-500">{dateShort(item.updatedAt)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* recent movements */}
        <div>
          <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('mat.store.recent')}</p>
          {movements.length === 0 ? (
            <p className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-xs text-stone-500">
              {t('mat.store.noMovements')}
            </p>
          ) : (
            <div className="max-h-72 space-y-1.5 overflow-y-auto pr-2 -mr-2">
              {movements.slice(0, 12).map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 border-b border-stone-100 pb-1.5 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <MovementBadge type={m.type} />
                    <span className="truncate font-medium text-stone-800">
                      {m.quantity.toLocaleString()} {m.unit} {m.materialName}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-stone-400">
                    {m.reference && <span className="font-mono">{m.reference}</span>}
                    <span title={m.note ?? undefined}>{m.recordedBy}</span>
                    <span>{dateShort(m.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* stock counts — reconciliation history (issue #194) */}
        <div>
          <div className="flex items-center justify-between pb-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('mat.count.historyTitle')}</p>
            {counts.length > 0 && (
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[11px] text-stone-500" onClick={exportReconciliation} aria-label={t('mat.count.exportAria')}>
                <Download className="h-3.5 w-3.5" aria-hidden /> {t('mat.count.export')}
              </Button>
            )}
          </div>
          {counts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-xs text-stone-500">
              {t('mat.count.empty')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {counts.slice(0, 5).map((c) => {
                const netVariance = c.items.reduce((s, line) => s + line.variance, 0)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCountDetailId(c.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3 text-left transition-colors hover:border-amber-300 hover:bg-amber-50/40"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={`border-0 text-[10px] hover:opacity-90 ${c.status === 'posted' ? 'bg-teal-100 text-teal-800' : 'bg-amber-100 text-amber-800'}`}>
                          {c.status === 'posted' ? t('mat.count.status.posted') : t('mat.count.status.open')}
                        </Badge>
                        <span className="text-sm font-semibold text-stone-800">{dateShort(c.countedAt)}</span>
                        <span className="truncate text-xs text-stone-500">{c.countedBy}</span>
                      </div>
                      <p className="pt-0.5 text-[11px] text-stone-500">
                        {t('mat.count.lines', { count: c.itemCount })}
                        {c.uncounted.length > 0 ? ` · ${t('mat.count.uncountedCount', { count: c.uncounted.length })}` : ''}
                        {c.note ? ` · ${c.note}` : ''}
                      </p>
                    </div>
                    <span className={`shrink-0 text-xs font-semibold tabular-nums ${netVariance === 0 ? 'text-stone-400' : netVariance > 0 ? 'text-orange-600' : 'text-emerald-600'}`}>
                      {t('mat.count.varianceTotal', { qty: netVariance > 0 ? `+${netVariance.toLocaleString()}` : netVariance.toLocaleString() })}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </CardContent>

      {/* ---- record movement dialog ---- */}
      <Dialog open={movementOpen} onOpenChange={setMovementOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('mat.store.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('mat.store.dialog.desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-1">
            <div className="space-y-2">
              <Label>{t('mat.store.label.type')}</Label>
              <Select value={mType} onValueChange={(v) => setMType(v)}>
                <SelectTrigger aria-label={t('mat.store.label.type')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MOVEMENT_TYPES.map((mt) => (
                    <SelectItem key={mt.value} value={mt.value}>{t(mt.key)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isNewLine ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="ss-material">{t('mat.store.label.materialNew')}</Label>
                  <Input id="ss-material" value={mName} onChange={(e) => setMName(e.target.value)} placeholder={t('mat.ph.ssMaterial')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ss-unit">{t('mat.store.label.unit')}</Label>
                  <Input id="ss-unit" value={mUnit} onChange={(e) => setMUnit(e.target.value)} placeholder={t('mat.ph.ssUnit')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ss-loc">{t('mat.store.label.location')}</Label>
                  <Input id="ss-loc" value={mLocation} onChange={(e) => setMLocation(e.target.value)} placeholder={t('mat.ph.ssLocation')} />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>{t('mat.store.label.stockLine')}</Label>
                <Select value={mItem} onValueChange={(v) => { setMItem(v); setMRequestLine('none') }}>
                  <SelectTrigger aria-label={t('mat.store.label.stockLine')}><SelectValue placeholder={t('mat.ph.chooseStockLine')} /></SelectTrigger>
                  <SelectContent>
                    {items.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {t('mat.store.lineOption', { name: i.materialName, location: i.location, qty: i.closingQty, unit: i.unit })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ss-qty">{mType === 'adjust' ? t('mat.store.label.qtyAdjust') : t('mat.store.label.qty')}</Label>
                <Input id="ss-qty" type="number" min="0.5" step="0.5" value={mQty} onChange={(e) => setMQty(e.target.value)} />
              </div>
              {isNewLine && (
                <div className="space-y-2">
                  <Label htmlFor="ss-cost">{t('mat.store.label.unitCost')}</Label>
                  <Input id="ss-cost" type="number" min="0" value={mCost} onChange={(e) => setMCost(e.target.value)} placeholder={t('mat.ph.optionalLower')} />
                </div>
              )}
            </div>

            {mType === 'transfer' && (
              <div className="space-y-2">
                <Label htmlFor="ss-to">{t('mat.store.label.toLocation')}</Label>
                <Input id="ss-to" value={mTo} onChange={(e) => setMTo(e.target.value)} placeholder={t('mat.ph.toLocation')} />
              </div>
            )}
            {mType === 'consumed' && (
              <div className="space-y-2">
                {/* #203: the source-line pick — structured consumption
                    attribution (requestLineId on the movement). Optional by
                    design: unattributed consumption stays legal. */}
                <Label>{t('mat.store.label.requestLine')}</Label>
                <Select value={mRequestLine} onValueChange={setMRequestLine}>
                  <SelectTrigger aria-label={t('mat.store.label.requestLine')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('mat.store.requestLineNone')}</SelectItem>
                    {consumeLineOptions.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {t('mat.store.requestLineOption', { code: l.requestCode, name: l.materialName, qty: l.qty, unit: l.unit })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-snug text-stone-400">{t('mat.store.requestLineHint')}</p>
              </div>
            )}
            {mType === 'consumed' && (
              <div className="space-y-2">
                <Label htmlFor="ss-ref">{t('mat.store.label.reference')}</Label>
                <Input id="ss-ref" value={mRef} onChange={(e) => setMRef(e.target.value)} placeholder={t('mat.ph.optionalLower')} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="ss-note">
                {mType === 'damage' ? t('mat.store.label.damageNote') : mType === 'adjust' ? t('mat.store.label.reason') : t('mat.label.note')}
              </Label>
              <Input id="ss-note" value={mNote} onChange={(e) => setMNote(e.target.value)} placeholder={mType === 'damage' ? t('mat.ph.damageNote') : t('mat.ph.optionalLower')} />
            </div>
            {selectedItem && !isNewLine && (
              <p className="text-[11px] text-stone-400">
                {t('mat.store.selectedLine', { name: selectedItem.materialName, location: selectedItem.location, qty: selectedItem.closingQty, unit: selectedItem.unit })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovementOpen(false)}>{t('mat.cancel')}</Button>
            <Button onClick={() => void recordMovement()} disabled={busy} className="bg-amber-600 hover:bg-amber-700 text-white gap-1">
              <Plus className="w-4 h-4" aria-hidden /> {t('mat.store.record')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- run stock count dialog (issue #194) ---- */}
      <Dialog open={countOpen} onOpenChange={setCountOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-900">{t('mat.count.dialog.title')}</DialogTitle>
            <DialogDescription>{t('mat.count.dialog.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="cnt-by">{t('mat.count.label.countedBy')}</Label>
                <Input id="cnt-by" value={countBy} onChange={(e) => setCountBy(e.target.value)} placeholder={t('mat.count.ph.countedBy')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cnt-note">{t('mat.count.label.note')}</Label>
                <Input id="cnt-note" value={countNote} onChange={(e) => setCountNote(e.target.value)} placeholder={t('mat.count.ph.noteOptional')} />
              </div>
            </div>
            <div className="max-h-72 space-y-1.5 overflow-y-auto pr-2 -mr-2">
              {items.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 p-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-800">{i.materialName}</p>
                    <p className="text-[11px] text-stone-500">{t('mat.count.countLine', { name: i.materialName, location: i.location, qty: i.closingQty, unit: i.unit })}</p>
                  </div>
                  <Input
                    aria-label={t('mat.count.col.counted')}
                    className="h-9 w-28 shrink-0 text-right tabular-nums"
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder={t('mat.count.ph.countedQty')}
                    value={countQtys[i.id] ?? ''}
                    onChange={(e) => setCountQtys({ ...countQtys, [i.id]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-stone-400">{t('mat.count.uncounted')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCountOpen(false)} disabled={busy}>{t('mat.cancel')}</Button>
            <Button onClick={() => void saveCount()} disabled={busy || items.length === 0} className="gap-1 bg-amber-600 text-white hover:bg-amber-700">
              <ClipboardCheck className="w-4 h-4" aria-hidden /> {t('mat.count.record')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- reconciliation detail dialog (variance view + posting) ---- */}
      <Dialog open={countDetailId !== null} onOpenChange={(open) => { if (!open) setCountDetailId(null) }}>
        <DialogContent className="sm:max-w-2xl">
          {(() => {
            const c = counts.find((x) => x.id === countDetailId)
            if (!c) return null
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-stone-900">{t('mat.count.detail.title')}</DialogTitle>
                  <DialogDescription>
                    {t('mat.count.detail.desc')} — {dateShort(c.countedAt)} · {c.countedBy}{c.note ? ` · ${c.note}` : ''}
                  </DialogDescription>
                </DialogHeader>
                <div className="max-h-96 overflow-y-auto pr-2 -mr-2">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{t('mat.count.col.material')}</TableHead>
                        <TableHead>{t('mat.count.col.location')}</TableHead>
                        <TableHead className="text-right">{t('mat.count.col.expected')}</TableHead>
                        <TableHead className="text-right">{t('mat.count.col.counted')}</TableHead>
                        <TableHead className="text-right">{t('mat.count.col.variance')}</TableHead>
                        <TableHead className="text-right">{t('mat.count.col.posted')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.items.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="font-medium text-stone-800">{line.materialName}</TableCell>
                          <TableCell className="text-stone-600">{line.location}</TableCell>
                          <TableCell className="text-right tabular-nums text-stone-600">{line.expectedQty.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold text-stone-800">{line.countedQty.toLocaleString()}</TableCell>
                          <TableCell className={`text-right tabular-nums font-semibold ${line.variance === 0 ? 'text-stone-400' : line.variance > 0 ? 'text-orange-600' : 'text-emerald-600'}`}>
                            {line.variance > 0 ? '+' : ''}{line.variance.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-stone-600">{line.postedQty === null ? '—' : line.postedQty.toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {c.uncounted.length > 0 && (
                    <div className="pt-3">
                      <p className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('mat.count.uncounted')}</p>
                      <div className="space-y-1">
                        {c.uncounted.map((line) => (
                          <p key={line.inventoryItemId} className="text-xs text-stone-500">
                            {t('mat.count.countLine', { name: line.materialName, location: line.location, qty: line.expectedQty, unit: line.unit })}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <DialogFooter>
                  {c.status === 'open' ? (
                    <Button onClick={() => void postAdjustments(c.id)} disabled={busy} className="gap-1 bg-teal-600 text-white hover:bg-teal-700">
                      <ClipboardCheck className="w-4 h-4" aria-hidden /> {t('mat.count.post')}
                    </Button>
                  ) : (
                    <Badge className="border-0 bg-teal-100 text-teal-800 hover:bg-teal-100">{t('mat.count.status.posted')}</Badge>
                  )}
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
