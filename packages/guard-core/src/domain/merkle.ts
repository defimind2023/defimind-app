import { createHash } from 'node:crypto'

/** One step of a proof: the sibling's hash, and which side of the path it sits on. */
export interface Sibling {
  side: 'left' | 'right'
  hash: string
}

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()

// RFC 6962 style: a leaf and a node are hashed under different prefixes, so a node can never be
// presented as a leaf (ADR 005).
const leaf = (hash: string) => sha256(Buffer.from([0]), Buffer.from(hash, 'hex'))
const node = (left: Buffer, right: Buffer) => sha256(Buffer.from([1]), left, right)

/** Each level up: pairs hashed together, an odd one at the end promoted unchanged. */
function up(level: Buffer[]): Buffer[] {
  const next: Buffer[] = []
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i] as Buffer
    const right = level[i + 1]
    next.push(right === undefined ? left : node(left, right))
  }
  return next
}

/** The root over receipt hashes, in seq order, as hex. */
export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) {
    throw new Error('no leaves')
  }
  let level: Buffer[] = hashes.map(leaf)
  while (level.length > 1) {
    level = up(level)
  }
  return (level[0] as Buffer).toString('hex')
}

/** The siblings from leaf `index` up to the root; a promoted level adds none. */
export function merkleProof(hashes: string[], index: number): Sibling[] {
  if (index < 0 || index >= hashes.length) {
    throw new Error('no such leaf')
  }
  const siblings: Sibling[] = []
  let level: Buffer[] = hashes.map(leaf)
  let at = index
  while (level.length > 1) {
    const pair = at % 2 === 0 ? at + 1 : at - 1
    const sibling = level[pair]
    if (sibling !== undefined) {
      siblings.push({ side: at % 2 === 0 ? 'right' : 'left', hash: sibling.toString('hex') })
    }
    level = up(level)
    at = Math.floor(at / 2)
  }
  return siblings
}

/** Folds a proof back up to its root, as a verifier would. */
export function rootFromProof(hash: string, siblings: Sibling[]): string {
  let at = leaf(hash)
  for (const { side, hash: other } of siblings) {
    const sibling = Buffer.from(other, 'hex')
    at = side === 'left' ? node(sibling, at) : node(at, sibling)
  }
  return at.toString('hex')
}
