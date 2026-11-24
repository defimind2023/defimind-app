import type { Anchor, ExecutionReceipt, ProofBundle } from '@defimind/shared'
import { z } from 'zod'

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex characters')
const time = z.iso.datetime({ offset: true })
const seq = z.number().int().min(1)

export const executionReceipt = z.looseObject({
  type: z.literal('defimind.execution.v1'),
  seq,
  prevHash: hex64,
  agentId: z.string().min(1),
  kind: z.enum(['tool_call', 'payment']),
  server: z.string().min(1),
  tool: z.string().min(1),
  requestHash: hex64,
  responseHash: hex64,
  outcome: z.enum(['ok', 'error', 'refused']),
  assurance: z.enum(['executed', 'relayed']),
  paymentReceipt: hex64.optional(),
  startedAt: time,
  endedAt: time,
  issuedAt: time,
  hash: hex64,
  signature: z.string().regex(/^[0-9a-f]{128}$/, 'expected a 64-byte hex signature'),
}) satisfies z.ZodType<ExecutionReceipt>

export const anchor = z.object({
  fromSeq: seq,
  toSeq: seq,
  root: hex64,
  chain: z.string().min(1),
  txId: z.string().min(1),
  anchoredAt: time,
}) satisfies z.ZodType<Anchor>

export const proofBundle = z.object({
  receipt: executionReceipt,
  siblings: z.array(z.object({ side: z.enum(['left', 'right']), hash: hex64 })).max(64),
  anchor,
}) satisfies z.ZodType<ProofBundle>

export type { ProofBundle }
