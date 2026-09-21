/**
 * The ACTION SCHEMA REGISTRY invariants (issue #161 / audit API-10) —
 * src/backend/api/action-schemas.ts.
 *
 * The registry is the machine-readable request contract for every dispatch
 * path (/api/actions, /api/sync, /api/share, the gateways — all through
 * applyAction). These pins hold the four properties the issue demands:
 *
 *   1. EXHAUSTIVENESS — every dispatchable action id has a registry entry,
 *      and the registry carries no stray keys. Compile-time this is the
 *      `satisfies Record<ActionType, z.ZodType>` (a new action type without
 *      a row fails tsc — probed manually during #161); HERE it is the
 *      runtime matrix over the real family arrays + the ActionType union
 *      source, so a rename or a stray key fails CI even when types lie.
 *      The total (124) is PINNED — growing the surface is a conscious act.
 *
 *   2. STRICT COVERAGE — STRICT_ACTION_TYPES is exactly the money-relevant
 *      families (MONEY_ACTIONS ∪ WALLET_ACTIONS), no more, no less, so
 *      widening the strict set is a reviewed change with tests, not drift.
 *
 *   3. THE STRICT CONTRACT — valid payloads pass (including every field the
 *      real appliers + frontend + tests send: by/confirm/paidBy/source/
 *      idempotencyKey/…); unknown fields are rejected; mistyped fields are
 *      rejected with the field path; `amount` shares parseMoneyCents (the
 *      appliers' own validator — the parity pin refuses exactly what the
 *      money stack refuses); values the appliers used to SILENTLY COERCE
 *      (a non-rail escrow method defaulting to 'mpesa', a typo'd
 *      payment.decide decision silently meaning 'reject') are honest 400s
 *      now.
 *
 *   4. THE CHOKE POINT — applyAction validates BEFORE any DB read (a
 *      violating payload never reaches resolveProjectId, proven by call
 *      tracking), the server-side __actor/__role/__supplierId stamp is
 *      stripped pre-validation (the money-tab decision payloads carry
 *      by/confirm and stay valid), and the routes render the failure in
 *      the house shapes: /api/actions → 400 { error, field? } (the v1/
 *      share zodIssueResponse contract), /api/sync → per-item ok:false
 *      with the self-describing message, never a batch abort.
 *
 * Route-level idiom: the client-actions/flags-gating mocks (fake guard +
 * stubbed db, applyAction REAL but spied so the dispatch receipt is
 * assertable); the db stub records reads so the "before any DB read" pin
 * has teeth.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null }
  },
}))

// Full fake guard (the client-actions idiom — mirrors guard.ts closely
// enough for route-kit's publicRoute and the sync route's withGuard).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier']
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    forbidden: (role?: string) =>
      NextResponse.json(
        { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
        { status: 403 },
      ),
    withGuard:
      (handler: (req: NextRequest, session: unknown, ctx: unknown) => unknown, opts?: { roles?: readonly string[] }) =>
      async (req: NextRequest, ctx: unknown) => {
        const session = await getSessionFromReq(req)
        if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
        if (opts?.roles && !opts.roles.includes(session.user.role)) {
          return NextResponse.json(
            { error: `Not permitted for role "${session.user.role}"` },
            { status: 403 },
          )
        }
        return handler(req, session, ctx)
      },
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    sessionSupplierId: (session: { user: { role: string; supplierId?: string | null } }) => {
      if (session.user.role !== 'supplier') return null
      const id = session.user.supplierId
      return typeof id === 'string' && id.trim() ? id.trim() : null
    },
    KNOWN_ROLES,
  }
})

// In-memory db stub. project reads feed resolveProjectId + the sync drain;
// the reads counter is the "validation happens BEFORE any DB read" oracle
// (a violating payload must leave it untouched).
vi.mock('@/backend/lib/db', () => {
  const project = {
    id: 'p-1', name: 'Riverside Villas', location: 'Karen', client: 'Mama Njeri',
    shareToken: 'tok-1', startDate: new Date('2026-01-05T09:00:00Z'),
  }
  const state = {
    projectReads: 0,
    reset() {
      state.projectReads = 0
    },
  }
  const nullFirst = async () => null
  return {
    db: {
      __state: state,
      project: {
        async findUnique({ where }: { where: Record<string, string> }) {
          state.projectReads++
          if (where.id !== undefined) return where.id === 'p-1' ? { ...project } : null
          if (where.shareToken !== undefined) return where.shareToken === 'tok-1' ? { ...project } : null
          return null
        },
        async findFirst() {
          state.projectReads++
          return { ...project }
        },
        async findMany() {
          return [{ ...project }]
        },
      },
      // Pre-check + deep-handler misses — every dispatch in this suite is
      // expected to die at the schema or at one of these honest miss-errors.
      milestone: { findFirst: nullFirst },
      variationOrder: { findFirst: nullFirst },
      paymentRequest: { findFirst: nullFirst },
      task: { findFirst: nullFirst, findUnique: nullFirst },
      attendance: { findFirst: nullFirst },
      sitePhoto: { findUnique: nullFirst },
      featureFlag: {
        // flags.ts lazily ensures its rows exist (upsert) before reading them.
        async upsert({ where }: { where: { key: string } }) {
          return { key: where.key, enabled: true, description: where.key }
        },
        async findMany() {
          return [
            { key: 'wallet', enabled: true, description: 'Wallet' },
            { key: 'marketplace', enabled: true, description: 'Marketplace' },
            { key: 'land_verification', enabled: true, description: 'Land' },
          ]
        },
      },
      idempotencyRecord: {
        async findUnique() {
          return null
        },
        async create({ data }: Record<string, unknown>) {
          return { ...data }
        },
      },
    },
  }
})

// applyAction stays REAL (validation lives inside it — the choke point under
// test) but spied, so route-level tests can assert the dispatch receipt;
// only the payload-refresh reads are stubbed (the client-actions idiom).
vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    applyAction: vi.fn(orig.applyAction as (...args: unknown[]) => Promise<unknown>),
    getProjectPayload: vi.fn(async () => null),
    getProjectsList: vi.fn(async () => []),
  }
})

import { z } from 'zod'
import {
  ACTION_PAYLOAD_SCHEMAS,
  ActionPayloadError,
  STRICT_ACTION_TYPES,
  parseActionPayload,
} from '@/backend/api/action-schemas'
import { applyAction } from '@/backend/lib/mjengo'
import { MONEY_ACTIONS } from '@/backend/actions/money'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'
import { EVIDENCE_ACTIONS } from '@/backend/actions/evidence'
import { INTEL_ACTIONS } from '@/backend/actions/intel'
import { INVENTORY_ACTIONS } from '@/backend/actions/inventory'
import { INVOICE_ACTIONS } from '@/backend/actions/invoices'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { PROFESSIONALS_ACTIONS } from '@/backend/actions/professionals'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'
import { TRUST_ACTIONS } from '@/backend/actions/trust'
import { AI_ACTIONS } from '@/backend/actions/ai'
import { db } from '@/backend/lib/db'
import { MONEY_AMOUNT_ERROR } from '@/backend/lib/money-bounds'
import { POST as actionsPost } from '@/app/api/actions/route'
import { POST as syncPost } from '@/app/api/sync/route'

// ---------------------------------------------------------------- helpers

/** Core (non-family) action ids, parsed from the ActionType union source. */
function coreActionIds(): string[] {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/backend/lib/mjengo.ts', import.meta.url)),
    'utf8',
  )
  const union = src.slice(
    src.indexOf('export type ActionType'),
    src.indexOf('export async function applyAction'),
  )
  return [...union.matchAll(/'([a-z]+[a-zA-Z]*\.[a-zA-Z]+)'/g)].map((m) => m[1])
}

