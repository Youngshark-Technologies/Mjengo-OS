'use client'

// Finder procurement dashboard (Finder spec §18/§20): money tiles
// (Required / Purchased / Committed / Remaining), status tiles (pending
// requests, pending approvals, orders in transit, discrepancies), the
// BOQ-lite per-material table with "Find suppliers for the remaining"
// prefill into the search, the approval-rules settings card (§11) and the
// cement price-alert chip (read-only intel surface). All numbers are computed
// with the pure insights module the server shares — no drift.

import { useMemo } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import {
  AlertTriangle, Boxes, ClipboardList, Hourglass, Landmark, LayoutDashboard, Lock, PackageSearch, ShoppingCart, Truck, Warehouse,
} from 'lucide-react'
import { boqProgress, boqRows, procurementTotals } from '@/backend/modules/supply/insights'
import { useT } from '@/frontend/i18n/provider'
import { useFinderLink } from './requests/finder-link'
import { fmtQty, formatKes } from './requests/bits'
import { PriceAlertChip } from './dashboard/price-alert-chip'
import { RulesCard } from './dashboard/rules-card'
import { BoqCard } from './dashboard/boq-card'
import { DataTable } from '@/frontend/mjengo/uikit/data-table'
import { EmptyState } from '@/frontend/mjengo/uikit/empty-state'

