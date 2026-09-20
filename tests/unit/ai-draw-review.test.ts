/**
 * W6-1 — AI Draw Review invariants (src/backend/modules/ai/draw-review.ts,
 * actions/ai.ts, the share GET serving, the flag/role gates).
 *
 * One block per acceptance criterion (the ai-provider / draw-pack /
 * mjengo-score idioms — the REAL SDK is vi.mock'ed, zero network, zero keys):
 *   · FLAG OFF → the action REFUSES honestly (single-line Error) and the SDK
 *     is NEVER contacted (sdk.create call count 0); the AI_ACTIONS family is
 *     registered under the `ai` flag in FLAGGED_ACTION_FAMILIES so
 *     POST /api/actions + POST /api/sync enforce the same 403 (actionFlagGate
 *     returns the feature-disabled response for a contractor session, null
 *     for an admin bypass).
 *   · PROVIDER NULL (flag on, ZAI.create rejects) → honest "AI unavailable"
 *     failure, NO AiReviewNote row, NO audit row, vision never called.
 *   · PROVIDER FAIL / TIMEOUT / EMPTY / UNPARSEABLE → leak-free honest
 *     failure (planted URL/key/body asserted absent), no fake note, no row.
 *   · SUCCESS → one append-only AiReviewNote row (verdict/confidence/
 *     findings persisted, providerId/modelLabel/ruleVersion stamped,
 *     human-decision columns NULL); a second run APPENDS (latest wins);
 *     inputsHash is deterministic (same rows → same hash, different rows →
 *     different hash) and the MODEL'S FIGURES ARE REDACTED (the ledger
 *     decides numbers — no digit run from model text survives into the row).
 *   · VISION INPUT = the pack's evidence photos resolved to bytes through
 *     the storage driver (temp-dir local-disk, real tiny PNG buffers), CAPPED
 *     at MAX_VISION_PHOTOS (8 photos on the pack → exactly 6 sent).
 *   · PERMISSIONS: contractor/admin run it; client/supervisor/finance
 *     roles are refused by the applyAction role gate; CLIENT_ACTIONS never
 *     contains ai.drawReview (clients read notes via the share link).
 *   · AUDIT: exactly one kind 'ai_review' audit event per SUCCESSFUL run
 *     (none on any failure).
 *   · SHARE SERVING: valid token → the pack response carries the LATEST note
 *     (aiReview, read-only); revoked/regenerated token → the standard share
 *     404 BEFORE any note query (findFirst never called).
 *   · NON-INFLUENCE (grep-level, the mjengo-score allowlist walk): note
 *     references exist ONLY in the ai module, its action registration, the
 *     share read, the viewer/money-tab display wiring, the audit kind map and
 *     the i18n display strings; the MUTATING modules stay note-blind; no
 *     code path anywhere calls aiReviewNote.update/delete/upsert.
 *   · MIGRATION: 05_ai_review_note is ONE CREATE TABLE, additive-only, and
 *     its columns match the Prisma model.
 *   · I18N: every aiReview.* key exists in BOTH dictionaries, non-empty.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'node:os'
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
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: sdk.create },
}))

const fakeInstance = () => ({
  chat: { completions: { create: sdk.chatCreate, createVision: sdk.visionCreate } },
  audio: { asr: { create: sdk.asrCreate } },
})

// ---------------------------------------------------------------- db mock
vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    drawPacks: new Map<string, Row>(),
    sitePhotos: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    transactions: new Map<string, Row>(),
    invoices: new Map<string, Row>(),
    invoiceLines: new Map<string, Row>(),
    aiReviewNotes: new Map<string, Row>(),
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
    createCounts: { aiReviewNote: 0, auditEvent: 0 },
    _id(prefix: string) {
      return `${prefix}_${++state.seq}`
    },
    reset() {
      state.seq = 0
      for (const m of Object.values(state)) {
        if (m instanceof Map) m.clear()
      }
      state.auditEvents.length = 0
      state.createCounts = { aiReviewNote: 0, auditEvent: 0 }
    },
  }

  /** Just enough of Prisma's where: equality + { in }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('not' in c && row[key] === (c.not as unknown)) return false
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** orderBy with the documented tie-break: later-inserted wins exact ties. */
  function orderIdx(row: Row): number {
    const n = Number(String(row.id).split('_').pop())
    return Number.isFinite(n) ? n : 0
  }
  function sorted(rows: Row[], orderBy?: Row): Row[] {
    if (!orderBy) return rows
    const [[field, dir]] = Object.entries(orderBy)
    const sign = dir === 'desc' ? -1 : 1
    return [...rows].sort((a, b) => {
      const av = a[field], bv = b[field]
      const cmp =
        av instanceof Date || bv instanceof Date
          ? new Date(av as string).getTime() - new Date(bv as string).getTime()
          : String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0
      if (cmp !== 0) return sign * cmp
      return sign * (orderIdx(a) - orderIdx(b)) // stable, last append wins
    })
  }

  const scoped = (map: Map<string, Row>, where: Row): Row[] =>
    [...map.values()].filter((r) => matches(r, where))

  const project = (map: Map<string, Row>, select?: Row): Row[] =>
    select ? map.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : map

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
    milestone: {
      async findUnique({ where }: { where: Row }) {
        const r = state.milestones.get(String(where.id))
        return r ? { ...r } : null
      },
    },
    drawPack: {
      async findUnique({ where }: { where: Row }) {
        if (where.milestoneId !== undefined) {
          for (const r of state.drawPacks.values()) {
            if (r.milestoneId === where.milestoneId) return { ...r }
          }
        }
        const r = state.drawPacks.get(String(where.id))
        return r ? { ...r } : null
      },
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.drawPacks, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy, select }: { where: Row; orderBy?: Row; select?: Row }) {
        return project(sorted(scoped(state.drawPacks, where), orderBy), select).map((r) => ({ ...r }))
      },
    },
    sitePhoto: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.sitePhotos, where), select).map((p) => ({ ...p }))
      },
    },
    phase: {
      async findMany({ where, orderBy, select }: { where: Row; orderBy?: Row | Row[]; select?: Row }) {
        return project(sorted(scoped(state.phases, where), orderBy as Row | undefined), select).map((p) => ({ ...p }))
      },
    },
    transaction: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.transactions, where), select).map((t) => ({ ...t }))
      },
    },
    invoice: {
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) {
        return sorted(scoped(state.invoices, where), orderBy as Row | undefined).map((i) => ({ ...i }))
      },
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.invoices, where)
        return rows[0] ? { ...rows[0] } : null
      },
    },
    invoiceLine: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.invoiceLines, where).map((l) => ({ ...l }))
      },
    },
    // 2-way fallback path of threeWayCheck (no PO on the fixture invoices).
    orderDeliveryLine: {
      async findMany() {
        return []
      },
    },
    purchaseOrder: {
      async findUnique() {
        return null
      },
    },
    // APPEND-ONLY by construction: create/findFirst ONLY. There is
    // deliberately NO update/delete method — the immutability contract
    // under test (the MjengoScore / DrawPack stub idiom).
    aiReviewNote: {
      async create({ data }: { data: Row }) {
        const row: Row = {
          id: `arn_${++state.seq}`,
          ruleVersion: 1,
          confidence: 'low',
          findings: '[]',
          reviewedBy: null,
          reviewedAt: null,
          decisionNote: null,
          ...data,
        }
        if (!row.createdAt) row.createdAt = new Date()
        state.aiReviewNotes.set(String(row.id), row)
        state.createCounts.aiReviewNote++
        return { ...row }
      },
      async findFirst({ where, orderBy }: { where: Row; orderBy?: Row }) {
        const rows = sorted(scoped(state.aiReviewNotes, where), orderBy)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row }) {
        return sorted(scoped(state.aiReviewNotes, where), orderBy).map((r) => ({ ...r }))
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
import {
  AI_DRAW_REVIEW_RULE_VERSION,
  MAX_VISION_PHOTOS,
  hashReviewInputs,
  loadLatestAiReviewNote,
  redactModelFigures,
  type ReviewInputs,
} from '@/backend/modules/ai/draw-review'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'
import { actionFlagGate, FLAGGED_ACTION_FAMILIES } from '@/backend/lib/action-flag-gate'
import { GET as shareGet } from '@/app/api/share/route'
import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { createLocalDiskDriver, setStorageDriverForTests } from '@/backend/lib/storage'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    seq: number
    projects: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    drawPacks: Map<string, Record<string, unknown>>
    sitePhotos: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    invoices: Map<string, Record<string, unknown>>
    invoiceLines: Map<string, Record<string, unknown>>
    aiReviewNotes: Map<string, Record<string, unknown>>
    auditEvents: Array<Record<string, unknown>>
    flagRows: Array<{ key: string; enabled: boolean; description: string }>
    createCounts: { aiReviewNote: number; auditEvent: number }
    _id: (prefix: string) => string
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

// ---------------------------------------------------------------- fixtures

const P1 = 'p-1'
const P2 = 'p-2'
const M1 = 'm-1'

/** Minimal PNG magic bytes — enough for the driver read seam (no decoding). */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const VISION_JSON = {
  observations: ['Walling courses up to lintel level with scaffolding in place'],
  photoQuality: [],
  workmanship: [],
  summary: 'Ground floor walls at lintel level, machine-cut stone visible',
}
const VERDICT_JSON = {
  verdict: 'advisory',
  confidence: 'medium',
  summary: 'Evidence looks consistent with the released scope. KSh 999,999 planted figure.',
  findings: [
    { category: 'evidence', severity: 'warning', text: 'One photo is blurred; 3 of 4 photos show lintel-level work' },
    { category: 'general', severity: 'info', text: 'No safety concerns visible' },
  ],
}

/** A frozen pack for a released milestone, with N driver-readable photos. */
async function seedReleasedPack(photoCount = 2) {
  const photoIds: string[] = []
  for (let i = 1; i <= photoCount; i++) {
    const key = `upp-100${i}.png`
    await driver.put(key, PNG_BYTES, 'image/png')
    const id = `ph-${i}`
    photoIds.push(id)
    state.sitePhotos.set(id, { id, projectId: P1, phaseId: null, url: `/photos/${key}`, caption: null, createdAt: new Date() })
  }
  state.milestones.set(M1, {
    id: M1, projectId: P1, phaseId: 'f-1', name: 'Foundation complete', amount: 65_000_000n,
    status: 'released', evidencePhotoIds: JSON.stringify(photoIds), requestedAt: new Date('2026-02-01'),
    decidedAt: new Date('2026-02-04'), decidedBy: 'Amina', decisionNote: null, releasedAt: new Date('2026-02-04'),
    createdAt: new Date('2026-01-20'),
  })
  const attendance = { windowStart: '2026-02-01', windowEnd: '2026-02-04', rows: 4, present: 3, halfDay: 0, absent: 1, excused: 0, verified: 2 }
  const pack = {
    id: 'dp-1', milestoneId: M1, projectId: P1, milestoneName: 'Foundation complete', amount: 65_000_000n,
    currency: 'KES', ledgerRef: 'LX-ABC123', ledgerTxnId: 'lt-1',
    evidencePhotoIds: JSON.stringify(photoIds),
    variationsOpen: JSON.stringify([{ id: 'vo-1', title: 'Extra hardcore filling', budgetImpact: 40_000, submittedAt: '2026-02-03T09:00:00.000Z' }]),
    attendanceSummary: JSON.stringify(attendance),
    mjengoScore: JSON.stringify({ score: 84, confidence: 'medium', ruleVersion: 'v1', computedAt: '2026-02-03T10:00:00.000Z' }),
    contentHash: 'a'.repeat(64), schemaVersion: 1, createdAt: new Date('2026-02-04T12:00:00Z'),
  }
  state.drawPacks.set('dp-1', pack)
  state.phases.set('f-1', { id: 'f-1', projectId: P1, name: 'Foundation', order: 1, budget: 90_000_000n })
  state.transactions.set('t-1', { id: 't-1', projectId: P1, amount: 65_000_000n })
  state.invoices.set('inv-1', {
    id: 'inv-1', invoiceCode: 'INV-2026-000031', projectId: P1, orderId: null, supplierId: null,
    status: 'approved', subtotal: 12_000_000n, tax: 0n, total: 12_000_000n, createdAt: new Date('2026-02-02'),
  })
  state.invoiceLines.set('il-1', { id: 'il-1', invoiceId: 'inv-1', name: 'Cement 50kg', qty: 200, unitPrice: 60_000n, lineTotal: 12_000_000n })
  return 'dp-1'
}

/** The share token project row (the GET fixture). */
function seedProjects() {
  state.projects.set(P1, {
    id: P1, shareToken: 'tok-1', name: 'Nyumba Yangu', client: 'Amina', clientType: 'diaspora',
    location: 'Karen', budget: 600_000_000n, startDate: new Date('2026-01-05'), targetDate: new Date('2026-12-01'),
    status: 'active', createdAt: new Date('2026-01-01'),
  })
  state.projects.set(P2, { ...state.projects.get(P1)!, id: P2, shareToken: 'tok-2', name: 'Other', client: 'Buba', location: 'Runda', createdAt: new Date('2026-01-02') })
}

/** Flip the ai flag (and drop the 30s flag cache) — the documented admin toggle. */
function setAiFlag(enabled: boolean) {
  const row = state.flagRows.find((r) => r.key === 'ai')
  if (row) row.enabled = enabled
  else state.flagRows.push({ key: 'ai', enabled, description: 'AI features (chat, vision, voice)' })
  invalidateFlagCache()
}

let driver = createLocalDiskDriver()
let tmpDir = ''

beforeEach(async () => {
  sdk.create.mockReset()
  sdk.chatCreate.mockReset()
  sdk.visionCreate.mockReset()
  sdk.asrCreate.mockReset()
  sdk.create.mockResolvedValue(fakeInstance())
  sdk.visionCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(VISION_JSON) } }] })
  sdk.chatCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(VERDICT_JSON) } }] })
  resetAiSdkCache() // drop the module singleton between tests
  state.reset()
  seedProjects()
  // Fresh temp-dir local-disk driver per test (real bytes, no repo writes).
  tmpDir = await mkdtemp(`${tmpdir()}/mj-ai-review-`)
  driver = createLocalDiskDriver({ photosDir: `${tmpDir}/photos`, docsDir: `${tmpDir}/docs` })
  setStorageDriverForTests(driver)
})

