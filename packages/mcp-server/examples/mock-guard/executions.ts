import { generateKeyPairSync, sign } from 'node:crypto'
import { sha256Hex, signedBytes } from '@defimind/sdk'
import type { ExecutionReceipt } from '@defimind/shared'
import { z } from 'zod'

const hex64 = z.string().regex(/^[0-9a-f]{64}$/)

const report = z.strictObject({
  server: z.string().min(1).max(64),
  tool: z.string().min(1).max(128),
  requestHash: hex64,
  responseHash: hex64,
  outcome: z.enum(['ok', 'error', 'refused']),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
})

/**
 * POST /v1/agent/executions as the SPEC shapes it: one chain, hashed and signed like guard-core's,
 * so defimind-verify can check what a demo produced. Its key is new on every start.
 */
export function executionLog(agentId: string, now: () => Date) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const receipts: ExecutionReceipt[] = []
  return {
    receipts,
    publicKey: spki.subarray(spki.length - 32).toString('hex'),
    append(body: unknown): ExecutionReceipt | undefined {
      const parsed = report.safeParse(body)
      if (!parsed.success) {
        return undefined
      }
      const fields = {
        type: 'defimind.execution.v1' as const,
        seq: receipts.length + 1,
        prevHash: receipts.at(-1)?.hash ?? '0'.repeat(64),
        agentId,
        kind: 'tool_call' as const,
        ...parsed.data,
        assurance: 'relayed' as const,
        issuedAt: now().toISOString(),
      }
      const bytes = signedBytes({ ...fields, hash: '', signature: '' })
      const receipt: ExecutionReceipt = {
        ...fields,
        hash: sha256Hex(bytes),
        signature: sign(null, Buffer.from(bytes), privateKey).toString('hex'),
      }
      receipts.push(receipt)
      return receipt
    },
  }
}
