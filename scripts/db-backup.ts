// MJG-018 — SQLite online backup via `VACUUM INTO`.
//
// Safe to run while the dev server holds the database: VACUUM INTO takes a
// single read transaction and writes a fresh, compact copy — it never blocks
// writers for long and cannot corrupt the source file.
//
// Usage:  bun scripts/db-backup.ts            # backup to db/backups/<ts>.db
//         bun scripts/db-backup.ts --out DIR  # custom output directory
//
// Exit codes: 0 = backup verified, non-zero = any step failed.

import { PrismaClient } from '@prisma/client'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

function databaseFilePath(): string {
  const url = process.env.DATABASE_URL ?? ''
  const match = /^file:(.+)$/.exec(url)
  if (!match) {
    console.error(`[backup] unsupported DATABASE_URL (expected file:...): ${url || '(unset)'}`)
    process.exit(1)
  }
  return resolve(process.cwd(), match[1])
}

async function main(): Promise<void> {
  const sourcePath = databaseFilePath()
  const outDir = (() => {
    const idx = process.argv.indexOf('--out')
    return idx > -1 && process.argv[idx + 1] ? resolve(process.argv[idx + 1]) : resolve(process.cwd(), 'db/backups')
  })()
  mkdirSync(outDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = resolve(outDir, `mjengo-${stamp}.db`)

  // 1. Online backup — the source DB stays readable/writable.
  const source = new PrismaClient({ datasourceUrl: `file:${sourcePath}` })
  console.log(`[backup] source : ${sourcePath}`)
  console.log(`[backup] target : ${backupPath}`)
  const started = Date.now()
  await source.$executeRawUnsafe(
    `VACUUM INTO '${backupPath.replace(/'/g, "''")}'`,
  )
  console.log(`[backup] vacuum  : done in ${Date.now() - started}ms`)
  await source.$disconnect()

  // 2. Verify the backup independently: integrity + row counts vs source.
  const backup = new PrismaClient({ datasourceUrl: `file:${backupPath}` })
  const integrity = await backup.$queryRawUnsafe<Array<{ integrity_check: string }>>(
    'PRAGMA integrity_check',
  )
  if (integrity[0]?.integrity_check !== 'ok') {
    console.error(`[backup] integrity: FAILED — ${JSON.stringify(integrity)}`)
    await backup.$disconnect()
    process.exit(1)
  }
  const counts = await countRows(backup)
  await backup.$disconnect()

  const live = new PrismaClient({ datasourceUrl: `file:${sourcePath}` })
  const liveCounts = await countRows(live)
  await live.$disconnect()

  let mismatch = false
  for (const [table, n] of Object.entries(liveCounts)) {
    const same = counts[table] === n
    if (!same) mismatch = true
    console.log(`[backup] ${table.padEnd(20)} live=${String(n).padStart(5)} backup=${String(counts[table]).padStart(5)} ${same ? 'ok' : 'MISMATCH'}`)
  }
  console.log(`[backup] integrity: ok`)
  if (mismatch) {
    console.error('[backup] row counts diverge — backup rejected')
    process.exit(1)
  }
  console.log(`[backup] SUCCESS — ${backupPath}`)
}

async function countRows(client: PrismaClient): Promise<Record<string, number>> {
  const tables = [
    'Organization', 'User', 'Session', 'Site', 'Supplier', 'Material',
    'StockLevel', 'StockMovement', 'PurchaseOrder', 'POItem', 'Delivery',
    'DeliveryItem', 'Worker', 'Assignment', 'Attendance', 'Milestone',
    'EvidenceReport', 'Payment',
  ]
  const result: Record<string, number> = {}
  for (const table of tables) {
    const rows = await client.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*) as n FROM "${table}"`,
    )
    result[table] = Number(rows[0]?.n ?? 0)
  }
  return result
}

main().catch((err: unknown) => {
  console.error('[backup] FAILED:', err)
  process.exit(1)
})
