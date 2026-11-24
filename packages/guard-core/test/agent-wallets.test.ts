import type { AllowanceState } from '@defimind/shared'
import { describe, expect, it, vi } from 'vitest'
import { StubChain } from '../src/adapters/stub.js'
import type { WalletKeys } from '../src/service/wallets.js'
import { CHAIN, harness, MERCHANT, MINT, type Harness } from './harness.js'
import { signedIn } from './owner.js'

const OWN = 'own-agent-1'
const PAGE = 'https://sign.example'

/** An own wallet's chain, whose limit reads as missing until the test signs it. */
function fakeKeys() {
  const own = new Map<string, StubChain>()
  const signed = { limit: false }
  const keys: WalletKeys = {
    ensure: async (agentId) => ({ file: `/keys/${agentId}`, address: `own-${agentId}` }),
    build: async (chain, file) => {
      const stub = new StubChain(chain, 50_000_000n)
      vi.spyOn(stub, 'getAllowanceState').mockImplementation(async (): Promise<AllowanceState> =>
        signed.limit
          ? { status: 'active', cap: '5000000', spent: '0', resetsAt: '', delegate: file }
          : { status: 'none', delegate: file },
      )
      own.set(file, stub)
      return stub
    },
  }
  return { keys, own, signed }
}

async function setup(options: Parameters<typeof harness>[0] = {}) {
  const fake = fakeKeys()
  const h = await harness({ walletKeys: fake.keys, build: async () => new Map(), ...options })
  const owner = await signedIn(h)
  const create = async (chain: string = CHAIN) =>
    owner.call('POST', '/v1/owner/agents/agent-1/wallets', {
      chain,
      assertion: await owner.stepUp('agent_wallet', { agentId: 'agent-1', chain }),
    })
  return { h, owner, create, ...fake }
}

const pay = (h: Harness) =>
  h.agent('POST', '/v1/agent/transfer', {
    agentId: 'agent-1',
    chain: CHAIN,
    token: MINT,
    amount: '1000000',
    recipient: MERCHANT,
    reason: 'pay the invoice',
  })

describe('an agent with its own wallet (CR-022)', () => {
  it('needs a passkey over the agent and the chain', async () => {
    const { owner } = await setup()
    const bare = await owner.call('POST', '/v1/owner/agents/agent-1/wallets', { chain: CHAIN })
    expect(bare.statusCode).toBe(403)
    expect(bare.json().error).toBe('step_up_required')
    const other = await owner.call('POST', '/v1/owner/agents/agent-1/wallets', {
      chain: CHAIN,
      assertion: await owner.stepUp('agent_wallet', { agentId: 'agent-2', chain: CHAIN }),
    })
    expect(other.statusCode).toBe(401)
  })

  it('is made pending, with its add-limit page, and a second call returns the same wallet', async () => {
    const { h, create } = await setup()
    const first = await create()
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      chain: CHAIN,
      address: OWN,
      status: 'pending_limit',
      gas: { balance: '0', minimum: '0', symbol: 'TEST' },
    })
    const page = new URL(first.json().addLimitPage)
    expect(page.pathname).toBe('/sign/')
    expect(page.searchParams.get('action')).toBe('add-limit')
    expect(page.searchParams.get('hot')).toBe(OWN)
    expect((await create()).json().address).toBe(OWN)
    expect(h.auditEvents().filter((e) => e === 'agent_wallet_created')).toHaveLength(2)
  })

  it('refuses a chain with no vault, and an unknown agent', async () => {
    const { owner, create } = await setup()
    expect((await create('eip155:84532')).json().error).toBe('no_vault')
    const res = await owner.call('GET', '/v1/owner/agents/nobody/wallets')
    expect(res.statusCode).toBe(404)
  })

  it('keeps paying from the shared wallet until its limit reads onchain, then only from its own', async () => {
    const { h, owner, create, own, signed } = await setup()
    await create()
    await pay(h)
    expect(h.chain.sent).toHaveLength(1)

    signed.limit = true
    const listed = (await owner.call('GET', '/v1/owner/agents/agent-1/wallets')).json()
    expect(listed.wallets).toMatchObject([{ address: OWN, status: 'active' }])
    expect((await pay(h)).json().status).toBe('executed')
    expect(h.chain.sent).toHaveLength(1)
    expect(own.get('/keys/agent-1')?.sent).toHaveLength(1)

    const budget = (await owner.call('GET', '/v1/owner/budget/agent-1')).json()
    expect(budget.hotWalletBalances[CHAIN]).toBe('49000000')
  })

  it('is listed with the agent and among the public keys', async () => {
    const { owner, create } = await setup({ keys: { hotWallets: [] } })
    await create()
    const agents = (await owner.call('GET', '/v1/owner/agents')).json().agents
    expect(agents[0]).toMatchObject({
      agentId: 'agent-1',
      wallets: [{ chain: CHAIN, address: OWN, status: 'pending_limit' }],
    })
    const keys = (await owner.call('GET', '/v1/owner/keys')).json()
    expect(keys.agentWallets).toEqual([{ agentId: 'agent-1', chain: CHAIN, address: OWN }])
  })

  it('gets its own doctor lines', async () => {
    const { owner, create } = await setup()
    await create()
    const checks = (await owner.call('GET', '/v1/owner/doctor')).json().checks
    expect(checks.find((c: { id: string }) => c.id === `${CHAIN}:agent-1:allowance`)).toMatchObject(
      { status: 'warn', message: expect.stringContaining("agent-1's own wallet") },
    )
    expect(checks.some((c: { id: string }) => c.id === `${CHAIN}:agent-1:control`)).toBe(false)
  })
})

