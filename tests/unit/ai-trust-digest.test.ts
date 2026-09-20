/**
 * W6-2 — Diaspora Trust Digest invariants
 * (src/backend/modules/ai/trust-digest.ts, actions/ai.ts, the share GET
 * branch, the digest.trust job + event policy, the flag/role gates).
 *
 * One block per acceptance criterion (the ai-draw-review / ai-provider /
 * mjengo-score idioms — the REAL SDK is vi.mock'ed, zero network, zero keys):
 *   · DETERMINISM — identical fixture rows + window → byte-identical EN and
 *     SW text and the same textHash (two-run deep-equal); a changed row set
 *     → a different text + hash. The window is an INPUT (fixed `now`).
 *   · ZERO MODEL FIGURES — every digit run in the EN and SW text is either
 *     a fixture row value, a fixture row's ledger-ref/date digits, or one of
 *     the documented deterministic derivations the TEST recomputes (release
 *     total, score delta, budget pace %, overall progress %, counts). The
 *     model never authors a number — the text is template-only.
 *   · EN + SW templates both render, differ, and the SW one keeps the i18n
 *     jargon policy (ledger / MJENGO SCORE / escrow stay English).
 *   · FLAG OFF → the action REFUSES (single-line Error), the weekly JOB
 *     skips honestly (skipped reason, no rows), the AI_ACTIONS family gate
 *     403s a contractor session, and the SDK is NEVER contacted anywhere.
 *   · PROVIDER NULL (flag on, ZAI.create rejects) → the TEXT row is still
 *     written (deterministic, no SDK needed), audio honestly NULL,
 *     audioStatus 'unavailable', providerId null.
 *   · TTS SUCCESS → audioBase64 populated (round-trips to a parseable WAV),
 *     audioStatus 'ready', providerId 'zai'.
 *   · TTS FAILURE / TIMEOUT → audioStatus 'failed' with the leak-free error,
 *     the TEXT row intact, no throw into the caller (text is the product).
 *   · LONG TEXT → chunked under the 1024-char API cap (N SDK calls, every
 *     input ≤ 1000).
 *   · APPEND-ONLY — regeneration appends (latest wins); the stub has no
 *     update/delete path; no src code path calls trustDigest.update/delete/
 *     upsert (grep pin).
 *   · NON-INFLUENCE — TrustDigest references exist ONLY in the ai module,
 *     its action registration, the share read, the job, the event policy,
 *     the frontend display wiring, the audit kind map and the i18n strings;
 *     the MUTATING modules stay digest-blind.
 *   · EVENT POLICY — one 'digest.trust' event per action run → ONE in-app
 *     notification row (kind 'trust.digest', channel in_app, deliveryStatus
 *     'logged', client audience); the weekly job emits ONE event for BOTH
 *     languages.
 *   · SHARE SERVING — valid token → digest JSON (text always; audio only
 *     from the row, or rendered on explicit &audio=1); revoked token → the
 *     standard 404 BEFORE any digest query; flag-off share links never
 *     contact the SDK.
 *   · I18N — every trustDigest.* key exists in BOTH dictionaries, non-empty.
 *   · MIGRATION — 8_trust_digest is ONE CREATE TABLE, additive-only, and
 *     its columns match the Prisma model.
 *
 * @/backend/lib/db is swapped for an in-memory stub (the ai-draw-review
 * pattern) whose where-clause understands equality + { in, not, gte, lte }
 * (the digest windows query createdAt ranges); the engines run REAL.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------- SDK mock
// z-ai-web-dev-sdk swapped for vi.fn()s (the ai-provider.test.ts idiom): the
// REAL SDK, its .z-ai-config and the network are NEVER touched.
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  chatCreate: vi.fn(),
  visionCreate: vi.fn(),
  asrCreate: vi.fn(),
  ttsCreate: vi.fn(),
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: sdk.create },
}))

/** A tiny valid PCM WAV (44-byte header + payload) wrapped in a raw Response. */
function fakeWavResponse(bytes = 320): Response {
  const data = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) data[i] = i % 251
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(8000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return new Response(Buffer.concat([header, data]), { headers: { 'content-type': 'audio/wav' } })
}

