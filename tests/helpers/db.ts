/**
 * Real-SQLite test harness (issue #184 / audit register TEST-2).
 *
 * The suite's historical blind spot: 70 of 71 test files stub
 * `@/backend/lib/db` with in-memory Maps, so Prisma query behavior, FK/unique
 * constraints and `$transaction` rollback were never exercised — exactly the
 * surfaces the #73 migration-drift incident lived in. This harness lets a
 * critical-path suite opt into a REAL engine while the fast stub suites keep
 * running unchanged:
 *
 *   · a FRESH SQLite database file per test file (vitest isolates module
 *     registries per file, so the lazily-created singleton below is per-file);
 *   · the FULL migration history (00→21; 23 folders — the #159/#207 merge
 *     race left two 18_* migrations, both applied; names stay unique so
 *     deploy order is deterministic) applied by the REAL
 *     `prisma migrate deploy` CLI (not by replaying SQL text) — the
 *     `_prisma_migrations` bookkeeping table is real, so the harness would
 *     catch a migration that applies via `db push` but not via `deploy`
 *     (the #73 bug class);
 *   · a real `PrismaClient` with the datasource URL overridden onto that
 *     file — the same generated client production code imports, now driving
 *     the real query engine, real constraint errors (P2002/P2003) and real
 *     interactive `$transaction`s;
 *   · a better-sqlite3 handle onto the SAME file (BigInt-safe integers),
 *     for direct-SQL assertions that deliberately bypass Prisma — the
 *     db-integrity-constraints.test.ts toolkit (trigger probes, sqlite_master,
 *     EXPLAIN QUERY PLAN) on a live service-populated database.
 *
 * WHY A TEMP FILE, NOT `file::memory:` — Prisma's SQLite engine opens its own
 * connection(s) and cannot share a `:memory:` database with better-sqlite3:
 * a shared-cache URI (`file::memory:?cache=shared`) probes as P2021 (the
 * engine sees an empty database), and a plain `:memory:` would be a different
 * database per connection. The issue sanctions the temp-file fallback
 * explicitly ("a `:memory:` (or temp-file) SQLite DB"): the harness stays
 * hermetic — a unique `os.tmpdir()` subdir per test file, removed on dispose;
 * no repo DB file, no network, no secrets (TEST-3 posture preserved).
 *
 * USAGE (in a test file):
 *
 *   vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())
 *   import { disposeRealDb, getRealTestDb } from '../helpers/db'
 *   const { prisma, sqlite } = getRealTestDb()
 *   afterAll(disposeRealDb)           // client disconnected, handles closed, file removed
 *
 * The vi.mock factory and `getRealTestDb()` both resolve to the SAME lazily
 * created instance, so import order does not matter: whichever runs first
 * (the mocked `@/backend/lib/db` import inside a service, or the test file's
 * top-level `getRealTestDb()`) builds the database and the other reuses it.
 */
import { PrismaClient } from '@prisma/client'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface RealTestDb {
  /** Real PrismaClient on the migrated database (datasource overridden). */
  prisma: PrismaClient
  /** better-sqlite3 handle on the same file — direct SQL, BigInt-safe. */
  sqlite: Database.Database
  /** Absolute path of the database file (inside its own temp dir). */
  dbPath: string
  /** The `file:` URL the PrismaClient is pointed at. */
  url: string
  /** Disconnect the client, close the handle, delete the temp dir. */
  dispose(): Promise<void>
}

/** The per-test-file singleton (vitest gives every file a fresh module registry). */
let current: RealTestDb | null = null

/** The repo root — vitest runs with cwd = the directory of vitest.config.mts. */
function repoRoot(): string {
  return process.cwd()
}

/**
 * Apply the full migration history with the REAL `prisma migrate deploy` CLI.
 * ~1.1s per invocation (measured), paid once per test file — the CLI is the
 * same binary `db:deploy` runs, resolving the same prisma/schema.prisma, so
 * the harness exercises the exact deployment path production boots through.
 */
