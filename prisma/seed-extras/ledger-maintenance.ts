// DB-3 (#124): the SQLite maintenance exemption — the twin of the Supabase
// design's mjengo.allow_maintenance GUC (0002_rls.sql §5.3/§9, runbook §9).
//
// The migration-14/21 triggers (append-only ledger rows, born-pending rule,
// posting-transition-only update guard) check the one-row LedgerMaintenance
// flag before firing, so seeds and supervised archival/backfill scripts can
// wipe or rewrite ledger history EXPLICITLY instead of being silently
// impossible.
// The posting-gate balance assertion and the CHECK constraints are NOT
// bypassed — maintenance is for archival ops, not for posting unbalanced
// legs.
//
// Contract: ALWAYS restore allow=false. The helper does it in a finally, so
// even a seed that crashes mid-wipe cannot leave the invariants disabled.

import type { PrismaClient } from '@prisma/client'

/** Run `fn` with the migration-14 ledger guards paused (archival ops only). */
export async function withLedgerMaintenance<T>(db: PrismaClient, fn: () => Promise<T>): Promise<T> {
  await db.ledgerMaintenance.upsert({
    where: { id: 1 },
    create: { id: 1, allow: true },
    update: { allow: true },
  })
  try {
    return await fn()
  } finally {
    await db.ledgerMaintenance.update({ where: { id: 1 }, data: { allow: false } })
  }
}