// ---------------------------------------------------------------- db mock
vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    drawPacks: new Map<string, Row>(),
    sitePhotos: new Map<string, Row>(),
    mjengoScores: new Map<string, Row>(),
    aiInsights: new Map<string, Row>(),
    aiReviewNotes: new Map<string, Row>(),
    transactions: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    trustDigests: new Map<string, Row>(),
    domainEvents: [] as Row[],
    notifications: [] as Row[],
    auditEvents: [] as Row[],
    // The five legacy flags default-on; `ai` ABSENT by default → lazily
    // created with FLAG_DEFAULTS.ai === false (the fresh-install path).
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ] as Array<{ key: string; enabled: boolean; description: string }>,
    /** Mutation counters — the "no row on failure" assertions. */
    createCounts: { trustDigest: 0, notification: 0, auditEvent: 0, domainEvent: 0 },
    _id(prefix: string) {
      return `${prefix}_${++state.seq}`
    },
    reset() {
      state.seq = 0
      for (const m of Object.values(state)) {
        if (m instanceof Map) m.clear()
      }
      state.domainEvents.length = 0
      state.notifications.length = 0
      state.auditEvents.length = 0
      state.createCounts = { trustDigest: 0, notification: 0, auditEvent: 0, domainEvent: 0 }
    },
  }

  const toTime = (v: unknown): number | null => {
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'string' || typeof v === 'number') {
      const t = new Date(v).getTime()
      return Number.isFinite(t) ? t : null
    }
    return null
  }

  /** Just enough of Prisma's where: equality, { in }, { not }, { gte, lte }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('not' in c && row[key] === (c.not as unknown)) return false
        if ('gte' in c) {
          const a = toTime(row[key])
          const b = toTime(c.gte)
          if (a === null || b === null ? row[key] !== c.gte : a < b) return false
        }
        if ('lte' in c) {
          const a = toTime(row[key])
          const b = toTime(c.lte)
          if (a === null || b === null ? row[key] !== c.lte : a > b) return false
        }
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const scoped = (map: Map<string, Row>, where: Row): Row[] =>
    [...map.values()].filter((r) => matches(r, where))

  /** orderBy as object OR array of single-key objects; later insert wins ties. */
  function orderIdx(row: Row): number {
    const n = Number(String(row.id).split('_').pop())
    return Number.isFinite(n) ? n : 0
  }
  function compare(a: Row, b: Row, field: string, dir: unknown): number {
    const av = a[field]
    const bv = b[field]
    const at = toTime(av)
    const bt = toTime(bv)
    const cmp =
      at !== null && bt !== null
        ? at - bt
        : String(av) < String(bv)
          ? -1
          : String(av) > String(bv)
            ? 1
            : 0
    return dir === 'desc' ? -cmp : cmp
  }
  function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
    if (!orderBy) return rows
    const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const [[field, dir]] = Object.entries(clause as Row)
        const cmp = compare(a, b, field, dir)
        if (cmp !== 0) return cmp
      }
      return orderIdx(a) - orderIdx(b) // stable, last append wins exact ties
    })
  }

  const project = (rows: Row[], select?: Row): Row[] =>
    select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) {
        if (where.id !== undefined) {
          const r = state.projects.get(String(where.id))
          return r ? { ...r } : null
        }
        if (where.shareToken !== undefined) {
          for (const r of state.projects.values()) {
            if (r.shareToken === where.shareToken) return { ...r }
          }
        }
        return null
      },
      async findFirst({ orderBy }: { orderBy?: Row }) {
        const rows = sorted([...state.projects.values()], orderBy)
        return rows[0] ? { ...rows[0] } : null
      },
    },
    drawPack: {
      async findMany({ where, orderBy, select }: { where: Row; orderBy?: Row | Row[]; select?: Row }) {
        return project(sorted(scoped(state.drawPacks, where), orderBy), select).map((r) => ({ ...r }))
      },
    },
    sitePhoto: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.sitePhotos, where), select).map((p) => ({ ...p }))
      },
    },
    mjengoScore: {
      async findMany({ where, orderBy, take, select }: { where: Row; orderBy?: Row | Row[]; take?: number; select?: Row }) {
        let rows = sorted(scoped(state.mjengoScores, where), orderBy)
        if (typeof take === 'number') rows = rows.slice(0, take)
        return project(rows, select).map((r) => ({ ...r }))
      },
    },
    aiInsight: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.aiInsights, where), select).map((r) => ({ ...r }))
      },
    },
    aiReviewNote: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.aiReviewNotes, where), select).map((r) => ({ ...r }))
      },
    },
    transaction: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.transactions, where), select).map((t) => ({ ...t }))
      },
    },
    phase: {
      // select carries a nested tasks projection — the stub returns full rows
      // (they include the tasks array), which the engine reads identically.
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) {
        return sorted(scoped(state.phases, where), orderBy).map((p) => ({ ...p }))
      },
    },
    // APPEND-ONLY by construction: create/findFirst ONLY. There is
    // deliberately NO update/delete method — the immutability contract
    // under test (the MjengoScore / AiReviewNote stub idiom).
    trustDigest: {
      async create({ data }: { data: Row }) {
        const row: Row = {
          id: `td_${++state.seq}`,
          audioBase64: null,
          audioMime: null,
          audioStatus: 'unavailable',
          audioError: null,
          providerId: null,
          ruleVersion: 1,
          ...data,
        }
        if (!row.createdAt) row.createdAt = new Date()
        state.trustDigests.set(String(row.id), row)
        state.createCounts.trustDigest++
        return { ...row }
      },
      async findFirst({ where, orderBy }: { where: Row; orderBy?: Row }) {
        const rows = sorted(scoped(state.trustDigests, where), orderBy)
        return rows[0] ? { ...rows[0] } : null
      },
    },
    domainEvent: {
      async create({ data }: { data: Row }) {
        const row = { id: `dev_${++state.seq}`, occurredAt: new Date(), processedAt: null, ...data }
        state.domainEvents.push(row)
        state.createCounts.domainEvent++
        return { ...row }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.domainEvents.find((r) => r.id === where.id)
        if (!row) throw new Error('Record not found')
        Object.assign(row, data)
        return { ...row }
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: `notif_${++state.seq}`, readAt: null, ...data }
        state.notifications.push(row)
        state.createCounts.notification++
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        const row = { id: `audit_${++state.seq}`, ...data }
        state.auditEvents.push(row)
        state.createCounts.auditEvent++
        return { ...row }
      },
    },
    featureFlag: {
      // The real ensureRows upsert (lazily creates the row with the default).
      async upsert({ where, create }: { where: { key: string }; create: { key: string; enabled: boolean; description: string } }) {
        if (!state.flagRows.find((r) => r.key === where.key)) state.flagRows.push({ ...create })
        const row = state.flagRows.find((r) => r.key === where.key)
        return row ? { ...row } : { ...create }
      },
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        const keys = where?.key?.in
        return state.flagRows
          .filter((r) => !keys || keys.includes(r.key))
          .map((r) => ({ ...r }))
      },
      async update({ where, data }: { where: { key: string }; data: { enabled: boolean } }) {
        const row = state.flagRows.find((r) => r.key === where.key)
        if (!row) throw new Error('Record not found')
        row.enabled = data.enabled
        return { ...row }
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { applyAction, type ActionType } from '@/backend/lib/mjengo'
import { resetAiSdkCache } from '@/backend/modules/ai/provider'
import { actionFlagGate, FLAGGED_ACTION_FAMILIES } from '@/backend/lib/action-flag-gate'
import { runTrustDigest } from '@/backend/modules/jobs/handlers'
import {
  DIGEST_RULE_VERSION,
  buildTrustDigest,
  composeDigestText,
  formatAmount,
  loadDigestFacts,
  hashDigestFacts,
  serveTrustDigestForShare,
  type DigestFacts,
} from '@/backend/modules/ai/trust-digest'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'
import { GET as shareGet } from '@/app/api/share/route'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { parseWavBuffer } from '@/backend/modules/ai/provider'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    seq: number
    projects: Map<string, Record<string, unknown>>
    drawPacks: Map<string, Record<string, unknown>>
    sitePhotos: Map<string, Record<string, unknown>>
    mjengoScores: Map<string, Record<string, unknown>>
    aiInsights: Map<string, Record<string, unknown>>
    aiReviewNotes: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    trustDigests: Map<string, Record<string, unknown>>
    domainEvents: Array<Record<string, unknown>>
    notifications: Array<Record<string, unknown>>
    auditEvents: Array<Record<string, unknown>>
    flagRows: Array<{ key: string; enabled: boolean; description: string }>
    createCounts: { trustDigest: number; notification: number; auditEvent: number; domainEvent: number }
    _id: (prefix: string) => string
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

// ---------------------------------------------------------------- fixtures

const P1 = 'p-1'
const P2 = 'p-2'

/** The fixed generation moment — the window is DATA, never a hidden clock. */
const NOW = new Date('2026-03-16T12:00:00.000Z')

const RELEASES = [
  { id: 'dp-1', milestoneName: 'Foundation complete', amount: 650_000, ledgerRef: 'LX-ABC123', createdAt: new Date('2026-03-14T09:00:00Z') },
  { id: 'dp-2', milestoneName: 'Walling to lintel level', amount: 1_200_000, ledgerRef: 'LX-DEF456', createdAt: new Date('2026-03-15T10:00:00Z') },
]

function seedBaseFixture() {
  state.projects.set(P1, {
    id: P1, shareToken: 'tok-1', name: 'Nyumba Yangu', client: 'Amina', clientType: 'diaspora',
    location: 'Karen', budget: 600_000_000n, startDate: new Date('2026-01-05'), targetDate: new Date('2026-12-01'),
    status: 'active', createdAt: new Date('2026-01-01'),
  })
  state.projects.set(P2, {
    id: P2, shareToken: 'tok-2', name: 'Other House', client: 'Buba', clientType: 'diaspora',
    location: 'Runda', budget: 400_000_000n, startDate: new Date('2026-01-06'), targetDate: new Date('2026-12-01'),
    status: 'active', createdAt: new Date('2026-01-02'),
  })
  for (const r of RELEASES) {
    state.drawPacks.set(r.id, {
      id: r.id, milestoneId: `m-${r.id}`, projectId: P1, milestoneName: r.milestoneName,
      amount: BigInt(r.amount) * 100n, // DB row: KSh fixture -> cents (#122)
      currency: 'KES', ledgerRef: r.ledgerRef, ledgerTxnId: `lt-${r.id}`,
      evidencePhotoIds: '[]', variationsOpen: '[]', attendanceSummary: '{}', mjengoScore: null,
      contentHash: 'a'.repeat(64), schemaVersion: 1, createdAt: r.createdAt,
    })
  }
  // A release OUTSIDE the 7-day window — must not appear in the digest.
  state.drawPacks.set('dp-old', {
    id: 'dp-old', milestoneId: 'm-old', projectId: P1, milestoneName: 'Site clearing',
    amount: 9_000_000n, currency: 'KES', ledgerRef: 'LX-OLD1', ledgerTxnId: 'lt-old',
    evidencePhotoIds: '[]', variationsOpen: '[]', attendanceSummary: '{}', mjengoScore: null,
    contentHash: 'b'.repeat(64), schemaVersion: 1, createdAt: new Date('2026-02-01T09:00:00Z'),
  })
  for (let i = 1; i <= 14; i++) {
    state.sitePhotos.set(`ph-${i}`, { id: `ph-${i}`, projectId: P1, phaseId: null, url: `/photos/p${i}.jpg`, caption: null, createdAt: new Date('2026-03-12T08:00:00Z') })
  }
  for (let i = 15; i <= 17; i++) {
    state.sitePhotos.set(`ph-${i}`, { id: `ph-${i}`, projectId: P1, phaseId: null, url: `/photos/p${i}.jpg`, caption: null, createdAt: new Date('2026-01-20T08:00:00Z') })
  }
  state.mjengoScores.set('ms-2', { id: 'ms-2', projectId: P1, computedAt: new Date('2026-03-15T06:00:00Z'), score: 84, confidence: 'medium', components: '[]', notes: null, ruleVersion: 'v1' })
  state.mjengoScores.set('ms-1', { id: 'ms-1', projectId: P1, computedAt: new Date('2026-03-07T06:00:00Z'), score: 79, confidence: 'low', components: '[]', notes: null, ruleVersion: 'v1' })
  state.aiInsights.set('ai-1', { id: 'ai-1', projectId: P1, targetType: 'site_photo', targetId: 'ph-3', packId: null, kind: 'duplicate', source: 'dhash', severity: 'warning', detail: '{}', confidence: null, createdAt: new Date('2026-03-13T09:00:00Z') })
  state.aiInsights.set('ai-2', { id: 'ai-2', projectId: P1, targetType: 'draw_pack', targetId: 'dp-2', packId: 'dp-2', kind: 'phase_mismatch', source: 'vision', severity: 'warning', detail: '{}', confidence: 'low', createdAt: new Date('2026-03-15T11:00:00Z') })
  state.aiInsights.set('ai-old', { id: 'ai-old', projectId: P1, targetType: 'site_photo', targetId: 'ph-9', packId: null, kind: 'duplicate', source: 'dhash', severity: 'warning', detail: '{}', confidence: null, createdAt: new Date('2026-02-10T09:00:00Z') })
  state.aiReviewNotes.set('arn-1', { id: 'arn-1', drawPackId: 'dp-1', projectId: P1, providerId: 'zai', modelLabel: 'Z AI', ruleVersion: 1, verdict: 'advisory', summary: '', confidence: 'low', findings: '[]', inputsHash: 'c'.repeat(64), reviewedBy: null, reviewedAt: null, decisionNote: null, createdAt: new Date('2026-03-14T16:00:00Z') })
  for (const [id, amount] of [['t-1', 65_000_000n], ['t-2', 120_000_000n], ['t-3', 12_000_000n], ['t-4', 88_000_000n]] as const) {
    state.transactions.set(id, { id, projectId: P1, amount })
  }
  state.phases.set('f-1', { id: 'f-1', projectId: P1, name: 'Foundation', order: 1, budget: 90_000_000n, progressManual: 100, tasks: [] })
  state.phases.set('f-2', { id: 'f-2', projectId: P1, name: 'Walling', order: 2, budget: 210_000_000n, progressManual: 40, tasks: [] })
}

/** Flip the ai flag (and drop the 30s flag cache) — the documented admin toggle. */
function setAiFlag(enabled: boolean) {
  const row = state.flagRows.find((r) => r.key === 'ai')
  if (row) row.enabled = enabled
  else state.flagRows.push({ key: 'ai', enabled, description: 'AI features (chat, vision, voice)' })
  invalidateFlagCache()
}

/** Run the action as the site team would (contractor role stamp, like /api/actions). */
async function runAction(payload: Record<string, unknown>, role = 'contractor') {
  return applyAction('ai.trustDigest' as ActionType, { ...payload, __actor: 'Juma', __role: role }, P1)
}

beforeEach(() => {
  sdk.create.mockReset()
  sdk.chatCreate.mockReset()
  sdk.visionCreate.mockReset()
  sdk.asrCreate.mockReset()
  sdk.ttsCreate.mockReset()
  sdk.create.mockResolvedValue({
    chat: { completions: { create: sdk.chatCreate, createVision: sdk.visionCreate } },
    audio: { asr: { create: sdk.asrCreate }, tts: { create: sdk.ttsCreate } },
  })
  sdk.ttsCreate.mockImplementation(async () => fakeWavResponse()) // a FRESH Response per call
  resetAiSdkCache() // drop the module singleton between tests
  state.reset()
  seedBaseFixture()
  setAiFlag(true)
})

afterEach(() => {
  vi.useRealTimers()
})

// ================================================================ determinism

describe('deterministic text — same rows, byte-identical', () => {
  it('identical fixture rows + window → identical EN text AND textHash (two runs deep-equal)', async () => {
    const a = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    const b = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(b.digest.text).toBe(a.digest.text)
      expect(b.digest.textHash).toBe(a.digest.textHash)
      expect(b.digest.ruleVersion).toBe(DIGEST_RULE_VERSION)
    }
  })

  it('the SW template is deterministic too, and DIFFERENT from EN', async () => {
    const en = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    const sw = await buildTrustDigest(P1, { lang: 'sw', now: NOW })
    expect(en.ok && sw.ok).toBe(true)
    if (en.ok && sw.ok) {
      const swAgain = await buildTrustDigest(P1, { lang: 'sw', now: NOW })
      expect(swAgain.ok && swAgain.digest.text).toBe(sw.digest.text)
      expect(sw.digest.text).not.toBe(en.digest.text)
    }
  })

  it('different rows → different text + different textHash', async () => {
    const before = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    state.drawPacks.set('dp-3', {
      id: 'dp-3', milestoneId: 'm-3', projectId: P1, milestoneName: 'Roof structure',
      amount: 95_000_000n, currency: 'KES', ledgerRef: 'LX-GHI789', ledgerTxnId: 'lt-3',
      evidencePhotoIds: '[]', variationsOpen: '[]', attendanceSummary: '{}', mjengoScore: null,
      contentHash: 'd'.repeat(64), schemaVersion: 1, createdAt: new Date('2026-03-16T08:00:00Z'),
    })
    const after = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    expect(before.ok && after.ok).toBe(true)
    if (before.ok && after.ok) {
      expect(after.digest.textHash).not.toBe(before.digest.textHash)
      expect(after.digest.text).toContain('Roof structure')
      expect(before.digest.text).not.toContain('Roof structure')
    }
  })

  it('the facts loader + composer are pure: loadDigestFacts → composeDigestText matches the engine row byte-for-byte', async () => {
    const facts = await loadDigestFacts(P1, 7, NOW)
    expect(facts).not.toBeNull()
    if (facts) {
      const en = await buildTrustDigest(P1, { lang: 'en', now: NOW })
      expect(en.ok && en.digest.text).toBe(composeDigestText(facts, 'en'))
      expect(en.ok && en.digest.textHash).toBe(hashDigestFacts(facts))
    }
  })
})

