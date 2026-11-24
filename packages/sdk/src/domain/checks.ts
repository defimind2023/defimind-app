import { createPublicKey, verify } from 'node:crypto'
import type { ExecutionReceipt } from '@defimind/shared'
import { canonicalJson, sha256Hex } from './canonical.js'
import { expectedSides, rootFromPath } from './merkle.js'
import type { ProofBundle } from './schemas.js'

export interface Check {
  name: string
  pass: boolean
  detail: string
}

const GENESIS = '0'.repeat(64)
// DER prefix that turns a raw 32-byte Ed25519 key into SPKI, which node:crypto reads.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

/** The bytes a receipt's hash and signature cover: every field but those two, as received. */
export function signedBytes(receipt: ExecutionReceipt): string {
  const { hash: _hash, signature: _signature, ...fields } = receipt
  return canonicalJson(fields)
}

export function checkHash(receipt: ExecutionReceipt): Check {
  const actual = sha256Hex(signedBytes(receipt))
  return actual === receipt.hash
    ? { name: 'hash', pass: true, detail: 'the fields match the receipt hash' }
    : { name: 'hash', pass: false, detail: `the fields hash to ${actual}, not ${receipt.hash}` }
}

export function checkSignature(receipt: ExecutionReceipt, publicKeyHex: string | undefined): Check {
  if (publicKeyHex === undefined) {
    return {
      name: 'signature',
      pass: false,
      detail:
        'not checked: pass --key with the hex key from GET /v1/receipts/key of the deployment',
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
    return { name: 'signature', pass: false, detail: 'the key is not 32 bytes of hex' }
  }
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  })
  const valid = verify(
    null,
    Buffer.from(signedBytes(receipt)),
    key,
    Buffer.from(receipt.signature, 'hex'),
  )
  return valid
    ? { name: 'signature', pass: true, detail: 'signed by the given key' }
    : { name: 'signature', pass: false, detail: 'the signature does not match the given key' }
}

export function checkPath(bundle: ProofBundle): Check {
  const { receipt, siblings, anchor } = bundle
  if (receipt.seq < anchor.fromSeq || receipt.seq > anchor.toSeq) {
    return {
      name: 'merkle path',
      pass: false,
      detail: `seq ${receipt.seq} is outside the anchored range ${anchor.fromSeq}-${anchor.toSeq}`,
    }
  }
  const sides = expectedSides(receipt.seq - anchor.fromSeq, anchor.toSeq - anchor.fromSeq + 1)
  if (sides.join() !== siblings.map((sibling) => sibling.side).join()) {
    return {
      name: 'merkle path',
      pass: false,
      detail: `the path does not fit seq ${receipt.seq} in ${anchor.fromSeq}-${anchor.toSeq}`,
    }
  }
  const root = rootFromPath(receipt.hash, siblings)
  return root === anchor.root
    ? { name: 'merkle path', pass: true, detail: `leads to the anchored root ${root}` }
    : { name: 'merkle path', pass: false, detail: `leads to ${root}, not the anchored root` }
}

/** Over receipts in the order given: no seq skipped, and each points at the one before. */
export function checkRun(receipts: readonly ExecutionReceipt[]): Check {
  for (const [i, receipt] of receipts.entries()) {
    const before = receipts[i - 1]
    if (before === undefined) {
      if (receipt.seq === 1 && receipt.prevHash !== GENESIS) {
        return fail(`seq 1 must have a prevHash of 64 zeros`)
      }
      continue
    }
    if (receipt.seq !== before.seq + 1) {
      return fail(`seq ${before.seq} is followed by ${receipt.seq}`)
    }
    if (receipt.prevHash !== before.hash) {
      return fail(`seq ${receipt.seq} does not link to the hash of seq ${before.seq}`)
    }
  }
  const first = receipts[0]?.seq
  const last = receipts.at(-1)?.seq
  return {
    name: 'chain',
    pass: true,
    detail: `seq ${first}-${last}: no gap, every prevHash links`,
  }
}

function fail(detail: string): Check {
  return { name: 'chain', pass: false, detail }
}

export function anchorMemo(anchor: ProofBundle['anchor']): string {
  return `defimind:anchor:v1:${anchor.fromSeq}-${anchor.toSeq}:${anchor.root}`
}