afterEach(async () => {
  vi.useRealTimers()
  setStorageDriverForTests(null) // re-resolve from the live env next test
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
})

/** Run the action as the site team would (contractor role stamp, like /api/actions). */
async function runAction(payload: Record<string, unknown>, role = 'contractor') {
  return applyAction('ai.drawReview' as ActionType, { ...payload, __actor: 'Juma', __role: role }, P1)
}

// ================================================================ flag gate

describe('flag OFF — the action refuses honestly and the SDK is never contacted', () => {
  it('ai.drawReview throws the honest refusal, writes NO row, NO audit row, sdk.create is never called', async () => {
    await seedReleasedPack()
    setAiFlag(false) // default-off path: a fresh install has no row either
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/ai feature flag is off/)
    expect(sdk.create).toHaveBeenCalledTimes(0)
    expect(sdk.visionCreate).not.toHaveBeenCalled()
    expect(sdk.chatCreate).not.toHaveBeenCalled()
    expect(state.aiReviewNotes.size).toBe(0)
    expect(state.auditEvents).toHaveLength(0)
  })

  it('flag ABSENT (fresh install) → the same honest refusal (default-off fails closed)', async () => {
    await seedReleasedPack()
    state.flagRows = state.flagRows.filter((r) => r.key !== 'ai')
    invalidateFlagCache()
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/ai feature flag is off/)
    expect(sdk.create).toHaveBeenCalledTimes(0)
  })

  it('the AI_ACTIONS family is registered under the ai flag (route + sync share the gate)', async () => {
    const family = FLAGGED_ACTION_FAMILIES.find((f) => f.actions.includes('ai.drawReview'))
    expect(family?.flag).toBe('ai')
    // The exact gate /api/actions + /api/sync run, with a contractor session:
    setAiFlag(false)
    const denied = await actionFlagGate('ai.drawReview', { user: { role: 'contractor' } })
    expect(denied?.status).toBe(403)
    expect((await denied!.json()).error).toMatch(/Feature disabled by feature flag \(ai\)/)
    // Admin bypass (so a flag can be toggled and exercised before rollout):
    expect(await actionFlagGate('ai.drawReview', { user: { role: 'admin' } })).toBeNull()
    // Flag on → allowed for the site team:
    setAiFlag(true)
    expect(await actionFlagGate('ai.drawReview', { user: { role: 'contractor' } })).toBeNull()
  })
})

