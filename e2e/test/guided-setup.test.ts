import {
  buildServer as buildGuard,
  loadConfig,
  migrateDb,
  openDb,
  StubChain,
} from '@defimind/guard-core'
import { createServer as createMcp, httpGuard } from '@defimind/mcp-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { softAuthenticator } from '../../packages/guard-core/test/webauthn.js'
import { offer, paidApi, SOLANA, type PaidApi } from './support/paid-api.js'
import { PANEL_RP, policy } from './support/stack.js'

// CR-019 end to end: a one-click deployment that starts with only ADMIN_TOKEN and SETUP_CODE, and an
// owner who reaches a live agent through the panel's API alone. No admin route, no bot, no shell.

const SETUP_CODE = 's'.repeat(44)
const HOT = '9'.repeat(44)
const PANEL = { origin: PANEL_RP.origin, 'x-defimind-request': '1' }

let api: PaidApi | undefined
let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await api?.close()
  await close?.()
})

async function deployment() {
  const config = loadConfig({
    ADMIN_TOKEN: 'a'.repeat(64),
    SETUP_CODE,
    ADMIN_ROUTES: 'false',
    PASSKEY_RP_ID: PANEL_RP.id,
    PASSKEY_ORIGIN: PANEL_RP.origin,
    LOG_LEVEL: 'fatal',
  })
  const db = openDb(':memory:')
  migrateDb(db)
  // The vault the owner signs in Phantom: the stub's limit names our hot wallet once it exists.
  const chain = new StubChain(SOLANA.chain, 100_000_000n)
  const guard = await buildGuard({
    db,
    config,
    chains: new Map(),
    keys: { hotWallets: [{ chain: SOLANA.chain, address: HOT }] },
    host: {
      env: config,
      build: async (next) =>
        next.SQUADS_MULTISIG === undefined ? new Map() : new Map([[chain.chain, chain]]),
    },
  })
  const url = await guard.listen({ port: 0, host: '127.0.0.1' })
  close = () => guard.close()
  return { guard, chain, url }
}

type Guard = Awaited<ReturnType<typeof deployment>>['guard']

/** The owner's browser: the passkey, the session cookie, and a step-up for each change. */
function browser(guard: Guard) {
  const device = softAuthenticator(PANEL_RP.id, PANEL_RP.origin)
  let cookie = ''
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await guard.inject({
      method,
      url,
      headers: { ...PANEL, cookie },
      ...(payload === undefined ? {} : { payload }),
    })
    return { status: res.statusCode, body: res.json<Record<string, unknown>>(), res }
  }
  return {
    call,
    async enrol(link: string) {
      const code = link.split('#code=')[1]
      const options = await call('POST', '/v1/owner/passkeys/options', { code })
      const registration = options.body['registration'] as { challenge: string }
      return call('POST', '/v1/owner/passkeys', {
        code,
        response: device.register(registration.challenge),
      })
    },
    async signIn() {
      const options = await call('POST', '/v1/owner/session/options')
      const res = await call('POST', '/v1/owner/session', {
        assertion: device.assert(String(options.body['challenge'])),
      })
      cookie = /dm_session=[^;]*/.exec(String(res.res.headers['set-cookie']))?.[0] ?? ''
      expect(cookie).not.toBe('')
    },
    async stepUp(action: string, body: object) {
      const step = await call('POST', '/v1/owner/challenge', { action, body })
      return device.assert(String(step.body['challenge']))
    },
  }
}

async function progress(owner: ReturnType<typeof browser>) {
  const { body } = await owner.call('GET', '/v1/owner/setup/progress')
  const steps = body['steps'] as { id: string; done: boolean }[]
  return steps.filter((step) => step.done).map((step) => step.id)
}

async function agent(url: string, agentId: string, token: string) {
  const mcp = createMcp({
    guard: httpGuard({ baseUrl: url, agentId, token }),
    log: pino({ level: 'silent' }),
    defaultChain: SOLANA.chain,
  })
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)])
  return async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
  }
}

describe('the guided setup, from a fresh deployment to a live agent (CR-019)', () => {
  it('takes the owner through every step with the panel alone', async () => {
    const { guard, chain, url } = await deployment()
    const owner = browser(guard)

    // First access: the code from the host's dashboard buys one enrol link, once.
    expect((await owner.call('GET', '/v1/owner/setup')).body).toEqual({ needsSetup: true })
    expect(
      (await owner.call('POST', '/v1/owner/setup', { setupCode: 'x'.repeat(44) })).status,
    ).toBe(401)
    const setup = await owner.call('POST', '/v1/owner/setup', { setupCode: SETUP_CODE })
    expect((await owner.enrol(String(setup.body['enrolLink']))).body).toEqual({ enrolled: true })
    expect((await owner.call('POST', '/v1/owner/setup', { setupCode: SETUP_CODE })).status).toBe(
      410,
    )
    await owner.signIn()
    expect(await progress(owner)).toEqual(['passkey'])

    // The vault: the owner names our hot wallet in its limit, then saves it with the passkey.
    const keys = await owner.call('GET', '/v1/owner/keys')
    expect(keys.body['hotWallets']).toEqual([{ chain: SOLANA.chain, address: HOT }])
    const chains = [{ chain: SOLANA.chain, vault: 'M'.repeat(44) }]
    const saved = await owner.call('PUT', '/v1/owner/settings', {
      chains,
      assertion: await owner.stepUp('change_settings', { chains }),
    })
    expect(saved.status).toBe(200)
    expect(await progress(owner)).toEqual(['passkey', 'vault', 'limit'])

    chain.vaultBalance = 20_000_000n
    const deposit = await owner.call('GET', '/v1/owner/deposit')
    expect(deposit.body['chains']).toEqual([
      expect.objectContaining({ chain: SOLANA.chain, balance: '20000000', dailyCap: '100000000' }),
    ])

    // The agent and its rules. New agents start in shadow mode, so nothing moves yet.
    const created = await owner.call('POST', '/v1/owner/agents', {
      agentId: 'my-agent',
      assertion: await owner.stepUp('create_agent', { agentId: 'my-agent' }),
    })
    const token = String(created.body['token'])
    const rules = policy({ mode: 'shadow' })
    const put = (next: object) =>
      owner
        .stepUp('loosen_policy', { agentId: 'my-agent', policy: next })
        .then((assertion) =>
          owner.call('PUT', '/v1/owner/policy/my-agent', { policy: next, assertion }),
        )
    expect((await put(rules)).status).toBe(200)

    api = await paidApi()
    api.quote = [offer({ amount: '1000000' })]
    const tool = await agent(url, 'my-agent', token)
    await tool('paid_fetch', { url: api.url })
    expect(api.payments).toHaveLength(0)
    expect(await progress(owner)).toEqual([
      'passkey',
      'vault',
      'limit',
      'deposit',
      'agent',
      'rules',
      'shadow',
    ])

    // Live: the same call now pays, within the rules and the vault's limit.
    expect((await put({ ...rules, mode: 'live' })).status).toBe(200)
    expect(await tool('paid_fetch', { url: api.url })).toContain(': executed.')
    expect(api.payments).toHaveLength(1)
    expect(await progress(owner)).toContain('live')

    // A one-click deployment serves no admin route at all.
    const admin = await guard.inject({
      method: 'GET',
      url: '/v1/admin/agents',
      headers: { authorization: `Bearer ${'a'.repeat(64)}` },
    })
    expect(admin.statusCode).toBe(404)
  })
})
