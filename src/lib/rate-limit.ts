// MJG-043 — dependency-free in-memory sliding-window rate limiter.
//
// Per-process state: each key keeps the timestamps of admitted attempts inside
// the current window. A request is admitted only while fewer than `limit`
// timestamps fall within the last `windowMs`. State resets on restart and is
// not shared across server processes — appropriate for brute-force throttling
// of auth endpoints, not for billing-grade quotas.

const windows = new Map<string, number[]>()

function prune(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs
  let firstAlive = 0
  while (firstAlive < timestamps.length && timestamps[firstAlive] <= cutoff) firstAlive++
  return firstAlive > 0 ? timestamps.slice(firstAlive) : timestamps
}

// Checks (and records) one attempt against the sliding window for `key`.
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now()
  const timestamps = prune(windows.get(key) ?? [], windowMs, now)
  if (timestamps.length >= limit) {
    windows.set(key, timestamps)
    const oldest = timestamps[0] ?? now
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) }
  }
  timestamps.push(now)
  windows.set(key, timestamps)
  return { ok: true, retryAfterSec: 0 }
}

// Records an attempt without enforcing a limit — used to penalize failures
// (e.g. wrong-password logins) even when the admission check already passed.
export function recordRateLimit(key: string): void {
  const timestamps = windows.get(key) ?? []
  timestamps.push(Date.now())
  windows.set(key, timestamps)
}

// Clears all windowed state for `key` (e.g. after a successful login).
export function resetRateLimit(key: string): void {
  windows.delete(key)
}
