import { CHAINS } from '@defimind/shared'
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SwapUnavailable, type JupiterQuote, type Venue } from '../src/svm/swap/jupiter.js'
import { tokenRisk } from '../src/svm/swap/risk.js'

/** Mint accounts as mainnet holds them, recorded with getAccountInfo. */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'

function account(mint: string): AccountInfo<Buffer> {
  const url = new URL(`./fixtures/mint-${mint}.json`, import.meta.url)
  const { owner, lamports, data } = JSON.parse(readFileSync(url, 'utf8')) as {
    owner: string
    lamports: number
    data: string
  }
  return {
    owner: new PublicKey(owner),
    lamports,
    data: Buffer.from(data, 'base64'),
    executable: false,
  }
}

const connection = {
  getAccountInfo: async (key: PublicKey) => account(key.toBase58()),
} as unknown as Connection

/** A venue where 10 USDC buys 1,000 units, and selling them back costs `impact` percent. */
function venue({ impact = '0.0125', route = true } = {}): Venue & { asked: bigint[] } {
  const asked: bigint[] = []
  return {
    asked,
    async quote({ inputMint, outputMint, amount, slippageBps }): Promise<JupiterQuote> {
      asked.push(amount)
      if (!route) throw new SwapUnavailable('no_route', 'COULD_NOT_FIND_ANY_ROUTE')
      const out = inputMint === USDC ? 1_000n : 9_800_000n
      return {
        inputMint,
        inAmount: amount.toString(),
        outputMint,
        outAmount: out.toString(),
        otherAmountThreshold: ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
        swapMode: 'ExactIn',
        slippageBps,
        priceImpactPct: inputMint === USDC ? '0.001' : impact,
      }
    },
    swap: () => Promise.reject(new Error('not used')),
  }
}

const risk = (mint: string, v: Venue = venue()) =>
  tokenRisk(
    { connection, dollar: new PublicKey(USDC), venue: v, chain: CHAINS.solanaMainnet },
    mint,
  )

describe("a token's risk card, from mainnet mints", () => {
  it('reads JUP: no freeze, no extensions, and prices the exit of what 10 USD buys', async () => {
    const v = venue()
    expect(await risk(JUP, v)).toEqual({
      chain: CHAINS.solanaMainnet,
      mint: JUP,
      decimals: 6,
      freezeAuthority: false,
      mintAuthority: false,
      extensions: [],
      risks: [],
      exit: { amountUsd: '10000000', priceImpactBps: 125 },
    })
    expect(v.asked).toEqual([10_000_000n, 1_000n])
  })

  it('reads PYUSD as Token-2022, with its extensions named and the risks a buy would meet', async () => {
    const card = await risk(PYUSD)
    expect(card).toMatchObject({ decimals: 6, freezeAuthority: true, mintAuthority: true })
    expect(card.extensions).toEqual(
      expect.arrayContaining(['TransferFeeConfig', 'PermanentDelegate']),
    )
    expect(card.risks).toEqual(['TOKEN_FREEZABLE', 'TOKEN_EXTENSION_RISK'])
  })

  it('says NO_EXIT_ROUTE, with no exit, when the venue has no route', async () => {
    const card = await risk(JUP, venue({ route: false }))
    expect(card.exit).toBeNull()
    expect(card.risks).toEqual(['NO_EXIT_ROUTE'])
  })

  it('passes on a venue that is down rather than calling it no route', async () => {
    const down: Venue = {
      quote: () => Promise.reject(new SwapUnavailable('venue_unavailable', '503')),
      swap: () => Promise.reject(new Error('not used')),
    }
    await expect(risk(JUP, down)).rejects.toThrow(SwapUnavailable)
  })

  it('refuses an address that is not a mint', async () => {
    const empty = { getAccountInfo: async () => null } as unknown as Connection
    const read = tokenRisk(
      {
        connection: empty,
        dollar: new PublicKey(USDC),
        venue: venue(),
        chain: CHAINS.solanaMainnet,
      },
      JUP,
    )
    await expect(read).rejects.toThrow(/^not_a_mint/)
  })
})