// ================================================================ provider states

describe('provider null (flag on, ZAI.create rejects) → honest unavailable, NO row', () => {
  beforeEach(async () => {
    await seedReleasedPack()
    setAiFlag(true)
    sdk.create.mockReset()
    sdk.create.mockRejectedValue(
      new Error('Configuration file not found or invalid. Please create .z-ai-config in your project, home directory, or /etc.'),
    )
  })

  it('the action fails with the honest unavailable message; vision/chat never sent; nothing recorded', async () => {
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/AI unavailable/)
    expect(sdk.visionCreate).not.toHaveBeenCalled()
    expect(sdk.chatCreate).not.toHaveBeenCalled()
    expect(state.aiReviewNotes.size).toBe(0)
    expect(state.auditEvents).toHaveLength(0)
    expect(state.createCounts.aiReviewNote).toBe(0)
  })
})

describe('provider fail / empty / unparseable → leak-free failure, no fake note, no row', () => {
  beforeEach(async () => {
    await seedReleasedPack()
    setAiFlag(true)
  })

  it('SDK throws (error embeds URL + key + provider body) → nothing leaks, no row', async () => {
    sdk.chatCreate.mockRejectedValueOnce(
      new Error('API request failed with status 500: {"error":"upstream exploded","key":"sk-live-9f8e7"} https://api.internal.example/v1/chat'),
    )
    const err = await runAction({ drawPackId: 'dp-1' }).then(() => null, (e: Error) => e.message)
    expect(err).toMatch(/AI cross-check failed/)
    expect(err).not.toContain('sk-live-9f8e7')
    expect(err).not.toContain('upstream exploded')
    expect(err).not.toContain('https://api.internal.example')
    expect(state.aiReviewNotes.size).toBe(0)
    expect(state.auditEvents).toHaveLength(0)
  })

  it('vision throws → honest failure before the cross-check, no row', async () => {
    sdk.visionCreate.mockRejectedValueOnce(new Error('API request failed with status 429: rate limited for key sk-999'))
    const err = await runAction({ drawPackId: 'dp-1' }).then(() => null, (e: Error) => e.message)
    expect(err).toMatch(/AI vision pass failed/)
    expect(err).not.toContain('sk-999')
    expect(sdk.chatCreate).not.toHaveBeenCalled()
    expect(state.aiReviewNotes.size).toBe(0)
  })

  it('20s timeout on the vision call (the provider cap) → honest failure, no row', async () => {
    // Only setTimeout is faked (fs/db/setImmediate stay real): the loop below
    // drains the REAL event loop so the pre-vision async chain (driver read,
    // context assembly) settles, then fake-advances the provider's 20s cap —
    // a vision call that never settles fails honestly and nothing is written.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    sdk.visionCreate.mockReturnValueOnce(new Promise(() => {})) // never settles
    const pending = runAction({ drawPackId: 'dp-1' })
    let settled = false
    void pending.catch(() => { settled = true })
    for (let i = 0; i < 80 && !settled; i++) {
      await new Promise<void>((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(400)
    }
    await expect(pending).rejects.toThrow(/timed out after 20s/)
    expect(state.aiReviewNotes.size).toBe(0)
    expect(state.auditEvents).toHaveLength(0)
  })

  it('empty model content → honest failure, no row', async () => {
    sdk.chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: '   ' } }] })
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/AI review response was not parseable JSON|empty response/)
    expect(state.aiReviewNotes.size).toBe(0)
  })

  it('model answers prose instead of JSON → unparseable, nothing recorded', async () => {
    sdk.chatCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'The evidence looks fine to me, cheers.' } }] })
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/not parseable JSON/)
    expect(state.aiReviewNotes.size).toBe(0)
    expect(state.auditEvents).toHaveLength(0)
  })
})

