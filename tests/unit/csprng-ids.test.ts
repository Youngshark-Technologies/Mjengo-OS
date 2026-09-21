/**
 * MD-4 (issue #350) — CSPRNG behind every user-visible reference id.
 *
 * The audit found Math.random minting money references (MPESA-XXXXXXXX top-up
 * and invoice-payment references, SIM-<rail>-XXXXXXXX simulated-rail
 * receipts), registry search refs (CS/YYYY/NNNNNN) and offline outbox item
 * ids. Math.random is NOT unpredictable — V8's xorshift128+ stream can be
 * reconstructed from observed outputs, so a reference a user reads over the
 * phone was a value an observer could predict or enumerate. All of it now
 * draws from ONE isomorphic seam, src/shared/ids.ts
 * (crypto.getRandomValues — global in browsers, Node >= 19, Bun), same
 * posture SEC-3 established for share tokens.
 *
 * Pinned here:
 *   · THE SEAM — no CSPRNG in the runtime → a LOUD throw, never a silent
 *     Math.random downgrade (the whole point of MD-4).
 *   · UNIFORMITY MECHANISM — rejection sampling: a stubbed getRandomValues
 *     proves out-of-range bytes are SKIPPED, not wrapped modulo the charset
 *     (modulo bias favors leading characters; the mechanism is pinned, not
 *     just the statistics).
 *   · FORMAT/CHARSET/LENGTH — the reference suffix stays 8 chars of the
 *     no-confusables alphabet (no 0/O/1/I), the outbox uid stays
 *     <base36 ts>-<6 base36 chars>, the search ref stays 6 digits, and every
 *     prefix arm (MPESA/BANK/CARD/WALLET/CASH + the historical fallback)
 *     survives.
 *   · MANY-DRAW UNIQUENESS — thousands of draws never repeat (draw counts
 *     sized so the birthday-probability of a legit collision is ~1e-5).
 *   · CONSUMER WIRING — every former Math.random site imports the shared
 *     seam, and a repo-wide sweep of every .ts/.tsx file under src/
 *     (comments stripped) finds ZERO Math.random calls left.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BASE36_CHARSET,
  REFERENCE_SUFFIX_CHARSET,
  REFERENCE_SUFFIX_LENGTH,
  autoPaymentReference,
  randomChars,
  randomIntInclusive,
  randomReferenceSuffix,
} from '@/shared/ids'
import { uid } from '@/frontend/lib/outbox'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/**
 * The reference suffix alphabet with the confusables removed: everything in
 * A-Z minus I and O, plus 2-9 (no 0, no 1) — exactly 32 characters.
 */
const REFERENCE_SUFFIX_RE = /^[A-HJ-NP-Z2-9]{8}$/

/** Outbox uid: base36 timestamp, dash, exactly 6 base36 characters. */
const UID_RE = /^[0-9a-z]+-[0-9a-z]{6}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------- the seam: loud refusal, never a Math.random downgrade ----------------

describe('MD-4: the CSPRNG seam fails closed', () => {
  it('no crypto.getRandomValues in the runtime → a loud throw naming MD-4, never a guessable fallback', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => randomReferenceSuffix()).toThrow(/No CSPRNG available.*MD-4/s)
    expect(() => randomChars(6, BASE36_CHARSET)).toThrow(/No CSPRNG available/)
    expect(() => randomIntInclusive(100000, 999999)).toThrow(/No CSPRNG available/)
  })

  it('a crypto object without getRandomValues is the same loud refusal (structural check, not truthiness)', () => {
    vi.stubGlobal('crypto', {})
    expect(() => randomReferenceSuffix()).toThrow(/No CSPRNG available/)
  })
})

// ---------------- the uniformity mechanism, pinned against a stub ----------------

