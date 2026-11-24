import { z } from 'zod'

export interface AnchorTx {
  memos: string[]
  /** The fee payer, the first signer: the anchor key that published the memo. */
  signer: string
  /** Unix seconds, as the cluster recorded the block. */
  blockTime?: number
  failed: boolean
}

// Memo v2 and v1, matched by id rather than by the name an RPC gives them.
const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
])

const instruction = z.looseObject({ programId: z.string(), parsed: z.unknown() })
const accountKey = z.looseObject({ pubkey: z.string(), signer: z.boolean() })

const reply = z.object({
  result: z
    .object({
      blockTime: z.number().nullable().optional(),
      meta: z.object({ err: z.unknown() }).nullable(),
      transaction: z.object({
        message: z.object({
          accountKeys: z.array(accountKey).min(1),
          instructions: z.array(instruction),
        }),
      }),
    })
    .nullable(),
})

/** Reads a finalized transaction from an RPC the verifier chose, and the memos it carries. */
export async function solanaAnchorTx(
  rpc: string,
  signature: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<AnchorTx | undefined> {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const parsed = reply.parse(await response.json())
  if (parsed.result === null) {
    return undefined
  }
  const { meta, blockTime, transaction } = parsed.result
  const { accountKeys, instructions } = transaction.message
  return {
    memos: instructions.flatMap((ix) =>
      MEMO_PROGRAMS.has(ix.programId) && typeof ix.parsed === 'string' ? [ix.parsed] : [],
    ),
    signer: (accountKeys.find((key) => key.signer) ?? accountKeys[0])?.pubkey ?? '',
    ...(typeof blockTime === 'number' ? { blockTime } : {}),
    failed: meta === null || meta.err !== null,
  }
}
