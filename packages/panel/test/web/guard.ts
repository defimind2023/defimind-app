import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { CHAINS, getAddress } from '@defimind/shared'
import { canonicalJson } from '../../src/domain/canonical.js'
import { setupMock } from './setup.js'
import { tradingMock } from './trading.js'
import { walletsMock } from './wallets.js'

/** SPEC's panel CSP, so a test fails on anything the real one would block. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
}

const chain = CHAINS.baseSepolia
const usd = getAddress(chain, 'usd')!
const b64 = (bytes: Buffer) => bytes.toString('base64url')

export interface Decision {
  kind: 'intent' | 'mandate'
  id: string
  decision: string
  /** The step-up action and body the assertion's challenge was issued for. */
  stepUp?: { action: string; body: unknown }
}

/**
 * guard-core's owner routes as SPEC words them, holding just enough state for the flows. It checks
 * what the panel must get right: the session cookie, X-DefiMind-Request and Origin on writes, and
 * that each step-up assertion signs a challenge issued for that exact action and body.
 */
export async function guardCore(
  dist: string,
  { fresh = false, trading = false, wallets = false } = {},
) {
  const setup = setupMock()
  const intentId = randomUUID()
  const mandateId = randomUUID()
  const later = new Date(Date.now() + 10 * 60_000).toISOString()
  // CR-021 only where a test asks for it: every other flow sees a guard-core without trading.
  const trades = trading ? tradingMock(later) : undefined
  const agentWallets = wallets ? walletsMock(() => origin) : undefined
  const state = {
    passkeys: 0,
    sessions: new Set<string>(),
    challenges: new Map<string, { action: string; body: unknown } | null>(),
    decisions: [] as Decision[],
    puts: [] as { policy: Record<string, unknown>; stepUp?: { action: string; body: unknown } }[],
    killed: false,
    /** CR-019: a fresh deployment starts with no agent; the guide creates one. */
    agents: fresh ? [] : [{ agentId: 'research-bot', mode: 'live' }],
    tokens: [] as { agentId: string; stepUp?: { action: string; body: unknown } }[],
    /** guard-core's answer to an assertion it cannot verify, for the next decision. */
    refuseNextPasskey: false,
    /** GC-68: what live would have asked, on the budget's shadow summary. */
    shadowAsked: undefined as { count: number; flags: string[] } | undefined,
    /** CR-013: the first receipt that no longer holds, as guard-core's integrity check reports it. */
    brokenAt: undefined as number | undefined,
    policy: {
      agentId: 'research-bot',
      chains: [chain],
      tokens: [usd],
      perTxMax: '1000000',
      dailyMax: '5000000',
      approvalThreshold: '2000000',
      allowedRecipients: [],
      allowedDomains: ['api.example.com'],
      paused: false,
      mode: fresh ? 'shadow' : 'live',
    } as Record<string, unknown>,
  }
  let origin = ''

  // Two receipts, the first anchored: a relayed tool call and a payment guard-core made itself.
  const receipt = (seq: number, extra: Record<string, unknown>) => ({
    type: 'defimind.execution.v1',
    seq,
    prevHash: (seq === 1 ? '0' : 'a').repeat(64),
    agentId: 'research-bot',
    requestHash: 'c'.repeat(64),
    responseHash: 'd'.repeat(64),
    startedAt: later,
    endedAt: later,
    issuedAt: later,
    hash: String(seq).repeat(64),
    signature: 'e'.repeat(128),
    ...extra,
  })
  // The CR-010 receipt of execution #2, as GET /v1/owner/receipts returns it; #2 names it by hash.
  const payment = {
    intent: {
      id: randomUUID(),
      agentId: 'research-bot',
      chain,
      token: usd,
      amount: '1750000',
      status: 'executed',
    },
    policyHash: 'p'.repeat(64),
    simulation: 'Pays 1.75 USDC.',
    approvedBy: 'policy',
    issuedAt: later,
    signature: 's'.repeat(128),
  }
  const paymentHash = createHash('sha256').update(canonicalJson(payment)).digest('hex')
  const receipts = [
    receipt(1, {
      kind: 'tool_call',
      server: 'github',
      tool: 'create_issue',
      outcome: 'ok',
      assurance: 'relayed',
    }),
    receipt(2, {
      kind: 'payment',
      server: 'defimind',
      tool: 'paid_fetch',
      outcome: 'refused',
      assurance: 'executed',
      paymentReceipt: paymentHash,
    }),
  ]
  const executionAnchor = {
    fromSeq: 1,
    toSeq: 1,
    root: '1'.repeat(64),
    chain: CHAINS.solanaDevnet,
    txId: '5'.repeat(88),
    anchoredAt: later,
  }

  const overview = () => ({
    // A fresh deployment has no vault, so no chain to draw on yet.
    chains: fresh
      ? []
      : [
          {
            chain,
            allowance: { status: 'active', cap: '5000000', spent: '1250000', resetsAt: later },
          },
        ],
    agents: state.agents.map(({ agentId }) => ({
      agentId,
      paused: state.killed,
      mode: state.policy['mode'],
    })),
    pending: [
      ...(trades === undefined || state.decisions.some((d) => d.id === trades.intentId)
        ? []
        : [trades.pending()]),
      ...(state.decisions.some((d) => d.id === intentId)
        ? []
        : [
            {
              intent: {
                id: intentId,
                agentId: 'research-bot',
                kind: 'x402',
                chain,
                token: usd,
                amount: '2500000',
                recipient: '0x1111111111111111111111111111111111111111',
                domain: 'api.example.com',
                reason: 'Buy the market report',
                status: 'pending_approval',
                expiresAt: later,
              },
              simulation: { summary: 'Pays 2.5 USDC to the API.' },
              approveBefore: later,
              flags: ['first payment to this domain'],
            },
          ]),
    ],
    mandates: state.decisions.some((d) => d.id === mandateId)
      ? []
      : [
          {
            mandate: {
              id: mandateId,
              agentId: 'research-bot',
              budget: '3000000',
              spent: '0',
              domains: ['api.example.com'],
              recipients: [],
              reason: 'Research task',
              status: 'pending_approval',
              expiresAt: later,
            },
            approveBefore: later,
            ttlSeconds: 3600,
          },
        ],
  })

  function issue(bound: { action: string; body: unknown } | null) {
    const challenge = b64(randomBytes(32))
    state.challenges.set(challenge, bound)
    return { challenge, rpId: 'localhost', userVerification: 'required', timeout: 60_000 }
  }

  /** The challenge the assertion signed, spent; undefined when it was never issued. */
  function redeem(assertion: unknown) {
    const data = (assertion as { response?: { clientDataJSON?: string } } | undefined)?.response
    if (!data?.clientDataJSON) {
      return undefined
    }
    const client = JSON.parse(Buffer.from(data.clientDataJSON, 'base64url').toString()) as {
      challenge: string
      origin: string
    }
    if (client.origin !== origin || !state.challenges.has(client.challenge)) {
      return undefined
    }
    const bound = state.challenges.get(client.challenge)
    state.challenges.delete(client.challenge)
    return { bound }
  }

  async function owner(
    method: string,
    path: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ) {
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(data))
    }
    const stepUp = () => redeem(body['assertion'])?.bound ?? undefined

    if (path === '/v1/owner/passkeys/options') {
      return send(200, {
        registration: {
          challenge: issue(null).challenge,
          rp: { id: 'localhost', name: 'DefiMind' },
          user: { id: b64(randomBytes(16)), name: 'owner', displayName: 'Owner' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        },
        ...(state.passkeys > 0 ? { stepUp: issue(null) } : {}),
      })
    }
    if (path === '/v1/owner/passkeys' && method === 'GET') {
      const at = new Date().toISOString()
      const ids = Array.from({ length: state.passkeys }, (_, i) => `credential-${i}`)
      return send(200, { passkeys: ids.map((id) => ({ id, createdAt: at, lastUsedAt: null })) })
    }
    if (path === '/v1/owner/passkeys' && method === 'POST') {
      if (state.passkeys > 0 && redeem(body['assertion']) === undefined) {
        return send(409, { error: 'step_up_required' })
      }
      state.passkeys++
      return send(200, { enrolled: true })
    }
    if (path === '/v1/owner/session/options') {
      return send(200, issue(null))
    }
    if (path === '/v1/owner/session') {
      if (redeem(body['assertion']) === undefined) {
        return send(401, { error: 'bad_assertion' })
      }
      const id = b64(randomBytes(24))
      state.sessions.add(id)
      return send(
        200,
        { expiresAt: later },
        {
          'set-cookie': `dm_session=${id}; HttpOnly; SameSite=Strict; Path=/v1/owner`,
        },
      )
    }
    if (path === '/v1/owner/challenge') {
      return send(200, issue({ action: String(body['action']), body: body['body'] }))
    }
    if (method === 'GET' && path === '/v1/owner/overview') {
      return send(200, overview())
    }
    const decision = /^\/v1\/owner\/(intents|mandates)\/([^/]+)\/decision$/.exec(path)
    if (decision) {
      if (state.refuseNextPasskey && body['assertion'] !== undefined) {
        state.refuseNextPasskey = false
        return send(401, { error: 'passkey_not_verified' })
      }
      const bound = stepUp()
      if (body['decision'] === 'approve' && bound === undefined) {
        return send(403, { error: 'step_up_required' })
      }
      state.decisions.push({
        kind: decision[1] === 'intents' ? 'intent' : 'mandate',
        id: decision[2]!,
        decision: String(body['decision']),
        ...(bound ? { stepUp: bound } : {}),
      })
      return send(200, {})
    }
    if (path === '/v1/owner/agents' && method === 'POST') {
      const bound = stepUp()
      if (bound?.action !== 'create_agent') {
        return send(403, { error: 'step_up_required' })
      }
      const agentId = String(body['agentId'])
      state.agents.push({ agentId, mode: 'shadow' })
      // As guard-core makes it: deny-all until the owner opens chains, tokens and amounts.
      state.policy = {
        agentId,
        chains: [],
        tokens: [],
        perTxMax: '0',
        dailyMax: '0',
        approvalThreshold: '0',
        allowedRecipients: [],
        allowedDomains: [],
        paused: false,
        mode: 'shadow',
      }
      state.tokens.push({ agentId, stepUp: bound })
      return send(200, { agentId, token: b64(randomBytes(32)) })
    }
    if (path === '/v1/owner/agents') {
      return send(200, { agents: overview().agents })
    }
    if (path === '/v1/owner/setup/progress') {
      const done = {
        passkey: state.passkeys > 0,
        vault: setup.state.vault !== undefined,
        limit: setup.state.vault !== undefined,
        deposit: setup.state.balance !== '0',
        agent: state.agents.length > 0,
        // guard-core counts the rules only once the agent may pay somewhere.
        rules:
          state.agents.length > 0 &&
          (state.policy['chains'] as string[]).length > 0 &&
          state.policy['dailyMax'] !== '0',
        shadow: state.puts.length > 0,
        live: state.policy['mode'] === 'live',
      }
      return send(200, { steps: Object.entries(done).map(([id, ok]) => ({ id, done: ok })) })
    }
    if (setup.route(method, path, body, send, stepUp, { passkeys: state.passkeys, origin })) {
      return
    }
    if (trades?.route(method, path, body, send, stepUp)) {
      return
    }
    if (agentWallets?.route(method, path, body, send, stepUp)) {
      return
    }
    if (path.startsWith('/v1/owner/policy/')) {
      if (method === 'PUT') {
        const bound = stepUp()
        state.policy = body['policy'] as Record<string, unknown>
        state.puts.push({ policy: state.policy, ...(bound ? { stepUp: bound } : {}) })
      }
      return send(200, state.policy)
    }
    if (path.startsWith('/v1/owner/budget/')) {
      return send(200, {
        ...(state.shadowAsked === undefined
          ? {}
          : { shadow: { since: later, total: '4000000', count: 3, asked: state.shadowAsked } }),
        spentToday: '1250000',
        dailyMax: state.policy['dailyMax'],
        perTxMax: state.policy['perTxMax'],
        paused: false,
      })
    }
    if (path === '/v1/owner/receipts') {
      return send(200, { receipts: [payment] })
    }
    if (path === '/v1/owner/executions') {
      return send(200, { receipts })
    }
    if (path === '/v1/owner/executions/integrity') {
      return send(200, {
        lastSeq: receipts.length,
        lastHash: receipts.at(-1)?.hash,
        ...(state.brokenAt === undefined ? {} : { brokenAt: state.brokenAt }),
        lastAnchor: executionAnchor,
      })
    }
    const proof = /^\/v1\/owner\/executions\/(\d+)\/proof$/.exec(path)
    if (proof) {
      const receipt = receipts[Number(proof[1]) - 1]
      return receipt && receipt.seq <= executionAnchor.toSeq
        ? send(200, {
            receipt,
            siblings: [{ side: 'right', hash: 'b'.repeat(64) }],
            anchor: executionAnchor,
          })
        : send(404, { error: 'not_found' })
    }
    if (path === '/v1/owner/kill') {
      state.killed = true
      return send(200, {
        pausedAgents: 1,
        ownerTransactions: [
          {
            chain,
            description: 'Set the allowance to 0 and remove the delegate.',
            payload: { to: '0x1' },
            link: 'https://phantom.app/ul/browse/x',
          },
          {
            chain: CHAINS.solanaDevnet,
            description: 'Could not build the kill transaction.',
            payload: null,
          },
        ],
      })
    }
    return send(404, { error: 'not_found' })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname.startsWith('/v1/owner/')) {
      const method = req.method ?? 'GET'
      let raw = ''
      for await (const chunk of req) {
        raw += String(chunk)
      }
      if (
        method !== 'GET' &&
        (req.headers['x-defimind-request'] !== '1' || req.headers.origin !== origin)
      ) {
        res.writeHead(403, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'bad_origin' }))
      }
      const open =
        [
          '/v1/owner/session',
          '/v1/owner/session/options',
          '/v1/owner/passkeys/options',
          '/v1/owner/setup',
        ].includes(url.pathname) ||
        (url.pathname === '/v1/owner/passkeys' && method === 'POST')
      const cookie = /dm_session=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (!open && !(cookie && state.sessions.has(cookie))) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'no_session' }))
      }
      return owner(method, url.pathname, raw ? JSON.parse(raw) : {}, res)
    }
    if (url.pathname === '/panel') {
      res.writeHead(308, { location: '/panel/' })
      return res.end()
    }
    const file = normalize(url.pathname.replace(/^\/panel\/?/, '')).replace(/^(\.\.[/\\])+/, '')
    const known = file !== '.' && TYPES[extname(file)] !== undefined
    const body = await readFile(join(dist, known ? file : 'index.html')).catch(() => undefined)
    if (body === undefined || !url.pathname.startsWith('/panel')) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200, {
      'content-type': TYPES[known ? extname(file) : '.html']!,
      'content-security-policy': CSP,
      'cache-control': 'no-cache',
    })
    res.end(body)
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  origin = `http://localhost:${(server.address() as AddressInfo).port}`
  return {
    origin,
    state,
    receipts,
    setup: setup.state,
    trading: trades,
    wallets: agentWallets,
    intentId,
    mandateId,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
