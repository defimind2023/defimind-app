import { CHAINS, type ChainId } from '@defimind/shared'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { generatePrivateKey } from 'viem/accounts'
import type { Config } from '../config.js'
import { dbFile } from '../db/client.js'
import type { ChainSetting } from '../domain/settings.js'

type Kind = 'solana' | 'evm' | 'ed25519' | 'p256'

/** Each kind in the format its reader in keypair.ts or push.ts already takes. */
const make: Record<Kind, () => string> = {
  solana: () => JSON.stringify(solanaKeypair()),
  evm: () => generatePrivateKey(),
  ed25519: () => pem(generateKeyPairSync('ed25519').privateKey),
  p256: () => pem(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey),
}

function pem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString()
}

/** The Solana CLI layout: the 32-byte seed, then the 32-byte public key. */
function solanaKeypair(): number[] {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
  return [...seed, ...pub]
}

/** Next to the database: the one place a deployment already keeps on a persistent disk. */
export function keysDir(config: Config): string {
  const file = dbFile(config.DATABASE_URL)
  return config.KEYS_DIR ?? join(file === ':memory:' ? './data' : dirname(file), 'keys')
}

/**
 * The key file at dir/name, made once. `wx` never replaces a file that exists: a second start, or
 * two at once, keeps the first key, since a new hot wallet would no longer match its onchain limit.
 */
export async function ensureKey(dir: string, name: string, kind: Kind): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const path = join(dir, name)
  try {
    await writeFile(path, make[kind](), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
  await chmod(path, 0o600)
  return path
}

export function slug(chain: ChainId): string {
  const name = Object.entries(CHAINS).find(([, id]) => id === chain)?.[0] ?? chain
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/[^a-z0-9-]/g, '-')
}

/**
 * The config with every key file it lacks made under `dir` (CR-019). A key given by env or a file
 * always wins, so a deployment that passes its keys as secrets is unchanged.
 *
 * A hot wallet is made only for a chain with no vault in the env or `stored`, the guided setup's
 * case, where the vault is adopted later for this key. With a vault already set, its limit names
 * some key: a missing one must stop the start, not be replaced by a wallet the limit never heard of.
 */
export async function withKeys(
  config: Config,
  stored: ChainSetting[] = [],
  dir = keysDir(config),
): Promise<Config> {
  // A vault the panel adopted names a hot wallet too: one lost from disk must stop the start.
  const vault = (chain: ChainId | undefined, env: string | undefined) =>
    env ?? stored.find((s) => s.chain === chain)?.vault
  const key = (given: string | undefined, name: string, kind: Kind) =>
    given === undefined ? ensureKey(dir, name, kind) : Promise.resolve(given)
  const hot = (
    chain: ChainId | undefined,
    vault: string | undefined,
    given: string | undefined,
    kind: 'solana' | 'evm',
  ) =>
    chain === undefined || vault !== undefined || given !== undefined
      ? Promise.resolve(given)
      : ensureKey(dir, `hot-${slug(chain)}${kind === 'solana' ? '.json' : ''}`, kind)
  return {
    ...config,
    SOLANA_HOT_WALLET_KEYPAIR: await hot(
      config.SOLANA_CHAIN,
      vault(config.SOLANA_CHAIN, config.SQUADS_MULTISIG),
      config.SOLANA_HOT_WALLET_KEYPAIR,
      'solana',
    ),
    BASE_HOT_WALLET_KEY_FILE: await hot(
      config.BASE_CHAIN,
      vault(config.BASE_CHAIN, config.SAFE_ADDRESS),
      config.BASE_HOT_WALLET_KEY_FILE,
      'evm',
    ),
    ROBINHOOD_HOT_WALLET_KEY_FILE: await hot(
      config.ROBINHOOD_CHAIN,
      vault(config.ROBINHOOD_CHAIN, config.ROBINHOOD_SAFE_ADDRESS),
      config.ROBINHOOD_HOT_WALLET_KEY_FILE,
      'evm',
    ),
    RECEIPT_SIGNING_KEY_FILE: await key(config.RECEIPT_SIGNING_KEY_FILE, 'receipt.pem', 'ed25519'),
    VAPID_PRIVATE_KEY_FILE: await key(config.VAPID_PRIVATE_KEY_FILE, 'vapid.pem', 'p256'),
    ANCHOR_KEY_FILE: await key(config.ANCHOR_KEY_FILE, 'anchor.json', 'solana'),
  }
}