// ================================================================ zero model figures

describe('zero model figures — every number in the text is a row (or documented row math)', () => {
  /**
   * The allowed number set, recomputed BY THE TEST from the fixture rows:
   * row values verbatim (amounts, ledger refs, dates, counts, scores) plus
   * the four documented deterministic derivations the template performs
   * (release total, score delta, budget pace %, budget-weighted progress %).
   */
  function allowedNumbers(): Set<string> {
    const allowed = new Set<string>()
    const addRaw = (n: number) => {
      allowed.add(String(n))
      allowed.add(formatAmount(n)) // the template's comma-grouped form
    }
    for (const r of RELEASES) addRaw(r.amount)
    addRaw(RELEASES.reduce((s, r) => s + r.amount, 0)) // Total released
    addRaw(6_000_000) // project budget row
    addRaw(650_000 + 1_200_000 + 120_000 + 880_000) // spent (txn rows)
    addRaw(84) // latest score row
    addRaw(79) // prior score row
    addRaw(100) // the fixed "of 100" score scale in the template (not a row, a constant)
    addRaw(84 - 79) // the score delta
    addRaw(14) // evidence photo rows in window
    addRaw(2) // insights in window
    addRaw(1) // review notes in window
    addRaw(3) // total AI flags (2 + 1)
    addRaw(4) // transaction rows
    addRaw(7) // window days (the input)
    addRaw(Math.round(((650_000 + 1_200_000 + 120_000 + 880_000) / 6_000_000) * 100)) // pace %
    addRaw(Math.round((((100 / 100) * 900_000 + (40 / 100) * 2_100_000) / 3_000_000) * 100)) // progress %
    // Window ISO dates → their digit components (2026, 03, 09, 16).
    const start = new Date(NOW.getTime() - 7 * 86_400_000).toISOString()
    const end = NOW.toISOString()
    for (const iso of [start, end]) for (const d of iso.match(/\d+/g) ?? []) allowed.add(d)
    // Ledger refs → their digit components (123, 456).
    for (const r of RELEASES) for (const d of r.ledgerRef.match(/\d+/g) ?? []) allowed.add(d)
    return allowed
  }

  it.each(['en', 'sw'] as const)('%s text: every digit run is row-authorized (nothing the model could have invented)', async (lang) => {
    const res = await buildTrustDigest(P1, { lang, now: NOW })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const runs = res.digest.text.match(/\d[\d.,]*/g) ?? []
    expect(runs.length).toBeGreaterThan(10) // the fixture renders a real digest
    const allowed = allowedNumbers()
    const offenders = runs.filter((run) => {
      const cleaned = run.replace(/[.,]+$/, '') // trailing sentence punctuation
      return !allowed.has(cleaned) && !allowed.has(run)
    })
    expect(offenders, `numbers in the ${lang} text that no row or documented rule produced: ${offenders.join(' | ')}`).toEqual([])
    // Explicit pins (the exact-substring AC): amounts, refs, score, pace.
    for (const needle of [
      'KSh 650,000', 'KSh 1,200,000', 'KSh 1,850,000', 'LX-ABC123', 'LX-DEF456',
      '84/100', 'KSh 6,000,000', 'KSh 2,850,000', '48%', '58%',
    ]) {
      expect(res.digest.text).toContain(needle)
    }
    // The out-of-window release must NOT appear.
    expect(res.digest.text).not.toContain('Site clearing')
    expect(res.digest.text).not.toContain('LX-OLD1')
  })

  it('the SW text keeps the i18n jargon policy: ledger / MJENGO SCORE / row values stay English/verbatim', async () => {
    const res = await buildTrustDigest(P1, { lang: 'sw', now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.digest.text).toContain('ledger LX-ABC123')
      expect(res.digest.text).toContain('MJENGO SCORE: 84/100')
      expect(res.digest.text).toContain('Foundation complete') // row value verbatim
      expect(res.digest.text).toContain('— MjengoOS')
    }
  })

  it('zero releases → the honest empty line (SW keeps the escrow jargon)', async () => {
    state.drawPacks.clear()
    const res = await buildTrustDigest(P1, { lang: 'sw', now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.digest.text).toContain('MALIPO YA WIKI HII (0):')
      expect(res.digest.text).toContain('escrow')
      expect(res.digest.text).not.toContain('Jumla iliyolipwa')
    }
  })
})

