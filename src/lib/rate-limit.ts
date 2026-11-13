// MJG-043 — dependency-free in-memory sliding-window rate limiter.
//
// Per-process state: each key keeps the timestamps of admitted attempts inside
// the current window. A request is admitted only while fewer than `limit`
// timestamps fall within the last `windowMs`. State resets on restart and is
// not shared across server processes — appropriate for brute-force throttling
// of auth endpoints, not for billing-grade quotas.
//
// MJG-065 — memory bounds. This map is reachable from UNAUTHENTICATED
// requests, so its growth must be bounded no matter what callers throw at it:
//   1. every Nth write sweeps buckets whose timestamps have ALL fallen out of
//      even the largest configured window (live buckets are never touched);
//   2. the map is hard-capped at MAX_BUCKETS buckets — once full, expired
//      buckets are swept first, and a NEW distinct key that still cannot fit
//      is routed into one shared 'overflow' bucket (still rate-limited, just
//      coarser) instead of allocating another bucket;
//   3. keys longer than MAX_KEY_LENGTH (e.g. a hostile multi-kilobyte email
//      header) are SHA-256 hashed to a fixed 64-char key before use.

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const windows = new Map<string, number[]>()

// MJG-065 — hard bounds and sweep cadence.
const MAX_BUCKETS = 10_000
const MAX_KEY_LENGTH = 200
const SWEEP_EVERY_N_WRITES = 256
const OVERFLOW_BUCKET = 'overflow' // real keys are always prefixed (`login:ip:…`), so this cannot collide

// MJG-065 — largest window any caller has configured so far (monotonic). A
// timestamp older than this cannot influence ANY bucket, so pruning with it
// as the cutoff can never evict a live (unexpired) bucket.
let maxWindowMs = 0
let writesSinceSweep = 0

function prune(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs
  let firstAlive = 0
  while (firstAlive < timestamps.length && timestamps[firstAlive] <= cutoff) firstAlive++
  return firstAlive > 0 ? timestamps.slice(firstAlive) : timestamps
}

// MJG-065 — long keys are hashed so no single bucket key can be arbitrarily
// large; hashing is deterministic, so check/record/reset resolve to the same
// bucket for the same logical key.
function normalizeKey(key: string): string {
  return key.length > MAX_KEY_LENGTH
    ? createHash('sha256').update(key).digest('hex')
    : key
}

// MJG-065 — drop fully-expired buckets. Conservative by construction: a
// bucket survives unless EVERY timestamp in it is older than maxWindowMs.
function sweepExpired(now: number): void {
  if (maxWindowMs <= 0) return
  for (const [key, timestamps] of windows) {
    const alive = prune(timestamps, maxWindowMs, now)
    if (alive.length === 0) windows.delete(key)
    else if (alive !== timestamps) windows.set(key, alive)
  }
}

// MJG-065 — resolve the storage bucket for a logical key on a WRITE. Existing
// buckets always keep their own key (routing never splits a bucket); a NEW
// key gets its own bucket only while the map is under the cap — then the map
// is swept once, and if it is STILL full the key shares the single overflow
// bucket, so an attacker minting unique keys shares one coarse budget instead
// of growing the map without bound.
function bucketFor(key: string, now: number): string {
  const normalized = normalizeKey(key)
  if (windows.has(normalized)) return normalized
  if (windows.size < MAX_BUCKETS) return normalized
  sweepExpired(now)
  if (windows.size < MAX_BUCKETS) return normalized
  return OVERFLOW_BUCKET
}

// MJG-065 — cheap periodic sweep piggybacked on ordinary writes.
function beforeWrite(now: number): void {
  if (++writesSinceSweep >= SWEEP_EVERY_N_WRITES) {
    writesSinceSweep = 0
    sweepExpired(now)
  }
}

// Checks (and records) one attempt against the sliding window for `key`.
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now()
  maxWindowMs = Math.max(maxWindowMs, windowMs)
  beforeWrite(now)

  const bucket = bucketFor(key, now)
  const timestamps = prune(windows.get(bucket) ?? [], windowMs, now)
  if (timestamps.length >= limit) {
    windows.set(bucket, timestamps)
    const oldest = timestamps[0] ?? now
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) }
  }
  timestamps.push(now)
  windows.set(bucket, timestamps)
  return { ok: true, retryAfterSec: 0 }
}

// Records an attempt without enforcing a limit — used to penalize failures
// (e.g. wrong-password logins) even when the admission check already passed.
export function recordRateLimit(key: string): void {
  const now = Date.now()
  beforeWrite(now)

  const bucket = bucketFor(key, now)
  const timestamps = windows.get(bucket) ?? []
  timestamps.push(now)
  windows.set(bucket, timestamps)
}

// Clears all windowed state for `key` (e.g. after a successful login).
export function resetRateLimit(key: string): void {
  const normalized = normalizeKey(key)
  // MJG-065 — one caller's success must never clear the SHARED overflow
  // bucket, which coalesces every overflowed key's budget.
  if (normalized === OVERFLOW_BUCKET) return
  windows.delete(normalized)
}

// MJG-061 — the single client-IP derivation for rate limiting (login and
// register share this). Replaces the per-route clientIp() helpers that
// trusted the LEFTMOST x-forwarded-for entry.
//
// x-forwarded-for semantics: every proxy APPENDS the address it observed, so
// the leftmost entry is whatever the CLIENT sent (freely spoofable) and the
// RIGHTMOST entry is the one added by the LAST trusted proxy — Render appends
// the real client IP; Vercel fronts the frontend only. Trusting the leftmost
// entry let an attacker rotate a fake first hop per request and mint fresh
// rate-limit buckets, silently bypassing the limiter.
//
// Therefore: take the RIGHTMOST entry of the (possibly multi-entry,
// whitespace-padded) chain and return it ONLY if it parses as an IP address
// (node:net.isIP). No header, empty chain, or unparseable entry ⇒ the literal
// 'unknown' — every such caller shares one bucket. Behind the standard proxy
// topology a spoofed chain cannot mint buckets: client-controlled entries can
// only sit LEFT of the real IP appended by the trusted proxy. On a bare-server
// deployment (no proxy) an inbound x-forwarded-for is entirely client-supplied
// — strip it at the edge, or verify header handling per docs/DEPLOYMENT.md.
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const entries = forwarded.split(',').map(entry => entry.trim())
    const rightmost = entries[entries.length - 1]
    if (rightmost && isIP(rightmost) !== 0) return rightmost
  }
  return 'unknown'
}
