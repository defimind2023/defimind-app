import type { ExecutionReceipt } from '@defimind/shared'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionReport, Recorder } from '../src/adapters/recorder.js'
import { hashOf } from '../src/domain/canonical.js'
import { ReceiptError, Refused, receipts, withReceipt } from '../src/receipt.js'
import { chain } from './chain.js'

const [receipt] = chain(1) as [ExecutionReceipt]

function recorder(fail = false) {
  const reports: ExecutionReport[] = []
  const record: Recorder = {
    record: async (report) => {
      reports.push(report)
      if (fail) {
        throw new Error('guard-core is down')
      }
      return receipt
    },
  }
  return { record, reports }
}

const clock = () => {
  let tick = 0
  return () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++))
}

describe('withReceipt', () => {
  it('reports a successful call with the hashes of its input and result, and returns the result', async () => {
    const { record, reports } = recorder()
    const onReceipt = vi.fn()
    const search = receipts({ recorder: record, onReceipt, now: clock() }).withReceipt(
      'search',
      'query',
      async (input: { q: string }) => ({ hits: [input.q] }),
    )
    expect(await search({ q: 'usdc' })).toEqual({ hits: ['usdc'] })
    expect(reports).toEqual([
      {
        server: 'search',
        tool: 'query',
        requestHash: hashOf({ q: 'usdc' }),
        responseHash: hashOf({ hits: ['usdc'] }),
        outcome: 'ok',
        startedAt: '2026-11-18T10:00:00.000Z',
        endedAt: '2026-11-18T10:00:01.000Z',
      },
    ])
    expect(onReceipt).toHaveBeenCalledWith(receipt)
  })

  it('reports a thrown error as "error" and rethrows it', async () => {
    const { record, reports } = recorder()
    const failing = receipts({ recorder: record }).withReceipt('db', 'write', async () => {
      throw new Error('disk full')
    })
    await expect(failing({})).rejects.toThrow('disk full')
    expect(reports[0]).toMatchObject({
      outcome: 'error',
      responseHash: hashOf({ error: 'disk full' }),
    })
  })

  it('reports a Refused call as "refused" and rethrows it', async () => {
    const { record, reports } = recorder()
    const declined = receipts({ recorder: record }).withReceipt('mail', 'send', async () => {
      throw new Refused('recipient not allowed')
    })
    await expect(declined({ to: 'x' })).rejects.toBeInstanceOf(Refused)
    expect(reports[0]?.outcome).toBe('refused')
  })

  it('fails closed when the receipt is not recorded, keeping the result', async () => {
    const { record } = recorder(true)
    const call = receipts({ recorder: record }).withReceipt('s', 't', async () => 42)
    const error: unknown = await call(undefined).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ReceiptError)
    expect((error as ReceiptError).result).toBe(42)
    expect((error as ReceiptError).message).toBe('s__t ran, but its receipt was not recorded.')
  })

  it('keeps the original error as the cause when an unrecorded call also threw', async () => {
    const { record } = recorder(true)
    const original = new Error('boom')
    const call = receipts({ recorder: record }).withReceipt('s', 't', async () => {
      throw original
    })
    const error: unknown = await call({}).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ReceiptError)
    expect((error as ReceiptError).cause).toBe(original)
  })

  it('reads GUARD_URL and AGENT_TOKEN when called without a recorder', async () => {
    vi.stubEnv('GUARD_URL', '')
    const call = withReceipt('s', 't', async () => 1)
    await expect(call({})).rejects.toThrow('needs GUARD_URL and AGENT_TOKEN')
    vi.unstubAllEnvs()
  })
})