// ================================================================ success + append-only

describe('provider ok → the note row, deterministic inputsHash, redacted figures', () => {
  beforeEach(async () => {
    await seedReleasedPack()
    setAiFlag(true)
  })

  it('writes ONE row: verdict/confidence/findings persisted, provider + rules stamped, decision columns NULL', async () => {
    const result = await runAction({ drawPackId: 'dp-1' })
    expect(result).toMatchObject({
      drawPackId: 'dp-1', verdict: 'advisory', confidence: 'medium', findingsCount: 2,
      ruleVersion: AI_DRAW_REVIEW_RULE_VERSION,
    })
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(state.aiReviewNotes.size).toBe(1)
    const row = [...state.aiReviewNotes.values()][0]
    expect(row.drawPackId).toBe('dp-1')
    expect(row.projectId).toBe(P1)
    expect(row.providerId).toBe('zai')
    expect(String(row.modelLabel)).toContain('Z AI')
    expect(row.verdict).toBe('advisory')
    expect(row.confidence).toBe('medium')
    const findings = JSON.parse(String(row.findings))
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ category: 'evidence', severity: 'warning' })
    // THE LEDGER DECIDES NUMBERS: the model's "KSh 999,999", "3 of 4" and
    // "One photo ... 3" digit runs are redacted before storage.
    expect(String(row.summary)).not.toContain('999')
    expect(String(row.summary)).toContain('#')
    expect(findings[0].text).not.toContain('3 of 4')
    expect(findings[0].text).toMatch(/# of #/)
    // Human decision columns: present-but-unwritten.
    expect(row.reviewedBy).toBeNull()
    expect(row.reviewedAt).toBeNull()
    expect(row.decisionNote).toBeNull()
    // Exactly ONE audit row, kind ai_review (the action's own logAudit).
    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0].kind).toBe('ai_review')
    expect(String(state.auditEvents[0].summary)).toContain('advisory')
    expect(String(state.auditEvents[0].summary)).toContain('humans decide')
  })

  it('the vision call carries the pack photos as data URLs, CAPPED at MAX_VISION_PHOTOS', async () => {
    await seedReleasedPack(8) // 8 evidence photos on the pack
    await runAction({ drawPackId: 'dp-1' })
    expect(sdk.visionCreate).toHaveBeenCalledTimes(1)
    const body = sdk.visionCreate.mock.calls[0][0] as {
      model: string
      messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
    }
    const images = body.messages[0].content.filter((c) => c.type === 'image_url')
    expect(images).toHaveLength(MAX_VISION_PHOTOS) // 8 on the pack → exactly 6 sent
    for (const img of images) {
      expect(img.image_url?.url).toMatch(/^data:image\/png;base64,/)
    }
    // The bytes round-trip: the driver read seam produced real payloads.
    expect(images[0].image_url?.url).toContain(PNG_BYTES.toString('base64'))
    // The prompt names the milestone and forbids model-authored figures.
    const text = body.messages[0].content.find((c) => c.type === 'text')?.text ?? ''
    expect(text).toContain('Foundation complete')
    expect(text).toContain('Do NOT state amounts')
  })

  it('milestoneId resolves to the unique pack (the alternate addressing)', async () => {
    const result = await runAction({ milestoneId: M1 })
    expect(result.drawPackId).toBe('dp-1')
  })

  it('a SECOND run APPENDS — two rows, latest wins in loadLatestAiReviewNote, first row byte-identical', async () => {
    const first = await runAction({ drawPackId: 'dp-1' })
    const firstRow = { ...[...state.aiReviewNotes.values()][0] } as Record<string, unknown>
    // The model changes its mind on the second pass (a genuinely new review).
    sdk.chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ ...VERDICT_JSON, verdict: 'escalate', confidence: 'low' }) } }],
    })
    const second = await runAction({ drawPackId: 'dp-1' })
    expect(state.aiReviewNotes.size).toBe(2)
    expect(second.verdict).toBe('escalate')
    // The first row is untouched (append-only: the MjengoScore determinism idiom).
    const firstAfter = [...state.aiReviewNotes.values()].find((r) => r.id === first.id)
    expect({ ...firstAfter, createdAt: firstRow.createdAt }).toEqual(firstRow)
    // Latest wins:
    const latest = await loadLatestAiReviewNote('dp-1')
    expect(latest?.verdict).toBe('escalate')
    // Same inputs → the SAME inputsHash on both rows (deterministic).
    const hashes = [...state.aiReviewNotes.values()].map((r) => r.inputsHash)
    expect(new Set(hashes).size).toBe(1)
  })

  it('inputsHash: same rows → same hash; a changed row → a different hash (pure fn)', () => {
    const base: ReviewInputs = {
      v: 1,
      pack: {
        milestoneId: 'm-1', milestoneName: 'Foundation complete', amount: 650_000, currency: 'KES',
        ledgerRef: 'LX-ABC123', ledgerTxnId: 'lt-1', evidencePhotoIds: ['ph-1', 'ph-2'], visionPhotoIds: ['ph-1', 'ph-2'],
        variationsOpen: [{ id: 'vo-1', title: 'Extra hardcore filling', budgetImpact: 40_000 }],
        attendance: { windowStart: '2026-02-01', windowEnd: '2026-02-04', rows: 4, present: 3 },
        mjengoScore: { score: 84, confidence: 'medium' },
      },
      invoices: [{ code: 'INV-2026-000031', status: 'approved', mode: 'two-way', mismatches: 1 }],
      budget: { phaseBudgets: [{ name: 'Foundation', budget: 900_000 }], totalSpent: 650_000, transactionCount: 1 },
    }
    const reordered: ReviewInputs = JSON.parse(JSON.stringify(base)) as ReviewInputs
    reordered.pack.variationsOpen = [...base.pack.variationsOpen].reverse() // key order irrelevant
    expect(hashReviewInputs(reordered)).toBe(hashReviewInputs(base))
    const changed: ReviewInputs = { ...base, budget: { ...base.budget, totalSpent: 651_000 } }
    expect(hashReviewInputs(changed)).not.toBe(hashReviewInputs(base))
  })

  it('redactModelFigures — every digit run dies, prose survives (the pure rule)', () => {
    expect(redactModelFigures('KSh 650,000 for phase 2')).toBe('KSh # for phase #')
    expect(redactModelFigures('no numbers here')).toBe('no numbers here')
    expect(redactModelFigures('68.5 percent')).toBe('# percent')
  })

  it('unknown pack / not-released milestone / no photos → honest errors, no rows', async () => {
    await expect(runAction({ drawPackId: 'dp-nope' })).rejects.toThrow(/Draw pack not found/)
    await expect(runAction({ milestoneId: 'm-never' })).rejects.toThrow(/No draw pack found/)
    await expect(runAction({})).rejects.toThrow(/needs a drawPackId or a milestoneId/)
    // Not released: a pack exists but the milestone walked back (defense in depth).
    state.milestones.get(M1)!.status = 'approved'
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/not released/)
    // No readable photos: rows point at files the driver cannot address.
    state.milestones.get(M1)!.status = 'released'
    state.sitePhotos.forEach((p) => { p.url = '/photos/gone.png' })
    await expect(runAction({ drawPackId: 'dp-1' })).rejects.toThrow(/No readable evidence photos/)
    expect(state.aiReviewNotes.size).toBe(0)
  })
})

