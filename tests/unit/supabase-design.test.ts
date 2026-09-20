/**
 * SUPABASE DESIGN-CONTRACT TESTS (issue #95, ADR 0002)
 *
 * The Supabase target-state design (supabase/migrations/*.sql +
 * docs/SUPABASE-DATABASE-DESIGN.md) must stay in lockstep with the shipped
 * Prisma model. These tests parse the SQL files structurally and pin:
 *
 *   1. SCHEMA COMPLETENESS — every Prisma model has exactly one
 *      create-table in 0001_schema.sql (parsed live from
 *      prisma/schema.prisma so the design cannot drift from the model),
 *      EXCEPT the documented SQLite-only models (§ below);
 *   2. RLS COVERAGE — every table (71 + profiles = 72) has RLS enabled and
 *      at least one policy; anon is revoked everywhere;
 *   3. MONEY TYPING — every money column is numeric(18,2), every quantity
 *      numeric(18,3) (the Float-money defect class stays fixed);
 *   4. TIMESTAMPS — timestamptz everywhere (zero bare `timestamp`);
 *   5. FK INDEX COVERAGE — every FK column has a leftmost index, a
 *      column-level unique, or a table-level unique leftmost position
 *      (SQLite never had FK indexes; Postgres requires them);
 *   6. APPEND-ONLY DISCIPLINE — the append-only artifacts have NO
 *      update/delete policies AND immutability triggers wired
 *      (ledger_transactions joined the set in #133: reversals are new rows
 *      linked via reversal_of_id — INSERT/SELECT-only like ledger_entries);
 *   7. MONEY INVARIANTS — balanced-legs deferred constraint trigger + the
 *      unique reversal_of_id link (one reversal per original) exist;
 *   8. HYGIENE — snake_case naming, no secrets in SQL, updated_at triggers
 *      on every table that carries an updated_at column.
 *
 * This is a DESIGN contract, not a live database test: it validates the SQL
 * artifacts that Phase-1 cutover applies to a fresh Supabase project (the
 * runtime cutover gates live in the migration plan, design doc §11).
 *
 * Naming contract (design doc §3): camelCase model → snake_case PLURAL table
 * (Supabase community convention — auth.users, storage.objects). Exceptions:
 * ProjectTeam → project_team and ProjectHealth → project_health (collective
 * nouns). The single column exception: Phase.order → order_index ("order"
 * is a reserved SQL word).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const SCHEMA_SQL_RAW = readFileSync(join(ROOT, 'supabase/migrations/0001_schema.sql'), 'utf8')
const RLS_SQL_RAW = readFileSync(join(ROOT, 'supabase/migrations/0002_rls.sql'), 'utf8')
const PLATFORM_SQL_RAW = readFileSync(join(ROOT, 'supabase/migrations/0003_platform.sql'), 'utf8')
const PRISMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8')

/** Strip line comments so structural regexes never match prose. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

const SCHEMA_SQL = stripComments(SCHEMA_SQL_RAW)
const RLS_SQL = stripComments(RLS_SQL_RAW)
const PLATFORM_SQL = stripComments(PLATFORM_SQL_RAW)
const ALL_SQL = `${SCHEMA_SQL}\n${RLS_SQL}\n${PLATFORM_SQL}`

// ---------------------------------------------------------------- naming map

/** camelCase → snake_case. */
function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/** The documented model→table contract: snake_case + plural, with the two
 *  collective-noun exceptions. Kept EXPLICIT here so a rename anywhere
 *  (Prisma side or SQL side) breaks this file loudly. */
const TABLE_NAME_EXCEPTIONS: Record<string, string> = {
  ProjectTeam: 'project_team',
  ProjectHealth: 'project_health',
}

/** SQLite-only models with NO Supabase table BY DESIGN (#124 / DB-3):
 *  LedgerMaintenance is the SQLite twin of the Supabase design's
 *  mjengo.allow_maintenance GUC (0002_rls.sql §5.3/§9) — Postgres uses a
 *  session GUC, not a table, so this model deliberately has no
 *  create-table in 0001_schema.sql. Keep this list EXPLICIT so any new
 *  SQLite-only model must justify itself here. */
const SQLITE_ONLY_MODELS = ['LedgerMaintenance']

function expectedTable(model: string): string {
  if (TABLE_NAME_EXCEPTIONS[model]) return TABLE_NAME_EXCEPTIONS[model]
  const snake = toSnake(model)
  if (/y$/.test(snake)) return `${snake.slice(0, -1)}ies` // Delivery → deliveries, Attendance → attendances
  if (/(s|x|z|ch|sh)$/.test(snake)) return `${snake}es` // Box/… → …es (none today, kept honest)
  return `${snake}s`
}

