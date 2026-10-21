import { z } from 'zod'
import type { Worker } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handle, parseBody, parseQuery, requireUser } from '@/lib/api-helpers'
import { WORKER_TRADE_VALUES } from '@/lib/types'
import type { WorkerDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

function toWorkerDTO(worker: Worker): WorkerDTO {
  return {
    id: worker.id,
    name: worker.name,
    phone: worker.phone,
    trade: worker.trade as WorkerDTO['trade'],
    dailyRate: worker.dailyRate,
    active: worker.active,
  }
}

// Empty-string query params (e.g. ?active=) are treated as absent.
const querySchema = z.object({
  active: z.preprocess(v => (v === '' ? undefined : v), z.enum(['true', 'false']).optional()),
})

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  phone: z.string().trim().min(1, 'phone cannot be empty').optional(),
  trade: z.enum(WORKER_TRADE_VALUES).default('LABORER'),
  dailyRate: z.number().min(0, 'dailyRate cannot be negative').default(0),
})

// GET /api/workers?active=true|false — roster, name ascending.
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const { active } = parseQuery(req, querySchema)

    const workers = await db.worker.findMany({
      where: {
        organizationId: user.organizationId,
        ...(active ? { active: active === 'true' } : {}),
      },
      orderBy: { name: 'asc' },
    })

    return ok(workers.map(toWorkerDTO))
  })
}

// POST /api/workers — register a worker.
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser()
    const body = await parseBody(req, createSchema)

    const worker = await db.worker.create({
      data: {
        organizationId: user.organizationId,
        name: body.name,
        phone: body.phone ?? null,
        trade: body.trade,
        dailyRate: body.dailyRate,
      },
    })

    return ok(toWorkerDTO(worker), 201)
  })
}