// ================================================================ permissions

describe('permissions: contractor/admin run it; everyone else is refused', () => {
  beforeEach(async () => {
    await seedReleasedPack()
    setAiFlag(true)
  })

  it.each(['client', 'supervisor', 'finance', 'qs', 'share_client'] as const)(
    'role %s → refused by the applyAction role gate (no row, no SDK contact)',
    async (role) => {
      await expect(runAction({ drawPackId: 'dp-1' }, role)).rejects.toThrow(/Only a contractor or admin may run an AI review action/)
      expect(sdk.create).toHaveBeenCalledTimes(0)
      expect(state.aiReviewNotes.size).toBe(0)
    },
  )

  it('supplier role → refused by the supplier pin BEFORE the ai dispatch (its own gate, same outcome)', async () => {
    await expect(runAction({ drawPackId: 'dp-1' }, 'supplier')).rejects.toThrow(/supplier|ai.drawReview/i)
    expect(sdk.create).toHaveBeenCalledTimes(0)
    expect(state.aiReviewNotes.size).toBe(0)
  })

  it('contractor and admin both succeed (the allowed pair)', async () => {
    await expect(runAction({ drawPackId: 'dp-1' }, 'contractor')).resolves.toBeTruthy()
    await expect(runAction({ drawPackId: 'dp-1' }, 'admin')).resolves.toBeTruthy()
    expect(state.aiReviewNotes.size).toBe(2)
  })

  it('CLIENT_ACTIONS never contains ai.drawReview (clients read notes via the share link)', () => {
    expect(CLIENT_ACTIONS).not.toContain('ai.drawReview')
  })

  it('the action never writes money: zero transactions/ledger/wallet rows exist after a run', async () => {
    await runAction({ drawPackId: 'dp-1' })
    expect(state.transactions.size).toBe(1) // the seeded release txn only
    expect(state.auditEvents.filter((e) => e.kind !== 'ai_review')).toHaveLength(0)
  })
})

