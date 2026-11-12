import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'

export const SESSION_COOKIE = 'mjengo_session'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// scrypt with per-password random salt. Stored format: scrypt$<saltHex>$<hashHex>
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return timingSafeEqual(expected, actual)
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

// MJG-042 — session tokens are stored at rest as SHA-256 digests; only the
// raw token ever reaches the client cookie. A leaked DB row cannot be replayed.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.session.create({ data: { token: hashToken(token), userId, expiresAt } })
  return { token, expiresAt }
}

export async function destroySession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { token: hashToken(token) } })
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  }
}
