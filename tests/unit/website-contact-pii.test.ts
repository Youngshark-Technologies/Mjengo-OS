/**
 * Issue #362 / MD-3 — contact-PII encryption at rest on the website.
 *
 * The chosen path (documented in the commit body): ENCRYPT-AT-REST (a),
 * not forward-and-purge — the leads ARE read back: the store file is the
 * documented retrieval path (§6.3 `docker compose exec …`), the backup
 * target (§7.2.1/§7.2.2) and the erasure surface ("the system of
 * record"), and no mailbox/forward endpoint exists (privacy §8: no
 * public mailbox yet; the site contacts no third party). This suite pins
 * the whole chain end-to-end at the unit level:
 *
 *   · the shared crypto module (mjengoos-website/lib/contact-pii.mjs):
 *     seal/open round-trips, the sealed-value shape, fresh IVs, tamper
 *     detection, wrong-key detection, AAD cut-and-paste binding (a sealed
 *     value cannot move between fields or rows), and the crafted-prefix
 *     bypass closure (a plaintext value that merely LOOKS sealed is
 *     decrypt-verified and wrapped when it fails);
 *   · the key verdict matrix — the VAPID_SUBJECT / issue-#354 posture:
 *     valid keys used verbatim (base64 + hex + unpadded), unset +
 *     production → refuse, unset + dev → labeled fallback, malformed →
 *     refuse in EVERY runtime;
 *   · the route (app/api/contact/route.ts) against the REAL fs (cwd in a
 *     temp dir, no fs mocking — the website-contact-route.test.ts
 *     convention): fail-closed 503 in production (nothing written, ONE
 *     loud error, honest reason), dev fallback (sealed file, ONE warn),
 *     real-key sealing (plaintext absent from the file), the legacy
 *     plaintext migration sweep (converges on first write, no churn on
 *     already-sealed rows, one migration warning), and the documented
 *     retention policy — the 500-most-recent count cap — still enforced
 *     on the sealed store;
 *   · the operator CLI (mjengoos-website/scripts/decrypt-leads.mjs) as
 *     REAL child processes (node, the production image's runtime):
 *     decrypt / --seal / stdin / failure / refusal modes, plus the
 *     route→script interop (what the route seals, the script opens);
 *   · the operator-facing wiring: env examples, docker-compose
 *     interpolation, the Dockerfile's tooling COPY, the package.json
 *     script, and the DEPLOYMENT.md §6.3 retrieval/erasure guide.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LIB_URL = '../../mjengoos-website/lib/contact-pii.mjs'
const ROUTE_URL = 'http://localhost:3001/api/contact'
const SCRIPT = path.join(REPO_ROOT, 'mjengoos-website', 'scripts', 'decrypt-leads.mjs')

/** A real 32-byte key in the two documented encodings. */
const KEY_B64 = Buffer.from(rangeBytes(32, 7)).toString('base64')
const KEY_HEX = Buffer.from(rangeBytes(32, 9)).toString('hex')
function rangeBytes(n: number, fill: number): number[] {
  return Array.from({ length: n }, (_, i) => (fill + i) % 256)
}

const VALID_SIGNUP = {
  source: 'signup',
  name: 'Amina Wanjiru',
  email: 'amina@example.com',
  role: 'Contractor',
}

const VALID_CONTACT = {
  ...VALID_SIGNUP,
  source: 'contact',
  message: 'Perimeter wall quote in Kiambu, half an acre.',
  phone: '+254712345678',
  organization: 'Wanjiru Construction',
  country: 'Kenya',
  projectType: 'Residential house',
}

let cwd: string
let tmp: string

beforeEach(async () => {
  vi.resetModules()
  delete process.env.CONTACT_PII_KEY
  delete process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  cwd = process.cwd()
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mjengo-pii-'))
  process.chdir(tmp)
})

