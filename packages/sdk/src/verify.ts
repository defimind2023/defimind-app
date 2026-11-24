import { CHAINS, type ExecutionReceipt } from '@defimind/shared'
import { z } from 'zod'
import { type AnchorTx, solanaAnchorTx } from './adapters/solana.js'
import {
  type Check,
  anchorMemo,
  checkHash,
  checkPath,
  checkRun,
  checkSignature,
} from './domain/checks.js'
import { type ProofBundle, executionReceipt, proofBundle } from './domain/schemas.js'

export interface VerifyOptions {
  /** Hex Ed25519 public key of the deployment. Without it no signature passes. */
  key?: string
  /** An RPC the verifier trusts, instead of the cluster's public one. */
  rpc?: string
  /** The deployment's anchor key; when given, an anchor signed by any other key fails. */
  anchorKey?: string
  fetch?: typeof globalThis.fetch
}

/** Public endpoints run by the clusters themselves, so no DefiMind server is involved. */
const PUBLIC_RPC: Record<string, string> = {
  [CHAINS.solanaMainnet]: 'https://api.mainnet-beta.solana.com',
  [CHAINS.solanaDevnet]: 'https://api.devnet.solana.com',
}

/** A proof bundle, a list of them, or a run of receipts as the timeline routes return it. */
const input = z.union([
  proofBundle,
  z.array(proofBundle).min(1),
  z.object({ receipts: z.array(executionReceipt).min(1) }),
  z.array(executionReceipt).min(1),
])

export async function verify(json: unknown, options: VerifyOptions = {}): Promise<Check[]> {
  const parsed = input.safeParse(json)
  if (!parsed.success) {
    return [{ name: 'input', pass: false, detail: describe(parsed.error) }]
  }
  const entries = entriesOf(parsed.data)
  const txs = new Map<string, Promise<AnchorTx | undefined>>()
  const checks: Check[] = []
  for (const { receipt, bundle } of entries) {
    checks.push(...labelled(receipt, [checkSignature(receipt, options.key), checkHash(receipt)]))
    if (bundle !== undefined) {
      checks.push(
        ...labelled(receipt, [checkPath(bundle), await checkAnchor(bundle, options, txs)]),
      )
    }
  }
  if (entries.length > 1) {
    checks.push(checkRun(entries.map((entry) => entry.receipt)))
  }
  return checks
}

interface Entry {
  receipt: ExecutionReceipt
  bundle?: ProofBundle
}

function entriesOf(value: z.infer<typeof input>): Entry[] {
  if (!Array.isArray(value)) {
    return 'receipts' in value
      ? value.receipts.map((receipt) => ({ receipt }))
      : [{ receipt: value.receipt, bundle: value }]
  }
  return value.map((item) => {
    const bundle = proofBundle.safeParse(item)
    return bundle.success
      ? { receipt: bundle.data.receipt, bundle: bundle.data }
      : { receipt: executionReceipt.parse(item) }
  })
}

function labelled(receipt: ExecutionReceipt, checks: Check[]): Check[] {
  return checks.map((check) => ({ ...check, name: `seq ${receipt.seq} ${check.name}` }))
}

async function checkAnchor(
  { anchor }: ProofBundle,
  options: VerifyOptions,
  txs: Map<string, Promise<AnchorTx | undefined>>,
): Promise<Check> {
  const fail = (detail: string): Check => ({ name: 'anchor', pass: false, detail })
  if (!anchor.chain.startsWith('solana:')) {
    return fail(`anchors on ${anchor.chain} cannot be checked yet`)
  }
  const rpc = options.rpc ?? PUBLIC_RPC[anchor.chain]
  if (rpc === undefined) {
    return fail(`no public RPC is known for ${anchor.chain}: pass --rpc`)
  }
  const key = `${rpc} ${anchor.txId}`
  if (!txs.has(key)) {
    txs.set(key, solanaAnchorTx(rpc, anchor.txId, options.fetch))
  }
  let tx: AnchorTx | undefined
  try {
    tx = await txs.get(key)
  } catch {
    return fail(`${rpc} did not answer for transaction ${anchor.txId}`)
  }
  if (tx === undefined) {
    return fail(`${rpc} has no finalized transaction ${anchor.txId}`)
  }
  if (tx.failed) {
    return fail(`transaction ${anchor.txId} failed on chain`)
  }
  const memo = anchorMemo(anchor)
  // An anchor is one memo in one transaction; a second one could say anything.
  if (tx.memos.length !== 1 || tx.memos[0] !== memo) {
    return fail(`transaction ${anchor.txId} does not carry exactly ${memo}`)
  }
  if (options.anchorKey !== undefined && tx.signer !== options.anchorKey) {
    return fail(`signed by ${tx.signer}, not by the anchor key ${options.anchorKey}`)
  }
  const when = tx.blockTime === undefined ? '' : `, in a block of ${iso(tx.blockTime)}`
  return {
    name: 'anchor',
    pass: true,
    detail: `${anchor.txId} carries the root, signed by ${tx.signer}${when}`,
  }
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue === undefined
    ? 'not a proof bundle or a run of receipts'
    : `not a proof bundle or a run of receipts (${issue.path.join('.') || 'root'}: ${issue.message})`
}
