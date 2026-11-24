import type { ExecutionReceipt } from '@defimind/shared'
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import type { Db } from './client.js'
import { executions } from './schema.js'

type Row = typeof executions.$inferSelect

export function toReceipt({ paymentReceipt, ...row }: Row): ExecutionReceipt {
  return {
    type: 'defimind.execution.v1',
    ...row,
    ...(paymentReceipt === null ? {} : { paymentReceipt }),
  }
}

export function lastExecution(db: Db): Row | undefined {
  return db.select().from(executions).orderBy(desc(executions.seq)).limit(1).get()
}

export function insertExecution(db: Db, receipt: ExecutionReceipt): void {
  const { type: _, paymentReceipt, ...row } = receipt
  db.insert(executions)
    .values({ ...row, paymentReceipt: paymentReceipt ?? null })
    .run()
}

/** In seq order, a page at a time, so a check of the whole chain never holds it all in memory. */
export function executionsFrom(db: Db, afterSeq: number, limit: number): ExecutionReceipt[] {
  return db
    .select()
    .from(executions)
    .where(gte(executions.seq, afterSeq + 1))
    .orderBy(asc(executions.seq))
    .limit(limit)
    .all()
    .map(toReceipt)
}

export function executionsBetween(
  db: Db,
  from: Date,
  to: Date,
  agentId?: string,
): ExecutionReceipt[] {
  const window = and(
    gte(executions.issuedAt, from.toISOString()),
    lte(executions.issuedAt, to.toISOString()),
    agentId === undefined ? undefined : eq(executions.agentId, agentId),
  )
  return db
    .select()
    .from(executions)
    .where(window)
    .orderBy(asc(executions.seq))
    .all()
    .map(toReceipt)
}

export function executionAt(db: Db, seq: number): ExecutionReceipt | undefined {
  const row = db.select().from(executions).where(eq(executions.seq, seq)).get()
  return row === undefined ? undefined : toReceipt(row)
}