/** Prisma model names, in declaration order. */
const PRISMA_MODELS = Array.from(PRISMA.matchAll(/^model (\w+) \{$/gm)).map((m) => m[1])
const MODEL_TABLES = PRISMA_MODELS.filter((m) => !SQLITE_ONLY_MODELS.includes(m)).map(expectedTable)

// ---- SQL structure parsing --------------------------------------------------

interface ColumnDef {
  table: string
  column: string
  type: string
  line: string
}

interface IndexDef {
  table: string
  columns: string[]
  unique: boolean
  partial: boolean
}

/** Known type vocabulary — an unknown type is a parser failure (loud), never
 *  a silent skip. Two-word types (double precision) are handled here. */
const TYPE_RE = String.raw`(?:double precision|numeric\(\d+,\d+\)|numeric\(\d+\)|timestamptz|timestamp|citext|jsonb|boolean|integer|text|uuid)`

function parseTables(sql: string): string[] {
  return Array.from(sql.matchAll(/create table public\.([a-z0-9_]+) \(/g)).map((m) => m[1])
}

function parseColumns(sql: string): ColumnDef[] {
  const out: ColumnDef[] = []
  const blockRe = /create table public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g
  for (const block of sql.matchAll(blockRe)) {
    const table = block[1]
    for (const line of block[2].split('\n')) {
      // Column lines: two-space indent, name, KNOWN type; skip constraints.
      // NOTE: no \b after the type — types like numeric(18,2) end in ')' and
      // \b would never fire there; a space/comma/end-of-line lookahead does.
      const col = line.match(new RegExp(`^  ([a-z0-9_]+)\\s+(${TYPE_RE})(?=[\\s,]|$)`))
      if (col && col[1] !== 'constraint') {
        out.push({ table, column: col[1], type: col[2], line })
      }
    }
  }
  return out
}

function parseIndexes(sql: string): IndexDef[] {
  const out: IndexDef[] = []
  const re = /create (unique )?index [a-z0-9_]+ on public\.([a-z0-9_]+) \(([^)]+)\)( where [^;]+)?;/g
  for (const m of sql.matchAll(re)) {
    out.push({
      table: m[2],
      columns: m[3].split(',').map((c) => c.trim().replace(/ desc$/, '')),
      unique: Boolean(m[1]),
      partial: Boolean(m[4]),
    })
  }
  return out
}

/** Table-level unique constraints: constraint <name> unique (a, b). */
function parseUniqueConstraints(sql: string): IndexDef[] {
  const out: IndexDef[] = []
  const re = /constraint ([a-z0-9_]+) unique \(([^)]+)\)/g
  for (const m of sql.matchAll(re)) {
    const before = sql.slice(0, m.index ?? 0)
    const table = before.match(/create table public\.([a-z0-9_]+) \(/g)?.pop()
    if (table) {
      out.push({
        table: table.replace('create table public.', '').replace(' (', ''),
        columns: m[2].split(',').map((c) => c.trim()),
        unique: true,
        partial: false,
      })
    }
  }
  return out
}

/** FK columns: column-level `references public.x` (the style used across 0001). */
function parseForeignKeys(sql: string): Array<{ table: string; column: string; uniqueInline: boolean }> {
  const out: Array<{ table: string; column: string; uniqueInline: boolean }> = []
  const blockRe = /create table public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g
  for (const block of sql.matchAll(blockRe)) {
    const table = block[1]
    for (const line of block[2].split('\n')) {
      if (/references public\./.test(line) && !/^  constraint /.test(line)) {
        const col = line.match(/^  ([a-z0-9_]+)/)
        if (col) {
          out.push({ table, column: col[1], uniqueInline: /\bunique\b/.test(line) })
        }
      }
    }
  }
  return out
}

/**
 * DO-block association: extract the array list from every `do $$ … end $$;`
 * block whose body CONTAINS the marker text. This is block-scoped, so a
 * marker that also appears outside DO blocks (e.g. in prose about
 * reject_mutation) can never pull in a foreign array.
 */
function parseDoArrayForMarker(sql: string, marker: string): string[] {
  const out: string[] = []
  for (const block of sql.matchAll(/do \$\$[\s\S]*?end \$\$\s*;/g)) {
    if (!block[0].includes(marker)) continue
    const arr = block[0].match(/foreach t in array array\[(.*?)\]/s)
    if (arr) {
      out.push(...Array.from(arr[1].matchAll(/'([a-z0-9_]+)'/g)).map((x) => x[1]))
    }
  }
  return out
}

const COLUMNS = [...parseColumns(SCHEMA_SQL), ...parseColumns(RLS_SQL)]
const INDEXES = parseIndexes(SCHEMA_SQL)
const UNIQUE_CONSTRAINTS = parseUniqueConstraints(SCHEMA_SQL)
const FOREIGN_KEYS = parseForeignKeys(SCHEMA_SQL)

// The canonical append-only set (design doc §5.3; must match 0002 exactly).
// #133 / DB-11: ledger_transactions joined — reversals are new rows linked
// via reversal_of_id, so there is no reversal-marking update to whitelist.
const APPEND_ONLY = [
  'audit_events', 'mjengo_scores', 'risk_assessments', 'intel_digests',
  'project_health', 'draw_packs', 'photo_hashes', 'ai_review_notes',
  'ai_insights', 'trust_digests', 'stock_movements', 'ledger_entries',
  'ledger_transactions', 'idempotency_records', 'credential_checks',
  'price_points',
]

// Money columns (numeric(18,2)) — the Float-money fix, pinned per column.
const MONEY_COLUMNS: Array<[string, string]> = [
  ['projects', 'budget'], ['phases', 'budget'], ['workers', 'daily_rate'],
  ['attendances', 'wage'], ['deliveries', 'unit_cost'], ['deliveries', 'total_cost'],
  ['transactions', 'amount'], ['escrow_wallets', 'balance'], ['milestones', 'amount'],
  ['variation_orders', 'budget_impact'], ['draw_packs', 'amount'],
  ['suppliers', 'delivery_fee_base'], ['suppliers', 'free_delivery_over'],
  ['suppliers', 'minimum_order'], ['catalog_items', 'unit_price'],
  ['quotes', 'unit_price'], ['quotes', 'delivery_fee'], ['quotes', 'transport_fee'],
  ['quotes', 'fees'], ['quotes', 'total_landed'], ['quote_lines', 'unit_price'],
  ['quote_lines', 'line_total'], ['purchase_orders', 'subtotal'],
  ['purchase_orders', 'delivery_fee'], ['purchase_orders', 'total'],
  ['purchase_order_lines', 'unit_price'], ['purchase_order_lines', 'line_total'],
  ['invoices', 'subtotal'], ['invoices', 'tax'], ['invoices', 'total'],
  ['invoice_lines', 'unit_price'], ['invoice_lines', 'line_total'],
  ['price_points', 'unit_price'], ['ledger_entries', 'amount'],
  ['payment_requests', 'amount'], ['stock_movements', 'unit_cost'],
  ['boq_lines', 'est_unit_price'], ['materials', 'unit_price'],
]

const QUANTITY_COLUMNS: Array<[string, string]> = [
  ['deliveries', 'quantity'], ['consumptions', 'quantity'],
  ['catalog_items', 'stock_qty'], ['catalog_items', 'min_order_qty'],
  ['material_request_lines', 'qty'], ['quote_lines', 'qty'],
  ['purchase_order_lines', 'qty'], ['order_delivery_lines', 'qty_ordered'],
  ['order_delivery_lines', 'qty_received'], ['order_delivery_lines', 'qty_rejected'],
  ['invoice_lines', 'qty'], ['boq_lines', 'qty'], ['stock_movements', 'quantity'],
  ['stock_count_items', 'counted_qty'], ['stock_count_items', 'expected_qty'],
  ['stock_count_items', 'posted_qty'],
]

// ---------------------------------------------------------------- tests

describe('1. schema completeness (design tracks the Prisma model)', () => {
  it('parses the full model list from prisma/schema.prisma (72 models)', () => {
    expect(PRISMA_MODELS.length).toBe(72)
  })

  it('the SQLite-only exemption list is exactly LedgerMaintenance (no Supabase table, by design)', () => {
    // #124: the maintenance flag is a SQLite TABLE because SQLite has no
    // session GUCs; the Supabase design uses mjengo.allow_maintenance
    // instead. Any OTHER model missing from 0001_schema.sql must extend
    // this list deliberately — the create-table test below still covers
    // every non-exempt model.
    expect(SQLITE_ONLY_MODELS).toEqual(['LedgerMaintenance'])
    expect(PRISMA_MODELS).toContain('LedgerMaintenance')
  })

  it('every Prisma model has exactly one create-table in 0001_schema.sql', () => {
    const tables = parseTables(SCHEMA_SQL)
    expect(new Set(tables)).toEqual(new Set(MODEL_TABLES)) // same set (order is dependency-safe, not declaration order)
    expect(tables.length).toBe(MODEL_TABLES.length) // and no duplicates
  })

  it('the mapping contract holds for every explicit name (plural rule + exceptions)', () => {
    expect(expectedTable('Project')).toBe('projects')
    expect(expectedTable('Delivery')).toBe('deliveries')
    expect(expectedTable('Attendance')).toBe('attendances')
    expect(expectedTable('ProjectTeam')).toBe('project_team')
    expect(expectedTable('ProjectHealth')).toBe('project_health')
    expect(expectedTable('AiReviewNote')).toBe('ai_review_notes')
  })

  it('Phase.order maps to order_index (the reserved-word exception) and exists', () => {
    expect(SCHEMA_SQL_RAW).toContain('order_index     integer not null')
    expect(TABLE_NAME_EXCEPTIONS).toEqual({ ProjectTeam: 'project_team', ProjectHealth: 'project_health' })
  })

  it('profiles (the Supabase Auth mapping) is created in 0002, not 0001', () => {
    expect(parseTables(SCHEMA_SQL)).not.toContain('profiles')
    expect(parseTables(RLS_SQL)).toEqual(['profiles'])
  })

  it('every table has a primary key and every column is snake_case', () => {
    for (const block of SCHEMA_SQL.matchAll(/create table public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g)) {
      expect(block[1]).toMatch(/^[a-z0-9_]+$/)
      expect(block[2], `${block[1]} needs a PK`).toMatch(/text primary key/)
      for (const line of block[2].split('\n')) {
        const col = line.match(/^  ([a-zA-Z0-9_]+)/)
        if (col && col[1] !== 'constraint') {
          expect(col[1], `column "${col[1]}" must be snake_case`).toMatch(/^[a-z0-9_]+$/)
        }
      }
    }
  })

  it('the column parser recognizes every declared column (no unknown types)', () => {
    // Every column line in every table block (0001 + profiles in 0002) must
    // have produced a ColumnDef — an unknown type is a loud failure.
    let declared = 0
    for (const block of [...SCHEMA_SQL.matchAll(/create table public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g), ...RLS_SQL.matchAll(/create table public\.([a-z0-9_]+) \(([\s\S]*?)\n\);/g)]) {
      for (const line of block[2].split('\n')) {
        if (/^  [a-z0-9_]+\s+[a-z]/.test(line) && !/^  constraint /.test(line)) declared += 1
      }
    }
    expect(COLUMNS.length).toBe(declared)
  })
})

describe('2. RLS coverage (fail-closed posture)', () => {
  const allTables = [...parseTables(SCHEMA_SQL), ...parseTables(RLS_SQL)]
  const rlsEnabled = parseDoArrayForMarker(RLS_SQL, 'enable row level security')
  const policyTables = new Map<string, number>()
  for (const m of RLS_SQL.matchAll(/create policy [a-z0-9_]+ on public\.([a-z0-9_]+)/g)) {
    policyTables.set(m[1], (policyTables.get(m[1]) ?? 0) + 1)
  }

  it('RLS is enabled + anon revoked for exactly the 72 tables (71 + profiles)', () => {
    expect(new Set(rlsEnabled).size).toBe(72)
    expect(new Set(rlsEnabled)).toEqual(new Set(allTables))
  })

  it('every table carries at least one policy (no default-deny holes)', () => {
    for (const t of allTables) {
      expect(policyTables.get(t) ?? 0, `table "${t}" has no policy`).toBeGreaterThan(0)
    }
  })

  it('every policy targets authenticated (anon never gets a policy)', () => {
    for (const m of RLS_SQL.matchAll(/create policy [a-z0-9_]+ on public\.[a-z0-9_]+ for (?:select|insert|update|delete) to ([a-z]+)/g)) {
      expect(m[1]).toBe('authenticated')
    }
  })

  it('the fail-closed helpers exist (is_staff / can_read_project / is_own_supplier_row)', () => {
    expect(RLS_SQL).toContain('function public.is_staff()')
    expect(RLS_SQL).toContain('function public.can_read_project(')
    expect(RLS_SQL).toContain('function public.is_own_supplier_row(')
    expect(RLS_SQL).toContain('function public.maintenance_allowed()')
  })

  it('staff band mirrors guard.ts OWNER_ROLES exactly', () => {
    const staffFn = RLS_SQL.match(/function public\.is_staff\(\)[\s\S]*?\$\$\s*select public\.app_role\(\) in\s*\(([^)]*)\)\s*\$\$/)
    expect(staffFn).toBeTruthy()
    const roles = (staffFn![1].match(/'([a-z]+)'/g) ?? []).map((r) => r.slice(1, -1)).sort()
    expect(roles).toEqual(['admin', 'contractor', 'finance', 'procurement', 'qs', 'supervisor'])
  })
})

