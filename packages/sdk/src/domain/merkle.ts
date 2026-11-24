import { createHash } from 'node:crypto'

export interface Sibling {
  side: 'left' | 'right'
  hash: string
}

// RFC 6962 prefixes: an inner node can never be presented as a leaf.
export function leafHash(receiptHash: string): string {
  return digest(Buffer.from([0]), Buffer.from(receiptHash, 'hex'))
}

export function nodeHash(left: string, right: string): string {
  return digest(Buffer.from([1]), Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function digest(...parts: Buffer[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
  }
  return hash.digest('hex')
}

/** Leaves in seq order; a node left without a partner is promoted unchanged. */
export function merkleRoot(receiptHashes: readonly string[]): string {
  let level = receiptHashes.map(leafHash)
  while (level.length > 1) {
    level = pairUp(level)
  }
  const [root] = level
  if (root === undefined) {
    throw new Error('a Merkle tree needs at least one leaf')
  }
  return root
}

function pairUp(level: readonly string[]): string[] {
  const next: string[] = []
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i] as string
    const right = level[i + 1]
    next.push(right === undefined ? left : nodeHash(left, right))
  }
  return next
}

/** The siblings from leaf `index` up to the root, as a proof bundle carries them. */
export function merklePath(receiptHashes: readonly string[], index: number): Sibling[] {
  let level = receiptHashes.map(leafHash)
  const path: Sibling[] = []
  while (level.length > 1) {
    const partner = index % 2 === 0 ? index + 1 : index - 1
    const hash = level[partner]
    if (hash !== undefined) {
      path.push({ side: index % 2 === 0 ? 'right' : 'left', hash })
    }
    level = pairUp(level)
    index = Math.floor(index / 2)
  }
  return path
}

/** The sides a path must have for leaf `index` of `count`, so a proof cannot move a receipt. */
export function expectedSides(index: number, count: number): Sibling['side'][] {
  const sides: Sibling['side'][] = []
  while (count > 1) {
    const partner = index % 2 === 0 ? index + 1 : index - 1
    if (partner < count) {
      sides.push(index % 2 === 0 ? 'right' : 'left')
    }
    index = Math.floor(index / 2)
    count = Math.ceil(count / 2)
  }
  return sides
}

export function rootFromPath(receiptHash: string, path: readonly Sibling[]): string {
  return path.reduce(
    (node, sibling) =>
      sibling.side === 'left' ? nodeHash(sibling.hash, node) : nodeHash(node, sibling.hash),
    leafHash(receiptHash),
  )
}