afterEach(async () => {
  process.chdir(cwd)
  await fsp.rm(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function post(payload: Record<string, unknown>): Promise<Response> {
  const route = await import('../../mjengoos-website/app/api/contact/route')
  return route.POST(
    new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

async function readStore(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'submissions.json'), 'utf8'))
}

function runScript(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.CONTACT_PII_KEY
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return spawnSync('node', [SCRIPT, ...args], { cwd: tmp, env, encoding: 'utf8' })
}

// ---------------------------------------------------------------------------
// the shared crypto module
// ---------------------------------------------------------------------------

describe('contact-pii lib — seal/open round-trip', () => {
  it('restores every PII field exactly, and never touches id/ts/source', async () => {
    const lib = await import(LIB_URL)
    const key = Buffer.from(rangeBytes(32, 3))
    const entry = {
      id: 'sub_abc',
      ts: '2026-09-26T08:14:02.104Z',
      source: 'contact',
      ...VALID_CONTACT,
    }
    const sealed = lib.sealContactSubmission(key, entry)
    expect(sealed.id).toBe('sub_abc')
    expect(sealed.ts).toBe('2026-09-26T08:14:02.104Z')
    expect(sealed.source).toBe('contact')
    const { entry: opened, failures } = lib.openContactSubmission(key, sealed)
    expect(failures).toEqual([])
    expect(opened).toEqual(entry)
  })

  it('sealed values carry the v1 marker with iv/tag/ciphertext base64 segments', async () => {
    const lib = await import(LIB_URL)
    const key = Buffer.from(rangeBytes(32, 5))
    const sealed = lib.sealContactSubmission(key, { id: 's1', ts: 't', source: 'contact', ...VALID_CONTACT })
    for (const field of ['name', 'email', 'phone', 'organization', 'role', 'country', 'projectType', 'message']) {
      const value = sealed[field]
      expect(typeof value, field).toBe('string')
      expect(value, field).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
      const [, , iv, tag] = String(value).split(':')
      expect(Buffer.from(iv, 'base64')).toHaveLength(12) // GCM IV
      expect(Buffer.from(tag, 'base64')).toHaveLength(16) // GCM tag
    }
  })

  it('absent optional fields stay absent (no phantom sealed fields)', async () => {
    const lib = await import(LIB_URL)
    const sealed = lib.sealContactSubmission(Buffer.from(rangeBytes(32, 1)), {
      id: 's1',
      ts: 't',
      source: 'signup',
      name: 'Amina Wanjiru',
      email: 'amina@example.com',
      role: 'Contractor',
    })
    expect(sealed).not.toHaveProperty('phone')
    expect(sealed).not.toHaveProperty('message')
  })

  it('every seal mints a fresh IV (same value, different ciphertexts)', async () => {
    const lib = await import(LIB_URL)
    const key = Buffer.from(rangeBytes(32, 2))
    const a = lib.sealContactSubmission(key, { id: 's1', ts: 't', source: 'c', name: 'Same Name' })
    const b = lib.sealContactSubmission(key, { id: 's1', ts: 't', source: 'c', name: 'Same Name' })
    expect(a.name).not.toBe(b.name)
    expect(a.name).not.toBe('Same Name')
  })
})

describe('contact-pii lib — integrity failures', () => {
  const KEY = Buffer.from(rangeBytes(32, 11))

  it('detects a tampered ciphertext byte', async () => {
    const lib = await import(LIB_URL)
    const sealed = lib.sealContactSubmission(KEY, { id: 's1', ts: 't', source: 'c', ...VALID_CONTACT })
    const parts = String(sealed.email).split(':')
    const ct = parts[4]
    const flipped = ct.endsWith('AA') ? `${ct.slice(0, -2)}BB` : `${ct.slice(0, -2)}AA`
    const tampered = [...parts.slice(0, 4), flipped].join(':')
    expect(() => lib.decryptContactPiiField(KEY, 's1', 'email', tampered)).toThrow(/cannot decrypt/)
  })

  it('detects a wrong key', async () => {
    const lib = await import(LIB_URL)
    const sealed = lib.sealContactSubmission(KEY, { id: 's1', ts: 't', source: 'c', ...VALID_CONTACT })
    const other = Buffer.from(rangeBytes(32, 12))
    expect(() => lib.decryptContactPiiField(other, 's1', 'email', String(sealed.email))).toThrow(/wrong CONTACT_PII_KEY/)
  })

  it('binds the AAD to the FIELD — a sealed value cannot move to another field', async () => {
    const lib = await import(LIB_URL)
    const sealed = lib.sealContactSubmission(KEY, { id: 's1', ts: 't', source: 'c', ...VALID_CONTACT })
    // "name"'s ciphertext presented as "email" must fail authentication.
    expect(() => lib.decryptContactPiiField(KEY, 's1', 'email', String(sealed.name))).toThrow(/cannot decrypt/)
  })

  it('binds the AAD to the ROW — a sealed value cannot move to another submission', async () => {
    const lib = await import(LIB_URL)
    const sealed = lib.sealContactSubmission(KEY, { id: 's1', ts: 't', source: 'c', ...VALID_CONTACT })
    expect(() => lib.decryptContactPiiField(KEY, 's2', 'email', String(sealed.email))).toThrow(/cannot decrypt/)
  })

  it('rejects malformed sealed values (wrong segment count) without throwing raw crypto errors', async () => {
    const lib = await import(LIB_URL)
    expect(() => lib.decryptContactPiiField(KEY, 's1', 'email', 'enc:v1:only-one-segment')).toThrow(/malformed/)
    expect(() => lib.decryptContactPiiField(KEY, 's1', 'email', 'enc:v2:aaaa:bbbb:cccc')).toThrow(/malformed/)
  })

  it('openContactSubmission reports failures per field and keeps the sealed value in place (no silent drop)', async () => {
    const lib = await import(LIB_URL)
    const sealedA = lib.sealContactSubmission(KEY, { id: 's1', ts: 't', source: 'c', ...VALID_CONTACT })
    const goodRow = lib.sealContactSubmission(KEY, { id: 's2', ts: 't', source: 'c', name: 'Brian', email: 'brian@example.com', role: 'QS' })
    // Corrupt s2's email only:
    const parts = String(goodRow.email).split(':')
    const corrupted = { ...goodRow, email: [...parts.slice(0, 4), parts[4].slice(0, -2) + (parts[4].endsWith('AA') ? 'BB' : 'AA')].join(':') }
    const a = lib.openContactSubmission(KEY, sealedA)
    expect(a.failures).toEqual([])
    const b = lib.openContactSubmission(KEY, corrupted)
    expect(b.failures).toHaveLength(1)
    expect(b.failures[0].field).toBe('email')
    expect(b.entry.email).toBe(corrupted.email) // sealed value kept, honest
    expect(b.entry.name).toBe('Brian') // other fields still opened
  })
})

describe('contact-pii lib — the crafted-prefix bypass closure', () => {
  it('a plaintext value that merely LOOKS sealed is decrypt-verified and wrapped, never rested as-is', async () => {
    const lib = await import(LIB_URL)
    const key = KEY_B64_BUFFER()
    // An otherwise-sealed row carrying one crafted "enc:v1:"-looking value
    // (a user who typed it, or an attacker probing the store): the cheap
    // prefix check sees "all sealed" and would skip the row entirely…
    const base = lib.sealContactSubmission(key, { id: 's1', ts: 't', source: 'contact', name: 'Amina Njeri' })
    const entry = { ...base, message: 'enc:v1:AAAA:BBBB:CCCC:not-a-real-sealed-value' }
    expect(lib.hasLegacyPlaintextContactPii(entry)).toBe(false)
    // …the seal step does not: the marker alone proves nothing — only a
    // value that AUTHENTICATES under this key is treated as sealed.
    const sealed = lib.sealContactSubmission(key, entry)
    expect(sealed.message).not.toBe(entry.message)
    expect(String(sealed.message)).toMatch(/^enc:v1:/)
    const opened = lib.openContactSubmission(key, sealed)
    expect(opened.entry.message).toBe('enc:v1:AAAA:BBBB:CCCC:not-a-real-sealed-value')
    expect(opened.failures).toEqual([])
  })

  it('a genuinely sealed current-key value passes through byte-identical (no churn)', async () => {
    const lib = await import(LIB_URL)
    const key = KEY_B64_BUFFER()
    const first = lib.sealContactSubmission(key, { id: 's1', ts: 't', source: 'c', ...VALID_CONTACT })
    const second = lib.sealContactSubmission(key, first) // re-seal an already-sealed row
    expect(second).toEqual(first)
  })
})

function KEY_B64_BUFFER(): Buffer {
  return Buffer.from(rangeBytes(32, 7))
}

// ---------------------------------------------------------------------------
// the key verdict — the #354 posture
// ---------------------------------------------------------------------------

describe('contactPiiKeyVerdict — the VAPID_SUBJECT-shaped posture', () => {
  it('uses a valid base64 key verbatim', async () => {
    const lib = await import(LIB_URL)
    const verdict = lib.contactPiiKeyVerdict(KEY_B64, 'production')
    expect(verdict).toEqual({ ok: true, key: Buffer.from(KEY_B64, 'base64'), fellBack: false })
  })

  it('uses a valid 64-hex-char key verbatim (the openssl rand -hex 32 shape)', async () => {
    const lib = await import(LIB_URL)
    const verdict = lib.contactPiiKeyVerdict(KEY_HEX, 'production')
    expect(verdict.ok).toBe(true)
    expect(verdict.fellBack).toBe(false)
  })

  it('accepts unpadded base64 of exactly 32 bytes', async () => {
    const lib = await import(LIB_URL)
    const unpadded = KEY_B64.replace(/=+$/, '')
    expect(lib.contactPiiKeyVerdict(unpadded, 'production').ok).toBe(true)
  })

  it('unset in production → refuse (fail closed)', async () => {
    const lib = await import(LIB_URL)
    expect(lib.contactPiiKeyVerdict(undefined, 'production')).toEqual({ ok: false, problem: 'unset' })
    expect(lib.contactPiiKeyVerdict('   ', 'production')).toEqual({ ok: false, problem: 'unset' })
  })

  it('unset outside production → the labeled dev fallback', async () => {
    const lib = await import(LIB_URL)
    const verdict = lib.contactPiiKeyVerdict(undefined, 'test')
    expect(verdict.ok).toBe(true)
    expect(verdict.fellBack).toBe(true)
    expect(verdict.key).toEqual(lib.DEV_FALLBACK_CONTACT_PII_KEY)
  })

  it('malformed → refuse in EVERY runtime (never paper over a typo with the fallback)', async () => {
    const lib = await import(LIB_URL)
    for (const bad of ['short', 'z'.repeat(100), Buffer.alloc(33).toString('base64'), 'not!base64///ok=??', '=']) {
      expect(lib.contactPiiKeyVerdict(bad, 'test'), bad).toEqual({ ok: false, problem: 'invalid' })
      expect(lib.contactPiiKeyVerdict(bad, 'production'), bad).toEqual({ ok: false, problem: 'invalid' })
    }
  })
})

// ---------------------------------------------------------------------------
// the route — fail-closed, fallback, sealing, migration, retention
// ---------------------------------------------------------------------------

describe('route — production fail-closed (the #354 posture at the endpoint)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
  })

  it('no key → 503 with an honest reason, NOTHING written, ONE loud error, repeat stays at one', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(VALID_SIGNUP)
    expect(res.status).toBe(503)
    const json = (await res.json()) as { ok: boolean; reason: string; error: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe('contact_pii_key_unset')
    expect(json.error).toContain('try again') // honest retry-later copy, never a fake success
    // Nothing touched the disk — no store, not even the data dir.
    await expect(fsp.access(path.join(tmp, 'data'))).rejects.toThrow()
    const msgs = err.mock.calls.map((c) => c.join(' '))
    expect(msgs.filter((m) => m.includes('CONTACT_PII_KEY'))).toHaveLength(1)
    expect(msgs.some((m) => m.includes('PRODUCTION POSTURE') && m.includes('openssl rand -base64 32'))).toBe(true)

    const again = await post(VALID_SIGNUP)
    expect(again.status).toBe(503)
    expect(err.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('CONTACT_PII_KEY'))).toHaveLength(1)
  })

  it('a malformed key → same refusal, reason contact_pii_key_invalid', async () => {
    vi.stubEnv('CONTACT_PII_KEY', 'definitely-not-32-bytes')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(VALID_SIGNUP)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { reason: string }).reason).toBe('contact_pii_key_invalid')
    await expect(fsp.access(path.join(tmp, 'data'))).rejects.toThrow()
    const msgs = err.mock.calls.map((c) => c.join(' '))
    expect(msgs.some((m) => m.includes('malformed') && m.includes('FAILS CLOSED'))).toBe(true)
  })

  it('the cross-site origin gate still answers first (403 before the key posture)', async () => {
    const route = await import('../../mjengoos-website/app/api/contact/route')
    const res = await route.POST(
      new Request(ROUTE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify(VALID_SIGNUP),
      }),
    )
    expect(res.status).toBe(403)
  })
})