describe('3. money & quantity typing (the Float-money fix stays fixed)', () => {
  it('every pinned money column is numeric(18,2)', () => {
    for (const [table, column] of MONEY_COLUMNS) {
      const def = COLUMNS.find((c) => c.table === table && c.column === column)
      expect(def, `${table}.${column} missing from 0001`).toBeTruthy()
      expect(def!.type, `${table}.${column} must be numeric(18,2)`).toBe('numeric(18,2)')
    }
  })

  it('every pinned quantity column is numeric(18,3)', () => {
    for (const [table, column] of QUANTITY_COLUMNS) {
      const def = COLUMNS.find((c) => c.table === table && c.column === column)
      expect(def, `${table}.${column} missing from 0001`).toBeTruthy()
      expect(def!.type, `${table}.${column} must be numeric(18,3)`).toBe('numeric(18,3)')
    }
  })

  it('no money column anywhere uses float/double (lat-lng excepted)', () => {
    const bad = COLUMNS.filter(
      (c) => /_(amount|price|fee|total|budget|balance|wage|rate|cost|subtotal|tax|impact)$/i.test(c.column)
        && (c.type === 'float' || c.type === 'double precision' || c.type === 'real'),
    )
    expect(bad).toEqual([])
  })

  it('lat/lng/zone coords stay double precision (geographic, not money)', () => {
    const geo = COLUMNS.filter(
      (c) => ['lat', 'lng', 'gps_lat', 'gps_lng', 'x', 'y', 'w', 'h', 'extraction_confidence'].includes(c.column),
    )
    expect(geo.length).toBeGreaterThanOrEqual(11)
    for (const col of geo) expect(col.type, `${col.table}.${col.column}`).toBe('double precision')
  })
})