// ================================================================ share serving

describe('share GET — the latest note rides the existing token gate', () => {
  const req = (query: string, ip = '198.51.100.9') =>
    new NextRequest(`http://localhost/api/share${query}`, { headers: { 'x-forwarded-for': ip } })

  beforeEach(async () => {
    await seedReleasedPack()
    setAiFlag(true)
  })

  it('valid token → the pack response carries the LATEST note (read-only)', async () => {
    await runAction({ drawPackId: 'dp-1' })
    const res = await shareGet(req('?token=tok-1&drawPack=dp-1'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.pack.milestoneId).toBe(M1)
    expect(body.aiReview).toMatchObject({
      drawPackId: 'dp-1', verdict: 'advisory', confidence: 'medium', providerId: 'zai',
    })
    expect(body.aiReview.findings).toHaveLength(2)
    expect(body.aiReview.reviewedBy).toBeNull()
    // A second (changed) run → the share surface serves the LATEST note.
    sdk.chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ ...VERDICT_JSON, verdict: 'consistent' }) } }],
    })
    await runAction({ drawPackId: 'dp-1' })
    const res2 = await shareGet(req('?token=tok-1&drawPack=dp-1', '198.51.100.10'), undefined)
    const body2 = (await res2.json()) as Record<string, any>
    expect(body2.aiReview.verdict).toBe('consistent')
  })

  it('no note yet → aiReview is explicit null (the honest "not run" state)', async () => {
    const res = await shareGet(req('?token=tok-1&drawPack=dp-1', '198.51.100.11'), undefined)
    const body = (await res.json()) as Record<string, any>
    expect(body.aiReview).toBeNull()
  })

  it('REVOKED/regenerated token → the standard share 404 BEFORE any note query', async () => {
    await runAction({ drawPackId: 'dp-1' })
    const noteFindFirst = vi.spyOn(db.aiReviewNote, 'findFirst')
    state.projects.get(P1)!.shareToken = 'tok-regenerated'
    const res = await shareGet(req('?token=tok-1&drawPack=dp-1', '198.51.100.12'), undefined)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Invalid or expired link')
    expect(noteFindFirst).not.toHaveBeenCalled()
    noteFindFirst.mockRestore()
  })

  it('a pack of ANOTHER project → the standard pack 404 (indistinguishable), no note leak', async () => {
    await runAction({ drawPackId: 'dp-1' })
    const noteFindFirst = vi.spyOn(db.aiReviewNote, 'findFirst')
    const res = await shareGet(req('?token=tok-1&drawPack=dp-foreign', '198.51.100.13'), undefined)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Draw pack not found')
    expect(noteFindFirst).not.toHaveBeenCalled()
    noteFindFirst.mockRestore()
  })
})

