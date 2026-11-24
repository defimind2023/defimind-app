import { loadConfig } from '@defimind/guard-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offer, paidApi, type PaidApi } from './support/paid-api.js'
import { intentIdIn, stack, type Stack } from './support/stack.js'

/**
 * CR-022, the fixes from an independent review, end to end: guard-core, the bot and its Telegram
 * over real HTTP. The reviewer used the admin token to widen a policy and pay a "Thief"; here every
 * such attempt is refused, changes nothing, and reaches the owner as a possible attack.
 */

const ADMIN_ENV = { ADMIN_TOKEN: 'a'.repeat(64), LOG_LEVEL: 'fatal' }

let s: Stack

beforeEach(async () => {
  s = await stack()
  s.setPolicy()
})

afterEach(async () => {
  await s.close()
})

async function policyNow() {
  return (await s.admin('GET', '/v1/admin/policy/agent-1')).body
}

/** The refusal the owner reads in Telegram, once per attempt. */
async function attackAlerts() {
  return s.telegram.messages.filter((m) => m.text.includes('Possible attack blocked')).length
}

describe('the admin token only tightens (HIGH-1)', () => {
  it("refuses the reviewer's attack: a wider policy to pay a thief", async () => {
    const before = await policyNow()
    const res = await s.admin('PUT', '/v1/admin/policy/agent-1', {
      ...(before as object),
      perTxMax: '50000000',
      dailyMax: '50000000',
      allowedRecipients: ['DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'],
    })
    expect(res).toEqual({ status: 403, body: { error: 'loosen_in_panel' } })
    expect(await policyNow()).toEqual(before)
    await vi.waitFor(async () => expect(await attackAlerts()).toBe(1))
  })

  it('refuses going live and resuming, each with an alert', async () => {
    s.setPolicy({ mode: 'shadow', paused: true })
    const before = await policyNow()
    const live = await s.admin('PUT', '/v1/admin/policy/agent-1', {
      ...(before as object),
      mode: 'live',
    })
    const resume = await s.admin('POST', '/v1/admin/resume', { agentId: 'agent-1' })
    expect([live.status, resume.status]).toEqual([403, 403])
    expect(await policyNow()).toEqual(before)
    // The bot tells the owner once and holds back repeats of the same kind of alert.
    await vi.waitFor(async () => expect(await attackAlerts()).toBe(1))
  })

  it('still tightens: a lower limit, a pause and a kill go through', async () => {
    const before = (await policyNow()) as { perTxMax: string }
    const lower = await s.admin('PUT', '/v1/admin/policy/agent-1', {
      ...before,
      perTxMax: '1000000',
    })
    expect(lower.status).toBe(200)
    expect((await s.admin('POST', '/v1/admin/pause', { agentId: 'agent-1' })).status).toBe(200)
    expect((await s.admin('POST', '/v1/admin/kill', {})).status).toBe(200)
    expect(await attackAlerts()).toBe(0)
  })

  it('opens an admin mandate at or above the threshold for the owner, not active', async () => {
    const res = await s.admin('POST', '/v1/admin/mandates', {
      agentId: 'agent-1',
      budget: '3000000',
      domains: ['127.0.0.1'],
      ttlSeconds: 600,
      reason: 'e2e: admin mandate',
    })
    expect(res.body).toMatchObject({ status: 'pending_approval' })
  })
})

describe('one listener never serves the admin API publicly by accident (MEDIUM-1)', () => {
  it('refuses to start on every interface with the admin routes on', () => {
    expect(() => loadConfig({ ...ADMIN_ENV, HOST: '0.0.0.0' })).toThrow(/HOST/)
  })

  it('starts on loopback, behind a split listener, without the admin routes, or when told', () => {
    expect(() => loadConfig({ ...ADMIN_ENV, HOST: '127.0.0.1' })).not.toThrow()
    expect(() => loadConfig({ ...ADMIN_ENV, HOST: '0.0.0.0', PUBLIC_PORT: '8080' })).not.toThrow()
    expect(() => loadConfig({ ...ADMIN_ENV, HOST: '0.0.0.0', ADMIN_ROUTES: 'false' })).not.toThrow()
    expect(() =>
      loadConfig({ ...ADMIN_ENV, HOST: '0.0.0.0', ALLOW_PUBLIC_ADMIN: 'true' }),
    ).not.toThrow()
  })
})

describe('an approval pays only the request the owner saw (LOW-1)', () => {
  let api: PaidApi

  beforeEach(async () => {
    api = await paidApi()
    api.quote = [offer({ amount: '3000000' })]
  })

  afterEach(async () => {
    await api.close()
  })

  it('is not redeemed by another path, query or method, and is by the same request', async () => {
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())
    await s.telegram.press(id, 'approve')

    const other = await s.tool('paid_fetch', { url: `${api.url}?all=1` })
    expect(other).toContain(': pending_approval.')
    expect(intentIdIn(other)).not.toBe(id)
    expect(await s.tool('paid_fetch', { url: api.url, method: 'POST' })).toContain(
      ': pending_approval.',
    )
    expect(api.payments).toHaveLength(0)

    expect(await s.tool('paid_fetch', { url: api.url })).toContain(': executed.')
    expect(api.payments).toHaveLength(1)
    expect((await s.intent(id)).status).toBe('executed')
  })
})
