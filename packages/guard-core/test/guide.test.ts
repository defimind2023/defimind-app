import { describe, expect, it } from 'vitest'
import { CHAIN, harness, MERCHANT, MINT, type Harness } from './harness.js'
import { signedIn } from './owner.js'

const MULTISIG = 'Squads1111111111111111111111111111111111111'
const SIGN_PAGE = 'https://sign.example'

const transfer = (h: Harness) =>
  h.agent('POST', '/v1/agent/transfer', {
    agentId: 'agent-1',
    chain: CHAIN,
    token: MINT,
    amount: '1000000',
    recipient: MERCHANT,
    reason: 'pay the invoice',
  })

async function owner(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ build: async () => new Map(), ...options })
  return { h, ...(await signedIn(h)) }
}

const progress = async (o: Awaited<ReturnType<typeof owner>>) =>
  Object.fromEntries(
    (
      (await o.call('GET', '/v1/owner/setup/progress')).json().steps as {
        id: string
        done: boolean
      }[]
    ).map((step) => [step.id, step.done]),
  )

describe('the setup progress (CR-019)', () => {
  it('lists the eight steps in order', async () => {
    const o = await owner()
    const ids = (await o.call('GET', '/v1/owner/setup/progress'))
      .json()
      .steps.map((step: { id: string }) => step.id)
    expect(ids).toEqual([
      'passkey',
      'vault',
      'limit',
      'deposit',
      'agent',
      'rules',
      'shadow',
      'live',
    ])
  })

  it('reads each step from stored state and the chain', async () => {
    const o = await owner({ policy: { mode: 'shadow' } })
    expect(await progress(o)).toEqual({
      passkey: true,
      vault: true,
      limit: true,
      deposit: false,
      agent: true,
      rules: true,
      shadow: false,
      live: false,
    })
    o.h.chain.vaultBalance = 1n
    await transfer(o.h)
    expect(await progress(o)).toMatchObject({ deposit: true, shadow: true, live: false })
  })

  it('shows a deny-all agent as not having rules', async () => {
    const o = await owner({ policy: { chains: [], dailyMax: '0' } })
    expect(await progress(o)).toMatchObject({ agent: true, rules: false })
  })

  it('counts a chain that cannot be read as not done', async () => {
    const o = await owner()
    o.h.chain.getAllowanceState = async () => {
      throw new Error('rpc down')
    }
    expect(await progress(o)).toMatchObject({ vault: true, limit: false })
  })

  it('needs a session', async () => {
    const h = await harness({ build: async () => new Map() })
    const res = await h.app.inject({ method: 'GET', url: '/v1/owner/setup/progress' })
    expect(res.statusCode).toBe(401)
  })
})

describe('the deposit screen (CR-019)', () => {
  it('answers each chain vault, balance and cap', async () => {
    const o = await owner()
    o.h.chain.vaultBalance = 25_000_000n
    expect((await o.call('GET', '/v1/owner/deposit')).json()).toEqual({
      chains: [
        {
          chain: CHAIN,
          vault: `stub-vault-${CHAIN}`,
          token: 'stub-usd',
          balance: '25000000',
          dailyCap: '100000000',
        },
      ],
    })
  })

  it('links the signing page deposit by the multisig, never the hot wallet', async () => {
    const o = await owner({ signPage: SIGN_PAGE, env: { SQUADS_MULTISIG: MULTISIG } })
    const [row] = (await o.call('GET', '/v1/owner/deposit')).json().chains
    const page = new URL(row.depositPage)
    expect(page.origin).toBe(SIGN_PAGE)
    expect(Object.fromEntries(page.searchParams)).toEqual({
      action: 'deposit',
      cluster: 'devnet',
      multisig: MULTISIG,
    })
  })

  it('leaves out a chain whose adapter has no vault to read', async () => {
    const o = await owner()
    o.h.chain.getVault = undefined as never
    expect((await o.call('GET', '/v1/owner/deposit')).json()).toEqual({ chains: [] })
  })
})
