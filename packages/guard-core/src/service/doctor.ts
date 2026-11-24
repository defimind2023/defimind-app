import type { ChainAdapter, Vault } from '@defimind/onchain'
import type { Amount, ChainId, DoctorCheck } from '@defimind/shared'
import { isSvm, usdSymbol } from '@defimind/shared'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../db/client.js'
import * as repo from '../db/repo.js'
import { auditLog } from '../db/schema.js'
import { formatDollars, parseAmount } from '../domain/amount.js'
import { chainName } from '../domain/chains.js'
import { BACKUP_NAME, backupsDir, UPLOADED } from './backup.js'
import type { Wallets } from './wallets.js'

const BACKUP_MAX_AGE_MS = 26 * 3_600_000
const READ_TIMEOUT_MS = 5_000

export interface DoctorDeps {
  db: Db
  chains: ReadonlyMap<ChainId, ChainAdapter>
  usdc: ReadonlyMap<ChainId, string>
  fetch: typeof fetch
  now: () => Date
  /** Unset when there is no Telegram bot (CR-017): nothing to check then. */
  botUrl?: string | undefined
  databaseUrl: string
  passkeyAbove?: Amount | undefined
  /** A one-click host with no admin routes (CR-019): its owner may have no shell to run a script. */
  hosted?: boolean
  /** ALLOW_PUBLIC_ADMIN let the admin routes face every interface (CR-022). */
  publicAdmin?: boolean
  /** A bucket is set for the backups: the check names the last upload. */
  bucket?: boolean
  wallets?: Wallets | undefined
}

/**
 * What an owner without a terminal needs to know is working. Every message is plain English and
 * names no URL, key or token: the answer is shown in Telegram, which is not a safe place for them.
 */
export async function doctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const own = (await deps.wallets?.all().catch(() => [])) ?? []
  const chains = await Promise.all([
    ...[...deps.chains.values()].map((adapter) => chainChecks(deps, adapter)),
    ...own.map(({ adapter, agentId }) => chainChecks(deps, adapter, agentId)),
  ])
  return [
    database(deps),
    ...chains.flat(),
    ...passkeyChecks(deps),
    ...(deps.botUrl === undefined ? [] : [await bot(deps.botUrl, deps.fetch)]),
    ...(deps.publicAdmin === true ? [PUBLIC_ADMIN] : []),
    await backup(deps),
  ]
}

class Rollback extends Error {}

function database({ db, now }: { db: Db; now: () => Date }): DoctorCheck {
  try {
    // A real write, undone: the check must not leave a trace in the log it is checking.
    db.transaction((tx) => {
      tx.insert(auditLog).values({ at: now().toISOString(), event: 'doctor_write_check' }).run()
      throw new Rollback()
    })
  } catch (error) {
    if (error instanceof Rollback) {
      return { id: 'database', status: 'ok', message: 'The database accepts writes.' }
    }
  }
  return {
    id: 'database',
    status: 'fail',
    message: 'The database refuses writes, so no payment can be recorded or made.',
    fix: 'Check that the volume holding the database is mounted, writable and not full.',
  }
}

/** The shared hot wallet's checks, or with `agentId` those of that agent's own (CR-022). */
async function chainChecks(
  deps: DoctorDeps,
  adapter: ChainAdapter,
  agentId?: string,
): Promise<DoctorCheck[]> {
  const id = adapter.chain
  const chain = chainName(id)
  const wallet = agentId === undefined ? 'the hot wallet' : `${agentId}'s own wallet`
  const Wallet = agentId === undefined ? 'The hot wallet' : wallet
  const prefix = agentId === undefined ? id : `${id}:${agentId}`
  const attempt = (check: string, read: () => Promise<Omit<DoctorCheck, 'id'> | undefined>) =>
    within(`${prefix}:${check}`, chain, read)
  // Side by side, so a chain whose RPC hangs costs one timeout, not four.
  const checks = await Promise.all([
    attempt('allowance', async () => {
      const allowance = await adapter.getAllowanceState()
      return allowance.status === 'active'
        ? { status: 'ok', message: `The onchain daily limit of ${wallet} on ${chain} is in place.` }
        : {
            status: 'warn',
            message: `There is no onchain limit on ${chain}, so ${wallet} can draw nothing.`,
            fix: 'If this follows a kill, set the limit up again before paying on this chain.',
          }
    }),
    attempt('gas', async () => {
      const gas = await adapter.getHotWalletGas()
      return parseAmount(gas.balance) < parseAmount(gas.minimum)
        ? {
            status: 'warn',
            message: `${Wallet} on ${chain} is low on ${gas.symbol} for fees.`,
            fix: `Send some ${gas.symbol} to the address of ${wallet}.`,
          }
        : { status: 'ok', message: `${Wallet} on ${chain} has enough ${gas.symbol} for fees.` }
    }),
    attempt('balance', async () => {
      const token = deps.usdc.get(id)
      const symbol = usdSymbol(id)
      if (token === undefined || symbol === undefined) {
        return { status: 'warn', message: `No dollar token is configured for ${chain}.` }
      }
      const balance = formatDollars(await adapter.getHotWalletBalance(token))
      return { status: 'ok', message: `${Wallet} on ${chain} holds ${balance} ${symbol}.` }
    }),
    // The vault is the same for every wallet on a chain: said once, with the shared wallet.
    ...(agentId === undefined
      ? [
          attempt('control', async () =>
            vaultControl(id, chain, (await adapter.getVault()).control),
          ),
        ]
      : []),
  ])
  return checks.filter((check) => check !== undefined)
}