describe('route — dev fallback (no key, non-production)', () => {
  it('stores the lead SEALED under the labeled dev key and warns exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(VALID_CONTACT)
    expect(res.status).toBe(200)
    const stored = await readStore()
    expect(stored).toHaveLength(1)
    expect(String(stored[0].name)).toMatch(/^enc:v1:/)
    expect(String(stored[0].email)).toMatch(/^enc:v1:/)
    expect(stored[0].id).toMatch(/^sub_/) // id/ts/source stay plaintext
    await post({ ...VALID_CONTACT, email: 'second@example.com' })
    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('CONTACT_PII_KEY'))).toHaveLength(1)
    const devWarns = warn.mock.calls.map((c) => c.join(' '))
    expect(devWarns.some((m) => m.includes('dev-fallback key') && m.includes('NOT secret'))).toBe(true)
  })

  it('the response leaks no PII (ok + id only) and the file contains no plaintext PII', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(VALID_CONTACT)
    const json = (await res.json()) as Record<string, unknown>
    expect(Object.keys(json).sort()).toEqual(['id', 'ok'])
    const raw = await fsp.readFile(path.join(tmp, 'data', 'submissions.json'), 'utf8')
    for (const secret of ['Amina Wanjiru', 'amina@example.com', '+254712345678', 'Perimeter wall quote', 'Wanjiru Construction']) {
      expect(raw, secret).not.toContain(secret)
    }
  })

  it('decrypts back to the exact submitted values with the dev key (route ↔ lib interop)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post(VALID_CONTACT)
    const lib = await import(LIB_URL)
    const stored = await readStore()
    const { entry, failures } = lib.openContactSubmission(lib.DEV_FALLBACK_CONTACT_PII_KEY, stored[0])
    expect(failures).toEqual([])
    expect(entry).toMatchObject({
      source: 'contact',
      name: 'Amina Wanjiru',
      email: 'amina@example.com',
      phone: '+254712345678',
      organization: 'Wanjiru Construction',
      country: 'Kenya',
      projectType: 'Residential house',
      message: 'Perimeter wall quote in Kiambu, half an acre.',
    })
  })
})

