import { loadConfig } from '../config.js'
import { migrateDb, openDb } from '../db/client.js'
import { countPasskeys } from '../db/passkeys.js'
import * as repo from '../db/repo.js'
import { issueEnrolCode } from '../service/passkeys.js'

// Usage: pnpm passkey-code. Prints the link that enrols the owner's first passkey in the panel.
// The code is in the fragment, which the browser never sends, so it reaches no server log.
const config = loadConfig()
if (config.PASSKEY_ORIGIN === undefined) {
  console.error('set PASSKEY_RP_ID and PASSKEY_ORIGIN first: a passkey is bound to that address')
  process.exit(1)
}
const db = openDb(config.DATABASE_URL)
migrateDb(db)
const { code, expiresAt } = issueEnrolCode(db, new Date())
repo.audit(db, { event: 'passkey_code_issued', detail: { expiresAt, via: 'script' } }, new Date())
console.log(`${config.PASSKEY_ORIGIN}/panel/enrol#code=${code}`)
console.log(`Good for one enrolment until ${expiresAt}.`)
if (countPasskeys(db) > 0) {
  console.log('A passkey is already enrolled: the new one must be vouched for with it.')
}