// ================================================================ flag / role / input gates

describe('flag + role + input gates (fail-closed, SDK never contacted while off)', () => {
  it('flag OFF → the action REFUSES honestly, no row, no event, no audit, SDK never contacted', async () => {
    setAiFlag(false)
    await expect(runAction({ lang: 'en' })).rejects.toThrow(/ai feature flag is off/)
    expect(sdk.create).toHaveBeenCalledTimes(0)
    expect(state.trustDigests.size).toBe(0)
    expect(state.domainEvents).toHaveLength(0)
    expect(state.auditEvents).toHaveLength(0)
  })

  it('the AI_ACTIONS family carries ai.trustDigest — the shared flag-family gate (POST /api/actions + /api/sync)', async () => {
    setAiFlag(false)
    const family = FLAGGED_ACTION_FAMILIES.find((f) => f.flag === 'ai')
    expect(family?.actions).toContain('ai.trustDigest')
    // Contractor session (non-admin) → the uniform 403 response.
    const denied = await actionFlagGate('ai.trustDigest', { user: { role: 'contractor' } })
    expect(denied).not.toBeNull()
    expect(denied?.status).toBe(403)
    // Admin bypass — the documented toggle-and-test path.
    const admin = await actionFlagGate('ai.trustDigest', { user: { role: 'admin' } })
    expect(admin).toBeNull()
  })

  it('client / supervisor / finance roles → refused by the applyAction role gate (no row, no SDK)', async () => {
    for (const role of ['client', 'supervisor', 'finance', 'share_client'] as const) {
      await expect(runAction({ lang: 'en' }, role)).rejects.toThrow(/Only a contractor or admin may run an AI review action/)
    }
    expect(sdk.create).toHaveBeenCalledTimes(0)
    expect(state.trustDigests.size).toBe(0)
  })

  it('payload without an explicit lang → honest refusal (no silent default language)', async () => {
    await expect(runAction({})).rejects.toThrow(/needs an explicit lang/)
    await expect(runAction({ lang: 'fr' })).rejects.toThrow(/needs an explicit lang/)
    expect(state.trustDigests.size).toBe(0)
  })

  it('unknown project → honest failure, no row', async () => {
    const res = await buildTrustDigest('nope', { lang: 'en', now: NOW })
    expect(res).toMatchObject({ ok: false, unavailable: false })
    expect(res.ok ? '' : res.error).toContain('No project found')
    expect(state.trustDigests.size).toBe(0)
  })

  it('the weekly JOB skips honestly while the flag is off (no rows, no event, SDK never contacted)', async () => {
    setAiFlag(false)
    const job = await runTrustDigest(P1)
    expect(job.digests).toHaveLength(0)
    expect(job.skipped).toContain('ai feature flag is off')
    expect(sdk.create).toHaveBeenCalledTimes(0)
    expect(state.trustDigests.size).toBe(0)
    expect(state.domainEvents).toHaveLength(0)
  })
})