describe('route — real key', () => {
  beforeEach(() => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
  })

  it('stores sealed and decrypts with the same key', async () => {
    const res = await post(VALID_CONTACT)
    expect(res.status).toBe(200)
    const stored = await readStore()
    const lib = await import(LIB_URL)
    const { entry, failures } = lib.openContactSubmission(Buffer.from(KEY_B64, 'base64'), stored[0])
    expect(failures).toEqual([])
    expect(entry.email).toBe('amina@example.com')
  })

  it('a different key cannot read the store (the volume is ciphertext to whoever lacks the key)', async () => {
    await post(VALID_CONTACT)
    const lib = await import(LIB_URL)
    const stored = await readStore()
    const other = Buffer.from(rangeBytes(32, 21))
    const { failures } = lib.openContactSubmission(other, stored[0])
    expect(failures.length).toBeGreaterThanOrEqual(1)
  })
})

describe('route — the legacy-plaintext migration sweep', () => {
  beforeEach(() => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
  })

  it('re-seals every plaintext row on the first write, preserving id/ts, and logs the count once', async () => {
    const legacy = [0, 1, 2].map((i) => ({
      id: `sub_legacy_${i}`,
      ts: new Date(Date.now() - (3 - i) * 1000).toISOString(),
      source: 'contact',
      name: `Legacy Lead ${i}`,
      email: `legacy${i}@example.com`,
      message: `Pre-encryption message ${i}.`,
    }))
    await fsp.mkdir(path.join(tmp, 'data'), { recursive: true })
    await fsp.writeFile(path.join(tmp, 'data', 'submissions.json'), JSON.stringify(legacy), 'utf8')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(VALID_CONTACT)
    expect(res.status).toBe(200)
    const stored = await readStore()
    expect(stored).toHaveLength(4)
    const lib = await import(LIB_URL)
    const key = Buffer.from(KEY_B64, 'base64')
    for (let i = 0; i < 3; i++) {
      const row = stored.find((r) => r.id === `sub_legacy_${i}`) as Record<string, unknown>
      expect(row).toBeDefined()
      expect(String(row.name)).toMatch(/^enc:v1:/)
      const { entry, failures } = lib.openContactSubmission(key, row)
      expect(failures).toEqual([])
      expect(entry.name).toBe(`Legacy Lead ${i}`)
      expect(entry.ts).toBe(legacy[i].ts) // metadata preserved untouched
    }
    const migrationWarns = warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('sealed 3 legacy'))
    expect(migrationWarns).toHaveLength(1)

    // Converged: the next write finds nothing to migrate.
    await post({ ...VALID_CONTACT, email: 'next@example.com' })
    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('legacy plaintext'))).toHaveLength(1)
  })

  it('already-sealed rows pass through byte-identical (no churn on steady-state writes)', async () => {
    const lib = await import(LIB_URL)
    const key = Buffer.from(KEY_B64, 'base64')
    const sealedRow = lib.sealContactSubmission(key, {
      id: 'sub_sealed_before',
      ts: '2026-09-01T00:00:00.000Z',
      source: 'contact',
      name: 'Already Sealed',
      email: 'sealed@example.com',
    })
    await fsp.mkdir(path.join(tmp, 'data'), { recursive: true })
    await fsp.writeFile(path.join(tmp, 'data', 'submissions.json'), JSON.stringify([sealedRow]), 'utf8')

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post(VALID_CONTACT)
    const stored = await readStore()
    expect(stored[0]).toEqual(sealedRow) // untouched, byte-identical
  })
})

