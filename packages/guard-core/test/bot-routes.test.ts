import { beforeEach, describe, expect, it } from 'vitest'
import { schema } from '../src/db/client.js'
import { ADMIN_TOKEN, BOT_TOKEN, harness, MERCHANT, type Harness } from './harness.js'

const as = (
  h: Harness,
  token: string | undefined,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  })
const bot = (h: Harness, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  as(h, BOT_TOKEN, method, url, payload)
const tighten = (h: Harness, payload: object) =>
  bot(h, 'POST', '/v1/bot/policy/agent-1/tighten', payload)

let h: Harness
beforeEach(async () => {
  h = await harness({
    policy: {
      allowedDomains: ['api.example.com', 'old.example.com'],
      allowedRecipients: [MERCHANT],
    },
  })
})

describe('the bot routes that only tighten or read', () => {
  const routes = [
    ['POST', '/v1/bot/pause', { agentId: 'agent-1' }],
    ['POST', '/v1/bot/kill', {}],
    ['POST', '/v1/bot/agents/agent-1/revoke', {}],
    ['POST', '/v1/bot/policy/agent-1/tighten', {}],
    ['GET', '/v1/bot/agents', undefined],
    ['GET', '/v1/bot/policy/agent-1', undefined],
    ['GET', '/v1/bot/budget/agent-1', undefined],
    ['GET', '/v1/bot/chains', undefined],
    ['GET', '/v1/bot/report', undefined],
    ['GET', '/v1/bot/doctor', undefined],
  ] as const

  it.each(routes)(
    '%s %s refuses the admin token and no token, and takes the bot token',
    async (method, url, body) => {
      expect((await as(h, ADMIN_TOKEN, method, url, body)).statusCode).toBe(401)
      expect((await as(h, undefined, method, url, body)).statusCode).toBe(401)
      expect((await bot(h, method, url, body)).statusCode).toBe(200)
    },
  )

  it('pauses, kills and revokes, audited as the bot', async () => {
    expect((await bot(h, 'POST', '/v1/bot/pause', { agentId: 'agent-1' })).json().paused).toBe(true)
    expect((await bot(h, 'POST', '/v1/bot/kill', {})).json().pausedAgents).toBe(1)
    expect((await bot(h, 'POST', '/v1/bot/agents/agent-1/revoke', {})).json().revoked).toBe(true)
    const vias = h.db
      .select()
      .from(schema.auditLog)
      .all()
      .filter((row) => ['paused', 'killed', 'agent_revoked'].includes(row.event))
      .map((row) => (row.detail as { via?: string }).via)
    expect(vias).toEqual(['bot', 'bot', 'bot'])
  })

  it('narrows a policy: removes entries, lowers limits, goes to shadow', async () => {
    const res = await tighten(h, {
      removeDomains: ['old.example.com'],
      removeRecipients: [MERCHANT],
      perTxMax: '1',
      mode: 'shadow',
    })
    expect(res.json()).toMatchObject({
      allowedDomains: ['api.example.com'],
      allowedRecipients: [],
      perTxMax: '1',
      mode: 'shadow',
    })
  })

  it.each(['perTxMax', 'dailyMax', 'approvalThreshold'])('refuses %s raised', async (limit) => {
    const res = await tighten(h, { [limit]: '999999999999' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'loosen_in_panel' })
  })

  it.each([
    ['going live', { mode: 'live' }],
    ['adding a domain', { addDomains: ['evil.example'] }],
    ['unpausing', { paused: false }],
    ['dropping the mandate requirement', { requireMandate: false }],
    ['a higher breaker limit', { maxPaymentsPerMinute: 1000 }],
  ])('refuses %s, which it has no field for', async (_case, body) => {
    expect((await tighten(h, body)).statusCode).toBe(400)
  })

  it.each([
    ['POST', '/v1/bot/agents'],
    ['POST', '/v1/bot/resume'],
    ['POST', '/v1/bot/passkeys/code'],
    ['PUT', '/v1/bot/policy/agent-1'],
    ['POST', '/v1/bot/mandates'],
  ] as const)(
    'has no %s %s: nothing under /v1/bot creates, allows, raises, resumes or issues codes',
    async (method, url) => {
      expect((await bot(h, method, url, { agentId: 'agent-1' })).statusCode).toBe(404)
    },
  )
})