/** The full dispatchable id set — the same census client-actions.test.ts uses. */
const KNOWN_ACTIONS = new Set<string>([
  ...coreActionIds(),
  ...TRUST_ACTIONS, ...MONEY_ACTIONS, ...EVIDENCE_ACTIONS, ...LAND_ACTIONS,
  ...PROFESSIONALS_ACTIONS, ...SUPPLY_ACTIONS, ...INVOICE_ACTIONS,
  ...INTEL_ACTIONS, ...INVENTORY_ACTIONS, ...WALLET_ACTIONS, ...AI_ACTIONS,
])

const REGISTRY_KEYS = Object.keys(ACTION_PAYLOAD_SCHEMAS)

/** Representative VALID payloads — every field the real callers send. */
const VALID_STRICT_PAYLOADS: Record<(typeof STRICT_ACTION_TYPES)[number], unknown> = {
  'escrow.topup': { amount: 25_000, method: 'mpesa', reference: 'TOP-1' },
  'milestone.create': { name: 'Slab', amount: 650_000, phaseId: 'ph-1' },
  'milestone.evidence': { id: 'm1', photoIds: ['ph-1', 'ph-2'] },
  'milestone.requestRelease': { id: 'm1' },
  'milestone.decide': { id: 'm1', decision: 'approve', by: 'Amina (Client)', confirm: true, note: 'Good work' },
  'variation.submit': { title: 'Extra patio', description: 'Client asked for more', budgetImpact: -15_000, phaseId: 'ph-1', submittedBy: 'Amina' },
  'variation.decide': { id: 'v1', decision: 'reject', note: 'rework first' },
  'payment.request': { description: 'Cement delivery', amount: 5000, payee: 'Bamburi', method: 'mpesa', relatedEntityType: 'phase', relatedEntityId: 'ph-1' },
  'payment.decide': { id: 'pr-1', decision: 'approve', note: 'ok' },
  'payment.pay': { id: 'pr-1', method: 'bank', reference: 'TX-9', costCode: 'materials' },
  'wallet.create': { label: 'Site float', ownerType: 'project' },
  'wallet.deposit': { walletId: 'w-1', amount: 5000, reference: 'DEP-1', source: 'mpesa' },
  'wallet.withdraw': { walletId: 'w-1', amount: 500, note: 'site materials float', destination: 'bank' },
  'wallet.transfer': { fromWalletId: 'w-1', toWalletId: 'w-2', amount: 100 },
  'transaction.reverse': { id: 't-legacy', reason: 'wrong amount', method: 'mpesa' },
  'ledger.post': {
    description: 'journal',
    lines: [
      { accountCode: 'CASH_MPESA', side: 'debit', amount: 10 },
      { accountCode: 'EXPENSE:p-1', side: 'credit', amount: 10 },
    ],
  },
}