describe('route — the documented retention policy still binds on the sealed store', () => {
  beforeEach(() => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
  })

  it('the 500-most-recent cap evicts the oldest SEALED entry with the loud warning (§6.3/§7.2.1)', async () => {
    const lib = await import(LIB_URL)
    const key = Buffer.from(KEY_B64, 'base64')
    const seed = Array.from({ length: 500 }, (_, i) =>
      lib.sealContactSubmission(key, {
        id: `sub_seed_${i}`,
        ts: new Date(Date.now() - (500 - i) * 1000).toISOString(),
        source: 'contact',
        name: `Seed ${i}`,
        email: `seed${i}@example.com`,
      }),
    )
    await fsp.mkdir(path.join(tmp, 'data'), { recursive: true })
    await fsp.writeFile(path.join(tmp, 'data', 'submissions.json'), JSON.stringify(seed), 'utf8')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(VALID_CONTACT)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string }
    const stored = await readStore()
    expect(stored).toHaveLength(500) // capped, not growing
    expect(stored.find((r) => r.id === 'sub_seed_0')).toBeUndefined() // oldest evicted
    expect(stored.find((r) => r.id === 'sub_seed_1')).toBeDefined() // only the oldest
    expect(stored[stored.length - 1].id).toBe(json.id) // newest is ours
    const msgs = warn.mock.calls.map((c) => c.join(' '))
    expect(msgs.some((m) => m.includes('submission cap reached') && m.includes('dropping 1 oldest'))).toBe(true)
    expect(msgs.some((m) => m.includes('sealed 500 legacy'))).toBe(false) // all-sealed seed: no migration churn
  })
})

