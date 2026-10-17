import { handle, ok, requireUser } from '@/lib/api-helpers'

export async function GET() {
  return handle(async () => {
    const user = await requireUser()
    return ok(user)
  })
}