function sessionFor(role: string, opts: { projectId?: string | null } = {}) {
  h.session = {
    user: {
      id: `u-${role}`,
      email: `${role}@action-schemas.test.dev`,
      name: role,
      role,
      projectId: opts.projectId ?? null,
      supplierId: null,
    },
  }
}

function actionReq(type: string, payload: unknown, projectId?: string | null): NextRequest {
  return new NextRequest('http://localhost/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, payload, ...(projectId !== undefined ? { projectId } : {}) }),
  })
}

function syncReq(actions: Array<{ id: string; type: string; payload?: unknown; projectId?: string }>): NextRequest {
  return new NextRequest('http://localhost/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actions }),
  })
}

type DbState = { projectReads: number; reset(): void }
const dbState = (db as unknown as { __state: DbState }).__state

// ------------------------------------------------------------ 1. exhaustiveness

describe('the registry is exhaustive over the dispatchable action surface', () => {
  it('every dispatchable action id has a registry entry', () => {
    const missing = [...KNOWN_ACTIONS].filter((t) => !REGISTRY_KEYS.includes(t))
    expect(missing, `action types without a schema: ${missing.join(', ')}`).toEqual([])
  })

  it('the registry carries no stray keys (renames cannot leave dead rows)', () => {
    const stray = REGISTRY_KEYS.filter((t) => !KNOWN_ACTIONS.has(t))
    expect(stray, `registry rows that are not dispatchable action ids: ${stray.join(', ')}`).toEqual([])
  })

  it('the surface total is pinned — 125 action types, 125 registry rows', () => {
    // 124 → 125: inventory.count.schedule (REC-1 #359, the count cadence).
    expect(KNOWN_ACTIONS.size).toBe(125)
    expect(REGISTRY_KEYS).toHaveLength(125)
    expect(new Set(REGISTRY_KEYS).size).toBe(125) // no duplicate rows either
  })

  it('a NEW action type without a registry row fails compilation (satisfies probe)', () => {
    // Compile-time behavior, pinned by source inspection so it cannot rot
    // silently: the registry must be declared `satisfies Record<ActionType,
    // z.ZodType>` — that clause is what makes a missing row a tsc error.
    const src = readFileSync(
      fileURLToPath(new URL('../../src/backend/api/action-schemas.ts', import.meta.url)),
      'utf8',
    )
    expect(src).toMatch(/as const satisfies Record<ActionType, z\.ZodType>/)
  })
})

