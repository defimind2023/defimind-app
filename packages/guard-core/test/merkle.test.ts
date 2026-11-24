import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { merkleProof, merkleRoot, rootFromProof } from '../src/domain/merkle.js'

const h = (...hex: string[]) =>
  createHash('sha256')
    .update(Buffer.concat(hex.map((x) => Buffer.from(x, 'hex'))))
    .digest('hex')
const leaf = (x: string) => h('00', x)
const node = (l: string, r: string) => h('01', l, r)
const hashes = Array.from({ length: 7 }, (_, i) => h(i.toString(16).padStart(2, '0')))
const [a, b, c] = hashes as [string, string, string]

describe('the Merkle tree', () => {
  it('hashes one leaf with the leaf prefix', () => {
    expect(merkleRoot([a])).toBe(leaf(a))
  })

  it('hashes two leaves under one node', () => {
    expect(merkleRoot([a, b])).toBe(node(leaf(a), leaf(b)))
  })

  it('promotes an odd node unchanged', () => {
    expect(merkleRoot([a, b, c])).toBe(node(node(leaf(a), leaf(b)), leaf(c)))
  })

  it('never lets an inner node pass for a leaf', () => {
    const inner = node(leaf(a), leaf(b))
    expect(merkleRoot([inner])).not.toBe(merkleRoot([a, b]))
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('proves every leaf of %i back to the root', (count) => {
    const set = hashes.slice(0, count)
    set.forEach((hash, i) => {
      expect(rootFromProof(hash, merkleProof(set, i))).toBe(merkleRoot(set))
    })
  })

  it('fails a proof for another leaf, or a tampered sibling', () => {
    const proof = merkleProof(hashes, 2)
    expect(rootFromProof(hashes[3] as string, proof)).not.toBe(merkleRoot(hashes))
    const [first, ...rest] = proof
    const forged = [{ ...first!, hash: 'f'.repeat(64) }, ...rest]
    expect(rootFromProof(hashes[2] as string, forged)).not.toBe(merkleRoot(hashes))
  })

  it('refuses an empty tree and a leaf outside it', () => {
    expect(() => merkleRoot([])).toThrow()
    expect(() => merkleProof([a], 1)).toThrow()
  })
})
