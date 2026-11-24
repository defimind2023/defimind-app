import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { anchorMemo } from '../src/domain/checks.js'
import { verify } from '../src/verify.js'
import { ANCHOR_KEY, bundle, chain, fakeRpc, rawKeyHex, seal } from './chain.js'

const key = rawKeyHex()
const receipts = chain(5)
const good = bundle(receipts, 3)
const rpc = fakeRpc([anchorMemo(good.anchor)])

function failures(checks: { name: string; pass: boolean; detail: string }[]) {
  return checks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.detail}`)
}

describe('verify a proof bundle', () => {
  it('passes every check on a good bundle, through the public devnet RPC', async () => {
    const checks = await verify(good, { key, fetch: rpc.fetch })
    expect(failures(checks)).toEqual([])
    expect(checks.map((check) => check.name)).toEqual([
      'seq 3 signature',
      'seq 3 hash',
      'seq 3 merkle path',
      'seq 3 anchor',
    ])
    expect(checks[3]?.detail).toContain(
      `signed by ${ANCHOR_KEY}, in a block of 2026-11-18T11:00:05.000Z`,
    )
  })

  it('passes for every receipt of an odd-sized anchor, and the edges of a one-leaf one', async () => {
    for (const seq of [1, 2, 3, 4, 5]) {
      const item = bundle(receipts, seq)
      const { fetch } = fakeRpc([anchorMemo(item.anchor)])
      expect(failures(await verify(item, { key, fetch }))).toEqual([])
    }
    const single = bundle(chain(1), 1)
    expect(
      failures(await verify(single, { key, fetch: fakeRpc([anchorMemo(single.anchor)]).fetch })),
    ).toEqual([])
  })

  it('fails the signature when a byte of it changes', async () => {
    const signature = `${good.receipt.signature.startsWith('0') ? '1' : '0'}${good.receipt.signature.slice(1)}`
    const checks = await verify(
      { ...good, receipt: { ...good.receipt, signature } },
      { key, fetch: rpc.fetch },
    )
    expect(failures(checks)).toEqual([
      'seq 3 signature: the signature does not match the given key',
    ])
  })

  it('fails the signature against another key, and without a key', async () => {
    const other = rawKeyHex(generateKeyPairSync('ed25519').publicKey)
    expect(failures(await verify(good, { key: other, fetch: rpc.fetch }))).toEqual([
      'seq 3 signature: the signature does not match the given key',
    ])
    expect(failures(await verify(good, { fetch: rpc.fetch }))[0]).toMatch(/not checked: pass --key/)
    expect(failures(await verify(good, { key: 'abc', fetch: rpc.fetch }))[0]).toMatch(
      /not 32 bytes/,
    )
  })

  it('fails the hash and the signature when a field is edited', async () => {
    const edited = { ...good, receipt: { ...good.receipt, outcome: 'error' as const } }
    const result = failures(await verify(edited, { key, fetch: rpc.fetch }))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatch(/^seq 3 signature/)
    expect(result[1]).toMatch(/^seq 3 hash: the fields hash to/)
  })

  it('fails the path when a sibling changes', async () => {
    const [first, ...rest] = good.siblings
    if (first === undefined) {
      throw new Error('expected a sibling')
    }
    const siblings = [{ ...first, hash: '0'.repeat(64) }, ...rest]
    expect(failures(await verify({ ...good, siblings }, { key, fetch: rpc.fetch }))).toEqual([
      expect.stringMatching(/^seq 3 merkle path: leads to [0-9a-f]{64}, not the anchored root/),
    ])
  })

  it('fails a path presented for another position', async () => {
    const moved = { ...good, siblings: bundle(receipts, 2).siblings }
    expect(failures(await verify(moved, { key, fetch: rpc.fetch }))).toEqual([
      'seq 3 merkle path: the path does not fit seq 3 in 1-5',
    ])
  })

  it('fails a receipt outside the anchored range', async () => {
    const outside = { ...good, anchor: { ...good.anchor, fromSeq: 4 } }
    const result = failures(
      await verify(outside, { key, fetch: fakeRpc([anchorMemo(outside.anchor)]).fetch }),
    )
    expect(result).toEqual(['seq 3 merkle path: seq 3 is outside the anchored range 4-5'])
  })

  it('fails the root when the bundle claims another one, and the anchor tx does not carry it', async () => {
    const root = '1'.repeat(64)
    const result = failures(
      await verify({ ...good, anchor: { ...good.anchor, root } }, { key, fetch: rpc.fetch }),
    )
    expect(result[0]).toMatch(/^seq 3 merkle path: leads to/)
    expect(result[1]).toBe(
      `seq 3 anchor: transaction ${good.anchor.txId} does not carry exactly defimind:anchor:v1:1-5:${root}`,
    )
  })

  it('fails the anchor when the tx is missing, failed, or the RPC is down', async () => {
    const missing = failures(
      await verify(good, { key, fetch: fakeRpc([], { missing: true }).fetch }),
    )
    expect(missing).toEqual([expect.stringMatching(/has no finalized transaction/)])
    const failed = fakeRpc([anchorMemo(good.anchor)], { failed: true })
    expect(failures(await verify(good, { key, fetch: failed.fetch }))).toEqual([
      expect.stringMatching(/failed on chain/),
    ])
    const down = async () => {
      throw new TypeError('fetch failed')
    }
    expect(failures(await verify(good, { key, fetch: down }))).toEqual([
      expect.stringMatching(/did not answer for transaction/),
    ])
  })

  it('fails a transaction with a second memo beside the anchor', async () => {
    const two = fakeRpc([anchorMemo(good.anchor), 'defimind:anchor:v1:1-5:' + '2'.repeat(64)])
    expect(failures(await verify(good, { key, fetch: two.fetch }))).toEqual([
      expect.stringMatching(/does not carry exactly/),
    ])
  })

  it('checks the signer against --anchor-key when given', async () => {
    expect(failures(await verify(good, { key, anchorKey: ANCHOR_KEY, fetch: rpc.fetch }))).toEqual(
      [],
    )
    expect(
      failures(await verify(good, { key, anchorKey: 'SomeoneElse111', fetch: rpc.fetch })),
    ).toEqual([`seq 3 anchor: signed by ${ANCHOR_KEY}, not by the anchor key SomeoneElse111`])
  })

  it('asks the RPC the verifier chose, for a finalized transaction', async () => {
    const asked: string[] = []
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(String(url))
      return rpc.fetch(url, init)
    }
    await verify(good, { key, rpc: 'https://rpc.example.org', fetch })
    expect(asked).toEqual(['https://rpc.example.org'])
    expect(rpc.calls.at(-1)).toMatchObject({
      method: 'getTransaction',
      params: [good.anchor.txId, { commitment: 'finalized', encoding: 'jsonParsed' }],
    })
  })

  it('cannot check an EVM anchor yet, nor a Solana cluster with no public RPC', async () => {
    const evm = { ...good, anchor: { ...good.anchor, chain: 'eip155:8453' } }
    expect(failures(await verify(evm, { key }))).toEqual([
      'seq 3 anchor: anchors on eip155:8453 cannot be checked yet',
    ])
    const local = { ...good, anchor: { ...good.anchor, chain: 'solana:localnet' } }
    expect(failures(await verify(local, { key }))).toEqual([
      'seq 3 anchor: no public RPC is known for solana:localnet: pass --rpc',
    ])
  })
})

describe('verify a run', () => {
  it('passes a whole run of receipts, as the timeline returns it', async () => {
    const checks = await verify({ receipts }, { key })
    expect(failures(checks)).toEqual([])
    expect(checks.at(-1)).toEqual({
      name: 'chain',
      pass: true,
      detail: 'seq 1-5: no gap, every prevHash links',
    })
  })

  it('fails a gap', async () => {
    const gapped = receipts.filter((receipt) => receipt.seq !== 3)
    expect(failures(await verify(gapped, { key }))).toEqual(['chain: seq 2 is followed by 4'])
  })

  it('fails a broken prevHash even when the receipt itself is well signed', async () => {
    const [one, two, three] = receipts as [
      (typeof receipts)[0],
      (typeof receipts)[0],
      (typeof receipts)[0],
    ]
    const { hash: _h, signature: _s, ...fields } = three
    const relinked = seal({ ...fields, prevHash: one.hash })
    expect(failures(await verify([one, two, relinked], { key }))).toEqual([
      'chain: seq 3 does not link to the hash of seq 2',
    ])
  })

  it('fails a first receipt that does not start from 64 zeros', async () => {
    const { hash: _h, signature: _s, ...fields } = receipts[0] as (typeof receipts)[0]
    const first = seal({ ...fields, prevHash: '2'.repeat(64) })
    expect(failures(await verify([first, receipts[1]], { key }))).toEqual([
      'chain: seq 1 must have a prevHash of 64 zeros',
    ])
  })

  it('checks a list of bundles both one by one and as a run', async () => {
    const list = [bundle(receipts, 4), bundle(receipts, 5)]
    const checks = await verify(list, { key, fetch: rpc.fetch })
    expect(failures(checks)).toEqual([])
    expect(checks.map((check) => check.name)).toContain('chain')
    expect(rpc.calls.length).toBeGreaterThan(0)
  })

  it('refuses something that is neither a bundle nor receipts', async () => {
    expect(failures(await verify({ hello: 'world' }))).toEqual([
      expect.stringMatching(/^input: not a proof bundle or a run of receipts/),
    ])
  })
})