// ---------------------------------------------------------- 2. strict coverage

describe('STRICT_ACTION_TYPES is exactly the money-relevant families', () => {
  it('is MONEY_ACTIONS ∪ WALLET_ACTIONS — no more, no less', () => {
    const moneyAndWallet = new Set<string>([...MONEY_ACTIONS, ...WALLET_ACTIONS])
    expect(new Set<string>(STRICT_ACTION_TYPES)).toEqual(moneyAndWallet)
    expect(STRICT_ACTION_TYPES).toHaveLength(16)
  })

  it('every strict entry is a strictObject — documented entries are loose', () => {
    for (const type of STRICT_ACTION_TYPES) {
      const schema = ACTION_PAYLOAD_SCHEMAS[type as keyof typeof ACTION_PAYLOAD_SCHEMAS] as z.ZodType
      // strictObject refuses an unknown key; the documented looseObject does not.
      const canary = schema.safeParse({ __canary_unknown_field__: 1 })
      expect(canary.success, `${type} must reject unknown fields`).toBe(false)
    }
    const aDocumented = ACTION_PAYLOAD_SCHEMAS['task.create'] as z.ZodType
    expect(aDocumented.safeParse({ anything: { goes: true } }).success).toBe(true)
  })
})

// ------------------------------------------------------- 3. the strict contract

describe('strict money/wallet schemas accept every real payload shape', () => {
  it.each([...STRICT_ACTION_TYPES])('%s: the representative caller payload parses', (type) => {
    expect(() => parseActionPayload(type, VALID_STRICT_PAYLOADS[type])).not.toThrow()
  })

  it('numeric-string amounts pass (the appliers accept both forms)', () => {
    expect(() => parseActionPayload('escrow.topup', { amount: '65000.50' })).not.toThrow()
  })

  it('the walletId OR code alternative (wallet.deposit) and the code form pass', () => {
    expect(() => parseActionPayload('wallet.deposit', { code: 'W-0001', amount: 500 })).not.toThrow()
  })

  it('optional actor/idempotency fallbacks pass (sessionless-caller fields)', () => {
    expect(() =>
      parseActionPayload('wallet.withdraw', { walletId: 'w-1', amount: 500, by: 'Finance', idempotencyKey: 'k-1' }),
    ).not.toThrow()
  })
})

