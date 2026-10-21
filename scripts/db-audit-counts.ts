// MJG-023 — Read-only production data audit.
//
// Enumerates every user table in the SQLite database, reports per-table row
// counts, and validates structural health. Never writes to the database.
//
// Usage:
//   bun scripts/db-audit-counts.ts                 # report counts
//   bun scripts/db-audit-counts.ts --zero-required # exit 1 if ANY table has rows
//
// Checks:
//   1. PRAGMA integrity_check      — file-level corruption
//   2. PRAGMA foreign_key_check    — orphaned rows violating FK constraints
//   3. per-table COUNT(*)          — residual data detection
//
// Exit codes: 0 = healthy (and zero if --zero-required), 1 = any failure.

import { PrismaClient } from '@prisma/client'
import { resolve } from 'node:path'

function databaseFilePath(): string {
  const url = process.env.DATABASE_URL ?? ''
  const match = /^file:(.+)$/.exec(url)
  if (!match) {
    console.error(`[audit] unsupported DATABASE_URL (expected file:...): ${url || '(unset)'}`)
    process.exit(1)
  }
  return resolve(process.cwd(), match[1])
}

async function main(): Promise<void> {
  const zeroRequired = process.argv.includes('--zero-required')
  const dbPath = databaseFilePath()
  const client = new PrismaClient({ datasourceUrl: `file:${dbPath}` })

  // 1. File integrity.
  const integrity = await client.$queryRawUnsafe<Array<{ integrity_check: string }>>(
    'PRAGMA integrity_check',
  )
  const integrityOk = integrity[0]?.integrity_check === 'ok'
  console.log(`[audit] integrity_check : ${integrity[0]?.integrity_check ?? 'MISSING'}`)

  // 2. Orphaned rows (FK violations) across every table with foreign keys.
  const fkViolations = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'PRAGMA foreign_key_check',
  )
  console.log(`[audit] foreign_key_check : ${fkViolations.length === 0 ? 'clean (0 orphans)' : `${fkViolations.length} VIOLATIONS`}`)
  for (const v of fkViolations.slice(0, 10)) console.log(`[audit]   orphan: ${JSON.stringify(v)}`)

  // 3. Dynamic table enumeration — cannot miss a residual table.
  const tables = await client.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name",
  )

  let total = 0
  let nonEmpty = 0
  const rows: Array<{ table: string; count: number }> = []
  for (const { name } of tables) {
    const res = await client.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*) as n FROM "${name.replace(/"/g, '""')}"`,
    )
    const n = Number(res[0]?.n ?? 0)
    total += n
    if (n > 0) nonEmpty += 1
    rows.push({ table: name, count: n })
  }

  for (const { table, count } of rows) {
    console.log(`[audit] ${table.padEnd(20)} ${String(count).padStart(7)}`)
  }
  console.log(`[audit] ${'-'.repeat(28)}`)
  console.log(`[audit] tables=${rows.length} non-empty=${nonEmpty} total_rows=${total}`)

  await client.$disconnect()

  if (!integrityOk) process.exit(1)
  if (fkViolations.length > 0) process.exit(1)
  if (zeroRequired && nonEmpty > 0) {
    console.error(`[audit] FAILED — ${nonEmpty} table(s) still contain rows`)
    process.exit(1)
  }
  if (zeroRequired) console.log('[audit] ZERO-RESIDUAL VERIFIED — all tables empty')
}

main().catch((err: unknown) => {
  console.error('[audit] FAILED:', err)
  process.exit(1)
})
