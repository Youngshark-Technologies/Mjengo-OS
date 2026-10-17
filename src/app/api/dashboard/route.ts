import { db } from '@/lib/db'
import { handle, ok, requireUser } from '@/lib/api-helpers'
import type { DashboardData, SiteStatus } from '@/lib/types'

// Human-readable status labels for the activity feed (strings only, no fabrication).
const EVIDENCE_LABEL: Record<string, string> = {
  REPORTED: 'awaiting verification',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
}
const DELIVERY_LABEL: Record<string, string> = {
  PENDING: 'awaiting verification',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
}
const PAYMENT_LABEL: Record<string, string> = {
  PENDING: 'awaiting approval',
  APPROVED: 'approved',
  PAID: 'paid',
  REJECTED: 'rejected',
}
const SITE_LABEL: Record<string, string> = {
  PLANNING: 'planning',
  ACTIVE: 'active',
  ON_HOLD: 'on hold',
  COMPLETED: 'completed',
}
const MOVEMENT_LABEL: Record<string, string> = {
  IN: 'Stock in',
  OUT: 'Stock out',
  ADJUST: 'Stock adjustment',
}

function money(amount: number): string {
  return `KES ${amount.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`
}

export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    const organizationId = user.organizationId

    // UTC day/month boundaries (server-time independent).
    const now = new Date()
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    const [
      sites,
      stockLevels,
      pendingDeliveries,
      evidenceAwaiting,
      paymentsAwaiting,
      workforceToday,
      monthlySpendAgg,
      evidenceRows,
      deliveryRows,
      paymentRows,
      movementRows,
    ] = await Promise.all([
      db.site.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          milestones: { select: { status: true } },
        },
      }),
      db.stockLevel.findMany({
        where: { organizationId },
        select: { quantity: true, material: { select: { unitCost: true } } },
      }),
      db.delivery.count({ where: { organizationId, status: 'PENDING' } }),
      db.evidenceReport.count({ where: { organizationId, status: 'REPORTED' } }),
      db.payment.count({ where: { organizationId, status: 'PENDING' } }),
      db.attendance.count({
        where: {
          organizationId,
          date: { gte: dayStart, lt: dayEnd },
          status: { in: ['PRESENT', 'HALF_DAY'] },
        },
      }),
      db.payment.aggregate({
        _sum: { amount: true },
        where: {
          organizationId,
          status: { in: ['APPROVED', 'PAID'] },
          approvedAt: { gte: monthStart },
        },
      }),
      db.evidenceReport.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          site: { select: { name: true } },
          milestone: { select: { name: true } },
        },
      }),
      db.delivery.findMany({
        where: { organizationId },
        orderBy: { deliveredAt: 'desc' },
        take: 4,
        select: {
          id: true,
          status: true,
          deliveredAt: true,
          site: { select: { name: true } },
          supplier: { select: { name: true } },
        },
      }),
      db.payment.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          amount: true,
          category: true,
          status: true,
          createdAt: true,
          site: { select: { name: true } },
        },
      }),
      db.stockMovement.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          type: true,
          quantity: true,
          createdAt: true,
          site: { select: { name: true } },
          material: { select: { name: true, unit: true } },
        },
      }),
    ])

    // ─── Metrics ──────────────────────────────────────────────────────────────
    const stockValue = stockLevels.reduce(
      (sum, level) => sum + level.quantity * level.material.unitCost,
      0,
    )

    const metrics: DashboardData['metrics'] = {
      activeSites: sites.filter(s => s.status === 'ACTIVE').length,
      totalSites: sites.length,
      stockValue,
      pendingDeliveries,
      evidenceAwaiting,
      paymentsAwaiting,
      workforceToday,
      monthlySpend: monthlySpendAgg._sum.amount ?? 0,
    }

    // ─── Sites with milestone progress ────────────────────────────────────────
    const siteCards: DashboardData['sites'] = sites.map(site => {
      const milestonesTotal = site.milestones.length
      const milestonesCompleted = site.milestones.filter(m => m.status === 'COMPLETED').length
      return {
        id: site.id,
        name: site.name,
        status: site.status as SiteStatus,
        progress:
          milestonesTotal > 0
            ? Math.round((milestonesCompleted / milestonesTotal) * 100)
            : 0,
        milestonesTotal,
        milestonesCompleted,
      }
    })

    // ─── Recent activity feed (latest of each kind, merged, newest first) ─────
    const recent: DashboardData['recent'] = []

    for (const e of evidenceRows) {
      recent.push({
        id: e.id,
        kind: 'EVIDENCE',
        title: e.title,
        meta: `${e.site.name}${e.milestone ? ` · ${e.milestone.name}` : ''} · ${EVIDENCE_LABEL[e.status] ?? e.status.toLowerCase()}`,
        at: e.createdAt.toISOString(),
      })
    }
    for (const d of deliveryRows) {
      recent.push({
        id: d.id,
        kind: 'DELIVERY',
        title: `Delivery from ${d.supplier?.name ?? 'unknown supplier'}`,
        meta: `${d.site.name} · ${DELIVERY_LABEL[d.status] ?? d.status.toLowerCase()}`,
        at: d.deliveredAt.toISOString(),
      })
    }
    for (const p of paymentRows) {
      recent.push({
        id: p.id,
        kind: 'PAYMENT',
        title: `${money(p.amount)} ${p.category.toLowerCase()} payment`,
        meta: `${p.site.name} · ${PAYMENT_LABEL[p.status] ?? p.status.toLowerCase()}`,
        at: p.createdAt.toISOString(),
      })
    }
    for (const m of movementRows) {
      recent.push({
        id: m.id,
        kind: 'STOCK',
        title: `${MOVEMENT_LABEL[m.type] ?? m.type} · ${m.material.name}`,
        meta: `${m.site.name} · ${m.quantity} ${m.material.unit}`,
        at: m.createdAt.toISOString(),
      })
    }
    // Latest 2 sites, derived from the already-fetched org site list.
    for (const s of [...sites]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 2)) {
      recent.push({
        id: s.id,
        kind: 'SITE',
        title: `New site · ${s.name}`,
        meta: `${SITE_LABEL[s.status] ?? s.status.toLowerCase()}`,
        at: s.createdAt.toISOString(),
      })
    }

    recent.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    const recentFeed = recent.slice(0, 8)

    const data: DashboardData = { metrics, sites: siteCards, recent: recentFeed }
    return ok(data)
  })
}
