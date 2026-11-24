import type { ChainAdapter } from '@defimind/onchain'
import type { AllowanceState, ChainId } from '@defimind/shared'
import { describe, expect, it, vi } from 'vitest'
import { StubChain } from '../src/adapters/stub.js'
import { loadConfig, type Config } from '../src/config.js'
import { schema } from '../src/db/client.js'
import { applySettings } from '../src/domain/settings.js'
import { ADMIN_TOKEN, CHAIN, harness } from './harness.js'
import { signedIn } from './owner.js'

const OURS = 'Squads1111111111111111111111111111111111111'
const THEIRS = 'Theirs111111111111111111111111111111111111'
const RPC = 'https://rpc.example/?api-key=secret'

class Vault extends StubChain {
  constructor(private readonly state: AllowanceState['status']) {
    super(CHAIN, 0n)
  }
  override async getAllowanceState(): Promise<AllowanceState> {
    return this.state === 'active'
      ? { status: 'active', cap: '50000000', spent: '0', resetsAt: '', delegate: 'hot' }
      : { status: 'none', delegate: 'hot' }
  }
}

/** A chain build like buildChains: an adapter only once the vault is set, ours or not by address. */
const build = vi.fn(async (config: Config) => {
  const chains = new Map<ChainId, ChainAdapter>()
  if (config.SQUADS_MULTISIG !== undefined) {
    if (config.SOLANA_RPC_URL === undefined) {
      throw new Error('invalid configuration: SOLANA_RPC_URL')
    }
    chains.set(CHAIN, new Vault(config.SQUADS_MULTISIG === OURS ? 'active' : 'none'))
  }
  return chains
})

async function owner(env: Record<string, string> = {}) {
  const h = await harness({ build, env })
  return { h, ...(await signedIn(h)) }
}

const put = async (o: Awaited<ReturnType<typeof owner>>, chains: object[]) =>
  o.call('PUT', '/v1/owner/settings', {
    chains,
    assertion: await o.stepUp('change_settings', { chains }),
  })

describe('the owner settings (CR-019)', () => {
  it('lists every enabled chain, with nothing stored yet', async () => {
    const o = await owner()
    expect((await o.call('GET', '/v1/owner/settings')).json()).toEqual({
      chains: [{ chain: CHAIN }],
    })
  })

  it('adopts a vault whose limit names this hot wallet, and answers as GET does', async () => {
    const o = await owner()
    const res = await put(o, [{ chain: CHAIN, rpcUrl: RPC, vault: OURS }])
    expect(res.statusCode).toBe(200)
    const settings = { chains: [{ chain: CHAIN, rpcUrl: RPC, vault: OURS }] }
    expect(res.json()).toEqual(settings)
    expect((await o.call('GET', '/v1/owner/settings')).json()).toEqual(settings)
    expect(build).toHaveBeenLastCalledWith(
      expect.objectContaining({ SQUADS_MULTISIG: OURS, SOLANA_RPC_URL: RPC }),
    )
    const audit = o.h.db.select().from(schema.auditLog).all()
    const changed = audit.find((row) => row.event === 'settings_changed')
    expect(changed).toBeDefined()
    expect(JSON.stringify(audit)).not.toContain('secret')
  })

  it('swaps the new chain in for the next request', async () => {
    const o = await owner()
    await put(o, [{ chain: CHAIN, rpcUrl: RPC, vault: OURS }])
    const overview = (await o.call('GET', '/v1/owner/overview')).json()
    expect(overview.chains).toEqual([
      { chain: CHAIN, allowance: expect.objectContaining({ status: 'active', cap: '50000000' }) },
    ])
  })

  it('refuses a vault this hot wallet cannot draw on, and stores nothing', async () => {
    const o = await owner()
    const res = await put(o, [{ chain: CHAIN, rpcUrl: RPC, vault: THEIRS }])
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'vault_not_ours' })
    expect((await o.call('GET', '/v1/owner/settings')).json()).toEqual({
      chains: [{ chain: CHAIN }],
    })
  })

  it('refuses a vault with no RPC to read it on', async () => {
    const o = await owner()
    const res = await put(o, [{ chain: CHAIN, vault: OURS }])
    expect(res.json()).toEqual({ error: 'settings_incomplete' })
  })

  it('needs a passkey over that exact change', async () => {
    const o = await owner()
    const chains = [{ chain: CHAIN, rpcUrl: RPC, vault: OURS }]
    const none = await o.call('PUT', '/v1/owner/settings', { chains })
    expect(none.json()).toEqual({ error: 'step_up_required' })
    const other = await o.stepUp('change_settings', { chains: [{ chain: CHAIN, vault: OURS }] })
    const res = await o.call('PUT', '/v1/owner/settings', { chains, assertion: other })
    expect(res.statusCode).toBe(401)
  })

  it.each([
    [[{ chain: 'eip155:8453', vault: OURS }], 400, 'chain_not_enabled'],
    [[{ chain: CHAIN, vault: '0x0000000000000000000000000000000000000001' }], 400, 'invalid_vault'],
  ])('refuses %j', async (chains, status, error) => {
    const o = await owner()
    const res = await put(o, chains)
    expect(res.statusCode).toBe(status)
    expect(res.json()).toEqual({ error })
  })

  it('answers an RPC from the env as its origin only, never its key', async () => {
    const o = await owner({
      SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=operator-key',
    })
    const res = await o.call('GET', '/v1/owner/settings')
    expect(res.json()).toEqual({
      chains: [{ chain: CHAIN, rpcUrl: 'https://mainnet.helius-rpc.com' }],
    })
    expect(res.body).not.toContain('operator-key')
  })

  it('leaves what the env sets to the env', async () => {
    const o = await owner({ SOLANA_RPC_URL: 'https://env.example' })
    const res = await put(o, [{ chain: CHAIN, rpcUrl: RPC }])
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'set_by_env' })
    expect((await o.call('GET', '/v1/owner/settings')).json()).toEqual({
      chains: [{ chain: CHAIN, rpcUrl: 'https://env.example' }],
    })
  })

  it('needs a session', async () => {
    const h = await harness({ build })
    expect((await h.app.inject({ method: 'GET', url: '/v1/owner/settings' })).statusCode).toBe(401)
  })
})

describe('applySettings', () => {
  it('fills in only what the env leaves unset', () => {
    const env = loadConfig({ ADMIN_TOKEN, SOLANA_RPC_URL: 'https://env.example' })
    const config = applySettings(env, [{ chain: env.SOLANA_CHAIN, rpcUrl: RPC, vault: OURS }])
    expect(config.SOLANA_RPC_URL).toBe('https://env.example')
    expect(config.SQUADS_MULTISIG).toBe(OURS)
  })

  it('ignores a chain that is not enabled', () => {
    const env = loadConfig({ ADMIN_TOKEN })
    const config = applySettings(env, [{ chain: 'eip155:84532', vault: OURS }])
    expect(config.SAFE_ADDRESS).toBeUndefined()
  })
})
