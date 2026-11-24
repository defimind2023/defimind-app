import { eq } from 'drizzle-orm'
import type { Db } from './client.js'
import { intents } from './schema.js'

/** Whether any payment has run in shadow mode: the owner has watched an agent before it pays. */
export function anyShadowed(db: Db): boolean {
  return (
    db.select({ id: intents.id }).from(intents).where(eq(intents.status, 'shadowed')).get() !==
    undefined
  )
}
