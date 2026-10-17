// MJG-018 — Restore drill: verify a backup, then materialize it at a target path.
//
// By design this NEVER touches the live database implicitly. Without --into it
// restores into a scratch file (pure drill). With --into <path> it copies the
// backup over that path — point it at the live DB path only while the app is
// stopped (docs/BACKUPS.md).
//
// Usage:  bun scripts/db-restore.ts <backup.db> [--into <path>]
//
// Exit codes: 0 = restore verified, non-zero = any step failed.

import { PrismaClient } from '@prisma/client'
import { copyFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const TABLES = [
  'Organization', 'User', 'Session', 'Site', 'Supplier', 'Material',
  'StockLevel', 'StockMovement', 'PurchaseOrder', 'POItem', 'Delivery',
  'DeliveryItem', 'Worker', 'Assignment', 'Attendance', 'Milestone',
  'EvidenceReport', 'Payment',
]

async function countRows(client: PrismaClient): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const table of TABLES) {
    const rows = await client.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*) as n FROM "${table}"`,
    )
    result[table] = Number(rows[0]?.n ?? 0)
  }
  return result
}

async function main(): Promise<void> {
  const backupArg = process.argv[2]
  if (!backupArg) {
    console.error('[restore] usage: bun scripts/db-restore.ts <backup.db> [--into <path>]')
    process.exit(1)
  }
  const backupPath = resolve(backupArg)
  const intoIdx = process.argv.indexOf('--into')
  const intoPath = intoIdx > -1 && process.argv[intoIdx + 1] ? resolve(process.argv[intoIdx + 1]) : null
  const scratchPath = intoPath ?? resolve(process.cwd(), `db/restore-drill-${Date.now()}.db`)

  const size = statSync(backupPath).size
  console.log(`[restore] backup : ${backupPath} (${(size / 1024).toFixed(1)} KiB)`)
  console.log(`[restore] target : ${scratchPath}${intoPath ? '' : '  (scratch — live DB untouched)'}`)

  // 1. Integrity gate on the backup itself.
  const probe = new PrismaClient({ datasourceUrl: `file:${backupPath}` })
  const integrity = await probe.$queryRawUnsafe<Array<{ integrity_check: string }>>(
    'PRAGMA integrity_check',
  )
  await probe.$disconnect()
  if (integrity[0]?.integrity_check !== 'ok') {
    console.error(`[restore] integrity: FAILED — refusing to restore`)
    process.exit(1)
  }

  // 2. Materialize: copy, then verify the copy boots and matches the backup.
  copyFileSync(backupPath, scratchPath)
  const restored = new PrismaClient({ datasourceUrl: `file:${scratchPath}` })
  const restoredIntegrity = await restored.$queryRawUnsafe<Array<{ integrity_check: string }>>(
    'PRAGMA integrity_check',
  )
  const restoredCounts = await countRows(restored)
  await restored.$disconnect()

  const reference = new PrismaClient({ datasourceUrl: `file:${backupPath}` })
  const referenceCounts = await countRows(reference)
  await reference.$disconnect()

  if (restoredIntegrity[0]?.integrity_check !== 'ok') {
    console.error('[restore] restored copy failed integrity — drill FAILED')
    process.exit(1)
  }
  for (const [table, n] of Object.entries(referenceCounts)) {
    if (restoredCounts[table] !== n) {
      console.error(`[restore] ${table}: expected ${n}, got ${restoredCounts[table]} — drill FAILED`)
      process.exit(1)
    }
  }
  const total = Object.values(restoredCounts).reduce((a, b) => a + b, 0)
  console.log(`[restore] integrity: ok — ${total} rows across ${TABLES.length} tables match the backup`)
  console.log(`[restore] SUCCESS — usable database at ${scratchPath}`)
  if (!intoPath) {
    console.log('[restore] drill complete. To actually swap the live DB: stop the app,')
    console.log('          re-run with --into <live path>, then start the app and run scripts/smoke.sh.')
  }
}

main().catch((err: unknown) => {
  console.error('[restore] FAILED:', err)
  process.exit(1)
})