describe('4. timestamps are timestamptz everywhere', () => {
  it('no bare `timestamp` (without tz) appears in any migration', () => {
    for (const sql of [SCHEMA_SQL, RLS_SQL, PLATFORM_SQL]) {
      const bare = Array.from(sql.matchAll(/\btimestamp\b(?! with time zone)/g))
      expect(bare, `bare timestamp in migration: ${bare[0]?.[0]}`).toEqual([])
    }
  })

  it('Attendance.date stays text (site-local calendar day, by design)', () => {
    const def = COLUMNS.find((c) => c.table === 'attendances' && c.column === 'date')
    expect(def?.type).toBe('text')
  })
})

describe('5. FK index coverage (SQLite never had these; Postgres needs them)', () => {
  const allIndexable = [...INDEXES, ...UNIQUE_CONSTRAINTS]

  it('every FK column is index-covered (leftmost prefix, inline unique, or unique constraint)', () => {
    const uncovered: string[] = []
    for (const fk of FOREIGN_KEYS) {
      if (fk.uniqueInline) continue // column-level unique is its own index
      const covered = allIndexable.some(
        (idx) => idx.table === fk.table && idx.columns[0] === fk.column,
      )
      if (!covered) uncovered.push(`${fk.table}.${fk.column}`)
    }
    expect(uncovered).toEqual([])
  })

  it('the parsed FK set is non-trivial (the parser actually works)', () => {
    expect(FOREIGN_KEYS.length).toBeGreaterThan(60)
  })
})

