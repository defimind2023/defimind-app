import type { LightMyRequestResponse } from 'fastify'
import type { KillTarget, Policy } from '@defimind/shared'
import type { PushService } from '../src/adapters/push.js'
import type { PublicKeys } from '../src/adapters/public-keys.js'
import type { ChainHost } from '../src/http/owner-settings.js'
import { CHAINS } from '@defimind/shared'
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { KeyObject } from 'node:crypto'
import { vi } from 'vitest'
import type { BotNotifier } from '../src/adapters/bot.js'
import { StubChain } from '../src/adapters/stub.js'
import { loadConfig } from '../src/config.js'
import { openDb, schema, type Db } from '../src/db/client.js'
import { hashToken } from '../src/domain/auth.js'
import { buildServer, type Server } from '../src/http/server.js'
import { Wallets, type WalletKeys } from '../src/service/wallets.js'

export const CHAIN = CHAINS.solanaDevnet
export const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
export const MERCHANT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
export const ADMIN_TOKEN = 'a'.repeat(64)
export const BOT_TOKEN = 'b'.repeat(64)
export const AGENT_TOKEN = 'agent-token-which-is-long-enough'
export const NOW = new Date('2026-11-03T12:00:00Z')
export const PASSKEY_RP = { id: 'guard.example', origin: 'https://guard.example' }

export const basePolicy: Omit<Policy, 'agentId'> = {
  chains: [CHAIN],
  tokens: [MINT],
  perTxMax: '5000000',
  dailyMax: '10000000',
  approvalThreshold: '2000000',
  allowedRecipients: [MERCHANT],
  allowedDomains: ['api.example.com'],
  paused: false,
}

export interface Harness {
  app: Server
  db: Db
  chain: StubChain
  bot: BotNotifier
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  clock: { now: Date }
  agent: (method: 'GET' | 'POST', url: string, payload?: object) => Promise<LightMyRequestResponse>
  asBot: (payload: object) => Promise<LightMyRequestResponse>
  auditEvents: (intentId?: string) => string[]
}

export async function harness(
  options: {
    policy?: Partial<Policy>
    balance?: bigint
    sweepMs?: number
    receiptKey?: KeyObject
    /** Most tests approve through the bot; the panel-only default has its own. */
    telegramApprovals?: 'true' | 'false'
    panelDir?: string
    /** Turns on the owner kill's signing-page links (CR-014). */
    signPage?: string
    killTargets?: KillTarget[]
    push?: { service: PushService; publicKey: string }
    /** Turns passkey approvals on at this amount, for the relying party in PASSKEY_RP. */
    passkeyAbove?: string
    /** More settings, over the defaults above. */
    env?: Record<string, string>
    keys?: PublicKeys
    /** Turns the owner's settings on (CR-019), rebuilding the chains with this. */
    build?: ChainHost['build']
    /** The chain the agent pays on; a plain StubChain by default. */
    chain?: StubChain
    /** Turns the agents' own wallets on (CR-022), with these keys and adapters. */
    walletKeys?: WalletKeys
  } = {},
): Promise<Harness> {
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
    .values({
      agentId: 'agent-1',
      ...basePolicy,
      ...options.policy,
      updatedAt: NOW.toISOString(),
    })
    .run()

  const chain = options.chain ?? new StubChain(CHAIN, options.balance ?? 100_000_000n)
  const bot: BotNotifier = {
    requestApproval: vi.fn(async () => {}),
    intentEvent: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
  }
  const fetchMock = vi.fn<typeof fetch>()
  const clock = { now: NOW }

  const config = loadConfig({
    ADMIN_TOKEN,
    BOT_TOKEN,
    BOT_URL: 'http://bot.local',
    BOT_WEBHOOK_SECRET: 'c'.repeat(64),
    LOG_LEVEL: 'fatal',
    TELEGRAM_APPROVALS: options.telegramApprovals ?? 'true',
    ...(options.panelDir === undefined ? {} : { PANEL_DIR: options.panelDir }),
    ...(options.signPage === undefined ? {} : { SIGN_PAGE_URL: options.signPage }),
    PASSKEY_RP_ID: PASSKEY_RP.id,
    PASSKEY_ORIGIN: PASSKEY_RP.origin,
    ...(options.passkeyAbove === undefined ? {} : { PASSKEY_ABOVE: options.passkeyAbove }),
    ...options.env,
  })
  const app = await buildServer({
    db,
    config,
    chains: new Map([[CHAIN, chain]]),
    bot,
    fetch: fetchMock,
    now: () => clock.now,
    ...(options.sweepMs === undefined ? {} : { sweepMs: options.sweepMs }),
    ...(options.receiptKey === undefined ? {} : { receiptKey: options.receiptKey }),
    ...(options.killTargets === undefined ? {} : { killTargets: options.killTargets }),
    ...(options.push === undefined ? {} : { push: options.push }),
    ...(options.keys === undefined ? {} : { keys: options.keys }),
    ...(options.build === undefined ? {} : { host: { env: config, build: options.build } }),
    ...(options.walletKeys === undefined ? {} : { wallets: new Wallets(db, options.walletKeys) }),
  })

  return {
    app,
    db,
    chain,
    bot,
    fetch: fetchMock,
    clock,
    agent: (method, url, payload) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        ...(payload === undefined ? {} : { payload }),
      }),
    asBot: (payload) =>
      app.inject({
        method: 'POST',
        url: '/v1/bot/decision',
        headers: { authorization: `Bearer ${BOT_TOKEN}` },
        payload,
      }),
    auditEvents: (intentId) =>
      db
        .select()
        .from(schema.auditLog)
        .all()
        .filter((row) => intentId === undefined || row.intentId === intentId)
        .map((row) => row.event),
  }
}

export function offer(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: CHAIN,
    asset: MINT,
    amount: '1000000',
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: { feePayer: 'FeePayer1111111111111111111111111111111111' },
    ...overrides,
  }
}

export function paymentRequired(accepts: PaymentRequirements[]): Response {
  const header = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: 'https://api.example.com/data' },
    accepts,
  })
  return new Response('{}', { status: 402, headers: { 'payment-required': header } })
}

export function paid(body = '{"data":42}', transaction = 'settledSignature'): Response {
  const header = encodePaymentResponseHeader({
    success: true,
    transaction,
    network: CHAIN,
  })
  return new Response(body, { status: 200, headers: { 'payment-response': header } })
}

export function spent(db: Db): bigint {
  return db
    .select()
    .from(schema.dailySpend)
    .all()
    .reduce((total, row) => total + BigInt(row.spent), 0n)
}

/** What the shadowed row of the audit says live would have done (CR-024). */
export const wouldHave = (h: Pick<Harness, 'db'>, intentId: string) =>
  h.db
    .select()
    .from(schema.auditLog)
    .all()
    .find((row) => row.intentId === intentId && row.event === 'shadowed')?.detail
