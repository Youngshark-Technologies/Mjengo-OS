import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Health check: verifies process + database connectivity with live queries.
export async function GET() {
  const startedAt = Date.now()
  try {
    const [orgs, users] = await Promise.all([db.organization.count(), db.user.count()])
    return NextResponse.json({
      status: 'ok',
      service: 'mjengoos',
      database: 'connected',
      records: { organizations: orgs, users },
      latencyMs: Date.now() - startedAt,
      time: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[health] database check failed:', err)
    return NextResponse.json(
      { status: 'degraded', service: 'mjengoos', database: 'unavailable' },
      { status: 503 },
    )
  }
}