describe('6. append-only discipline (policies + triggers)', () => {
  it('append-only tables have NO update/delete policies', () => {
    for (const t of APPEND_ONLY) {
      for (const m of RLS_SQL.matchAll(new RegExp(`create policy [a-z0-9_]+ on public\\.${t} for (update|delete)`, 'g'))) {
        expect(m, `${t} must not have an update/delete policy`).toBeFalsy()
      }
    }
  })

  it('append-only tables have immutability triggers wired (fire even for service role)', () => {
    const immutable = parseDoArrayForMarker(RLS_SQL, 'execute function public.reject_mutation()')
    expect(new Set(immutable)).toEqual(new Set(APPEND_ONLY))
    expect(immutable.length).toBe(APPEND_ONLY.length)
  })

  it('ledger transactions are append-only like ledger entries (#133 / DB-11: reversals are new rows)', () => {
    // In the blanket set — the old reversal-only update guard is GONE.
    expect(APPEND_ONLY).toContain('ledger_transactions')
    expect(RLS_SQL).not.toContain('guard_ledger_txn_update')
    expect(RLS_SQL).not.toContain('ledger_transactions_update_guard')
    expect(RLS_SQL).not.toContain('ledger_transactions_delete_guard')
  })
})

describe('7. money invariants DB-enforced', () => {
  it('balanced-legs constraint trigger is deferred (checked at COMMIT)', () => {
    expect(RLS_SQL).toContain('function public.assert_ledger_balanced()')
    const trig = RLS_SQL.match(/create constraint trigger ledger_entries_balanced[\s\S]*?;/)
    expect(trig).toBeTruthy()
    expect(trig![0]).toContain('deferrable initially deferred')
    expect(trig![0]).toContain('after insert or update or delete')
  })

  it('one reversal per original: reversal_of_id carries a UNIQUE index (#133 / DB-11)', () => {
    const idx = INDEXES.find((i) => i.table === 'ledger_transactions' && i.columns[0] === 'reversal_of_id')
    expect(idx).toMatchObject({ unique: true })
  })

  it('escrow balance can never go negative', () => {
    expect(RLS_SQL).toContain('function public.guard_escrow_balance()')
    expect(RLS_SQL).toMatch(/create trigger escrow_wallets_balance_guard/)
  })

  it('sync entity versions are monotonic (stale writes rejected)', () => {
    expect(RLS_SQL).toContain('function public.guard_version_monotonic()')
    expect(RLS_SQL).toMatch(/create trigger tasks_version_guard/)
    expect(RLS_SQL).toMatch(/create trigger attendances_version_guard/)
  })
})

