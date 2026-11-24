import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { CHAIN, harness, MERCHANT, MINT, type Harness } from './harness.js'
import { PANEL, signedIn } from './owner.js'
import { softAuthenticator } from './webauthn.js'

const pay = (h: Harness, amount = '3000000') =>
  h.agent('POST', '/v1/agent/transfer', {
    agentId: 'agent-1',
    chain: CHAIN,
    token: MINT,
    amount,
    recipient: MERCHANT,
    reason: 'pay the invoice',
  })

const openMandate = (h: Harness) =>
  h.agent('POST', '/v1/agent/mandates', {
    agentId: 'agent-1',
    budget: '3000000',
    domains: ['api.example.com'],
    recipients: [MERCHANT],
    ttlSeconds: 3600,
    reason: 'research task',
  })

let h: Harness
let owner: Awaited<ReturnType<typeof signedIn>>
beforeEach(async () => {
  h = await harness({ receiptKey: generateKeyPairSync('ed25519').privateKey })
  owner = await signedIn(h)
})

describe('owner panel routes', () => {
  it.each([
    ['GET', '/v1/owner/overview'],
    ['POST', '/v1/owner/challenge'],
    ['POST', `/v1/owner/intents/${crypto.randomUUID()}/decision`],
    ['POST', `/v1/owner/mandates/${crypto.randomUUID()}/decision`],
    ['GET', '/v1/owner/report'],
    ['GET', '/v1/owner/receipts'],
    ['GET', '/v1/owner/doctor'],
    ['GET', '/v1/owner/budget/agent-1'],
    ['GET', '/v1/owner/agents'],
    ['POST', '/v1/owner/agents'],
    ['POST', '/v1/owner/agents/agent-1/revoke'],
    ['GET', '/v1/owner/policy/agent-1'],
    ['PUT', '/v1/owner/policy/agent-1'],
    ['POST', '/v1/owner/pause'],
    ['POST', '/v1/owner/resume'],
    ['POST', '/v1/owner/kill'],
    ['GET', '/v1/owner/passkeys'],
  ] as const)('refuses %s %s without a session', async (method, url) => {
    const res = await h.app.inject({ method, url, headers: PANEL, payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'no_session' })
  })

  it('refuses a state change from a session without the panel header', async () => {
    const { cookie } = owner
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/owner/kill',
      headers: { cookie, origin: PANEL.origin },
    })
    expect(res.json()).toEqual({ error: 'bad_origin' })
    expect(h.auditEvents()).not.toContain('killed')
  })

  it('shows what waits for the owner, and drops it once decided', async () => {
    const intent = (await pay(h)).json()
    const mandate = (await openMandate(h)).json()
    const overview = (await owner.call('GET', '/v1/owner/overview')).json()
    expect(overview.pending.map((r: { intent: { id: string } }) => r.intent.id)).toEqual([
      intent.intentId,
    ])
    expect(overview.mandates.map((r: { mandate: { id: string } }) => r.mandate.id)).toEqual([
      mandate.id,
    ])
    expect(overview.agents[0].agentId).toBe('agent-1')
    expect(overview.chains[0].chain).toBe(CHAIN)
    await owner.call('POST', `/v1/owner/intents/${intent.intentId}/decision`, {
      decision: 'reject',
    })
    expect((await owner.call('GET', '/v1/owner/overview')).json().pending).toEqual([])
  })

  it('approves an intent only with a step-up for that intent, and records the passkey', async () => {
    const one = (await pay(h)).json().intentId
    const other = (await pay(h)).json().intentId
    const url = `/v1/owner/intents/${one}/decision`
    const bare = await owner.call('POST', url, { decision: 'approve' })
    expect(bare.statusCode).toBe(403)
    expect(bare.json()).toEqual({ error: 'step_up_required' })
    const forOther = await owner.stepUp('approve_intent', { intentId: other })
    expect(
      (await owner.call('POST', url, { decision: 'approve', assertion: forOther })).statusCode,
    ).toBe(401)
    const assertion = await owner.stepUp('approve_intent', { intentId: one })
    const done = await owner.call('POST', url, { decision: 'approve', assertion })
    expect(done.json().status).toBe('executed')
    const receipt = await h.agent('GET', `/v1/agent/intents/${one}/receipt`)
    expect(receipt.json().approvedBy).toBe('passkey')
    const listed = (await owner.call('GET', '/v1/owner/receipts')).json().receipts
    expect(listed).toEqual([receipt.json()])
  })

  it('refuses a step-up made for another action with the same body', async () => {
    const res = await owner.call('POST', '/v1/owner/resume', {
      agentId: 'agent-1',
      assertion: await owner.stepUp('create_agent', { agentId: 'agent-1' }),
    })
    expect(res.statusCode).toBe(401)
    expect(h.auditEvents()).toContain('step_up_refused')
  })

  it('refuses a step-up signed by a passkey that is not enrolled', async () => {
    const stranger = softAuthenticator('guard.example', 'https://guard.example')
    const assertion = await owner.stepUp('resume', { agentId: 'agent-1' }, stranger)
    expect(
      (await owner.call('POST', '/v1/owner/resume', { agentId: 'agent-1', assertion })).statusCode,
    ).toBe(401)
  })

  it('lets one step-up through once, even sent twice at once', async () => {
    const assertion = await owner.stepUp('create_agent', { agentId: 'bot-2' })
    const both = await Promise.all([
      owner.call('POST', '/v1/owner/agents', { agentId: 'bot-2', assertion }),
      owner.call('POST', '/v1/owner/agents', { agentId: 'bot-2', assertion }),
    ])
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 401])
    expect(both.find((r) => r.statusCode === 200)?.json().token).toEqual(expect.any(String))
  })

  it('approves a mandate with a step-up, and rejects one without', async () => {
    const first = (await openMandate(h)).json().id
    const second = (await openMandate(h)).json().id
    const assertion = await owner.stepUp('approve_mandate', { mandateId: first })
    const approved = await owner.call('POST', `/v1/owner/mandates/${first}/decision`, {
      decision: 'approve',
      assertion,
    })
    expect(approved.json().status).toBe('active')
    const rejected = await owner.call('POST', `/v1/owner/mandates/${second}/decision`, {
      decision: 'reject',
    })
    expect(rejected.json().status).toBe('revoked')
  })

  describe('policy changes', () => {
    const current = async () => (await owner.call('GET', '/v1/owner/policy/agent-1')).json()

    it('takes a tightening with the session alone', async () => {
      const policy = { ...(await current()), perTxMax: '1' }
      const res = await owner.call('PUT', '/v1/owner/policy/agent-1', { policy })
      expect(res.json().perTxMax).toBe('1')
    })

    it('needs a step-up over the exact policy to loosen it', async () => {
      const policy = { ...(await current()), perTxMax: '99000000' }
      const url = '/v1/owner/policy/agent-1'
      expect((await owner.call('PUT', url, { policy })).json()).toEqual({
        error: 'step_up_required',
      })
      const signed = await owner.stepUp('loosen_policy', { agentId: 'agent-1', policy })
      const swapped = { ...policy, perTxMax: '999000000' }
      expect(
        (await owner.call('PUT', url, { policy: swapped, assertion: signed })).statusCode,
      ).toBe(401)
      const assertion = await owner.stepUp('loosen_policy', { agentId: 'agent-1', policy })
      expect((await owner.call('PUT', url, { policy, assertion })).json().perTxMax).toBe('99000000')
    })

    it('treats unpausing through the policy as a loosening', async () => {
      await owner.call('POST', '/v1/owner/pause', { agentId: 'agent-1' })
      const policy = { ...(await current()), paused: false }
      expect((await owner.call('PUT', '/v1/owner/policy/agent-1', { policy })).statusCode).toBe(403)
    })
  })

  it('pauses with the session alone and resumes only with a step-up', async () => {
    expect((await owner.call('POST', '/v1/owner/pause', { agentId: 'agent-1' })).json()).toEqual({
      agentId: 'agent-1',
      paused: true,
    })
    const bare = { agentId: 'agent-1' }
    expect((await owner.call('POST', '/v1/owner/resume', bare)).statusCode).toBe(400)
    const assertion = await owner.stepUp('resume', { agentId: 'agent-1' })
    const res = await owner.call('POST', '/v1/owner/resume', { agentId: 'agent-1', assertion })
    expect(res.json().paused).toBe(false)
    expect(h.auditEvents()).toContain('resumed')
  })

  it('kills, reports and lists as the admin routes do', async () => {
    const kill = (await owner.call('POST', '/v1/owner/kill', {})).json()
    expect(kill.pausedAgents).toBe(1)
    expect(kill.ownerTransactions[0].chain).toBe(CHAIN)
    expect((await owner.call('GET', '/v1/owner/report')).json().agents[0].agentId).toBe('agent-1')
    expect((await owner.call('GET', '/v1/owner/receipts')).json()).toEqual({ receipts: [] })
    expect((await owner.call('GET', '/v1/owner/budget/agent-1')).statusCode).toBe(200)
    expect((await owner.call('GET', '/v1/owner/doctor')).json().checks.length).toBeGreaterThan(0)
    expect((await owner.call('GET', '/v1/owner/agents')).json().agents).toHaveLength(1)
    expect((await owner.call('POST', '/v1/owner/agents/agent-1/revoke')).json().revoked).toBe(true)
  })
})