describe('MD-4: rejection sampling skips out-of-range draws (no modulo bias)', () => {
  /**
   * Stub getRandomValues to replay `script` element-wise, cycling: each call
   * fills the view with the next script values (bytes for Uint8Array views,
   * 32-bit words for Uint32Array views — element-wise, like the real API).
   */
  function stubScript(script: number[]) {
    let i = 0
    vi.stubGlobal('crypto', {
      getRandomValues(view: Uint8Array | Uint32Array) {
        for (let k = 0; k < view.length; k++) {
          ;(view as unknown as { [k: number]: number })[k] = script[i % script.length]!
          i++
        }
        return view
      },
    })
  }

  it('randomChars: bytes in the rejected tail are dropped, not wrapped onto early characters', () => {
    // charset 'VWXYZ' (5 chars): 256 % 5 = 1, so only bytes < 255 are usable
    // and byte 255 MUST be rejected (a modulo implementation would map it to
    // 'V' — the bias this test exists to catch).
    stubScript([255, 0, 1, 255, 2, 3, 255, 4, 0])
    expect(randomChars(6, 'VWXYZ')).toBe('VWXYZV')
  })

  it('randomChars: a charset that divides 256 evenly accepts every byte (no rejection band)', () => {
    // 32 chars → limit 256: byte 255 maps to the 32nd character '9' — the
    // full byte range is usable, nothing is rejected.
    stubScript([255, 255])
    expect(randomChars(2, REFERENCE_SUFFIX_CHARSET)).toBe('99')
    stubScript([0, 0])
    expect(randomChars(2, REFERENCE_SUFFIX_CHARSET)).toBe('AA')
  })

  it('randomIntInclusive: 32-bit draws past the range boundary are dropped, in-range draws map exactly', () => {
    // [100000, 999999]: range 900000, limit 4294800000 — 0xFFFFFFFF is past
    // the boundary and must be retried; 123456 maps to 100000 + 123456.
    stubScript([0xffffffff, 123456])
    expect(randomIntInclusive(100000, 999999)).toBe(223456)
  })

  it('randomIntInclusive: a single-value range accepts any draw (limit is the full 2^32)', () => {
    stubScript([0xffffffff])
    expect(randomIntInclusive(3, 3)).toBe(3)
  })
})

// ---------------- argument guards ----------------

describe('MD-4: helper argument guards', () => {
  it('randomChars refuses non-positive/non-integer lengths and degenerate charsets', () => {
    expect(() => randomChars(0, BASE36_CHARSET)).toThrow(/positive integer/)
    expect(() => randomChars(-1, BASE36_CHARSET)).toThrow(/positive integer/)
    expect(() => randomChars(1.5, BASE36_CHARSET)).toThrow(/positive integer/)
    expect(() => randomChars(6, '')).toThrow(/2\.\.256/)
    expect(() => randomChars(6, 'A')).toThrow(/2\.\.256/)
  })

  it('randomIntInclusive refuses non-integer bounds, inverted bounds and >32-bit ranges', () => {
    expect(() => randomIntInclusive(0.5, 10)).toThrow(/integers/)
    expect(() => randomIntInclusive(10, 5)).toThrow(/min must not exceed max/)
    expect(() => randomIntInclusive(0, 2 ** 32)).toThrow(/32-bit/)
  })
})

// ---------------- format / charset / length — the public shapes survive ----------------

describe('MD-4: the reference suffix shape is unchanged (8 chars, no confusables)', () => {
  it('the alphabet is pinned: 32 chars, A-Z minus I/O plus 2-9', () => {
    expect(REFERENCE_SUFFIX_CHARSET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
    expect(REFERENCE_SUFFIX_LENGTH).toBe(8)
    expect(BASE36_CHARSET).toBe('0123456789abcdefghijklmnopqrstuvwxyz')
  })

  it('5,000 draws: every suffix matches the shape, every alphabet character appears, no confusable ever does', () => {
    const seen = new Set<string>()
    const charHits = new Map<string, number>()
    for (let i = 0; i < 5_000; i++) {
      const s = randomReferenceSuffix()
      expect(s).toMatch(REFERENCE_SUFFIX_RE)
      expect(s).not.toMatch(/[IO01]/)
      seen.add(s)
      for (const ch of s) charHits.set(ch, (charHits.get(ch) ?? 0) + 1)
    }
    // 40,000 character draws, 32-char alphabet: P(any char missing) ~ e^-1250.
    for (const ch of REFERENCE_SUFFIX_CHARSET) {
      expect(charHits.get(ch), `alphabet character ${ch} never appeared`).toBeGreaterThan(0)
    }
    // 32^8 ≈ 2^40 space, 5,000 draws: P(legit collision) ≈ 1e-5.
    expect(seen.size).toBe(5_000)
  })
})

describe('MD-4: autoPaymentReference keeps every prefix arm (incl. the historical fallback)', () => {
  const CASES: Array<[method: string, prefix: string]> = [
    ['mpesa', 'MPESA'],
    ['bank', 'BANK'],
    ['card', 'CARD'],
    ['wallet', 'WALLET'],
    ['cash', 'CASH'],
    ['cheque', 'MPESA'], // unknown method → the historical MPESA default arm
    ['', 'MPESA'],
  ]

  it.each(CASES)('method %j → %s-XXXXXXXX (8 no-confusable chars)', (method, prefix) => {
    for (let i = 0; i < 25; i++) {
      const r = autoPaymentReference(method)
      expect(r.startsWith(`${prefix}-`)).toBe(true)
      expect(r.slice(prefix.length + 1)).toMatch(REFERENCE_SUFFIX_RE)
    }
  })

  it('5,000 draws: shaped, unique, and the prefix arm follows the method', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5_000; i++) {
      const r = autoPaymentReference(i % 2 === 0 ? 'mpesa' : 'bank')
      expect(r).toMatch(i % 2 === 0 ? /^MPESA-/ : /^BANK-/)
      expect(r.slice(-8)).toMatch(REFERENCE_SUFFIX_RE)
      seen.add(r)
    }
    expect(seen.size).toBe(5_000)
  })
})