describe('stopping agents with their own wallets (CR-022)', () => {
  const target = { chain: CHAIN, multisig: MERCHANT, hot: 'shared-hot' }

  it('the owner kill removes every limit, each link naming its own hot wallet', async () => {
    const { owner, create } = await setup({ signPage: PAGE, killTargets: [target] })
    await create()
    const killed = (await owner.call('POST', '/v1/owner/kill')).json()
    expect(killed.ownerTransactions).toHaveLength(2)
    const [shared, own] = killed.ownerTransactions
    expect(new URL(shared.pageLink).searchParams.get('hot')).toBe('shared-hot')
    expect(new URL(own.pageLink).searchParams.get('hot')).toBe(OWN)
    expect(own.description).toMatch(/^agent-1's own wallet: /)
    expect(own.wallet).toEqual({ agentId: 'agent-1', address: OWN })
    expect(shared.wallet).toBeUndefined()
  })

  it("one agent's kill pauses it alone and removes only its own wallet's limit", async () => {
    const { h, owner, create } = await setup({ signPage: PAGE, killTargets: [target] })
    await create()
    const res = (await owner.call('POST', '/v1/owner/agents/agent-1/kill')).json()
    expect(res.pausedAgents).toBe(1)
    expect(res.ownerTransactions).toHaveLength(1)
    expect(new URL(res.ownerTransactions[0].pageLink).searchParams.get('hot')).toBe(OWN)
    expect((await pay(h)).json().rejectReasons).toContain('PAUSED')
    expect(h.auditEvents()).toContain('agent_killed')
  })

  it('a revoke hands back the transactions its wallet still needs', async () => {
    const { owner, create } = await setup()
    await create()
    const res = (await owner.call('POST', '/v1/owner/agents/agent-1/revoke')).json()
    expect(res).toMatchObject({ agentId: 'agent-1', revoked: true })
    expect(res.ownerTransactions).toHaveLength(1)
    expect(res.note).toMatch(/still live/)
  })

  it('a revoke without an own wallet answers as before', async () => {
    const { owner } = await setup()
    const res = (await owner.call('POST', '/v1/owner/agents/agent-1/revoke')).json()
    expect(res).toEqual({ agentId: 'agent-1', revoked: true })
  })
})
