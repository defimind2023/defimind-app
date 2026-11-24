import type { ApprovalRequest, MandateApprovalRequest } from '@defimind/shared'
import { lte } from 'drizzle-orm'
import type { Db } from './client.js'
import { getMandate } from './mandates.js'
import { getIntent } from './repo.js'
import { approvalRequests } from './schema.js'

export function saveRequest(db: Db, request: ApprovalRequest | MandateApprovalRequest): void {
  const row =
    'mandate' in request
      ? { id: request.mandate.id, kind: 'mandate' as const }
      : { id: request.intent.id, kind: 'intent' as const }
  db.insert(approvalRequests)
    .values({ ...row, body: request, approveBefore: request.approveBefore })
    .onConflictDoUpdate({ target: approvalRequests.id, set: { body: request } })
    .run()
}

/** The requests still waiting for the owner, judged by the intent or mandate as it is now. */
export function openRequests(db: Db, now: Date) {
  const rows = db.select().from(approvalRequests).all()
  const live = (approveBefore: string) => new Date(approveBefore).getTime() > now.getTime()
  const pending: ApprovalRequest[] = []
  const mandates: MandateApprovalRequest[] = []
  for (const row of rows) {
    if (!live(row.approveBefore)) {
      continue
    }
    if (row.kind === 'intent' && getIntent(db, row.id)?.status === 'pending_approval') {
      pending.push(row.body as ApprovalRequest)
    }
    if (row.kind === 'mandate' && getMandate(db, row.id)?.status === 'pending_approval') {
      mandates.push(row.body as MandateApprovalRequest)
    }
  }
  return { pending, mandates }
}

export function pruneRequests(db: Db, now: Date): void {
  db.delete(approvalRequests).where(lte(approvalRequests.approveBefore, now.toISOString())).run()
}
