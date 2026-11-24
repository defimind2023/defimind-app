import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTACKER, offer, paidApi, type PaidApi } from './support/paid-api.js'
import { intentIdIn, stack, type Stack } from './support/stack.js'

// CR-010 end to end, through the MCP server: the protections beyond the limits, each one tried the
// way an attacker would, against guard-core, the bot and the agent wired together.

let s: Stack
let api: PaidApi

beforeEach(async () => {
  s = await stack()
  api = await paidApi()
  s.setPolicy()
})

afterEach(async () => {
  await api.close()
  await s.close()
})

const fetchPaid = (args: Record<string, unknown> = {}) =>
  s.tool('paid_fetch', { url: api.url, ...args })

/** The reject codes the agent was told, as the MCP tool listed them. */
const codes = (text: string) => [...text.matchAll(/^- ([A-Z0-9_]+):/gm)].map((m) => m[1] ?? '')

describe('recipient and price pinning', () => {
  it('sends a site that starts paying someone else to the owner, even below the threshold', async () => {
    expect(await fetchPaid()).toContain(': executed.')
    api.quote = [offer({ payTo: ATTACKER })]
    const id = intentIdIn(await fetchPaid())
    expect((await s.intent(id)).status).toBe('pending_approval')
    expect(api.payments).toHaveLength(1)
  })

  it('sends a price far above the last one paid to the owner', async () => {
    api.quote = [offer({ amount: '500000' })]
    expect(await fetchPaid()).toContain(': executed.')
    api.quote = [offer({ amount: '1500000' })]
    const id = intentIdIn(await fetchPaid())
    expect((await s.intent(id)).status).toBe('pending_approval')
    expect(api.payments).toHaveLength(1)
  })
})

describe('task budgets', () => {
  it('refuses a payment with no budget, pays inside one, and refuses what would pass it', async () => {
    s.setPolicy({ requireMandate: true })
    expect(codes(await fetchPaid())).toEqual(['MANDATE_REQUIRED'])

    const opened = await s.tool('start_task', {
      budgetUsd: '1.50',
      domains: ['127.0.0.1'],
      minutes: 10,
      reason: 'e2e: one paid lookup',
    })
    const mandateId = /([0-9a-f-]{36})/.exec(opened)?.[1]
    expect(mandateId, opened).toBeDefined()

    expect(await fetchPaid({ mandateId })).toContain(': executed.')
    expect(codes(await fetchPaid({ mandateId }))).toEqual(['MANDATE_EXCEEDED'])
    expect(api.payments).toHaveLength(1)
  })
})

describe('the circuit breaker', () => {
  it('pauses the agent on the payment that would pass the rate, and pays nothing more', async () => {
    s.setPolicy({ maxPaymentsPerMinute: 2 })
    api.quote = [offer({ amount: '100000' })]
    expect(await fetchPaid()).toContain(': executed.')
    expect(await fetchPaid()).toContain(': executed.')
    expect(codes(await fetchPaid())).toEqual(['BREAKER_TRIPPED'])

    // Paused now: the next one is refused for that, not for the rate.
    expect(codes(await fetchPaid())).toEqual(['PAUSED'])
    expect(api.payments).toHaveLength(2)
  })
})
