import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schema } from '../src/db/client.js'
import { canonicalJson } from '../src/domain/canonical.js'
import { checkChain, GENESIS, receiptHolds, sha256Hex } from '../src/service/executions.js'
import { integrityMonitor } from '../src/service/integrity.js'
import { CHAIN, harness, MERCHANT, MINT, type Harness } from './harness.js'

const key = generateKeyPairSync('ed25519').privateKey
const pub = createPublicKey(key)
const report = (tool = 'search') => ({
  server: 'web',
  tool,
  requestHash: 'a'.repeat(64),
  responseHash: 'b'.repeat(64),
  outcome: 'ok',
  startedAt: '2026-11-03T11:59:59.000Z',
  endedAt: '2026-11-03T12:00:00.000Z',
})

let h: Harness
const record = (body: object = report()) => h.agent('POST', '/v1/agent/executions', body)

beforeEach(async () => {
  h = await harness({ receiptKey: key })
})

describe('the execution chain', () => {
  it('appends signed, linked receipts with the agent from the token', async () => {
    const first = (await record()).json()
    const second = (await record(report('fetch'))).json()
    expect(first).toMatchObject({
      type: 'defimind.execution.v1',
      seq: 1,
      prevHash: GENESIS,
      agentId: 'agent-1',
      kind: 'tool_call',
      assurance: 'relayed',
    })
    expect(second.seq).toBe(2)
    expect(second.prevHash).toBe(first.hash)
    expect(receiptHolds(first, pub)).toBe(true)
    expect(checkChain(h.db, pub)).toEqual({ lastSeq: 2, lastHash: second.hash })
  })

  it('refuses a body that is not hashes, or ends before it starts', async () => {
    expect((await record({ ...report(), requestHash: 'my secret prompt' })).statusCode).toBe(400)
    expect((await record({ ...report(), endedAt: '2026-11-03T11:00:00.000Z' })).statusCode).toBe(
      400,
    )
  })

  it('answers 409 without a receipt key', async () => {
    h = await harness()
    expect((await record()).json()).toEqual({ error: 'receipts_not_configured' })
  })

  it('cannot fork: twenty appends at once take twenty seqs in one chain', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => record()))
    expect(new Set(all.map((r) => r.json().seq)).size).toBe(20)
    expect(checkChain(h.db, pub)).toMatchObject({ lastSeq: 20 })
    expect(checkChain(h.db, pub).brokenAt).toBeUndefined()
  })

  it.each([
    [
      'a deleted row',
      (db: Harness['db']) => db.delete(schema.executions).where(eq(schema.executions.seq, 2)).run(),
    ],
    [
      'an edited row',
      (db: Harness['db']) =>
        db
          .update(schema.executions)
          .set({ tool: 'transfer_all' })
          .where(eq(schema.executions.seq, 2))
          .run(),
    ],
    [
      'a forged signature',
      (db: Harness['db']) =>
        db
          .update(schema.executions)
          .set({ signature: 'f'.repeat(128) })
          .where(eq(schema.executions.seq, 2))
          .run(),
    ],
  ])('finds %s', async (_case, tamper) => {
    for (let i = 0; i < 3; i++) {
      await record()
    }
    tamper(h.db)
    expect(checkChain(h.db, pub).brokenAt).toBe(2)
  })

  it('records an executed payment, pointing to its payment receipt by hash', async () => {
    const res = await h.agent('POST', '/v1/agent/transfer', {
      agentId: 'agent-1',
      chain: CHAIN,
      token: MINT,
      amount: '1000000',
      recipient: MERCHANT,
      reason: 'pay',
    })
    const { intentId } = res.json()
    const receipt = (await h.agent('GET', `/v1/agent/intents/${intentId}/receipt`)).json()
    const [entry] = h.db.select().from(schema.executions).all()
    expect(entry).toMatchObject({
      kind: 'payment',
      server: 'defimind',
      tool: 'transfer',
      assurance: 'executed',
      paymentReceipt: sha256Hex(canonicalJson(receipt)),
    })
    expect(JSON.stringify(entry)).not.toContain(MERCHANT)
  })
})

describe('the integrity monitor', () => {
  it('alerts once on a break, not again on the same one', async () => {
    await record()
    await record()
    h.db.delete(schema.executions).where(eq(schema.executions.seq, 1)).run()
    vi.mocked(h.bot.alert).mockClear()
    const monitor = integrityMonitor(
      {
        db: h.db,
        bot: h.bot,
        now: () => h.clock.now,
        log: { warn: vi.fn(), error: vi.fn() },
      } as never,
      key,
    )
    expect(monitor.check().brokenAt).toBe(1)
    monitor.check()
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.bot.alert).toHaveBeenCalledTimes(1)
    expect(h.bot.alert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chain_broken', detail: 'seq 1' }),
    )
  })
})
