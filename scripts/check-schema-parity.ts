// MJG-026 — schema parity gate.
// The dual-schema track keeps prisma/schema.prisma (SQLite, local/sandbox/Docker)
// and prisma/schema.postgres.prisma (PostgreSQL, hosted targets) hand-synced.
// This script fails the gate if their model sections drift apart.
// Normalization: comments, blank lines and the datasource block (the ONLY
// block expected to differ — provider/url) are stripped before comparison.
import { readFileSync } from 'node:fs'

const SQLITE = 'prisma/schema.prisma'
const POSTGRES = 'prisma/schema.postgres.prisma'

function normalize(path: string): string[] {
  const raw = readFileSync(path, 'utf8').split('\n')
  const out: string[] = []
  let inDatasource = false
  for (const line0 of raw) {
    const line = line0.trim()
    if (inDatasource) {
      if (line === '}') inDatasource = false
      continue
    }
    if (line.startsWith('datasource ')) {
      inDatasource = true
      continue
    }
    if (line === '' || line.startsWith('//')) continue
    out.push(line)
  }
  return out
}

const a = normalize(SQLITE)
const b = normalize(POSTGRES)

if (a.length !== b.length) {
  console.error(`[schema-parity] FAIL — line count mismatch after normalization: ${SQLITE}=${a.length}, ${POSTGRES}=${b.length}`)
  process.exit(1)
}

for (let i = 0; i < a.length; i++) {
  if (a[i] !== b[i]) {
    console.error(`[schema-parity] FAIL — drift at normalized line ${i + 1}:`)
    console.error(`  ${SQLITE}:  ${a[i]}`)
    console.error(`  ${POSTGRES}: ${b[i]}`)
    console.error(`Fix: edit BOTH schema files so models stay identical (datasource blocks excluded).`)
    process.exit(1)
  }
}

console.log(`[schema-parity] OK — ${a.length} normalized lines identical across sqlite/postgres schemas`)
