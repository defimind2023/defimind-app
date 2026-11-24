import { generateKeyPairSync, sign } from 'node:crypto'
import type { Anchor, ExecutionReceipt } from '@defimind/shared'
import { sha256Hex } from '../src/domain/canonical.js'
import { signedBytes } from '../src/domain/checks.js'
import { merklePath, merkleRoot } from '../src/domain/merkle.js'
import type { ProofBundle } from '../src/domain/schemas.js'

export const { privateKey, publicKey } = generateKeyPairSync('ed25519')

export function rawKeyHex(key = publicKey): string {
  const spki = key.export({ format: 'der', type: 'spki' })
  return spki.subarray(spki.length - 32).toString('hex')
}

/** Seals a receipt as guard-core does: hash and sign the canonical JSON of every other field. */
export function seal(receipt: Omit<ExecutionReceipt, 'hash' | 'signature'>): ExecutionReceipt {
  const unsigned = { ...receipt, hash: '', signature: '' }
  const bytes = signedBytes(unsigned)
  return {
    ...receipt,
    hash: sha256Hex(bytes),
    signature: sign(null, Buffer.from(bytes), privateKey).toString('hex'),
  }
}

export function chain(count: number): ExecutionReceipt[] {
  const receipts: ExecutionReceipt[] = []
  for (let seq = 1; seq <= count; seq++) {
    receipts.push(
      seal({
        type: 'defimind.execution.v1',
        seq,
        prevHash: receipts.at(-1)?.hash ?? '0'.repeat(64),
        agentId: 'agent-1',
        kind: 'tool_call',
        server: 'github',
        tool: 'create_issue',
        requestHash: sha256Hex(`request ${seq}`),
        responseHash: sha256Hex(`response ${seq}`),
        outcome: 'ok',
        assurance: 'relayed',
        startedAt: '2026-11-18T10:00:00.000Z',
        endedAt: '2026-11-18T10:00:01.000Z',
        issuedAt: '2026-11-18T10:00:01.100Z',
      }),
    )
  }
  return receipts
}

export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'

export function bundle(receipts: ExecutionReceipt[], seq: number): ProofBundle {
  const hashes = receipts.map((receipt) => receipt.hash)
  const anchor: Anchor = {
    fromSeq: receipts[0]?.seq ?? 1,
    toSeq: receipts.at(-1)?.seq ?? 1,
    root: merkleRoot(hashes),
    chain: SOLANA_DEVNET,
    txId: '5wHu1qwD7q5ifaN5nwdcDqNFo53GJqa7nLp2BeeEpcHCusb4GzARz4GjgzsEHMkBMgCJMGa6GSQ1VG96Exv8kt2W',
    anchoredAt: '2026-11-18T11:00:00.000Z',
  }
  const receipt = receipts.find((item) => item.seq === seq)
  if (receipt === undefined) {
    throw new Error(`no seq ${seq}`)
  }
  return { receipt, siblings: merklePath(hashes, seq - anchor.fromSeq), anchor }
}

/** A public RPC that knows one transaction, with the memos given. */
export const ANCHOR_KEY = 'AnchrKey1111111111111111111111111111111111'

export interface FakeRpc {
  fetch: typeof globalThis.fetch
  calls: unknown[]
}

export function fakeRpc(
  memos: string[],
  options: { failed?: boolean; missing?: boolean } = {},
): FakeRpc {
  const calls: unknown[] = []
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(JSON.parse(String(init?.body)))
    const result = options.missing
      ? null
      : {
          blockTime: Date.parse('2026-11-18T11:00:05.000Z') / 1000,
          meta: { err: options.failed ? { InstructionError: [0, 'Custom'] } : null },
          transaction: {
            message: {
              accountKeys: [
                { pubkey: ANCHOR_KEY, signer: true, writable: true },
                { pubkey: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', signer: false },
              ],
              instructions: [
                {
                  programId: 'ComputeBudget111111111111111111111111111111',
                  parsed: { type: 'setComputeUnitLimit' },
                },
                ...memos.map((memo) => ({
                  programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
                  parsed: memo,
                })),
              ],
            },
          },
        }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  }
  return { fetch, calls }
}
