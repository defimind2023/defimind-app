import { eq, lte } from 'drizzle-orm'
import type { Db } from './client.js'
import { ownerSessions } from './schema.js'

export type OwnerSession = typeof ownerSessions.$inferSelect

export function saveSession(db: Db, session: OwnerSession): void {
  db.insert(ownerSessions).values(session).run()
}

export function getSession(db: Db, tokenHash: string): OwnerSession | undefined {
  return db.select().from(ownerSessions).where(eq(ownerSessions.tokenHash, tokenHash)).get()
}

export function touchSession(db: Db, tokenHash: string, now: Date): void {
  db.update(ownerSessions)
    .set({ lastSeenAt: now.toISOString() })
    .where(eq(ownerSessions.tokenHash, tokenHash))
    .run()
}

export function deleteSession(db: Db, tokenHash: string): void {
  db.delete(ownerSessions).where(eq(ownerSessions.tokenHash, tokenHash)).run()
}

/** Ends every session a passkey opened, for when that passkey is removed. */
export function deleteSessionsOf(db: Db, passkeyId: string): number {
  return db.delete(ownerSessions).where(eq(ownerSessions.passkeyId, passkeyId)).run().changes
}

/** Sessions past their twelve hours; idle ones are refused on use and go when they reach it. */
export function pruneSessions(db: Db, now: Date): void {
  db.delete(ownerSessions).where(lte(ownerSessions.expiresAt, now.toISOString())).run()
}