describe('MD-4: the outbox uid shape is unchanged (<base36 ts>-<6 base36 chars>)', () => {
  it('prefix decodes to a sane timestamp and the suffix is exactly 6 base36 chars', () => {
    const before = Date.now()
    const id = uid()
    const after = Date.now()
    expect(id).toMatch(UID_RE)
    const ts = parseInt(id.slice(0, id.indexOf('-')), 36)
    expect(ts).toBeGreaterThanOrEqual(before - 60_000)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('250 rapid draws are all distinct (same-millisecond uniqueness rides the CSPRNG suffix)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 250; i++) ids.add(uid())
    // 36^6 ≈ 2^31 suffix space; 250 same-ms draws: P(legit collision) ≈ 7e-6.
    expect(ids.size).toBe(250)
  })
})

describe('MD-4: randomIntInclusive keeps the CS/YYYY/NNNNNN six-digit draw', () => {
  it('10,000 draws: always an integer in [100000, 999999], always exactly 6 digits', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 10_000; i++) {
      const n = randomIntInclusive(100000, 999999)
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(100000)
      expect(n).toBeLessThanOrEqual(999999)
      expect(String(n)).toMatch(/^\d{6}$/)
      seen.add(n)
    }
    // Both endpoints of the shape stay representable across many draws.
    expect(seen.size).toBeGreaterThan(9_000)
  })
})

// ---------------- consumer wiring: every former Math.random site uses the seam ----------------

describe('MD-4: every former Math.random id site draws from the shared seam', () => {
  const SITES: Array<{ file: string; pin: string }> = [
    { file: 'src/frontend/lib/outbox.ts', pin: 'randomChars(6, BASE36_CHARSET)' },
    { file: 'src/frontend/mjengo/money-tab.tsx', pin: 'autoPaymentReference(tMethod)' },
    { file: 'src/frontend/mjengo/finder/sections/invoices/pay-invoice-dialog.tsx', pin: 'autoPaymentReference(method)' },
    { file: 'src/backend/actions/money.ts', pin: 'autoPaymentReference(method)' },
    { file: 'src/backend/modules/invoices/service.ts', pin: 'autoPaymentReference(method)' },
    { file: 'src/backend/modules/wallet/providers.ts', pin: 'randomReferenceSuffix()' },
    { file: 'src/backend/modules/land/service.ts', pin: 'randomIntInclusive(100000, 999999)' },
  ]

  it.each(SITES)('$file wires the shared CSPRNG seam ($pin)', ({ file, pin }) => {
    const src = readSrc(file)
    expect(src).toContain(`from '@/shared/ids'`)
    expect(src).toContain(pin)
  })
})

describe('MD-4: no Math.random call survives anywhere in src/', () => {
  /**
   * Strip // line comments and block comments so PROSE mentioning
   * Math.random ("never Math.random (was predictable)") cannot false-positive
   * while a real call — with any whitespace before its paren — cannot hide.
   * The [^:] before // keeps https:// URLs in strings intact.
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  }

  it('the sweep finds zero Math.random calls across every .ts/.tsx file under src/', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(`${dir}/${entry.name}`)
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThan(300) // the sweep really walked the tree
    const offenders = files.filter((f) => /Math\.random\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
    expect(offenders, `Math.random calls left in: ${offenders.join(', ')}`).toEqual([])
  })
})
