import { createSvmAnchor } from '@defimind/onchain'
import { bucketConfig } from './adapters/bucket.js'
import { readKeypairFile, readReceiptKeyFile } from './adapters/keypair.js'
import { keysDir, withKeys } from './adapters/keystore.js'
import { publicKeys } from './adapters/public-keys.js'
import { readVapidKeyFile, webPushService } from './adapters/push.js'
import { agentKeys } from './adapters/agent-keys.js'
import { buildAgentChain, buildChains } from './chains.js'
import { listenerLayout, loadConfig, publicAdmin } from './config.js'
import { migrateDb, openDb } from './db/client.js'
import { countPasskeys } from './db/passkeys.js'
import { requirePersistentDb } from './db/placement.js'
import { buildServers } from './http/server.js'
import type { ChainHost } from './http/owner-settings.js'
import { readSettings } from './db/settings.js'
import { applySettings, settingKeys } from './domain/settings.js'
import { killTargets } from './kill-targets.js'
import { Wallets } from './service/wallets.js'

const env = loadConfig()

requirePersistentDb(env)

const db = openDb(env.DATABASE_URL)
migrateDb(db)

const stored = readSettings(db)
const config = await withKeys(env, stored)

// Approvals above PASSKEY_ABOVE need a passkey; with none enrolled, nothing above it could ever be
// approved, and the owner would find out only when one was needed.
if (config.PASSKEY_ABOVE !== undefined && countPasskeys(db) === 0) {
  throw new Error('invalid configuration: PASSKEY_ABOVE is set but no passkey is enrolled')
}

// A setting the owner stored in the panel fills in only what the env leaves unset (CR-019).
const effective = applySettings(config, stored)
const chains = await buildChains(effective)
const receiptKey =
  config.RECEIPT_SIGNING_KEY_FILE === undefined
    ? undefined
    : await readReceiptKeyFile(config.RECEIPT_SIGNING_KEY_FILE)

const vapidSubject = config.VAPID_SUBJECT ?? config.PUBLIC_URL
const vapid =
  config.VAPID_PRIVATE_KEY_FILE === undefined || vapidSubject === undefined
    ? undefined
    : await readVapidKeyFile(config.VAPID_PRIVATE_KEY_FILE, vapidSubject)

// The anchor key is its own keypair: one that holds fees only, so a leak of it moves no funds.
const anchorPublisher =
  config.ANCHOR_CHAIN === undefined ||
  config.ANCHOR_RPC_URL === undefined ||
  config.ANCHOR_KEY_FILE === undefined
    ? undefined
    : createSvmAnchor({
        chain: config.ANCHOR_CHAIN,
        rpcUrl: config.ANCHOR_RPC_URL,
        secretKey: await readKeypairFile(config.ANCHOR_KEY_FILE),
      })

const targets = config.SIGN_PAGE_URL === undefined ? [] : await killTargets(effective)
const host: ChainHost = {
  env: config,
  build: (next) => buildChains(next),
  // In place: the owner kill route holds this array.
  changed: async (next) => {
    if (config.SIGN_PAGE_URL !== undefined) {
      targets.splice(0, targets.length, ...(await killTargets(next)))
    }
  },
}

// CR-022. Built against the settings as they are when a wallet is made, since the vault may be
// adopted after the start.
const wallets = new Wallets(
  db,
  agentKeys(keysDir(config), (chain, file) =>
    buildAgentChain(applySettings(config, readSettings(db)), chain, file),
  ),
)
await wallets.load()

const keys = await publicKeys(config)
const split = config.PUBLIC_PORT !== undefined
const [app, publicApp] = await buildServers(
  {
    db,
    config,
    chains,
    sweepMs: config.EXPIRY_SWEEP_MS,
    killTargets: targets,
    keys,
    host,
    wallets,
    backups: {
      databaseUrl: config.DATABASE_URL,
      hour: config.BACKUP_HOUR_UTC,
      bucket: bucketConfig(config),
    },
    ...(anchorPublisher === undefined ? {} : { anchorPublisher }),
    ...(vapid === undefined
      ? {}
      : { push: { service: webPushService(vapid), publicKey: vapid.publicKey } }),
    ...(receiptKey === undefined ? {} : { receiptKey }),
  },
  split ? (['private', 'public'] as const) : (['all'] as const),
)

if (config.GUARD_STUB_CHAINS === 'true') {
  app.log.warn('stub chains: nothing is signed and no money moves')
} else if (chains.size === 0) {
  // With no adapter the policy has no chain to clear a payment on, so every payment is refused:
  // default deny, not a degraded mode. A guided deployment starts here, with every chain waiting
  // for the owner to adopt a vault, which the line below says; anything else is a misconfiguration.
  const waiting = keys.hotWallets.length > 0
  app.log[waiting ? 'info' : 'warn']('no chain adapter configured: every payment will be refused')
}
for (const { chain } of keys.hotWallets) {
  const rpc = settingKeys(effective).find((k) => k.chain === chain)?.rpcUrl
  if (chains.has(chain) && rpc !== undefined && effective[rpc] === undefined) {
    app.log.info(
      { chain },
      'using the public RPC, which is rate-limited: set your own in the panel',
    )
  }
  if (!chains.has(chain)) {
    app.log.info({ chain }, 'no vault yet: the chain waits for the owner to adopt one in the panel')
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all([app.close(), publicApp?.close()])
  })
}

app.log.info({ listeners: listenerLayout(config) }, 'listener layout')
if (config.ADMIN_ROUTES === 'true' && config.SETUP_CODE === undefined && countPasskeys(db) === 0) {
  app.log.warn(
    'no passkey yet and no SETUP_CODE: whoever holds the admin token can enrol the first passkey',
  )
}
if (publicAdmin(config)) {
  app.log.warn(
    'ALLOW_PUBLIC_ADMIN: the admin routes face every interface; anyone who reaches this address ' +
      'and holds the admin token can pause, kill and read every agent',
  )
}

await app.listen({ port: config.PORT, host: config.HOST })
if (publicApp !== undefined) {
  await publicApp.listen({ port: config.PUBLIC_PORT, host: config.PUBLIC_HOST })
}
