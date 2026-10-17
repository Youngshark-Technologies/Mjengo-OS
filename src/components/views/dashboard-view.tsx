'use client'

import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import {
  AlertTriangle,
  Banknote,
  Boxes,
  Building2,
  ClipboardCheck,
  HardHat,
  Plus,
  RefreshCw,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import { api } from '@/lib/api-client'
import { useAppStore } from '@/lib/store'
import { formatMoney, type DashboardData, type SiteStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

type ActivityKind = DashboardData['recent'][number]['kind']

const SITE_STATUS_STYLES: Record<SiteStatus, string> = {
  PLANNING: 'bg-stone-200/70 text-stone-700',
  ACTIVE: 'bg-amber-500/15 text-amber-700',
  ON_HOLD: 'bg-orange-500/15 text-orange-700',
  COMPLETED: 'bg-emerald-500/15 text-emerald-700',
}

const SITE_STATUS_LABELS: Record<SiteStatus, string> = {
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
}

const KIND_ICONS: Record<ActivityKind, LucideIcon> = {
  EVIDENCE: ClipboardCheck,
  DELIVERY: Truck,
  PAYMENT: Wallet,
  STOCK: Boxes,
  SITE: Building2,
}

function timeAgo(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return formatDistanceToNow(date, { addSuffix: true })
}

function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent', SITE_STATUS_STYLES[status])}
    >
      {SITE_STATUS_LABELS[status]}
    </Badge>
  )
}

function KpiCard({
  label,
  value,
  icon: Icon,
  highlight = false,
  money = false,
}: {
  label: string
  value: string
  icon: LucideIcon
  highlight?: boolean
  money?: boolean
}) {
  return (
    <Card className="gap-1 px-4 py-4 md:px-5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-stone-500">
          {label}
        </span>
        <Icon className={cn('size-4 shrink-0', highlight ? 'text-amber-500' : 'text-stone-400')} />
      </div>
      <p
        className={cn(
          'font-semibold tracking-tight tabular-nums',
          money ? 'truncate text-xl md:text-2xl' : 'text-2xl md:text-3xl',
          highlight ? 'text-amber-600' : 'text-stone-900'
        )}
      >
        {value}
      </p>
    </Card>
  )
}

function EmptyOrgState() {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
        <Building2 className="size-6 text-amber-600" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-stone-900">Welcome to MjengoOS</h2>
        <p className="mx-auto max-w-sm text-sm text-stone-500">
          Your organization is ready. Create your first site to start tracking materials,
          deliveries, workforce and evidence in one place.
        </p>
      </div>
      <Button
        className="h-11 bg-amber-600 text-white hover:bg-amber-500"
        onClick={() => useAppStore.getState().setView('sites')}
      >
        <Plus className="size-4" />
        Create your first site
      </Button>
    </Card>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  )
}

export function DashboardView() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
  })

  if (isLoading) return <DashboardSkeleton />

  if (isError) {
    return (
      <Card className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-red-500/10">
          <AlertTriangle className="size-5 text-red-600" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-stone-900">Could not load the dashboard</p>
          <p className="mx-auto max-w-md text-sm text-stone-500">{error.message}</p>
        </div>
        <Button variant="outline" className="h-11" onClick={() => refetch()}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      </Card>
    )
  }

  if (!data) return null

  const { metrics, sites, recent } = data

  if (metrics.totalSites === 0 && recent.length === 0) return <EmptyOrgState />

  const kpis: {
    label: string
    value: string
    icon: LucideIcon
    highlight?: boolean
    money?: boolean
  }[] = [
    { label: 'Active sites', value: String(metrics.activeSites), icon: Building2 },
    { label: 'Stock value', value: formatMoney(metrics.stockValue), icon: Boxes, money: true },
    {
      label: 'Pending deliveries',
      value: String(metrics.pendingDeliveries),
      icon: Truck,
      highlight: metrics.pendingDeliveries > 0,
    },
    {
      label: 'Evidence to verify',
      value: String(metrics.evidenceAwaiting),
      icon: ClipboardCheck,
      highlight: metrics.evidenceAwaiting > 0,
    },
    {
      label: 'Payments to approve',
      value: String(metrics.paymentsAwaiting),
      icon: Wallet,
      highlight: metrics.paymentsAwaiting > 0,
    },
    { label: 'Workers on site today', value: String(metrics.workforceToday), icon: Users },
    { label: 'Monthly spend', value: formatMoney(metrics.monthlySpend), icon: Banknote, money: true },
    { label: 'Total sites', value: String(metrics.totalSites), icon: HardHat },
  ]

  return (
    <div className="space-y-6">
      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Site progress */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Site progress</CardTitle>
            <CardDescription>Milestone completion per site</CardDescription>
          </CardHeader>
          <CardContent>
            {sites.length === 0 ? (
              <p className="py-4 text-sm text-stone-500">
                No sites yet. Create a site to start tracking progress.
              </p>
            ) : (
              <div className="divide-y divide-stone-100">
                {sites.map((s) => {
                  const pct =
                    s.milestonesTotal > 0
                      ? Math.round((s.milestonesCompleted / s.milestonesTotal) * 100)
                      : 0
                  return (
                    <div key={s.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-medium text-stone-900">{s.name}</span>
                        <SiteStatusBadge status={s.status} />
                      </div>
                      <Progress
                        value={pct}
                        className="h-2 bg-stone-200 [&>div]:bg-amber-500"
                        aria-label={`${s.name} progress: ${pct}%`}
                      />
                      <div className="flex items-center justify-between text-xs text-stone-500">
                        <span>
                          {s.milestonesCompleted}/{s.milestonesTotal} milestones
                        </span>
                        <span className="tabular-nums">{pct}%</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>Latest records across your sites</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="py-4 text-sm text-stone-500">
                No activity yet. Records appear here as your team works.
              </p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {recent.map((r) => {
                  const Icon = KIND_ICONS[r.kind] ?? Building2
                  return (
                    <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                        <Icon className="size-4 text-amber-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-stone-900">{r.title}</p>
                        <p className="truncate text-xs text-stone-500">{r.meta}</p>
                      </div>
                      <time
                        dateTime={r.at}
                        className="shrink-0 text-xs text-stone-400"
                        title={new Date(r.at).toLocaleString()}
                      >
                        {timeAgo(r.at)}
                      </time>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
