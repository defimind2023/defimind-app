import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashesBetween, saveAnchor } from '../src/db/anchors.js'
import { merkleRoot, rootFromProof } from '../src/domain/merkle.js'
import { receiptHolds } from '../src/service/executions.js'
import { ADMIN_TOKEN, harness, NOW, type Harness } from './harness.js'
import { signedIn } from './owner.js'

const key = generateKeyPairSync('ed25519').privateKey
const report = {
  server: 'web',
  tool: 'search',
  requestHash: 'a'.repeat(64),
  responseHash: 'b'.repeat(64),
  outcome: 'ok',
  startedAt: NOW.toISOString(),
  endedAt: NOW.toISOString(),
}

let h: Harness
let owner: Awaited<ReturnType<typeof signedIn>>
beforeEach(async () => {
  h = await harness({ receiptKey: key })
  owner = await signedIn(h)
  for (let i = 0; i < 3; i++) {
    await h.agent('POST', '/v1/agent/executions', report)
  }
})

const anchorAll = () => {
  const root = merkleRoot(hashesBetween(h.db, 1, 3))
  const anchor = {
    fromSeq: 1,
    toSeq: 3,
    root,
    chain: 'solana:devnet',
    txId: 'tx-1',
    anchoredAt: NOW.toISOString(),
  }
  saveAnchor(h.db, anchor)
  return anchor
}

describe('the execution routes', () => {
  it('gives the owner the timeline, filtered by agent', async () => {
    const all = (await owner.call('GET', '/v1/owner/executions')).json().receipts
    expect(all.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3])
    const none = (await owner.call('GET', '/v1/owner/executions?agentId=other')).json().receipts
    expect(none).toEqual([])
  })

  it('reports the chain as it is now, with the last anchor', async () => {
    anchorAll()
    const integrity = (await owner.call('GET', '/v1/owner/executions/integrity')).json()
    expect(integrity).toMatchObject({ lastSeq: 3, lastAnchor: { toSeq: 3, txId: 'tx-1' } })
    expect(integrity).not.toHaveProperty('brokenAt')
  })

  it('has no proof until the receipt is anchored, then one that folds to the anchored root', async () => {
    expect((await owner.call('GET', '/v1/owner/executions/2/proof')).statusCode).toBe(404)
    const anchor = anchorAll()
    const bundle = (await owner.call('GET', '/v1/owner/executions/2/proof')).json()
    expect(bundle.anchor).toEqual(anchor)
    expect(rootFromProof(bundle.receipt.hash, bundle.siblings)).toBe(anchor.root)
    expect(receiptHolds(bundle.receipt, createPublicKey(key))).toBe(true)
  })

  it('needs the session for the owner routes', async () => {
    for (const url of [
      '/v1/owner/executions',
      '/v1/owner/executions/integrity',
      '/v1/owner/executions/1/proof',
    ]) {
      expect((await h.app.inject({ method: 'GET', url })).json()).toEqual({ error: 'no_session' })
    }
  })

  it('gives the admin token the same timeline', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/admin/executions',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.json().receipts).toHaveLength(3)
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/executions' })).statusCode).toBe(
      401,
    )
  })

  it('lists anchors to anyone, and never a receipt', async () => {
    const anchor = anchorAll()
    const res = await h.app.inject({ method: 'GET', url: '/v1/anchors' })
    expect(res.json()).toEqual({ anchors: [anchor] })
  })
})