// ================================================================ non-influence (grep-level)

describe('non-influence: note rows change no action outcomes anywhere', () => {
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

  it('AiReviewNote / ai.drawReview appear ONLY in the ai module, its registration, the share read, the display wiring and the i18n strings', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const allowlist = new Set([
      'src/backend/modules/ai/draw-review.ts', // the module (writes + reads)
      // W6-2 trust digest: READS the notes table (findMany count, never
      // writes) for the digest's advisory AI-flags count — row math,
      // displayed, never an influence on any action.
      'src/backend/modules/ai/trust-digest.ts',
      'src/backend/actions/ai.ts', // action registration + dispatch
      'src/backend/lib/audit.ts', // audit kind map + ledger one-liner only — no reads
      'src/backend/lib/mjengo.ts', // ActionType registration + role gate — dispatch wiring only
      'src/backend/api/action-schemas.ts', // #161 registry: the request-contract catalog lists every action type — validation wiring, no domain reads
      'src/backend/lib/action-flag-gate.ts', // the ai flag family registration (enforcement, not influence)
      'src/backend/modules/intel/flags.ts', // enforcement-map comment only
      'src/backend/api/share.ts', // the read: serves the latest note through the token gate
      'src/frontend/mjengo/draw-pack-viewer.tsx', // displays the note (response shape + i18n)
      'src/frontend/mjengo/money-tab.tsx', // the "Run AI review" trigger — display wiring only
      // #150 waiting-worklist: the offline-refusal REMINDER taxonomy names
      // the flow as a string literal kind ('ai.drawReview') — taxonomy only,
      // the store never reads or writes note rows (remind-only, no execution).
      'src/frontend/hooks/use-mjengo.ts',
      'src/frontend/i18n/dicts/en.ts', // display strings only
      'src/frontend/i18n/dicts/sw.ts', // display strings only
    ].map((p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))))
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/AiReviewNote|aiReviewNote|ai\.drawReview/.test(src) && !allowlist.has(file)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders, `files outside the allowlist reference the AI review note: ${offenders.join(', ')}`).toEqual([])
  })

  it('no MUTATING module reads or writes notes — the action modules stay note-blind', () => {
    const modules = [
      'src/backend/actions/money.ts', 'src/backend/actions/supply.ts', 'src/backend/actions/invoices.ts',
      'src/backend/actions/trust.ts', 'src/backend/actions/evidence.ts', 'src/backend/actions/land.ts',
      'src/backend/actions/professionals.ts', 'src/backend/actions/wallet.ts', 'src/backend/actions/inventory.ts',
      'src/backend/actions/intel.ts', 'src/backend/api/actions.ts',
    ]
    for (const rel of modules) {
      const src = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
      expect(src, `${rel} must not reference AiReviewNote`).not.toMatch(/AiReviewNote|aiReviewNote/)
    }
    // milestone.decide's module is untouched by this feature (grep-level):
    const moneySrc = readFileSync(fileURLToPath(new URL('../../src/backend/actions/money.ts', import.meta.url)), 'utf8')
    expect(moneySrc).not.toMatch(/ai\.drawReview|drawReview|runDrawReview/)
  })

  it('no background path dispatches it: jobs handlers never run ai.drawReview', () => {
    const jobsSrc = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/jobs/handlers.ts', import.meta.url)),
      'utf8',
    )
    expect(jobsSrc).not.toMatch(/ai\.drawReview|runDrawReview|AiReviewNote/)
  })
})

