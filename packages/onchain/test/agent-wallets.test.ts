import { CHAINS } from '@defimind/shared'
import { Keypair } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { svmAdapter } from '../src/svm/adapter.js'
import { spendingLimitPda } from '../src/svm/squads.js'
import { chain, plantMultisig, plantSpendingLimit, USDC, type Chain } from './fixture.js'

/**
 * An agent's own wallet (CR-022) is a second hot wallet on the same multisig: its adapter reads and
 * kills its own spending limit and never the shared one.
 */
let c: Chain
let agent: Keypair
let own: ReturnType<typeof svmAdapter>

beforeEach(() => {
  c = chain()
  agent = Keypair.generate()
  own = svmAdapter({
    chain: CHAINS.solanaDevnet,
    connection: c.connection,
    hotWallet: agent,
    multisigPda: c.multisigPda,
    mint: c.mint,
  })
  plantSpendingLimit(c, 100n * USDC, 100n * USDC, 0)
})

describe("an agent's own wallet", () => {
  it('reads its own limit, not the shared one', async () => {
    plantSpendingLimit(c, 20n * USDC, 15n * USDC, 0, {}, agent.publicKey)
    expect(await own.getAllowanceState()).toMatchObject({
      status: 'active',
      cap: '20000000',
      delegate: agent.publicKey.toBase58(),
    })
    expect(await c.adapter.getAllowanceState()).toMatchObject({ cap: '100000000' })
  })

  it('has no limit until the owner signs one, while the shared wallet keeps its own', async () => {
    expect(await own.getAllowanceState()).toEqual({
      status: 'none',
      delegate: agent.publicKey.toBase58(),
    })
  })

  it('kills only its own limit', async () => {
    plantMultisig(c, Keypair.generate().publicKey)
    const kill = await own.buildKillTx()
    const accounts = (kill.payload as { accounts: { pubkey: string }[] }).accounts.map(
      (a) => a.pubkey,
    )
    expect(accounts).toContain(spendingLimitPda(c.multisigPda, agent.publicKey).toBase58())
    expect(accounts).not.toContain(
      spendingLimitPda(c.multisigPda, c.hotWallet.publicKey).toBase58(),
    )
    expect(kill.description).toContain(agent.publicKey.toBase58())
  })
})
