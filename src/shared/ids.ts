// CSPRNG id/reference generation — register MD-4 (issue #350), the ONE
// isomorphic seam every user-visible id and reference in the app draws from.
//
// WHY THIS FILE EXISTS: the audit found Math.random behind user-visible
// reference ids — escrow top-ups (MPESA-XXXXXXXX), invoice payments
// (BANK-/CARD-/WALLET-/CASH-…), simulated-rail receipts (SIM-…), registry
// search refs (CS/YYYY/NNNNNN) and offline outbox item ids. Math.random is
// NOT unpredictable: V8 seeds a xorshift128+ stream whose full state (and
// therefore every future output) can be reconstructed from a handful of
// observed draws. For a money app, a reference a user reads aloud over the
// phone ("I sent to MPESA-7XK2P4QA") must not be a value an observer can
// predict or enumerate — same posture SEC-3 established for share tokens.
//
// THE SEAM: WebCrypto's crypto.getRandomValues — a global in every browser
// this PWA supports, in Node >= 19 (the Docker runtime is node:20-slim) and
// in Bun. Both sides of the wire (server routes and client components) run
// the SAME single code path — no node:crypto import that would break the
// client bundle, no second server-only variant to drift.
//
// HONESTY POSTURE (fail closed, never downgrade): if the runtime provides no
// CSPRNG the helpers THROW. There is deliberately NO Math.random fallback —
// a silently guessable reference is worse than a loud error, which is the
// entire point of MD-4.
//
// UNIFORMITY: both draws use rejection sampling. A raw `byte % charset.length`
// favors the leading characters whenever 256 % length !== 0 (e.g. base-36:
// bytes 252..255 wrap to chars 0..3); the rejected band keeps every
// character exactly equiprobable. The mechanism (not just the statistics) is
// pinned in tests/unit/csprng-ids.test.ts against a stubbed getRandomValues.

/**
 * Narrow structural type for the WebCrypto piece this module needs — avoids
 * depending on lib.dom vs @types/node spelling of the global `crypto`.
 * Generic over the typed-array view exactly like the platform signature, so
 * both the byte batches (Uint8Array) and the 32-bit draws (Uint32Array)
 * ride it.
 */
interface RandomValuesSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

/** One CSPRNG fill, or a loud refusal — never a Math.random downgrade. */
function csprngFill<T extends ArrayBufferView>(bytes: T): T {
  const webcrypto = (globalThis as { crypto?: RandomValuesSource }).crypto
  if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
    throw new Error(
      'No CSPRNG available: globalThis.crypto.getRandomValues is missing. ' +
        'Refusing to mint ids from Math.random — MD-4, issue #350. Every ' +
        'supported runtime (browsers, Node >= 19, Bun) ships WebCrypto; fix ' +
        'the runtime, not this guard.',
    )
  }
  return webcrypto.getRandomValues(bytes)
}

/**
 * `length` characters drawn UNIFORMLY from `charset` (rejection sampling —
 * no modulo bias). Batches are capped at 256 bytes so a single
 * getRandomValues call never approaches the WebCrypto 65,536-byte quota.
 */
export function randomChars(length: number, charset: string): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`randomChars: length must be a positive integer (got ${length})`)
  }
  if (charset.length < 2 || charset.length > 256) {
    throw new Error(`randomChars: charset must carry 2..256 characters (got ${charset.length})`)
  }
  const size = charset.length
  // Bytes below this bound map uniformly onto the charset; the tail is rejected.
  const limit = 256 - (256 % size)
  let out = ''
  const batch = new Uint8Array(Math.min(256, length * 2))
  while (out.length < length) {
    csprngFill(batch)
    for (let i = 0; i < batch.length && out.length < length; i++) {
      const byte = batch[i]
      if (byte < limit) out += charset[byte % size]
    }
  }
  return out
}

/**
 * A uniform integer in [min, max] (both inclusive) — 32-bit rejection
 * sampling, same no-bias posture as randomChars. Powers the CS/YYYY/NNNNNN
 * registry search ref, whose six-digit shape is the pinned public format.
 */
export function randomIntInclusive(min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error(`randomIntInclusive: both bounds must be integers (got ${min}..${max})`)
  }
  if (min > max) {
    throw new Error(`randomIntInclusive: min must not exceed max (got ${min}..${max})`)
  }
  const range = max - min + 1
  if (range > 2 ** 32) {
    throw new Error(`randomIntInclusive: range ${range} exceeds the 32-bit draw`)
  }
  // Draws below this bound map uniformly onto the range; the tail is rejected.
  const limit = Math.floor(2 ** 32 / range) * range
  const draw = new Uint32Array(1)
  for (;;) {
    csprngFill(draw)
    if (draw[0] < limit) return min + (draw[0] % range)
  }
}

/** Base-36 alphabet (0-9a-z) — the outbox uid suffix idiom (see outbox.ts). */
export const BASE36_CHARSET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * The payment-reference suffix alphabet: 32 characters, deliberately WITHOUT
 * the confusables 0/O and 1/I — a reference a Kenyan site foreman reads over
 * the phone must have exactly one reading (the shape is pinned by docs and
 * seed data as MPESA-7XK2P4QA style).
 */
export const REFERENCE_SUFFIX_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Reference suffix length — 32^8 ≈ 2^40 possible suffixes per prefix. */
export const REFERENCE_SUFFIX_LENGTH = 8

/** One payment-reference suffix draw: 8 uniform chars from the no-confusables alphabet. */
export function randomReferenceSuffix(): string {
  return randomChars(REFERENCE_SUFFIX_LENGTH, REFERENCE_SUFFIX_CHARSET)
}

/**
 * The auto payment reference minted when a payer supplies none — the ONE
 * shape behind escrow top-ups, invoice payments and their client-side
 * previews (was five drifting Math.random copies; MD-4 consolidated them):
 *
 *   autoPaymentReference('mpesa')  // MPESA-7XK2P4QA
 *   autoPaymentReference('bank')   // BANK-QK3M8XW2
 *   autoPaymentReference('card')   // CARD-…
 *   autoPaymentReference('wallet') // WALLET-…
 *   autoPaymentReference('cash')   // CASH-…
 *   anything else                  // MPESA-… (the historical default arm)
 *
 * Method matching is case-sensitive exactly like the copies it replaces —
 * every call site feeds a lowercased, validated method.
 */
const REFERENCE_PREFIXES: Record<string, string> = {
  bank: 'BANK',
  card: 'CARD',
  wallet: 'WALLET',
  cash: 'CASH',
}

export function autoPaymentReference(method: string): string {
  const prefix = REFERENCE_PREFIXES[method] ?? 'MPESA'
  return `${prefix}-${randomReferenceSuffix()}`
}