// ================================================================ audio honesty

describe('audio is the bonus, text is the product', () => {
  it('flag ON + provider NULL (ZAI.create rejects) → the TEXT row is still written, audio honestly unavailable', async () => {
    sdk.create.mockRejectedValue(new Error('Configuration file not found or invalid. Please create .z-ai-config in your project, home directory, or /etc.'))
    const res = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.digest.audioStatus).toBe('unavailable')
      expect(res.digest.text).toContain('KSh 1,850,000') // the product shipped
      expect(state.trustDigests.size).toBe(1)
      const row = state.trustDigests.values().next().value as Record<string, unknown>
      expect(row.audioBase64).toBeNull()
      expect(row.audioError).toContain('AI unavailable')
      expect(row.providerId).toBeNull()
    }
  })

  it('TTS SUCCESS → audioBase64 round-trips to a parseable WAV, audioStatus ready, providerId stamped', async () => {
    const res = await buildTrustDigest(P1, { lang: 'sw', now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.digest.audioStatus).toBe('ready')
      expect(res.digest.providerId).toBe('zai')
      const row = state.trustDigests.values().next().value as Record<string, unknown>
      const wav = parseWavBuffer(Buffer.from(String(row.audioBase64), 'base64'))
      expect(wav).not.toBeNull()
      expect(wav?.data.length).toBe(320)
      expect(row.audioMime).toBe('audio/wav')
    }
  })

  it('TTS FAILURE → audioStatus failed with the leak-free error; the text row is INTACT; no throw', async () => {
    sdk.ttsCreate.mockRejectedValueOnce(
      new Error('API request failed with status 500: {"error":"tts down","key":"sk-live-42"}}'),
    )
    const res = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.digest.audioStatus).toBe('failed')
      expect(res.digest.audioError).toContain('HTTP 500')
      expect(res.digest.audioError).not.toContain('sk-live-42')
      expect(res.digest.audioError).not.toContain('tts down')
      expect(res.digest.text).toContain('Total released: KSh 1,850,000') // the text never degrades
    }
  })

  it('TTS TIMEOUT → honest failure after the 20s cap, text intact, no throw', async () => {
    vi.useFakeTimers()
    sdk.ttsCreate.mockReturnValueOnce(new Promise(() => {})) // never settles
    const pending = buildTrustDigest(P1, { lang: 'en', now: NOW })
    await vi.advanceTimersByTimeAsync(20_000)
    const res = await pending
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.digest.audioStatus).toBe('failed')
      expect(res.digest.audioError).toContain('timed out after 20s')
      expect(res.digest.text).toContain('BUDGET PACE')
    }
  })

  it('a digest text longer than the 1024-char API cap → the voice note is CHUNKED (N SDK calls, every input ≤ 1000)', async () => {
    // Six releases with 200-char names → a ~2000-char digest text.
    const longName = 'Structural works package including excavation hardcore filling compaction blinding reinforcement and walling works'
    for (let i = 1; i <= 6; i++) {
      const id = `dp-long-${i}`
      state.drawPacks.set(id, {
        id, milestoneId: `m-long-${i}`, projectId: P1, milestoneName: `${longName} ${i}`,
        amount: BigInt(100_000 + i) * 100n, currency: 'KES', ledgerRef: `LX-L${i}`, ledgerTxnId: `lt-l${i}`,
        evidencePhotoIds: '[]', variationsOpen: '[]', attendanceSummary: '{}', mjengoScore: null,
        contentHash: 'e'.repeat(64), schemaVersion: 1, createdAt: new Date('2026-03-13T08:00:00Z'),
      })
    }
    const res = await buildTrustDigest(P1, { lang: 'en', now: NOW })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.digest.text.length).toBeGreaterThan(1_024)
    expect(sdk.ttsCreate.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of sdk.ttsCreate.mock.calls) {
      expect((call[0] as { input: string }).input.length).toBeLessThanOrEqual(1_000)
    }
  })
})