describe('strict schemas refuse unknown and mistyped fields with the field path', () => {
  it.each([...STRICT_ACTION_TYPES])('%s: an unknown field is rejected', (type) => {
    const base = VALID_STRICT_PAYLOADS[type] as Record<string, unknown>
    expect(() => parseActionPayload(type, { ...base, surpriseField: 1 })).toThrow(ActionPayloadError)
  })

  it('a typo’d decision carries the field path', () => {
    try {
      parseActionPayload('milestone.decide', { id: 'm1', decision: 'appove' })
      expect.unreachable('must throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ActionPayloadError)
      const err = e as ActionPayloadError
      expect(err.issues[0]!.path.join('.')).toBe('decision')
      expect(err.message).toContain("decision must be 'approve' or 'reject'")
    }
  })

  it('a missing required amount names the field', () => {
    try {
      parseActionPayload('escrow.topup', { method: 'mpesa' })
      expect.unreachable('must throw')
    } catch (e) {
      expect((e as ActionPayloadError).issues[0]!.path.join('.')).toBe('amount')
    }
  })

  it('out-of-bounds / garbage amounts share the appliers’ one honest message', () => {
    for (const bad of [999_999_999_999, 0, -5, 10.999, 'abc', true, {}, [5000], '12,000']) {
      try {
        parseActionPayload('escrow.topup', { amount: bad })
        expect.unreachable(`amount ${JSON.stringify(String(bad))} must be refused`)
      } catch (e) {
        expect(e).toBeInstanceOf(ActionPayloadError)
        expect((e as ActionPayloadError).message).toContain(MONEY_AMOUNT_ERROR)
      }
    }
  })

  it('budgetImpact refuses zero and 3-dp values (the signed non-zero contract)', () => {
    for (const bad of [0, '0.00', 0.005, 15000.123]) {
      expect(() => parseActionPayload('variation.submit', {
        title: 'T', description: 'D', budgetImpact: bad,
      })).toThrow(/Budget impact must be a non-zero amount/)
    }
    expect(() => parseActionPayload('variation.submit', {
      title: 'T', description: 'D', budgetImpact: -15000,
    })).not.toThrow()
  })

  it('values the appliers used to silently coerce are honest 400s now', () => {
    // escrow.topup method: any non-rail value used to default to 'mpesa'.
    expect(() => parseActionPayload('escrow.topup', { amount: 1000, method: 'cheque' })).toThrow(/method/)
    // payment.decide decision: a typo used to silently mean 'rejected'.
    expect(() => parseActionPayload('payment.decide', { id: 'pr-1', decision: 'aprove' })).toThrow(/decision/)
    // payment.request method: any string used to be stored raw.
    expect(() => parseActionPayload('payment.request', { description: 'D', amount: 5, payee: 'P', method: 42 })).toThrow(/method/)
  })

  it('confirm is strictly the literal true (the SEC-3r share-link flag)', () => {
    expect(() => parseActionPayload('milestone.decide', { id: 'm1', decision: 'approve', confirm: true })).not.toThrow()
    expect(() => parseActionPayload('milestone.decide', { id: 'm1', decision: 'approve', confirm: 'yes' })).toThrow(ActionPayloadError)
    expect(() => parseActionPayload('milestone.decide', { id: 'm1', decision: 'approve', confirm: 1 })).toThrow(ActionPayloadError)
  })

  it('ledger.post lines are structural (side enum, nested accountCode, min 1)', () => {
    expect(() => parseActionPayload('ledger.post', {
      lines: [{ accountCode: 'CASH_MPESA', side: 'debit', amount: 10 }],
    })).not.toThrow()
    expect(() => parseActionPayload('ledger.post', { lines: [] })).toThrow(/at least one line/)
    expect(() => parseActionPayload('ledger.post', {
      lines: [{ accountCode: 'CASH_MPESA', side: 'debit' }],
    })).toThrow(ActionPayloadError)
    expect(() => parseActionPayload('ledger.post', {
      lines: [{ accountCode: 'CASH_MPESA', side: 'both', amount: 10 }],
    })).toThrow(/side/)
  })

  it('unknown action types keep the dispatcher’s own honest miss', () => {
    expect(() => parseActionPayload('totally.made_up', {})).toThrow('Unknown action type: totally.made_up')
  })
})

// -------------------------------------------------------- 4. the choke point

describe('applyAction validates at the choke point, before any DB read', () => {
  beforeEach(() => {
    vi.mocked(applyAction).mockClear()
    dbState.reset()
  })

  it('a violating payload throws ActionPayloadError with ZERO project reads', async () => {
    await expect(
      applyAction('milestone.decide', { id: 'm1', decision: 'approve', evil: true }, 'p-1'),
    ).rejects.toThrow(ActionPayloadError)
    expect(dbState.projectReads).toBe(0)
  })

  it('the server-side __actor/__role stamp is stripped BEFORE validation (money-tab decision payloads stay valid)', async () => {
    await expect(
      applyAction('milestone.decide', { __actor: 'Amina', __role: 'client', id: 'm1', decision: 'approve' }, 'p-1'),
    ).rejects.toThrow('Milestone not found in this project') // passed the schema, died in the applier
    expect(dbState.projectReads).toBeGreaterThan(0)
  })

  it('a payload __actor copy does NOT pass for strict types once the server stamp overwrites it (route stamps survive)', () => {
    // The strip removes the keys the ROUTES stamp; a client cannot smuggle
    // extra fields past a strict schema by naming them __-prefixed — the
    // route overwrites __actor/__role/__supplierId, the strip removes them,
    // and any OTHER unknown key is still refused:
    expect(() => parseActionPayload('milestone.decide', { id: 'm1', decision: 'approve', __evil: 1 })).toThrow(ActionPayloadError)
  })

  it('documented (non-strict) types still accept their applier-shaped payloads untouched', () => {
    expect(() => parseActionPayload('task.update', { id: 't-1', progress: 50, baseVersion: 3 })).not.toThrow()
    expect(() => parseActionPayload('attendance.record', { records: '[{"workerId":"w-1","status":"present"}]' })).not.toThrow()
    expect(() => parseActionPayload('notification.readAll', {})).not.toThrow()
  })
})

// ------------------------------------------------------ 5. route-level shapes

describe('POST /api/actions renders registry violations in the house 400 shape', () => {
  beforeEach(() => {
    sessionFor('contractor')
    vi.mocked(applyAction).mockClear()
    dbState.reset()
  })

  it('mistyped field → 400 { error, field } (the v1/share zodIssueResponse contract)', async () => {
    const res = await actionsPost(actionReq('milestone.decide', { id: 'm1', decision: 'appove' }, 'p-1'), undefined)
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe("decision must be 'approve' or 'reject'")
    expect(body.field).toBe('decision')
    expect(dbState.projectReads).toBe(0) // never reached the DB
  })

  it('unknown field → 400 Unknown field(s)', async () => {
    const res = await actionsPost(actionReq('milestone.decide', { id: 'm1', decision: 'approve', surprise: 1 }, 'p-1'), undefined)
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Unknown field(s): "surprise"')
  })

  it('a VALID strict payload flows through to the applier (deep miss-error, no field key)', async () => {
    const res = await actionsPost(
      actionReq('milestone.decide', { id: 'm1', decision: 'approve', by: 'Amina', confirm: true }, 'p-1'),
      undefined,
    )
    expect(res.status).toBe(400) // the applier’s honest miss, via safeError
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ ok: false, error: 'Milestone not found in this project' })
    expect('field' in body).toBe(false)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })

  it('documented types keep the lenient legacy contract (extra fields flow to the applier)', async () => {
    const res = await actionsPost(
      actionReq('comment.add', { photoId: 'ph-1', author: 'Amina', role: 'client', message: 'hi', extraJunk: true }, 'p-1'),
      undefined,
    )
    expect(res.status).toBe(400) // the applier’s miss, NOT a schema refusal
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ ok: false, error: 'Photo not found in this project' })
  })
})