/**
 * A vault one key can empty is only as safe as that key (CR-022). On Solana the key is the
 * multisig's config authority, which can add itself a spending limit whatever the threshold says,
 * so raising the threshold would not help there: only keeping that key on a hardware wallet does.
 */
function vaultControl(
  id: ChainId,
  chain: string,
  control: Vault['control'],
): Omit<DoctorCheck, 'id'> | undefined {
  if (control === undefined) {
    return undefined
  }
  if (control.threshold > 1) {
    return {
      status: 'ok',
      message: `The vault on ${chain} needs ${control.threshold} of ${control.signers} keys to move funds.`,
    }
  }
  return isSvm(id)
    ? {
        status: 'warn',
        message: `One key, the multisig's config authority, can empty the vault on ${chain}.`,
        fix: 'Keep the config authority on a hardware wallet, such as a Ledger connected through Phantom.',
      }
    : {
        status: 'warn',
        message: `One key can empty the vault on ${chain}.`,
        fix: 'Add another owner to the Safe, or make it a 2-of-3, so no single key can move its funds.',
      }
}

/** A check whose read throws fails, and says which read, never the error text: it may hold a URL. */
async function within(
  id: string,
  chain: string,
  check: () => Promise<Omit<DoctorCheck, 'id'> | undefined>,
): Promise<DoctorCheck | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT_MS)
  })
  try {
    // A hung RPC must not hang the whole report: the owner is waiting on it in Telegram.
    const result = await Promise.race([check(), timeout])
    return result === undefined ? undefined : { id, ...result }
  } catch {
    return {
      id,
      status: 'fail',
      message: `guard-core could not read this from ${chain}.`,
      fix: 'Check that the RPC URL for this chain is set and reachable.',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * An agent whose approval threshold is above PASSKEY_ABOVE never asks for a passkey on the
 * amounts between the two: those pay without the owner at all.
 */
function passkeyChecks(deps: DoctorDeps): DoctorCheck[] {
  const above = deps.passkeyAbove
  if (above === undefined) {
    return []
  }
  return repo.agentIds(deps.db).flatMap((agentId): DoctorCheck[] => {
    const threshold = repo.getPolicy(deps.db, agentId)?.approvalThreshold
    return threshold !== undefined && parseAmount(above) < parseAmount(threshold)
      ? [
          {
            id: `${agentId}:passkey`,
            status: 'warn',
            message: `Payments by ${agentId} below its approval threshold skip the owner, even those above the passkey amount.`,
            fix: `Lower ${agentId}'s approval threshold to the passkey amount or below.`,
          },
        ]
      : []
  })
}

async function bot(url: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(`${url}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (response.ok) {
      return { id: 'bot', status: 'ok', message: 'The Telegram bot answers.' }
    }
  } catch {
    // Reported below, the same as a bad status.
  }
  return {
    id: 'bot',
    status: 'fail',
    message: 'The Telegram bot does not answer, so approvals and alerts cannot reach the owner.',
    fix: 'Check that the bot is running and that BOT_URL points at it.',
  }
}

const PUBLIC_ADMIN: DoctorCheck = {
  id: 'public_admin',
  status: 'warn',
  message:
    'The admin routes answer on every interface, so anyone who reaches this address can try the admin token.',
  fix: 'Split the listeners with PUBLIC_PORT, keep HOST on loopback, or set ADMIN_ROUTES=false.',
}

async function backup(deps: DoctorDeps): Promise<DoctorCheck> {
  const none: DoctorCheck = {
    id: 'backup',
    status: 'warn',
    message: 'No database backup was found.',
    fix: deps.hosted
      ? "Check that the data disk is mounted and writable, or turn on your host's disk snapshots."
      : 'Check that the data volume is writable, or run the database backup by hand.',
  }
  const dir = backupsDir(deps.databaseUrl)
  const names = dir === undefined ? [] : await readdir(dir).catch(() => [])
  const backups = names.filter((name) => BACKUP_NAME.test(name))
  if (dir === undefined || backups.length === 0) {
    return none
  }
  const age = async (name: string) => deps.now().getTime() - (await stat(join(dir, name))).mtimeMs
  const newest = Math.min(...(await Promise.all(backups.map(age))))
  const uploaded = deps.bucket
    ? await readFile(join(dir, UPLOADED), 'utf8').catch(() => undefined)
    : undefined
  const upload = !deps.bucket
    ? ''
    : uploaded === undefined
      ? ' None has been uploaded to the bucket yet.'
      : ` The last upload to the bucket was at ${uploaded}.`
  const stale = newest > BACKUP_MAX_AGE_MS
  return {
    id: 'backup',
    status: stale || (deps.bucket === true && uploaded === undefined) ? 'warn' : 'ok',
    message: `${stale ? 'The newest database backup is more than 26 hours old.' : 'A database backup from the last 26 hours exists.'}${upload}`,
    ...(stale ? { fix: 'Check the log for "database backup failed".' } : {}),
  }
}