function deployMigrations(dbPath: string): void {
  const cli = resolve(repoRoot(), 'node_modules', 'prisma', 'build', 'index.js')
  const schema = resolve(repoRoot(), 'prisma', 'schema.prisma')
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', `--schema=${schema}`], {
    cwd: repoRoot(),
    // The datasource is env("DATABASE_URL") — the override on the spawned CLI
    // wins over any .env the repo might carry.
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `real-db harness: prisma migrate deploy failed (status ${result.status})\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
}

/** Build (once per test file) the migrated database + clients. */
export function getRealTestDb(): RealTestDb {
  if (current) return current

  const dir = mkdtempSync(join(tmpdir(), 'mjengo-realdb-'))
  const dbPath = join(dir, 'mjengo-test.db')
  deployMigrations(dbPath)

  const url = `file:${dbPath}`
  const prisma = new PrismaClient({
    datasources: { db: { url } },
    // Silent by design: several suites ASSERT Prisma-known rejections (P2002
    // unique probes, trigger aborts) — the engine's own error logging would
    // spam stderr for every expected failure. Vitest reports real failures
    // from the rejection itself.
    log: [],
  })
  // BigInt-safe direct reads (mirrors Prisma's INTEGER→BigInt mapping — the
  // ledger-sql-sum.test.ts convention), so raw-SQL amount assertions are exact.
  const sqlite = new Database(dbPath)
  sqlite.defaultSafeIntegers(true)

  current = {
    prisma,
    sqlite,
    dbPath,
    url,
    async dispose() {
      await prisma.$disconnect()
      sqlite.close()
      rmSync(dir, { recursive: true, force: true })
      current = null
    },
  }
  return current
}

/**
 * The `vi.mock('@/backend/lib/db')` factory payload: the REAL PrismaClient.
 * Services importing `{ db }` then run their real queries against the real
 * engine — this is the module swap that takes a suite off the in-memory Maps.
 */
export function realDbModule(): { db: PrismaClient } {
  return { db: getRealTestDb().prisma }
}

/** afterAll hook — dispose the per-file database cleanly. */
export async function disposeRealDb(): Promise<void> {
  if (current) await current.dispose()
}

// ---------------------------------------------------------------- factories
// Minimal per-suite seeds (the seed-extras/* shapes, trimmed to what the
// critical-path suites need). Kept here so every real-DB suite constructs
// parents the same way — one Project, Workers with BigInt dailyRate cents.

export interface SeededProject {
  id: string
  client: string
}

/** One project row (shareToken minted by Prisma's cuid default). */
export async function seedProject(
  prisma: PrismaClient,
  overrides: Partial<{ name: string; client: string; location: string; budget: bigint }> = {},
): Promise<SeededProject> {
  const project = await prisma.project.create({
    data: {
      name: overrides.name ?? 'RealDB Bungalow',
      client: overrides.client ?? 'RealDB Client',
      location: overrides.location ?? 'Nairobi',
      budget: overrides.budget ?? 5_000_000_00n, // KSh 5,000,000.00 in cents
      startDate: new Date('2026-01-06T08:00:00Z'),
      targetDate: new Date('2026-12-18T17:00:00Z'),
    },
  })
  return { id: project.id, client: project.client }
}

/** One worker row; dailyRate is CENTS (issue #122 — KSh 800 → 80000n). */
export async function seedWorker(
  prisma: PrismaClient,
  projectId: string,
  overrides: Partial<{ name: string; role: string; dailyRate: bigint }> = {},
): Promise<{ id: string; dailyRate: bigint }> {
  const worker = await prisma.worker.create({
    data: {
      projectId,
      name: overrides.name ?? 'Kamau Njoroge',
      role: overrides.role ?? 'fundi',
      phone: '0700000001',
      dailyRate: overrides.dailyRate ?? 80000n,
      active: true,
    },
  })
  return { id: worker.id, dailyRate: worker.dailyRate }
}
