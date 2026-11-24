import type { Anchor, ExecutionReceipt, ProofBundle } from '@defimind/shared'
import { verify } from '@defimind/sdk'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executionsFrom } from '../../packages/guard-core/src/db/executions.js'
import { merkleProof } from '../../packages/guard-core/src/domain/merkle.js'
import { ANCHOR_EVERY_MS, anchorJob } from '../../packages/guard-core/src/service/anchor.js'
import { offer, paidApi, type PaidApi } from './support/paid-api.js'
import { stack, type Stack } from './support/stack.js'

// CR-013 across packages: receipts guard-core really issues, a payment's and a gateway's in one
// chain, anchored by guard-core's own job, then checked by the sdk's verifier alone.

let s: Stack
let api: PaidApi

beforeEach(async () => {
  s = await stack({ panel: true })
  api = await paidApi()
  s.setPolicy()
})

afterEach(async () => {
  await api.close()
  await s.close()
})

const ANCHOR_KEY = 'AnchorKey1111111111111111111111111111111111'
const hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** Stands in for a Solana RPC: getTransaction returns the memo the anchor job published. */
function cluster(memos: Map<string, string>) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body)) as { params: [string] }
    const memo = memos.get(params[0])
    const result =
      memo === undefined
        ? null
        : {
            blockTime: 1_795_000_000,
            meta: { err: null },
            transaction: {
              message: {
                accountKeys: [{ pubkey: ANCHOR_KEY, signer: true }],
                instructions: [
                  { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: memo },
                ],
              },
            },
          }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  })
  return fetch as unknown as typeof globalThis.fetch
}

async function receiptKey(): Promise<string> {
  const res = await fetch(new URL('/v1/receipts/key', s.guardUrl))
  return ((await res.json()) as { publicKey: string }).publicKey
}

async function reportCall(tool: string): Promise<ExecutionReceipt> {
  const at = s.clock.now.toISOString()
  const res = await fetch(new URL('/v1/agent/executions', s.guardUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${s.agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      server: 'search',
      tool,
      requestHash: hex(`request ${tool}`),
      responseHash: hex(`response ${tool}`),
      outcome: 'ok',
      startedAt: at,
      endedAt: at,
    }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as ExecutionReceipt
}

/** Runs guard-core's anchor job once the hour has passed, with a publisher that records the memo. */
async function anchor(memos: Map<string, string>): Promise<Anchor> {
  s.clock.now = new Date(s.clock.now.getTime() + ANCHOR_EVERY_MS)
  const job = anchorJob({
    db: s.db,
    publisher: {
      chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      publish: async (memo) => {
        const txId = `tx${memos.size + 1}`
        memos.set(txId, memo)
        return txId
      },
    },
    now: () => s.clock.now,
    log: { info: () => undefined, warn: () => undefined },
  })
  const done = await job.tick()
  expect(done).toBeDefined()
  return done as Anchor
}

function bundles(anchored: Anchor): ProofBundle[] {
  const receipts = executionsFrom(s.db, anchored.fromSeq - 1, 1_000).filter(
    (r) => r.seq <= anchored.toSeq,
  )
  const hashes = receipts.map((r) => r.hash)
  return receipts.map((receipt, i) => ({
    receipt,
    siblings: merkleProof(hashes, i),
    anchor: anchored,
  }))
}

describe('verified execution (CR-013)', () => {
  it('a payment and gateway calls land in one chain, and every bundle verifies offline', async () => {
    api.quote = [offer({ amount: '500000' })]
    expect(await s.tool('paid_fetch', { url: api.url })).toContain(': executed.')
    await reportCall('lookup')
    await reportCall('summarize')

    const memos = new Map<string, string>()
    const anchored = await anchor(memos)
    expect([anchored.fromSeq, anchored.toSeq]).toEqual([1, 3])

    const all = bundles(anchored)
    expect(all.map((b) => [b.receipt.kind, b.receipt.assurance])).toEqual([
      ['payment', 'executed'],
      ['tool_call', 'relayed'],
      ['tool_call', 'relayed'],
    ])

    const checks = await verify(all, {
      key: await receiptKey(),
      rpc: 'https://rpc.example',
      anchorKey: ANCHOR_KEY,
      fetch: cluster(memos),
    })
    expect(checks.filter((c) => !c.pass)).toEqual([])
    expect(checks.length).toBeGreaterThan(all.length * 4)
  })

  it('catches an edited receipt, a forged anchor and a gap in the run', async () => {
    await reportCall('lookup')
    await reportCall('summarize')
    await reportCall('fetch')
    const memos = new Map<string, string>()
    const [first, second, third] = bundles(await anchor(memos)) as [
      ProofBundle,
      ProofBundle,
      ProofBundle,
    ]
    const options = { key: await receiptKey(), rpc: 'https://rpc.example', fetch: cluster(memos) }

    const edited = { ...second, receipt: { ...second.receipt, tool: 'transfer_all' } }
    expect((await verify(edited, options)).some((c) => !c.pass)).toBe(true)

    const forged = { ...first, anchor: { ...first.anchor, root: 'ab'.repeat(32) } }
    expect((await verify(forged, options)).some((c) => !c.pass)).toBe(true)

    const strangers = await verify(first, {
      ...options,
      anchorKey: 'SomeoneElse1111111111111111111111111111111',
    })
    expect(strangers.some((c) => !c.pass)).toBe(true)

    const gap = await verify([first.receipt, third.receipt], options)
    expect(gap.some((c) => !c.pass)).toBe(true)
  })
})