// ---------------------------------------------------------------------------
// the operator CLI — real child processes (node, the image's runtime)
// ---------------------------------------------------------------------------

describe('scripts/decrypt-leads.mjs — decrypt mode', () => {
  it('opens what the ROUTE sealed (full interop) and exits 0', async () => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
    await post(VALID_CONTACT)
    const result = runScript([], { CONTACT_PII_KEY: KEY_B64 })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      source: 'contact',
      name: 'Amina Wanjiru',
      email: 'amina@example.com',
      phone: '+254712345678',
      message: 'Perimeter wall quote in Kiambu, half an acre.',
    })
  })

  it('decrypts the dev-fallback store with no key set (local dev posture) and notes the fallback on stderr', async () => {
    // Route sealed under the dev fallback (no CONTACT_PII_KEY, NODE_ENV=test):
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post(VALID_CONTACT)
    const result = runScript([]) // no key in the child env either
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as Array<Record<string, unknown>>)[0].email).toBe('amina@example.com')
    expect(result.stderr).toContain('dev-fallback key')
  })

  it('a wrong key exits 1, reports every failed field on stderr, keeps the sealed value in stdout', async () => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
    await post(VALID_CONTACT)
    const result = runScript([], { CONTACT_PII_KEY: Buffer.from(rangeBytes(32, 99)).toString('base64') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('field "name" failed')
    expect(result.stderr).toContain('field "email" failed')
    expect(result.stderr).toContain('cannot decrypt')
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(String(parsed[0].name)).toMatch(/^enc:v1:/) // sealed value kept, not dropped, not faked
  })

  it('reads a store from an explicit path argument', async () => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
    await post(VALID_CONTACT)
    const result = runScript([path.join(tmp, 'data', 'submissions.json')], { CONTACT_PII_KEY: KEY_B64 })
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as Array<Record<string, unknown>>)[0].email).toBe('amina@example.com')
  })

  it('reads a piped store from stdin ("-")', async () => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
    await post(VALID_CONTACT)
    const raw = await fsp.readFile(path.join(tmp, 'data', 'submissions.json'), 'utf8')
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.CONTACT_PII_KEY
    const result = spawnSync('node', [SCRIPT, '-'], { cwd: tmp, env: { ...env, CONTACT_PII_KEY: KEY_B64 }, encoding: 'utf8', input: raw })
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as Array<Record<string, unknown>>)[0].name).toBe('Amina Wanjiru')
  })

  it('a plaintext (legacy) store passes through readable with a note; exit stays 0', () => {
    mkdirSync(path.join(tmp, 'data'), { recursive: true })
    writeFileSync(
      path.join(tmp, 'data', 'submissions.json'),
      JSON.stringify([{ id: 'sub_old', ts: 't', source: 'contact', name: 'Old Lead', email: 'old@example.com' }]),
    )
    const result = runScript([], { CONTACT_PII_KEY: KEY_B64 })
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as Array<Record<string, unknown>>)[0].name).toBe('Old Lead')
    expect(result.stderr).toContain('plaintext fields')
  })

  it('missing file / invalid JSON / non-array input each exit 1 with a clear error', () => {
    expect(runScript([], { CONTACT_PII_KEY: KEY_B64 }).status).toBe(1) // no data/ at all
    mkdirSync(path.join(tmp, 'data'), { recursive: true })
    writeFileSync(path.join(tmp, 'data', 'submissions.json'), 'not json at all')
    const bad = runScript([], { CONTACT_PII_KEY: KEY_B64 })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('not valid JSON')
    writeFileSync(path.join(tmp, 'data', 'submissions.json'), '{"not":"an array"}')
    const notArray = runScript([], { CONTACT_PII_KEY: KEY_B64 })
    expect(notArray.status).toBe(1)
    expect(notArray.stderr).toContain('JSON array')
  })

  it('unset key under NODE_ENV=production refuses (exit 1) — same posture as the route', () => {
    mkdirSync(path.join(tmp, 'data'), { recursive: true })
    writeFileSync(path.join(tmp, 'data', 'submissions.json'), '[]')
    const result = runScript([], { NODE_ENV: 'production' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no usable CONTACT_PII_KEY')
    expect(result.stderr).toContain('PRODUCTION POSTURE')
  })

  it('a malformed key refuses in dev too (exit 1)', () => {
    mkdirSync(path.join(tmp, 'data'), { recursive: true })
    writeFileSync(path.join(tmp, 'data', 'submissions.json'), '[]')
    const result = runScript([], { CONTACT_PII_KEY: 'nope' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('malformed')
  })
})

describe('scripts/decrypt-leads.mjs — --seal mode (the erasure write-back)', () => {
  it('round-trips: seal a plaintext file, decrypt it back, byte-stable values', () => {
    const plain = [
      { id: 'sub_a', ts: '2026-09-26T08:14:02.104Z', source: 'contact', name: 'Amina Njeri', email: 'amina@example.co.ke', message: 'Wall quote.' },
      { id: 'sub_b', ts: '2026-09-26T09:02:55.741Z', source: 'signup', name: 'Brian Otieno', email: 'brian@example.com', role: 'contractor' },
    ]
    const plainFile = path.join(tmp, 'plain.json')
    writeFileSync(plainFile, JSON.stringify(plain, null, 2))
    const sealed = runScript(['--seal', plainFile], { CONTACT_PII_KEY: KEY_B64 })
    expect(sealed.status).toBe(0)
    expect(sealed.stderr).toContain('sealed 2 plaintext entries')
    const sealedEntries = JSON.parse(sealed.stdout) as Array<Record<string, unknown>>
    expect(String(sealedEntries[0].name)).toMatch(/^enc:v1:/)
    writeFileSync(path.join(tmp, 'sealed.json'), sealed.stdout)
    const reopened = runScript([path.join(tmp, 'sealed.json')], { CONTACT_PII_KEY: KEY_B64 })
    expect(reopened.status).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual(plain)
  })

  it('is idempotent on an already-sealed store (no churn, no stderr noise)', async () => {
    vi.stubEnv('CONTACT_PII_KEY', KEY_B64)
    await post(VALID_CONTACT)
    const before = await fsp.readFile(path.join(tmp, 'data', 'submissions.json'), 'utf8')
    const result = runScript(['--seal', path.join(tmp, 'data', 'submissions.json')], { CONTACT_PII_KEY: KEY_B64 })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    // Same entries (id/ts/source identical), same sealed values — re-parsed
    // equality, not byte equality (the file's pretty-printing may differ).
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(before))
  })

  it('wraps a crafted "enc:v1:"-looking plaintext message instead of resting it (bypass closure at the CLI)', () => {
    const plain = [{ id: 'sub_c', ts: 't', source: 'contact', name: 'Cara', email: 'cara@example.com', message: 'enc:v1:fake:fake:fake' }]
    const plainFile = path.join(tmp, 'plain.json')
    writeFileSync(plainFile, JSON.stringify(plain))
    const sealed = runScript(['--seal', plainFile], { CONTACT_PII_KEY: KEY_B64 })
    expect(sealed.status).toBe(0)
    const sealedEntries = JSON.parse(sealed.stdout) as Array<Record<string, unknown>>
    expect(String(sealedEntries[0].message)).toMatch(/^enc:v1:/)
    expect(sealedEntries[0].message).not.toBe('enc:v1:fake:fake:fake')
    writeFileSync(path.join(tmp, 'sealed.json'), sealed.stdout)
    const reopened = runScript([path.join(tmp, 'sealed.json')], { CONTACT_PII_KEY: KEY_B64 })
    expect((JSON.parse(reopened.stdout) as Array<Record<string, unknown>>)[0].message).toBe('enc:v1:fake:fake:fake')
  })
})

// ---------------------------------------------------------------------------
// the operator-facing wiring (docs + deploy files)
// ---------------------------------------------------------------------------

describe('#362 wiring — the operator surface ships with the code', () => {
  const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8')

  it('the website .env.example documents CONTACT_PII_KEY with the full posture + retrieval pointer', () => {
    const envExample = read('mjengoos-website/.env.example')
    expect(envExample).toContain('CONTACT_PII_KEY')
    expect(envExample).toContain('openssl rand -base64 32')
    expect(envExample).toContain('FAIL CLOSED')
    expect(envExample).toContain('dev-fallback')
    expect(envExample).toContain('bun run decrypt-leads')
  })

  it('the root .env.example carries the compose-interpolation block', () => {
    const envExample = read('.env.example')
    expect(envExample).toContain('CONTACT_PII_KEY')
    expect(envExample).toContain('openssl rand -base64 32')
    expect(envExample).toContain('docker-compose.yml interpolates this ONE variable')
  })

  it('docker-compose.yml passes CONTACT_PII_KEY into the website service by interpolation', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain('- CONTACT_PII_KEY=${CONTACT_PII_KEY:-}')
  })

  it('the website Dockerfile copies the CLI + shared module into the runner image', () => {
    const dockerfile = read('mjengoos-website/Dockerfile')
    expect(dockerfile).toContain('COPY --from=builder --chown=node:node /app/lib/contact-pii.mjs /app/lib/contact-pii.mjs')
    expect(dockerfile).toContain('COPY --from=builder --chown=node:node /app/scripts/decrypt-leads.mjs /app/scripts/decrypt-leads.mjs')
  })

  it('the website package.json exposes bun run decrypt-leads', () => {
    const pkg = JSON.parse(read('mjengoos-website/package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['decrypt-leads']).toBe('node scripts/decrypt-leads.mjs')
  })

  it('the website README points lead retrieval at the decrypt CLI', () => {
    const readme = read('mjengoos-website/README.md')
    expect(readme).toContain('bun run decrypt-leads')
    expect(readme).toContain('docker compose exec website node /app/scripts/decrypt-leads.mjs')
    expect(readme).toContain('CONTACT_PII_KEY')
  })

  it('DEPLOYMENT.md §6.3 carries the in-container decrypt command and the seal-back erasure path', () => {
    const deployment = read('DEPLOYMENT.md')
    const flat = deployment.replace(/\s+/g, ' ')
    expect(flat).toContain('docker compose exec website node /app/scripts/decrypt-leads.mjs > leads.json')
    expect(flat).toContain('node /app/scripts/decrypt-leads.mjs --seal > /app/data/submissions.json')
    expect(flat).toContain('decrypt → edit →')
    expect(flat).toContain('Fail-closed, the `VAPID_SUBJECT` / issue-#354 shape')
  })

  it('DEPLOYMENT.md §7.2 secrets bullet names the website key and its custody rule', () => {
    const deployment = read('DEPLOYMENT.md')
    const flat = deployment.replace(/\s+/g, ' ')
    expect(flat).toContain('The website has one secret of its own (issue #362 / MD-3): `CONTACT_PII_KEY`')
    expect(flat).toContain('never lives in the backup dir')
  })
})
