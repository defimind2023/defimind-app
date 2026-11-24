import { loadConfig } from '../config.js'
import { migrateDb, openDb } from '../db/client.js'
import { listPasskeys } from '../db/passkeys.js'
import { removePasskey } from '../service/remove-passkey.js'

// Usage: pnpm remove-passkey <id or prefix>. With no argument it lists the enrolled passkeys.
// Kept off the HTTP API on purpose: removing the owner's passkey takes a shell on this machine.
const wanted = process.argv[2]
const db = openDb(loadConfig().DATABASE_URL)
migrateDb(db)
const enrolled = listPasskeys(db)

if (wanted === undefined) {
  for (const { id, createdAt, lastUsedAt } of enrolled) {
    console.log(`${id}  created ${createdAt}  last used ${lastUsedAt ?? 'never'}`)
  }
  process.exit(0)
}

const removal = removePasskey(db, wanted, new Date())
if (!removal.ok) {
  const messages = {
    too_short: 'give at least the first 8 characters of the id',
    none: `no passkey starts with ${wanted}; nothing changed`,
    ambiguous: `${removal.matches} passkeys start with ${wanted}; give more of the id`,
  }
  console.error(messages[removal.reason])
  process.exit(1)
}
console.log(`passkey ${removal.id} removed, and ${removal.sessions} panel session(s) with it`)
