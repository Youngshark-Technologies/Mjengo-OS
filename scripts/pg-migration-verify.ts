// MJG-026 — live Postgres verification of the versioned migration track.
// Sequence: embedded Postgres (real binaries, port 3112) → `prisma migrate deploy`
// (applies prisma/migrations/** against the PG server) → regenerate the Prisma
// client from the postgres schema → boot the production standalone server on
// :3113 against the migrated PG database → run the full 21-case API golden-journey
// suite → teardown (server killed, PG stopped, SQLite client restored).
// Any phase failure exits non-zero.
import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import EmbeddedPostgres from 'embedded-postgres'

const PG_PORT = 3112
const API_PORT = 3113
const API_BASE = `http://localhost:${API_PORT}`
const PG_URL = `postgresql://mjengo:mjengo@localhost:${PG_PORT}/mjengo_test`
const DATA_DIR = 'db/pg-test-data'

function run(cmd: string, args: string[], env: Record<string, string>, label: string): void {
  console.log(`[pg-verify] $ ${cmd} ${args.join(' ')}  (${label})`)
  const res = spawnSync(cmd, args, { env: { ...process.env, ...env }, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`[pg-verify] FAIL at: ${label}`)
    process.exit(1)
  }
}

let serverPid: number | undefined
let pg: InstanceType<typeof EmbeddedPostgres> | undefined
let clientRestored = false

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true })

  // 1 — start embedded Postgres
  console.log(`[pg-verify] 1/6 starting embedded Postgres on :${PG_PORT}`)
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'mjengo',
    password: 'mjengo',
    port: PG_PORT,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('mjengo_test')
  console.log('[pg-verify] Postgres up, database mjengo_test created')

  // 2 — apply versioned migrations with the postgres schema
  run('bunx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.postgres.prisma'],
    { DATABASE_URL: PG_URL }, 'migrate deploy (MJG-026 versioned migrations)')

  // 3 — regenerate the Prisma client against the postgres provider
  run('bunx', ['prisma', 'generate', '--schema', 'prisma/schema.postgres.prisma'],
    { DATABASE_URL: PG_URL }, 'prisma generate (postgres client)')

  // 4 — boot the production standalone server against the migrated PG database
  console.log(`[pg-verify] 4/6 booting production server on :${API_PORT} (DATABASE_URL → postgres)`)
  const server = spawn('bun', ['.next/standalone/server.js'], {
    env: { ...process.env, PORT: String(API_PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', DATABASE_URL: PG_URL },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  serverPid = server.pid
  let healthy = false
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API_BASE}/api`)
      if (res.ok) { healthy = true; break }
    } catch { /* not up yet */ }
    if (server.exitCode !== null && server.exitCode !== 0) {
      console.error('[pg-verify] server process died while booting')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!healthy) { console.error('[pg-verify] server never became healthy'); process.exit(1) }
  console.log(`[pg-verify] server healthy on ${API_BASE}/api — Postgres-backed`)

  // 5 — full API golden-journey suite against the migrated Postgres database
  run('bun', ['test', 'tests/api-mjengo.test.ts'],
    { MJENGO_API_BASE: API_BASE, DATABASE_URL: PG_URL }, '21-case API suite on Postgres')

  // 6 — teardown
  console.log('[pg-verify] 6/6 teardown')
}

async function teardown(): Promise<void> {
  if (serverPid) { try { process.kill(serverPid, 'SIGKILL') } catch {} }
  if (pg) { try { await pg.stop() } catch {} }
  if (!clientRestored) {
    const res = spawnSync('bunx', ['prisma', 'generate'], { stdio: 'inherit' })
    clientRestored = res.status === 0
    console.log(clientRestored
      ? '[pg-verify] SQLite Prisma client restored (sandbox default)'
      : '[pg-verify] WARNING: client restore failed — run `bunx prisma generate` manually')
  }
  rmSync(DATA_DIR, { recursive: true, force: true })
  console.log('[pg-verify] PG data dir removed')
}

main()
  .then(async () => { await teardown(); console.log('PG MIGRATION VERIFICATION PASSED'); process.exit(0) })
  .catch(async (e: unknown) => { console.error('[pg-verify] FAILED:', e); await teardown(); process.exit(1) })
