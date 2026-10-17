import { cookies } from 'next/headers'
import { handle, ok } from '@/lib/api-helpers'
import { destroySession, SESSION_COOKIE } from '@/lib/auth'

export async function POST() {
  return handle(async () => {
    const jar = await cookies()
    const token = jar.get(SESSION_COOKIE)?.value
    if (token) await destroySession(token)
    const res = ok({ ok: true })
    res.cookies.delete(SESSION_COOKIE)
    return res
  })
}
