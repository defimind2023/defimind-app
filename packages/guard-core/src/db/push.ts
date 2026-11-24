import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from './client.js'
import { pushSubscriptions } from './schema.js'

export type PushSubscription = typeof pushSubscriptions.$inferSelect

/** The same browser subscribing again keeps its id: the endpoint is what identifies it. */
export function subscribe(
  db: Db,
  sub: { endpoint: string; p256dh: string; auth: string },
  now: Date,
): string {
  const existing = db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, sub.endpoint))
    .get()
  const id = existing?.id ?? randomUUID()
  db.insert(pushSubscriptions)
    .values({ id, ...sub, createdAt: now.toISOString() })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: sub.p256dh, auth: sub.auth },
    })
    .run()
  return id
}

export function subscriptions(db: Db): PushSubscription[] {
  return db.select().from(pushSubscriptions).all()
}

export function unsubscribe(db: Db, id: string): boolean {
  return db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run().changes > 0
}
