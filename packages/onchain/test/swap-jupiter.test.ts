import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { jupiter, SwapUnavailable } from '../src/svm/swap/jupiter.js'

const quote = {
  inputMint: 'USDC',
  inAmount: '10',
  outputMint: 'BONK',
  outAmount: '9',
  otherAmountThreshold: '8',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0',
  routePlan: [{ kept: 'as Jupiter sent it' }],
}
const request = { inputMint: 'USDC', outputMint: 'BONK', amount: 10n, slippageBps: 50 }

/** A fetch that answers every call with one response, and records what it was asked. */
function venue(status: number, body: unknown) {
  const asked: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
  return { api: jupiter('https://jup.test', fetcher), asked }
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof SwapUnavailable ? error.code : String(error)
  }
  return 'resolved'
}

describe("Jupiter's API, untrusted", () => {
  it('asks for an exact-in quote and keeps every field Jupiter sent', async () => {
    const { api, asked } = venue(200, quote)
    expect(await api.quote(request)).toEqual(quote)
    const url = new URL(asked[0]!.url)
    expect(url.pathname).toBe('/quote')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      inputMint: 'USDC',
      outputMint: 'BONK',
      amount: '10',
      slippageBps: '50',
      swapMode: 'ExactIn',
    })
  })

  it('tells no route from an outage', async () => {
    expect(
      await code(venue(400, { errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }).api.quote(request)),
    ).toBe('no_route')
    expect(await code(venue(503, 'down').api.quote(request))).toBe('venue_unavailable')
    expect(await code(venue(200, 'not json').api.quote(request))).toBe('venue_unavailable')
    expect(await code(venue(200, { ...quote, swapMode: 'ExactOut' }).api.quote(request))).toBe(
      'venue_unavailable',
    )
  })

  it('treats a network failure as an outage', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch
    expect(await code(jupiter('https://jup.test', failing).quote(request))).toBe(
      'venue_unavailable',
    )
  })

  it('asks for the swap with wrapped SOL left wrapped, and reads the transaction back', async () => {
    const payer = Keypair.generate().publicKey
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: payer.toBase58(),
        instructions: [],
      }).compileToV0Message(),
    )
    const swapTransaction = Buffer.from(tx.serialize()).toString('base64')
    const { api, asked } = venue(200, { swapTransaction })
    const built = await api.swap(quote as never, payer.toBase58())
    expect(built.message.staticAccountKeys[0]!.equals(payer)).toBe(true)
    const sent = JSON.parse(String(asked[0]!.init!.body))
    expect(sent).toMatchObject({
      quoteResponse: quote,
      userPublicKey: payer.toBase58(),
      wrapAndUnwrapSol: false,
    })
    expect(await code(venue(200, { swapTransaction: 'AAAA' }).api.swap(quote as never, 'x'))).toBe(
      'venue_unavailable',
    )
    expect(await code(venue(200, {}).api.swap(quote as never, 'x'))).toBe('venue_unavailable')
  })
})