// ================================================================ append-only (source walk)

describe('append-only: no code path updates or deletes a note', () => {
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
    }
    return out
  }

  it('NOWHERE in src/ calls aiReviewNote.update/delete/upsert/deleteMany/updateMany', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      if (/aiReviewNote\s*\.\s*(update|delete|upsert|deleteMany|updateMany)\b/.test(src)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders, `mutation call sites found: ${offenders.join(', ')}`).toEqual([])
  })

  it('the only note call sites in the module are create + findFirst (the one write, the one read)', () => {
    const moduleSrc = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/ai/draw-review.ts', import.meta.url)),
      'utf8',
    )
    expect(moduleSrc).toContain('db.aiReviewNote.create')
    expect(moduleSrc).toContain('db.aiReviewNote.findFirst')
    expect(moduleSrc).not.toMatch(/aiReviewNote\s*\.\s*(update|delete|upsert|deleteMany|updateMany)\b/)
    // The model's prisma delegate in tests deliberately exposes no update
    // either — the stub IS the contract under test.
    expect(db.aiReviewNote).not.toHaveProperty('update')
    expect(db.aiReviewNote).not.toHaveProperty('delete')
  })
})

// ================================================================ migration

describe('migration 05_ai_review_note is additive-only (existing rows untouched)', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/05_ai_review_note/migration.sql', import.meta.url)),
    'utf8',
  )
  // Comments stripped — comment text may legitimately say the word UPDATE.
  const body = sql.replace(/--[^\n]*/g, '')
  const statements = body.split(';').map((s) => s.trim()).filter(Boolean)

  it('is exactly ONE statement: CREATE TABLE "AiReviewNote"', () => {
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE "AiReviewNote" \(/)
  })

  it('starts no ALTER/DROP/INSERT/UPDATE/DELETE/REPLACE statement (existing rows untouched)', () => {
    const mutations = statements.filter((s) => /^(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|CREATE (INDEX|TRIGGER|VIEW))/i.test(s))
    expect(mutations, `mutation statements found: ${mutations.join(' || ')}`).toEqual([])
    expect(body.match(/CREATE TABLE/g)).toHaveLength(1)
  })

  it('the SQL columns match the Prisma model; human-decision columns are nullable', () => {
    for (const col of [
      'id', 'drawPackId', 'projectId', 'providerId', 'modelLabel', 'ruleVersion', 'verdict',
      'summary', 'confidence', 'findings', 'inputsHash', 'reviewedBy', 'reviewedAt', 'decisionNote', 'createdAt',
    ]) {
      expect(sql).toContain(`"${col}"`)
    }
    for (const nullable of ['"reviewedBy" TEXT', '"reviewedAt" DATETIME', '"decisionNote" TEXT']) {
      const line = sql.split('\n').find((l) => l.includes(nullable))!
      expect(line).not.toContain('NOT NULL')
    }
    const schema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8')
    expect(schema).toContain('model AiReviewNote')
    expect(schema).toMatch(/inputsHash\s+String/)
    expect(schema).toMatch(/modelLabel\s+String/)
    expect(schema).toMatch(/reviewedBy\s+String\?/)
    expect(schema).toMatch(/decisionNote\s+String\?/)
  })
})

// ================================================================ i18n

describe('en/sw dictionaries ship the aiReview keys (parity pinned)', () => {
  it('every aiReview.* key exists in BOTH dictionaries with non-empty values', () => {
    const enKeys = Object.keys(enDict).filter((k) => k.startsWith('aiReview.'))
    const swKeys = Object.keys(swDict).filter((k) => k.startsWith('aiReview.'))
    expect(new Set(enKeys)).toEqual(new Set(swKeys))
    expect(enKeys.length).toBeGreaterThanOrEqual(23)
    for (const k of enKeys) {
      expect(enDict[k as keyof typeof enDict].trim().length).toBeGreaterThan(0)
      expect(swDict[k as keyof typeof swDict].trim().length).toBeGreaterThan(0)
    }
  })

  it('the viewer + money-tab t("aiReview.…") literals resolve in both dictionaries', () => {
    const files = ['src/frontend/mjengo/draw-pack-viewer.tsx', 'src/frontend/mjengo/money-tab.tsx']
    for (const rel of files) {
      const src = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
      const literals = [...src.matchAll(/t\((['"`])(aiReview\.[A-Za-z0-9_.]+)\1/g)].map((m) => m[2])
      expect(literals.length, `${rel} should use aiReview.* keys`).toBeGreaterThan(0)
      for (const key of literals) {
        expect(enDict[key as keyof typeof enDict], `${rel} key ${key} missing in en`).toBeTruthy()
        expect(swDict[key as keyof typeof swDict], `${rel} key ${key} missing in sw`).toBeTruthy()
      }
    }
  })
})
