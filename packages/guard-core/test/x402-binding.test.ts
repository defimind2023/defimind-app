import { describe, expect, it } from 'vitest'
import { requestHash } from '../src/service/x402.js'
import { harness, offer, paid, paymentRequired, type Harness } from './harness.js'

const URL = 'https://api.example.com/data?q=1'

/** A 402 for 2.5 USDC, above the threshold, so the first call waits for the owner. */
async function approvedOnce(h: Harness, request: object) {
  h.fetch.mockImplementation(async (_url, init) =>
    new Headers(init?.headers).has('payment-signature')
      ? paid()
      : paymentRequired([offer({ amount: '2500000' })]),
  )
  const pending = await h.agent('POST', '/v1/agent/x402/fetch', { agentId: 'agent-1', ...request })
  expect(pending.json().status).toBe('pending_approval')
  await h.asBot({ intentId: pending.json().intentId, decision: 'approve', telegramUserId: '1' })
  return pending.json().intentId as string
}

const fetchAs = (h: Harness, request: object) =>
  h.agent('POST', '/v1/agent/x402/fetch', { agentId: 'agent-1', ...request })

describe('an x402 approval covers its exact request (CR-022)', () => {
  it('is redeemed by the same method, URL and body', async () => {
    const h = await harness()
    const request = { url: URL, method: 'POST', body: '{"n":1}' }
    const id = await approvedOnce(h, request)
    expect((await fetchAs(h, request)).json()).toMatchObject({ status: 'executed', intentId: id })
  })

  it.each([
    ['another query', { url: 'https://api.example.com/data?q=2', method: 'POST', body: '{"n":1}' }],
    ['another body', { url: URL, method: 'POST', body: '{"n":2}' }],
    ['another method', { url: URL, method: 'PUT', body: '{"n":1}' }],
  ])('is not redeemed by %s, which is a new intent', async (_case, other) => {
    const h = await harness()
    const id = await approvedOnce(h, { url: URL, method: 'POST', body: '{"n":1}' })
    const res = (await fetchAs(h, other)).json()
    expect(res).toMatchObject({ status: 'pending_approval' })
    expect(res.intentId).not.toBe(id)
  })

  it('hashes the method, the full URL and the body, and nothing else', () => {
    const base = { method: 'GET' as const, url: URL }
    expect(requestHash(base)).toBe(requestHash({ ...base, body: '' }))
    expect(requestHash(base)).not.toBe(requestHash({ ...base, url: `${URL}&x=1` }))
    expect(requestHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
