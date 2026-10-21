// Probe — embedded Postgres boot only (diagnostic for MJG-026 verification hang).
import { rmSync } from 'node:fs'
import EmbeddedPostgres from 'embedded-postgres'

const DATA_DIR = 'db/pg-probe-data'

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true })
  console.log('[probe] constructing EmbeddedPostgres on :3114')
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'probe',
    password: 'probe',
    port: 3114,
    persistent: false,
  })
  console.log('[probe] initialise() …')
  await pg.initialise()
  console.log('[probe] start() …')
  await pg.start()
  console.log('[probe] createDatabase("probe_db") …')
  await pg.createDatabase('probe_db')
  console.log('[probe] PG BOOT OK — stopping')
  await pg.stop()
  rmSync(DATA_DIR, { recursive: true, force: true })
  console.log('[probe] PROBE PASSED')
  process.exit(0)
}

main().catch((e: unknown) => { console.error('[probe] FAILED:', e); rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(1) })
