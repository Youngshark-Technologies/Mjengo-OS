import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // MJG-029 — SQL query logging only in development. Unconditional query
    // logging shipped full SQL statements (with embedded values) to production
    // logs: log noise plus potential data leakage into log aggregation.
    log: process.env.NODE_ENV === 'development' ? ['query'] : [],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db