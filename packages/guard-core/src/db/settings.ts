import type { ChainId } from '@defimind/shared'
import type { ChainSetting } from '../domain/settings.js'
import type { Db } from './client.js'
import { chainSettings } from './schema.js'

export function readSettings(db: Db): ChainSetting[] {
  return db
    .select()
    .from(chainSettings)
    .all()
    .map((row) => ({
      chain: row.chain as ChainId,
      ...(row.rpcUrl === null ? {} : { rpcUrl: row.rpcUrl }),
      ...(row.vault === null ? {} : { vault: row.vault }),
    }))
}

export function writeSettings(db: Db, settings: ChainSetting[], now: Date) {
  const updatedAt = now.toISOString()
  db.transaction((tx) => {
    for (const { chain, rpcUrl = null, vault = null } of settings) {
      tx.insert(chainSettings)
        .values({ chain, rpcUrl, vault, updatedAt })
        .onConflictDoUpdate({ target: chainSettings.chain, set: { rpcUrl, vault, updatedAt } })
        .run()
    }
  })
}
