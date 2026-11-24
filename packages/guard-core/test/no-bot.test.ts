import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { openDb, schema } from '../src/db/client.js'
import { hashToken } from '../src/domain/auth.js'
import { buildServer } from '../src/http/server.js'
import { StubChain } from '../src/adapters/stub.js'
import {
  ADMIN_TOKEN,
  AGENT_TOKEN,
  basePolicy,
  BOT_TOKEN,
  CHAIN,
  MERCHANT,
  MINT,
  NOW,
} from './harness.js'

const BOT = { BOT_URL: 'http://bot.local', BOT_TOKEN, BOT_WEBHOOK_SECRET: 'c'.repeat(64) }

describe('the bot settings', () => {
  it.each([
    [{ BOT_URL: BOT.BOT_URL }, 'BOT_TOKEN, BOT_WEBHOOK_SECRET'],
    [{ BOT_TOKEN }, 'BOT_URL, BOT_WEBHOOK_SECRET'],
    [{ BOT_URL: BOT.BOT_URL, BOT_TOKEN }, 'BOT_WEBHOOK_SECRET'],
  ])('refuses a partial set and names what is missing', (set, missing) => {
    expect(() => loadConfig({ ADMIN_TOKEN, ...set })).toThrow(`invalid configuration: ${missing}`)
  })

  it('takes all three or none', () => {
    expect(() => loadConfig({ ADMIN_TOKEN })).not.toThrow()
    expect(() => loadConfig({ ADMIN_TOKEN, ...BOT })).not.toThrow()
  })
})

describe('guard-core without a bot', () => {
  async function server() {
    const db = openDb(':memory:')
    migrate(db, { migrationsFolder: 'migrations' })
    db.insert(schema.agents)
      .values({
        id: 'agent-1',
        name: 'agent-1',
        tokenHash: hashToken(AGENT_TOKEN),
        createdAt: NOW.toISOString(),
      })
      .run()
    db.insert(schema.policies)
      .values({ agentId: 'agent-1', ...basePolicy, updatedAt: NOW.toISOString() })
      .run()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'))
    const app = await buildServer({
      db,
      config: loadConfig({ ADMIN_TOKEN, LOG_LEVEL: 'fatal' }),
      chains: new Map([[CHAIN, new StubChain(CHAIN, 100_000_000n)]]),
      fetch,
      now: () => NOW,
    })
    return { app, db, fetch }
  }

  it('sends no webhook and records no failed request when it asks the owner', async () => {
    const { app, db, fetch } = await server()
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/transfer',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        agentId: 'agent-1',
        chain: CHAIN,
        token: MINT,
        amount: '3000000',
        recipient: MERCHANT,
        reason: 'pay',
      },
    })
    expect(res.json().status).toBe('pending_approval')
    expect(fetch).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
    const events = db
      .select()
      .from(schema.auditLog)
      .all()
      .map((row) => row.event)
    expect(events).toContain('approval_requested')
    expect(events).not.toContain('approval_request_failed')
    globalFetch.mockRestore()
  })

  it('has no /v1/bot routes', async () => {
    const { app } = await server()
    for (const url of ['/v1/bot/decision', '/v1/bot/pause', '/v1/bot/kill']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${BOT_TOKEN}` },
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    }
  })

  it('leaves the bot out of the doctor instead of failing it', async () => {
    const { app } = await server()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/doctor',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    const ids = res.json().checks.map((check: { id: string }) => check.id)
    expect(ids).not.toContain('bot')
    expect(ids).toContain('database')
  })
})