// ================================================================ append-only + events + audit

describe('append-only rows, the event policy, the audit kind', () => {
  it('re-running the action APPENDS (latest wins); the stub contract has no update path', async () => {
    await runAction({ lang: 'en' })
    await runAction({ lang: 'en' })
    expect(state.trustDigests.size).toBe(2)
    const latest = await serveTrustDigestForShare(P1, { lang: 'en' })
    expect(latest).not.toBeNull()
    // latest wins = the second row (higher seq id)
    const ids = [...state.trustDigests.keys()]
    expect(latest?.id).toBe(ids[1])
  })

  it('one successful run → ONE digest row + ONE digest.trust event + ONE in-app notification (honest logged state) + ONE ai_digest audit event', async () => {
    await runAction({ lang: 'en' })
    expect(state.trustDigests.size).toBe(1)
    expect(state.createCounts.trustDigest).toBe(1)
    // Event + notification: kind trust.digest, channel in_app, 'logged', client audience.
    const events = state.domainEvents.filter((e) => e.type === 'digest.trust')
    expect(events).toHaveLength(1)
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0]).toMatchObject({
      kind: 'trust.digest', channel: 'in_app', deliveryStatus: 'logged',
      audienceRole: 'client', recipient: 'Amina',
    })
    // The audit kind: applyAction auto-writes it (kindForAction → ai_digest).
    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0].kind).toBe('ai_digest')
    expect(String(state.auditEvents[0].summary)).toContain('Trust digest appended')
  })

  it('a FAILED generation writes NO event, NO notification, NO audit row (no fake digest)', async () => {
    setAiFlag(false)
    await expect(runAction({ lang: 'en' })).rejects.toThrow(/ai feature flag is off/)
    expect(state.createCounts.trustDigest).toBe(0)
    expect(state.createCounts.notification).toBe(0)
    expect(state.createCounts.auditEvent).toBe(0)
    expect(state.createCounts.domainEvent).toBe(0)
  })

  it('the weekly JOB generates BOTH languages and emits exactly ONE event/notification pair', async () => {
    const job = await runTrustDigest(P1)
    expect(job.skipped).toBeNull()
    expect(job.digests.map((d) => d.lang).sort()).toEqual(['en', 'sw'])
    expect(state.trustDigests.size).toBe(2)
    expect(state.domainEvents.filter((e) => e.type === 'digest.trust')).toHaveLength(1)
    expect(state.notifications).toHaveLength(1)
    // TTS ran for both languages (the job is the bilingual weekly path).
    expect(sdk.ttsCreate.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

// ================================================================ share serving

describe('share GET — the digest rides the existing token gate', () => {
  const req = (query: string, ip = '203.0.113.9') =>
    new NextRequest(`http://localhost/api/share${query}`, { headers: { 'x-forwarded-for': ip } })

  beforeEach(async () => {
    await runAction({ lang: 'sw' })
    await runAction({ lang: 'en' })
  })

  it('valid token + lang → the latest digest JSON (text always; no audio leg → honest note)', async () => {
    const res = await shareGet(req('?token=tok-1&trustDigest=latest&lang=sw'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.digest).toMatchObject({ lang: 'sw', audioStatus: 'ready' })
    expect(body.digest.text).toContain('MJENGO-OS TRUST DIGEST')
    // audio=1 not requested → the ROW's stored audio is served anyway (it exists):
    expect(body.digest.audio).toMatchObject({ mimeType: 'audio/wav' })
    expect(body.project.name).toBe('Nyumba Yangu')
  })

  it('no digest rows at all → digest null (the honest empty state, not an error)', async () => {
    state.trustDigests.clear()
    const res = await shareGet(req('?token=tok-1&trustDigest=latest&lang=en', '203.0.113.10'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.digest).toBeNull()
  })

  it('REVOKED/regenerated token → the standard share 404 BEFORE any digest query', async () => {
    const digestFindFirst = vi.spyOn(db.trustDigest, 'findFirst')
    state.projects.get(P1)!.shareToken = 'tok-regenerated'
    const res = await shareGet(req('?token=tok-1&trustDigest=latest', '203.0.113.11'), undefined)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Invalid or expired link')
    expect(digestFindFirst).not.toHaveBeenCalled()
    digestFindFirst.mockRestore()
  })

  it('a trustDigest value other than latest → honest 400 (no probing surface)', async () => {
    const res = await shareGet(req('?token=tok-1&trustDigest=abc', '203.0.113.12'), undefined)
    expect(res.status).toBe(400)
  })

  it('a row with NO stored audio + &audio=1 → ON-DEMAND render (returned, not persisted; row untouched)', async () => {
    // Strip the stored audio (simulate a generation-time TTS failure).
    for (const row of state.trustDigests.values()) {
      row.audioBase64 = null
      row.audioMime = null
      row.audioStatus = 'failed'
      row.audioError = 'AI speech failed (HTTP 500)'
    }
    const callsBefore = sdk.ttsCreate.mock.calls.length
    const res = await shareGet(req('?token=tok-1&trustDigest=latest&lang=en&audio=1', '203.0.113.13'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.digest.audio).toMatchObject({ mimeType: 'audio/wav' })
    expect(body.digest.audioOnDemand).toBe(true)
    expect(sdk.ttsCreate.mock.calls.length).toBe(callsBefore + 1)
    // Append-only: the fresh render is NOT written back.
    expect((state.trustDigests.values().next().value as Record<string, unknown>).audioBase64).toBeNull()
  })

  it('the flag OFF share link NEVER contacts the SDK — audio honestly unavailable', async () => {
    setAiFlag(false)
    for (const row of state.trustDigests.values()) {
      row.audioBase64 = null
      row.audioMime = null
      row.audioStatus = 'unavailable'
      row.audioError = null
    }
    sdk.ttsCreate.mockClear() // the beforeEach generations ran with the flag ON
    sdk.create.mockClear()
    const res = await shareGet(req('?token=tok-1&trustDigest=latest&lang=en&audio=1', '203.0.113.14'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true) // READING stays open (the W6-1 boundary)
    expect(body.digest.text).toContain('MJENGO-OS TRUST DIGEST')
    expect(body.digest.audio).toBeNull()
    expect(body.digest.audioNote).toContain('Audio not available')
    expect(sdk.create).not.toHaveBeenCalled()
    expect(sdk.ttsCreate).not.toHaveBeenCalled()
  })
})

// ================================================================ non-influence (grep-level)

describe('non-influence: digest rows change no action outcomes anywhere', () => {
  /** Recursively collect .ts/.tsx files under a directory. */
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
    }
    return out
  }

  it('TrustDigest / trustDigest appears ONLY in the ai module, its wiring and the display strings', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const allowlist = new Set([
      'src/backend/modules/ai/trust-digest.ts', // the engine (reads rows, appends digests)
      'src/backend/actions/ai.ts', // the ai.trustDigest action registration + dispatcher
      'src/backend/api/action-schemas.ts', // #161 registry: the request-contract catalog lists every action type — validation wiring, no domain reads
      'src/backend/lib/audit.ts', // kind map + ledger one-liner only — no reads
      'src/backend/api/share.ts', // the read-only share GET branch
      'src/backend/modules/jobs/handlers.ts', // the digest.trust job twin
      'src/backend/modules/events/service.ts', // the NOTIFY_POLICY entry
      'src/backend/modules/notify/types.ts', // the notification kind union
      'src/backend/modules/intel/flags.ts', // comment-only enforcement-map lines
      'src/frontend/mjengo/intel/sections/trust-digest-section.tsx', // display wiring only
      'src/frontend/mjengo/intel-tab.tsx', // mounts the section — display wiring only
      // #150 waiting-worklist: the offline-refusal REMINDER taxonomy names
      // the flow as a string literal kind ('ai.trustDigest') — taxonomy only,
      // the store never reads or writes digest rows (remind-only, no execution).
      'src/frontend/hooks/use-mjengo.ts',
      'src/frontend/mjengo/audit-tab.tsx', // the audit kind filter list
      'src/frontend/mjengo/header.tsx', // the notification-kind icon map
      // display strings only — dictionary values, no logic
      'src/frontend/i18n/dicts/en.ts',
      'src/frontend/i18n/dicts/sw.ts',
    ].map((p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))))
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/TrustDigest|trustDigest|digest\.trust|trust\.digest/.test(src) && !allowlist.has(file)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders, `files outside the allowlist reference the digest: ${offenders.join(', ')}`).toEqual([])
  })

  it('no code path anywhere updates/deletes a TrustDigest row (append-only, grep pin)', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/trustDigest\.(update|delete|upsert|deleteMany|updateMany)/.test(src)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the mutating modules stay digest-blind (no trustDigest reads outside the ai module + share read)', () => {
    const modules = [
      'src/backend/actions/money.ts', 'src/backend/actions/supply.ts', 'src/backend/actions/invoices.ts',
      'src/backend/actions/trust.ts', 'src/backend/actions/evidence.ts', 'src/backend/actions/land.ts',
      'src/backend/actions/professionals.ts', 'src/backend/actions/wallet.ts', 'src/backend/actions/inventory.ts',
      'src/backend/lib/mjengo.ts', 'src/backend/api/actions.ts', 'src/backend/modules/intel/score.ts',
    ]
    for (const rel of modules) {
      const file = fileURLToPath(new URL(`../../${rel}`, import.meta.url))
      const src = readFileSync(file, 'utf8')
      expect(src, `${rel} must not read TrustDigest rows`).not.toMatch(/trustDigest\.(findMany|findFirst|findUnique|create)/)
    }
  })
})

// ================================================================ i18n parity + migration

describe('i18n parity + migration shape', () => {
  it('every trustDigest.* key exists in BOTH dictionaries, non-empty', () => {
    const enKeys = Object.keys(enDict).filter((k) => k.startsWith('trustDigest.'))
    const swKeys = Object.keys(swDict).filter((k) => k.startsWith('trustDigest.'))
    expect(enKeys.length).toBeGreaterThan(20)
    expect(swKeys.sort()).toEqual(enKeys.sort())
    for (const k of enKeys) {
      expect(enDict[k].trim()).not.toBe('')
      expect(swDict[k].trim()).not.toBe('')
    }
  })

  it('migration 8_trust_digest is ONE CREATE TABLE, additive-only, and matches the Prisma model', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../prisma/migrations/08_trust_digest/migration.sql', import.meta.url)),
      'utf8',
    )
    // Strip line comments BEFORE splitting on ';' (a ';' inside a comment
    // would otherwise split a statement mid-comment).
    const body = sql.replace(/--[^\n]*/g, '')
    const statements = body
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE "TrustDigest" \(/)
    // No mutation STATEMENT (the W6-1 idiom: comment text and the FK's
    // "ON UPDATE CASCADE" may legitimately contain the words).
    const mutations = statements.filter((s) => /^(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|CREATE (INDEX|TRIGGER|VIEW))/i.test(s))
    expect(mutations, `mutation statements found: ${mutations.join(' || ')}`).toEqual([])
    expect(body.match(/CREATE TABLE/g)).toHaveLength(1)
    for (const column of [
      '"id"', '"projectId"', '"lang"', '"windowStart"', '"windowEnd"', '"text"', '"textHash"',
      '"audioBase64"', '"audioMime"', '"audioStatus"', '"audioError"', '"providerId"', '"ruleVersion"', '"createdAt"',
    ]) {
      expect(sql).toContain(column)
    }
    // The Prisma model block exists with the same columns.
    const schema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8')
    expect(schema).toContain('model TrustDigest {')
    expect(schema).toMatch(/trustDigests\s+TrustDigest\[\]/) // whitespace-agnostic (the #174 realignment is cosmetic)
  })
})
