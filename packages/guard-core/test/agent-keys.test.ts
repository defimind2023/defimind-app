import { CHAINS } from '@defimind/shared'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { agentKeys } from '../src/adapters/agent-keys.js'
import { StubChain } from '../src/adapters/stub.js'
import { buildAgentChain } from '../src/chains.js'
import { loadConfig } from '../src/config.js'
import { openDb, schema } from '../src/db/client.js'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { listWallets } from '../src/db/wallets.js'
import { adapterFor, Wallets, type WalletKeys } from '../src/service/wallets.js'
import { ADMIN_TOKEN, CHAIN, NOW } from './harness.js'

const fresh = () => mkdtempSync(join(tmpdir(), 'guard-agent-keys-'))
const build = async (chain: string) => new StubChain(chain)

describe("an agent's own key on disk (CR-022)", () => {
  it('is made once, 0600, under agents/<agentId>, and only its address comes back', async () => {
    const dir = fresh()
    const keys = agentKeys(dir, build, {})
    const first = await keys.ensure('fly-agent', CHAINS.solanaDevnet)
    expect(first.file).toBe(join(dir, 'agents', 'fly-agent', 'solana-devnet.json'))
    expect(statSync(first.file).mode & 0o777).toBe(0o600)
    expect(first.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    expect(await keys.ensure('fly-agent', CHAINS.solanaDevnet)).toEqual(first)

    const evm = await keys.ensure('fly-agent', CHAINS.robinhoodTestnet)
    expect(evm.file).toBe(join(dir, 'agents', 'fly-agent', 'robinhood-testnet'))
    expect(evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('takes the file AGENT_WALLET_<AGENT>_<CHAIN>_FILE names', async () => {
    const file = join(fresh(), 'given')
    const key = generatePrivateKey()
    writeFileSync(file, key)
    const env = { AGENT_WALLET_FLY_AGENT_ROBINHOOD_TESTNET_FILE: file }
    const own = await agentKeys(fresh(), build, env).ensure('fly-agent', CHAINS.robinhoodTestnet)
    expect(own).toEqual({ file, address: privateKeyToAddress(key) })
  })

  it('never lets an agent id climb out of the keys folder', async () => {
    const dir = fresh()
    const { file } = await agentKeys(dir, build, {}).ensure('../../etc', CHAINS.solanaDevnet)
    expect(file.startsWith(join(dir, 'agents', 'id-'))).toBe(true)
  })
})

describe('routing to an own wallet', () => {
  function setup(keys: WalletKeys) {
    const db = openDb(':memory:')
    migrate(db, { migrationsFolder: 'migrations' })
    db.insert(schema.agents)
      .values({ id: 'agent-1', name: 'agent-1', tokenHash: 'h', createdAt: NOW.toISOString() })
      .run()
    return { db, wallets: new Wallets(db, keys) }
  }

  it('refuses to start on a key that no longer matches the stored address', async () => {
    const { db, wallets } = setup({ ensure: async () => ({ file: 'f', address: 'new' }), build })
    db.insert(schema.agentWallets)
      .values({ agentId: 'agent-1', chain: CHAIN, address: 'old', status: 'active', createdAt: '' })
      .run()
    await expect(wallets.load()).rejects.toThrow('agent wallet key changed')
  })

  it('refuses, rather than fall back to the shared wallet, when an active wallet has no adapter', async () => {
    const { db, wallets } = setup({ ensure: async () => ({ file: 'f', address: 'a' }), build })
    db.insert(schema.agentWallets)
      .values({ agentId: 'agent-1', chain: CHAIN, address: 'a', status: 'active', createdAt: '' })
      .run()
    const chains = new Map([[CHAIN, new StubChain(CHAIN)]])
    expect(adapterFor({ chains, wallets }, 'agent-1', CHAIN)).toBeUndefined()
    expect(adapterFor({ chains, wallets }, 'agent-2', CHAIN)).toBe(chains.get(CHAIN))
  })

  it('stays pending when its limit cannot be read', async () => {
    const chain = new StubChain(CHAIN)
    vi.spyOn(chain, 'getAllowanceState').mockRejectedValue(new Error('rpc down'))
    const { db, wallets } = setup({
      ensure: async () => ({ file: 'f', address: 'a' }),
      build: async () => chain,
    })
    await wallets.create('agent-1', CHAIN, NOW)
    expect((await wallets.refresh('agent-1'))[0]?.status).toBe('pending_limit')
    expect(listWallets(db)[0]?.status).toBe('pending_limit')
  })
})

describe('buildAgentChain', () => {
  it('needs the chain to have its vault', async () => {
    const config = loadConfig({ ADMIN_TOKEN })
    await expect(buildAgentChain(config, CHAIN, 'f')).rejects.toThrow('no vault')
  })
})
