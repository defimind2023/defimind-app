import { describe, expect, it, vi } from 'vitest'
import { httpControlClient } from '../src/adapters/control.js'
import { CONFIRM_TTL_MS, Confirms } from '../src/domain/confirms.js'
import { hostname, parseDollars, raises } from '../src/domain/policy.js'
import { NOW, policy } from './support.js'

describe('parseDollars', () => {
  it.each([
    ['1', '1000000'],
    ['$12.50', '12500000'],
    ['0.000001', '1'],
    [' 3.5 ', '3500000'],
    ['999999999999.999999', '999999999999999999'],
  ])('%s is %s units', (dollars, units) => {
    expect(parseDollars(dollars)).toBe(units)
  })

  it.each(['-1', '1.0000001', '1e3', '', '.5', '1,50', '0x10'])('refuses %j', (bad) => {
    expect(parseDollars(bad)).toBeUndefined()
  })
})

describe('hostname', () => {
  it('lowercases a hostname and refuses anything else', () => {
    expect(hostname('API.Example.COM')).toBe('api.example.com')
    for (const bad of ['example', 'a_b.example.com', `${'a'.repeat(64)}.com`, 'x.-y.com', '']) {
      expect(hostname(bad)).toBeUndefined()
    }
  })
})

describe('raises', () => {
  it('names only the limits that went up', () => {
    const before = policy()
    expect(raises(before, { perTxMax: '2000001', dailyMax: '1' })).toEqual(['perTxMax'])
    expect(raises(before, { removeDomains: ['api.example.com'], mode: 'shadow' })).toEqual([])
  })
})

describe('Confirms', () => {
  it('gives a value back once, and not after its time', () => {
    let n = 0
    const confirms = new Confirms<string>(() => `id${n++}`)
    const a = confirms.add('a', NOW)
    const b = confirms.add('b', NOW, 1000)
    expect(confirms.take(a, NOW)).toBe('a')
    expect(confirms.take(a, NOW)).toBeUndefined()
    expect(confirms.take(b, new Date(NOW.getTime() + 1000))).toBeUndefined()
    const c = confirms.add('c', NOW)
    expect(confirms.take(c, new Date(NOW.getTime() + CONFIRM_TTL_MS))).toBeUndefined()
  })

  it('makes ids that fit in callback data', () => {
    const id = new Confirms<string>().add('x', NOW)
    expect(`own:${id}`.length).toBeLessThanOrEqual(64)
  })
})

describe('httpControlClient', () => {
  const json = (status: number, body: unknown) => Response.json(body, { status })
  function client(...responses: Response[]) {
    const fetch = vi.fn<typeof globalThis.fetch>()
    for (const response of responses) {
      fetch.mockResolvedValueOnce(response)
    }
    return { fetch, control: httpControlClient({ url: 'http://guard', botToken: 'BOT', fetch }) }
  }
  const sent = (fetch: ReturnType<typeof client>['fetch'], i = 0) => {
    const [url, init] = fetch.mock.calls[i] ?? []
    return {
      url,
      method: init?.method,
      body: init?.body,
      auth: new Headers(init?.headers).get('authorization'),
    }
  }

  it('lists, revokes and reads 404 as unknown, on the bot routes with the bot token', async () => {
    const { fetch, control } = client(
      json(200, { agents: [{ agentId: 'a', paused: false, mode: 'live' }] }),
      json(200, { agentId: 'a/1', revoked: true }),
      json(404, { error: 'not_found' }),
    )
    expect(await control.listAgents()).toEqual([{ agentId: 'a', paused: false, mode: 'live' }])
    expect(sent(fetch)).toMatchObject({ url: 'http://guard/v1/bot/agents', auth: 'Bearer BOT' })
    expect(await control.revokeAgent('a/1')).toBe(true)
    expect(sent(fetch, 1).url).toBe('http://guard/v1/bot/agents/a%2F1/revoke')
    expect(await control.revokeAgent('a')).toBe(false)
  })

  it('reads the policy and sends only the change to tighten it', async () => {
    const current = policy()
    const { fetch, control } = client(json(200, current), json(404, {}), json(200, current))
    expect(await control.policy('research-agent')).toEqual(current)
    expect(sent(fetch).url).toBe('http://guard/v1/bot/policy/research-agent')
    expect(await control.policy('ghost')).toBeUndefined()
    const change = { removeDomains: ['api.example.com'], perTxMax: '1' }
    expect(await control.tighten('research-agent', change)).toEqual(current)
    expect(sent(fetch, 2)).toMatchObject({
      url: 'http://guard/v1/bot/policy/research-agent/tighten',
      method: 'POST',
      body: JSON.stringify(change),
      auth: 'Bearer BOT',
    })
  })

  it('reads a refused loosening as such, and any other 403 as an error', async () => {
    const { control } = client(
      json(403, { error: 'loosen_in_panel' }),
      json(403, { error: 'unauthorized' }),
    )
    expect(await control.tighten('a', { perTxMax: '9' })).toBe('loosen_in_panel')
    await expect(control.tighten('a', { perTxMax: '9' })).rejects.toThrow()
  })

  it('reads the doctor checks, and throws on an error', async () => {
    const checks = [{ id: 'db', status: 'ok', message: 'Database writable' }]
    const { fetch, control } = client(json(200, { checks }), json(500, {}))
    expect(await control.doctor()).toEqual(checks)
    expect(sent(fetch).url).toBe('http://guard/v1/bot/doctor')
    await expect(control.doctor()).rejects.toThrow()
  })
})