describe('POST /api/sync items pass through the same validation (per-item, batch survives)', () => {
  beforeEach(() => {
    sessionFor('contractor')
    vi.mocked(applyAction).mockClear()
    dbState.reset()
  })

  it('a violating outbox item → ok:false with the self-describing schema message; the batch continues', async () => {
    const res = await syncPost(
      syncReq([
        { id: 'bad-1', type: 'milestone.decide', payload: { id: 'm1', decision: 'nope' }, projectId: 'p-1' },
        { id: 'good-1', type: 'task.update', payload: { id: 't-1', progress: 50 }, projectId: 'p-1' },
      ]),
      undefined,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ id: string; ok: boolean; error?: string }> }
    expect(body.results).toHaveLength(2)
    const bad = body.results.find((r) => r.id === 'bad-1')!
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('Invalid milestone.decide payload')
    expect(bad.error).toContain("decision must be 'approve' or 'reject'")
    // the sibling item flowed through the schema into its own applier miss
    const good = body.results.find((r) => r.id === 'good-1')!
    expect(good.ok).toBe(false)
    expect(good.error).toContain('Task not found')
    expect(applyAction).toHaveBeenCalledTimes(2)
  })

  it('an unknown-field wallet item → per-item failure, never a batch abort', async () => {
    const res = await syncPost(
      syncReq([{ id: 'w-1', type: 'wallet.deposit', payload: { walletId: 'w-1', amount: 500, hacked: true }, projectId: 'p-1' }]),
      undefined,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ id: string; ok: boolean; error?: string }> }
    expect(body.results[0]!.ok).toBe(false)
    expect(body.results[0]!.error).toContain('Invalid wallet.deposit payload')
  })
})
