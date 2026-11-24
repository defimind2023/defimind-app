import type { Db } from '../db/client.js'
import { deletePasskey, listPasskeys } from '../db/passkeys.js'
import * as repo from '../db/repo.js'
import { deleteSessionsOf } from '../db/sessions.js'

export type Removal =
  | { ok: true; id: string; sessions: number }
  | { ok: false; reason: 'too_short' | 'none' | 'ambiguous'; matches: number }

/**
 * Removes the one passkey whose id starts with `wanted`, and ends every panel session it opened:
 * a lost or stolen key must not keep the owner's panel open for the rest of its twelve hours.
 */
export function removePasskey(db: Db, wanted: string, now: Date): Removal {
  // A short prefix could match more than meant; an empty one matches every passkey.
  if (wanted.length < 8) {
    return { ok: false, reason: 'too_short', matches: 0 }
  }
  const matches = listPasskeys(db).filter(({ id }) => id.startsWith(wanted))
  const [match] = matches
  if (match === undefined || matches.length > 1) {
    return {
      ok: false,
      reason: matches.length === 0 ? 'none' : 'ambiguous',
      matches: matches.length,
    }
  }
  const { id } = match
  const sessions = db.$client.transaction(() => {
    deletePasskey(db, id)
    return deleteSessionsOf(db, id)
  })()
  repo.audit(db, { event: 'passkey_removed', detail: { id: id.slice(0, 8), sessions } }, now)
  return { ok: true, id, sessions }
}
