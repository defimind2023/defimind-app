import { generateKeyPairSync } from 'node:crypto'
import {
  type Db,
  buildServer as buildGuard,
  createAgent,
  loadConfig,
  migrateDb,
  openDb,
  StubChain,
} from '@defimind/guard-core'
import { createServer as createMcp, httpGuard } from '@defimind/mcp-server'
import type { PayIntent, Policy } from '@defimind/shared'
import { buildServer as buildBotHooks, httpGuardClient } from '@defimind/telegram-bot'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { pino } from 'pino'
import { SOLANA, type Net } from './paid-api.js'
import { telegram } from './telegram.js'
// The admin token only tightens (CR-022), so the suite writes its policies where the panel's
// passkey-checked route would: straight into the database.
import { putPolicy } from '../../../packages/guard-core/src/db/repo.js'
import { Wallets, type WalletKeys } from '../../../packages/guard-core/src/service/wallets.js'

const ADMIN_TOKEN = 'a'.repeat(64)
const BOT_TOKEN = 'b'.repeat(64)
export const WEBHOOK_SECRET = 'w'.repeat(64)
const AGENT = 'agent-1'
/** The relying party the panel's passkeys are bound to; requests carry it as their Origin. */
export const PANEL_RP = { id: 'guard.example', origin: 'https://guard.example' }

export const START = new Date('2026-11-03T12:00:00.000Z')

/** 2 USDC needs the owner; 5 USDC is the most one payment may be; 10 USDC a day. */
export function policy(
  overrides: Partial<Policy> = {},
  net: Net = SOLANA,
): Omit<Policy, 'agentId'> {
  return {
    chains: [net.chain],
    tokens: [net.token],
    perTxMax: '5000000',
    dailyMax: '10000000',
    approvalThreshold: '2000000',
    allowedRecipients: [],
    allowedDomains: ['127.0.0.1'],
    paused: false,
    // New agents start in shadow (CR-011), and a PUT that omits mode keeps it, so these runs say live.
    mode: 'live',
    ...overrides,
  }
}

/**
 * guard-core, telegram-bot and mcp-server wired together over real HTTP, as `pnpm dev:all` runs
 * them. Only the chain (a stub that signs nothing) and Telegram (recorded, not sent) are fake, and
 * one clock drives all three so expiry can be tested without waiting.
 */
export async function stack(
  options: {
    chain?: StubChain
    net?: Net
    panel?: boolean
    setupCode?: string
    /** CR-022: where agents' own wallets come from; without it every agent uses the shared one. */
    walletKeys?: WalletKeys
    /** guard-core's outbound fetch, for a test that plays a venue's HTTP API. */
    fetch?: typeof fetch
  } = {},
) {
  const net = options.net ?? SOLANA
  const log = pino({ level: 'silent' })
  const clock = { now: START }
  const now = () => clock.now

  // The bot's hooks have to be listening before guard-core is told where they are, and the bot
  // needs guard-core's address: its handlers are bound once both exist.
  const late: { tg?: ReturnType<typeof telegram> } = {}
  const hooks = await buildBotHooks({
    secret: WEBHOOK_SECRET,
    handlers: {
      approvalRequest: (request) => required(late.tg).desk.post(request),
      intentEvent: (event) => required(late.tg).desk.event(event),
      alert: (event) => required(late.tg).desk.alert(event),
    },
    logger: log,
  })
  const botUrl = await hooks.listen({ port: 0, host: '127.0.0.1' })

  const db = openDb(':memory:')
  migrateDb(db)
  const agentToken = createAgent(db, AGENT)
  const chain = options.chain ?? new StubChain(net.chain, 100_000_000n)
  const wallets = options.walletKeys && new Wallets(db, options.walletKeys)
  const config = loadConfig({
    ADMIN_TOKEN,
    BOT_TOKEN,
    BOT_URL: botUrl,
    BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    LOG_LEVEL: 'fatal',
    ...(options.setupCode === undefined ? {} : { SETUP_CODE: options.setupCode }),
    // The flows approve through the bot unless they test the panel, its default since CR-012.
    ...(options.panel
      ? { PASSKEY_RP_ID: PANEL_RP.id, PASSKEY_ORIGIN: PANEL_RP.origin }
      : { TELEGRAM_APPROVALS: 'true' }),
  })
  const guard = await buildGuard({
    db,
    config,
    chains: new Map([[chain.chain, chain]]),
    now,
    sweepMs: 20,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    // The settings and agent-wallet routes come with a chain host; nothing here changes the chain.
    ...(wallets === undefined
      ? {}
      : { wallets, host: { env: config, build: async () => new Map([[chain.chain, chain]]) } }),
    ...(options.panel ? { receiptKey: generateKeyPairSync('ed25519').privateKey } : {}),
  })
  const guardUrl = await guard.listen({ port: 0, host: '127.0.0.1' })

  const tg = telegram(httpGuardClient({ url: guardUrl, botToken: BOT_TOKEN }), now, log)
  late.tg = tg

  const mcp = createMcp({
    guard: httpGuard({ baseUrl: guardUrl, agentId: AGENT, token: agentToken }),
    log,
    defaultChain: net.chain,
  })
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)])

  async function admin(method: 'GET' | 'PUT' | 'POST', path: string, body?: object) {
    const response = await fetch(new URL(path, guardUrl), {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as unknown }
  }

  return {
    clock,
    chain,
    /** The database, for tests that run guard-core's own jobs against it. */
    db: db as Db,
    guard,
    guardUrl,
    botUrl,
    agentToken,
    telegram: tg,
    admin,
    setPolicy: (overrides: Partial<Policy> = {}, agentId = AGENT) =>
      putPolicy(db, { agentId, ...policy(overrides, net) }, clock.now.toISOString()),
    /** Calls an MCP tool the way an agent would, and returns the text it reads back. */
    async tool(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult
      return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
    },
    async intent(id: string): Promise<PayIntent> {
      const response = await fetch(new URL(`/v1/agent/intents/${id}`, guardUrl), {
        headers: { authorization: `Bearer ${agentToken}` },
      })
      return (await response.json()) as PayIntent
    },
    async close() {
      await client.close()
      await guard.close()
      await hooks.close()
    },
  }
}

export type Stack = Awaited<ReturnType<typeof stack>>

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('bot hooks called before the bot was built')
  }
  return value
}

/** The intent id an MCP tool result names, as the agent would read it. */
export function intentIdIn(text: string): string {
  const id = /Intent id: ([0-9a-f-]{36})/.exec(text)?.[1]
  if (id === undefined) {
    throw new Error(`no intent id in: ${text}`)
  }
  return id
}
