import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/domain/canonical.js'
import {
  expectedSides,
  leafHash,
  merklePath,
  merkleRoot,
  nodeHash,
  rootFromPath,
} from '../src/domain/merkle.js'

const hashes = Array.from({ length: 9 }, (_, i) => sha256Hex(`receipt ${i + 1}`))

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    )
  })

  it('hashes a call that returned nothing as null', () => {
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('Merkle tree', () => {
  it('hashes leaves and nodes with RFC 6962 prefixes', () => {
    const [a, b] = hashes as [string, string]
    expect(leafHash(a)).toBe(sha256Hex(Buffer.concat([Buffer.from([0]), Buffer.from(a, 'hex')])))
    expect(nodeHash(a, b)).toBe(
      sha256Hex(Buffer.concat([Buffer.from([1]), Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])),
    )
  })

  it('has the leaf hash as the root of one leaf', () => {
    const [a] = hashes as [string]
    expect(merkleRoot([a])).toBe(leafHash(a))
    expect(merklePath([a], 0)).toEqual([])
  })

  it('pairs two leaves', () => {
    const [a, b] = hashes as [string, string]
    expect(merkleRoot([a, b])).toBe(nodeHash(leafHash(a), leafHash(b)))
  })

  it('promotes an odd node unchanged', () => {
    const [a, b, c] = hashes as [string, string, string]
    expect(merkleRoot([a, b, c])).toBe(nodeHash(nodeHash(leafHash(a), leafHash(b)), leafHash(c)))
    expect(merklePath([a, b, c], 2)).toEqual([
      { side: 'left', hash: nodeHash(leafHash(a), leafHash(b)) },
    ])
  })

  it('proves every leaf of every size up to 9, with the sides its position implies', () => {
    for (let count = 1; count <= hashes.length; count++) {
      const leaves = hashes.slice(0, count)
      const root = merkleRoot(leaves)
      leaves.forEach((hash, index) => {
        const path = merklePath(leaves, index)
        expect(rootFromPath(hash, path)).toBe(root)
        expect(path.map((sibling) => sibling.side)).toEqual(expectedSides(index, count))
      })
    }
  })

  it('does not let an inner node pass for a leaf', () => {
    const [a, b, c, d] = hashes as [string, string, string, string]
    const left = nodeHash(leafHash(a), leafHash(b))
    const right = nodeHash(leafHash(c), leafHash(d))
    const root = merkleRoot([a, b, c, d])
    expect(nodeHash(left, right)).toBe(root)
    expect(rootFromPath(left, [{ side: 'right', hash: right }])).not.toBe(root)
  })

  it('refuses a tree with no leaf', () => {
    expect(() => merkleRoot([])).toThrow('at least one leaf')
  })
})