describe('8. hygiene', () => {
  it('updated_at triggers cover every table that has an updated_at column', () => {
    const withUpdatedAt = COLUMNS.filter((c) => c.column === 'updated_at').map((c) => c.table)
    const touched = parseDoArrayForMarker(RLS_SQL, 'execute function public.touch_updated_at()')
    expect(new Set(touched)).toEqual(new Set(withUpdatedAt))
    expect(touched.length).toBe(withUpdatedAt.length)
  })

  it('no secrets/tokens embedded in any migration', () => {
    for (const sql of [SCHEMA_SQL, RLS_SQL, PLATFORM_SQL]) {
      expect(sql).not.toMatch(/ghp_[A-Za-z0-9]+/)
      expect(sql).not.toMatch(/sk_live_[A-Za-z0-9]+/)
      expect(sql).not.toMatch(/password\s*[:=]\s*'[^']+'/i)
      expect(sql).not.toMatch(/Bearer [A-Za-z0-9._-]{16,}/)
    }
  })

  it('platform layer: buckets, realtime, cron template present', () => {
    expect(PLATFORM_SQL).toContain("values ('site-photos', 'site-photos', true")
    expect(PLATFORM_SQL).toContain("values ('documents', 'documents', false")
    expect(PLATFORM_SQL).toContain('add table public.notifications')
    expect(PLATFORM_SQL).toContain("cron.schedule('mjengo-jobs-drain'")
    expect(PLATFORM_SQL).toContain('mjengo_jobs_run_token') // vault-read, never inline
  })

  it('storage policies are path-tenancy checked (project folder = first segment)', () => {
    expect(PLATFORM_SQL).toContain('function public.storage_project_of(')
    expect(PLATFORM_SQL.match(/create policy storage_documents_select/g)?.length).toBe(1)
  })
})

describe('9. profile/auth mapping (Phase 2 seam)', () => {
  it('claims are minted server-side (token hook reads profiles, not client input)', () => {
    expect(RLS_SQL).toContain('function auth.custom_access_token_hook()')
    expect(RLS_SQL).toContain('app_role')
    expect(RLS_SQL).toContain('app_project_id')
    expect(RLS_SQL).toContain('app_supplier_id')
  })

  it('signup auto-provisions a profile (handle_new_user on auth.users)', () => {
    expect(RLS_SQL).toContain('function public.handle_new_user()')
    expect(RLS_SQL).toContain('create trigger on_auth_user_created')
  })

  it('role/pin columns are never self-service (guard trigger)', () => {
    expect(RLS_SQL).toContain('function public.guard_profiles_update()')
    expect(RLS_SQL).toMatch(/create trigger profiles_guard/)
  })
})
