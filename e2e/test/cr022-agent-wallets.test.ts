import { createAgent, StubChain } from '@defimind/guard-core'
import { httpGuard } from '@defimind/mcp-server'
import type { AllowanceState, OwnerTransaction } from '@defimind/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WalletKeys } from '../../packages/guard-core/src/service/wallets.js'
import { MERCHANT, SOLANA } from './support/paid-api.js'
import { owner } from './support/owner.js'
import { stack, type Stack } from './support/stack.js'

/**
 * CR-022 HIGH-2, end to end: the owner gives an agent its own spending wallet in the panel, with the
 * passkey; once its onchain limit reads, the agent pays from it alone, and stopping that agent
 * removes only its own limit. Each own wallet is a stub chain whose limit the test "signs".
 */

let s: Stack
let panel: Awaited<ReturnType<typeof owner>>
const own = new Map<string, StubChain>()
const signed = { limit: false }

const keys: WalletKeys = {
  ensure: async (agentId) => ({ file: `/keys/${agentId}`, address: `own-${agentId}` }),
  build: async (chain, file) => {
    const stub = new StubChain(chain, 50_000_000n)
    stub.getAllowanceState = async (): Promise<AllowanceState> =>
      signed.limit
        ? { status: 'active', cap: '5000000', spent: '0', resetsAt: '', delegate: file }
        : { status: 'none', delegate: file }
    own.set(file, stub)
    return stub
  },
}

const wallet = () => own.get('/keys/agent-1')!

const pay = () =>
  s.tool('transfer', { to: MERCHANT, amountUsd: '1', reason: 'e2e: pay the invoice' })

beforeEach(async () => {
  own.clear()
  signed.limit = false
  s = await stack({ panel: true, walletKeys: keys })
  s.setPolicy({ allowedRecipients: [MERCHANT] })
  panel = await owner(s)
})

afterEach(async () => {
  await s.close()
})

async function giveOwnWallet() {
  const body = { agentId: 'agent-1', chain: SOLANA.chain }
  const assertion = await panel.stepUp('agent_wallet', body)
  return panel.call('/v1/owner/agents/agent-1/wallets', { chain: SOLANA.chain, assertion })
}

describe('an agent with its own wallet (CR-022 HIGH-2)', () => {
  it('needs the passkey to be given one', async () => {
    const bare = await panel.call('/v1/owner/agents/agent-1/wallets', { chain: SOLANA.chain })
    expect(bare.body).toEqual({ error: 'step_up_required' })
    expect(own.size).toBe(0)
  })

  it('keeps paying from the shared wallet until its own limit reads onchain', async () => {
    const created = await giveOwnWallet()
    expect(created.body).toMatchObject({ status: 'pending_limit', address: 'own-agent-1' })
    expect(await pay()).toContain(': executed.')
    expect(s.chain.sent).toHaveLength(1)
    expect(wallet().sent).toHaveLength(0)
  })

  it('then pays from its own wallet alone', async () => {
    await giveOwnWallet()
    signed.limit = true
    const listed = await panel.call('/v1/owner/agents/agent-1/wallets', {}, 'GET')
    expect(listed.body).toMatchObject({ wallets: [{ status: 'active' }] })

    expect(await pay()).toContain(': executed.')
    expect(wallet().sent).toHaveLength(1)
    expect(s.chain.sent).toHaveLength(0)
  })

  it("stops that agent and returns only its own wallet's kill", async () => {
    await giveOwnWallet()
    signed.limit = true
    await panel.call('/v1/owner/agents/agent-1/wallets', {}, 'GET')

    const killed = await panel.call('/v1/owner/agents/agent-1/kill')
    const txs = killed.body['ownerTransactions'] as OwnerTransaction[]
    expect(txs).toHaveLength(1)
    expect(txs[0]?.description).toMatch(/^agent-1's own wallet: /)
    expect(await pay()).toContain(': rejected.')

    const all = await panel.call('/v1/owner/kill')
    const every = all.body['ownerTransactions'] as OwnerTransaction[]
    expect(every.map((tx) => tx.description.startsWith("agent-1's own wallet"))).toEqual([
      false,
      true,
    ])
  })
  it("keeps another agent off that wallet, even with the first agent's id", async () => {
    await giveOwnWallet()
    signed.limit = true
    await panel.call('/v1/owner/agents/agent-1/wallets', {}, 'GET')
    const token = createAgent(s.db, 'agent-2')
    s.setPolicy({ allowedRecipients: [MERCHANT] }, 'agent-2')
    const as = (agentId: string) => httpGuard({ baseUrl: s.guardUrl, agentId, token })
    const invoice = {
      chain: SOLANA.chain,
      token: SOLANA.token,
      amount: '1000000',
      recipient: MERCHANT,
      reason: 'e2e: pay the invoice',
    }

    await expect(as('agent-1').transfer(invoice)).rejects.toThrow(/did not accept this agent/)
    expect(await as('agent-2').transfer(invoice)).toMatchObject({ status: 'executed' })
    expect(s.chain.sent).toHaveLength(1)
    expect(wallet().sent).toHaveLength(0)
  })
})