export function DashboardSection() {
  const { data, viewMode } = useMjengo()
  const t = useT()
  const { setSearchPrefill } = useFinderLink()
  const isSiteTeam = viewMode === 'owner'

  const requests = data?.supply.requests ?? []
  const orders = data?.supply.orders ?? []
  const approvals = data?.supply.approvals ?? []
  const suppliers = data?.supply.suppliers ?? []

  const totals = useMemo(
    () =>
      procurementTotals(
        requests.map((r) => ({
          status: r.status,
          lines: r.lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
          quotes: r.quotes.map((q) => ({ status: q.status, totalLanded: q.totalLanded })),
        })),
        orders.map((o) => ({
          status: o.status,
          total: o.total,
          lines: o.lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, qty: l.qty })),
          deliveries: o.deliveries.map((d) => ({
            status: d.status,
            lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
          })),
        })),
        approvals.map((a) => ({ decision: a.decision })),
        suppliers.map((s) => ({ catalogItems: s.catalogItems })),
      ),
    [requests, orders, approvals, suppliers],
  )

  const boq = useMemo(() => boqRows(
    requests.map((r) => ({
      status: r.status,
      lines: r.lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
      quotes: r.quotes.map((q) => ({ status: q.status, totalLanded: q.totalLanded })),
    })),
    orders.map((o) => ({
      status: o.status,
      total: o.total,
      lines: o.lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, qty: l.qty })),
      deliveries: o.deliveries.map((d) => ({
        status: d.status,
        lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
      })),
    })),
  ), [requests, orders])

  // #203: the LINEAGE BOQ-vs-actual view — per BOQ line, estimated/requested/
  // ordered/delivered/consumed/remaining walked over the FK stamps
  // (boqLineId / requestLineId), never over material names. The movements
  // input is the inventory slice's flattened movement log (only
  // type/quantity/requestLineId are read).
  const progress = useMemo(() => boqProgress(
    data?.boq.boqs ?? [],
    requests.map((r) => ({
      id: r.id,
      requestCode: r.requestCode,
      status: r.status,
      lines: r.lines.map((l) => ({ id: l.id, boqLineId: l.boqLineId, materialName: l.materialName, unit: l.unit, qty: l.qty })),
    })),
    orders.map((o) => ({
      status: o.status,
      lines: o.lines.map((l) => ({ id: l.id, requestLineId: l.requestLineId, qty: l.qty })),
      deliveries: o.deliveries.map((d) => ({
        status: d.status,
        lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
      })),
    })),
    data?.inventory.movements ?? [],
  ), [data, requests, orders])

  if (!data) return null

  const moneyTiles: Array<{ labelKey: string; value: number; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; hintKey: string; tone: string }> = [
    {
      labelKey: 'finder.dash.tile.required',
      value: totals.required,
      icon: ClipboardList,
      hintKey: 'finder.dash.tile.requiredHint',
      tone: 'text-stone-900',
    },
    {
      labelKey: 'finder.dash.tile.purchased',
      value: totals.purchased,
      icon: ShoppingCart,
      hintKey: 'finder.dash.tile.purchasedHint',
      tone: 'text-emerald-700',
    },
    {
      labelKey: 'finder.dash.tile.committed',
      value: totals.committed,
      icon: Truck,
      hintKey: 'finder.dash.tile.committedHint',
      tone: 'text-amber-700',
    },
    {
      labelKey: 'finder.dash.tile.remaining',
      value: totals.remaining,
      icon: Warehouse,
      hintKey: 'finder.dash.tile.remainingHint',
      tone: 'text-stone-900',
    },
  ]

  const statusTiles: Array<{ labelKey: string; value: number; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; hintKey: string; warn: boolean }> = [
    { labelKey: 'finder.dash.tile.pendingRequests', value: totals.pendingRequests, icon: Hourglass, hintKey: 'finder.dash.tile.pendingRequestsHint', warn: false },
    { labelKey: 'finder.dash.tile.pendingApprovals', value: totals.pendingApprovals, icon: Lock, hintKey: 'finder.dash.tile.pendingApprovalsHint', warn: false },
    { labelKey: 'finder.dash.tile.inTransit', value: totals.ordersInTransit, icon: Truck, hintKey: 'finder.dash.tile.inTransitHint', warn: false },
    { labelKey: 'finder.dash.tile.discrepancies', value: totals.discrepancies, icon: AlertTriangle, hintKey: 'finder.dash.tile.discrepanciesHint', warn: true },
  ]

  return (
    <section aria-label={t('finder.dash.aria')} className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg text-stone-900">
            <LayoutDashboard className="h-5 w-5 text-amber-600" aria-hidden /> {t('finder.dash.title')}
            <PriceAlertChip pricePoints={data.intel.pricePoints} />
          </CardTitle>
          <CardDescription>
            {t('finder.dash.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* money tiles */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {moneyTiles.map((tile) => {
              const Icon = tile.icon
              return (
                <Card key={tile.labelKey} className="border-stone-200 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription className="flex items-center gap-1.5 text-xs">
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {t(tile.labelKey)}
                    </CardDescription>
                    <CardTitle className={`text-2xl font-bold tabular-nums ${tile.tone}`}>{formatKes(tile.value)}</CardTitle>
                  </CardHeader>
                  <CardContent><p className="text-xs leading-relaxed text-stone-500">{t(tile.hintKey)}</p></CardContent>
                </Card>
              )
            })}
          </div>

          {/* status tiles */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {statusTiles.map((tile) => {
              const Icon = tile.icon
              return (
                <div key={tile.labelKey} className={`rounded-lg border p-3 ${tile.warn && tile.value > 0 ? 'border-orange-200 bg-orange-50/70' : 'border-stone-200 bg-stone-50/60'}`}>
                  <p className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide ${tile.warn && tile.value > 0 ? 'text-orange-800' : 'text-stone-500'}`}>
                    <Icon className="h-3.5 w-3.5" aria-hidden /> {t(tile.labelKey)}
                  </p>
                  <p className={`pt-1 text-xl font-bold tabular-nums ${tile.warn && tile.value > 0 ? 'text-orange-900' : 'text-stone-900'}`}>{tile.value}</p>
                  <p className="pt-0.5 text-[10px] leading-snug text-stone-500">{t(tile.hintKey)}</p>
                </div>
              )
            })}
          </div>

          {/* BOQ entities (spec §28) — versioned estimates, approve → generate MR.
              The DERIVED required-vs-purchased view ("BOQ-lite") stays below. */}
          <BoqCard canManage={isSiteTeam} progress={progress} />

          {/* BOQ-lite table */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-stone-800">
                {t('finder.dash.boq.title')}
              </h3>
              <p className="text-[11px] text-stone-500">{t('finder.dash.boq.desc')}</p>
            </div>
            {/* BOQ-lite table (W3-F2: migrated to the shared DataTable —
                desktop table + mobile stacked cards, empty state via uikit) */}
            <DataTable
              columns={[
                {
                  key: 'materialKey',
                  header: t('finder.dash.boq.col.material'),
                  className: 'whitespace-normal',
                  render: (row) => (
                    <>
                      <span className="font-medium text-stone-800">{row.displayNames[0]}</span>
                      {row.displayNames.length > 1 && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] font-normal text-stone-400" title={t('finder.dash.boq.variants', { list: row.displayNames.join(' · ') })}>
                          {t(row.displayNames.length > 2 ? 'finder.dash.boq.variantsMany' : 'finder.dash.boq.variantsOne', { count: row.displayNames.length - 1 })}
                        </Badge>
                      )}
                      <span className="block text-[10px] text-stone-400">{t('finder.dash.boq.perUnit', { unit: row.unit })}</span>
                    </>
                  ),
                },
                { key: 'required', header: t('finder.dash.boq.col.required'), align: 'right', render: (row) => <span className="tabular-nums text-stone-700">{fmtQty(row.required)}</span> },
                { key: 'purchased', header: t('finder.dash.boq.col.purchased'), align: 'right', render: (row) => <span className="tabular-nums text-stone-700">{fmtQty(row.purchased)}</span> },
                { key: 'remaining', header: t('finder.dash.boq.col.remaining'), align: 'right', render: (row) => <span className="font-semibold tabular-nums text-stone-900">{fmtQty(row.remaining)}</span> },
                {
                  key: 'displayNames',
                  header: t('finder.dash.boq.col.sourcing'),
                  align: 'right',
                  render: (row) =>
                    row.remaining > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 min-h-8 gap-1 px-2 text-xs"
                        onClick={() => setSearchPrefill({ materialName: row.displayNames[0], qty: row.remaining })}
                        aria-label={t('finder.dash.boq.findAria', { qty: fmtQty(row.remaining), unit: row.unit, name: row.displayNames[0] })}
                      >
                        <PackageSearch className="h-3.5 w-3.5" aria-hidden /> {t('finder.dash.boq.find')}
                      </Button>
                    ) : (
                      <span className="text-[11px] text-emerald-700">{t('finder.dash.boq.sourced')}</span>
                    ),
                },
              ]}
              rows={boq}
              rowKey={(row) => row.materialKey}
              emptyState={
                <EmptyState
                  icon={Boxes}
                  title={t('finder.dash.boq.emptyTitle')}
                  description={t('finder.dash.boq.emptyDesc')}
                />
              }
            />
          </div>
        </CardContent>
      </Card>

      <RulesCard canManage={isSiteTeam} />

      <p className="flex items-center gap-1.5 text-[11px] text-stone-400">
        <Landmark className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('finder.dash.ledgerNote')}
      </p>
    </section>
  )
}
