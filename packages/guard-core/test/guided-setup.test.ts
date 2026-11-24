import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { readEvmKeyFile, readKeypairFile, readReceiptKeyFile } from '../src/adapters/keypair.js'
import { keysDir, withKeys } from '../src/adapters/keystore.js'
import { publicKeys } from '../src/adapters/public-keys.js'
import { readVapidKeyFile } from '../src/adapters/push.js'
import { buildChains } from '../src/chains.js'
import { loadConfig } from '../src/config.js'
import { applySettings } from '../src/domain/settings.js'
import { ADMIN_TOKEN, harness, PASSKEY_RP, type Harness } from './harness.js'
import { PANEL, signedIn } from './owner.js'
import { softAuthenticator } from './webauthn.js'

const SETUP_CODE = 's'.repeat(40)
const mode = (path: string) => statSync(path).mode & 0o777

describe('keys made on the server (CR-019)', () => {
  const fresh = () => mkdtempSync(join(tmpdir(), 'guard-keys-'))

  it('makes each missing key once, in a 0700 directory, as 0600 files its reader takes', async () => {
    const dir = join(fresh(), 'keys')
    const config = await withKeys(
      loadConfig({ ADMIN_TOKEN, BASE_CHAIN: 'eip155:84532', ROBINHOOD_CHAIN: 'eip155:46630' }),
      [],
      dir,
    )
    expect(mode(dir)).toBe(0o700)
    const files = [
      config.SOLANA_HOT_WALLET_KEYPAIR,
      config.BASE_HOT_WALLET_KEY_FILE,
      config.ROBINHOOD_HOT_WALLET_KEY_FILE,
      config.RECEIPT_SIGNING_KEY_FILE,
      config.VAPID_PRIVATE_KEY_FILE,
      config.ANCHOR_KEY_FILE,
    ].map(String)
    for (const file of files) {
      expect(file.startsWith(dir)).toBe(true)
      expect(mode(file)).toBe(0o600)
    }
    const [solana, base, robinhood, receipt, vapid, anchor] = files as [string, ...string[]]
    expect((await readKeypairFile(solana)).length).toBe(64)
    expect(await readEvmKeyFile(base as string)).not.toBe(await readEvmKeyFile(robinhood as string))
    expect((await readReceiptKeyFile(receipt as string)).asymmetricKeyType).toBe('ed25519')
    expect((await readVapidKeyFile(vapid as string, 'mailto:o@example.com')).publicKey).toMatch(
      /^[A-Za-z0-9_-]{87}$/,
    )
    expect((await readKeypairFile(anchor as string)).length).toBe(64)
  })

  it('keeps the first key on every later start', async () => {
    const dir = fresh()
    const config = loadConfig({ ADMIN_TOKEN })
    const first = await withKeys(config, [], dir)
    const before = readFileSync(String(first.SOLANA_HOT_WALLET_KEYPAIR), 'utf8')
    const second = await withKeys(config, [], dir)
    expect(readFileSync(String(second.SOLANA_HOT_WALLET_KEYPAIR), 'utf8')).toBe(before)
  })

  it('lets a key given by env win and makes none for a chain that is off', async () => {
    const dir = fresh()
    const config = await withKeys(
      loadConfig({ ADMIN_TOKEN, RECEIPT_SIGNING_KEY_FILE: '/run/defimind/receipt.pem' }),
      [],
      dir,
    )
    expect(config.RECEIPT_SIGNING_KEY_FILE).toBe('/run/defimind/receipt.pem')
    expect(config.BASE_HOT_WALLET_KEY_FILE).toBeUndefined()
    expect(config.ROBINHOOD_HOT_WALLET_KEY_FILE).toBeUndefined()
  })

  it('makes no hot wallet for a chain whose vault the env names, so the start still fails', async () => {
    const vaults = {
      ADMIN_TOKEN,
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      SQUADS_MULTISIG: 'Squads1111111111111111111111111111111111111',
      BASE_CHAIN: 'eip155:84532',
      SAFE_ADDRESS: `0x${'11'.repeat(20)}`,
    }
    const config = await withKeys(loadConfig(vaults), [], fresh())
    expect(config.SOLANA_HOT_WALLET_KEYPAIR).toBeUndefined()
    expect(config.BASE_HOT_WALLET_KEY_FILE).toBeUndefined()
    await expect(buildChains(config)).rejects.toThrow(
      'invalid configuration: SOLANA_HOT_WALLET_KEYPAIR',
    )
    await expect(buildChains({ ...config, SQUADS_MULTISIG: undefined })).rejects.toThrow(
      /BASE_HOT_WALLET_KEY_FILE/,
    )
  })

  it('makes no hot wallet for a vault the panel adopted, so a lost key file stops the start', async () => {
    const env = loadConfig({ ADMIN_TOKEN, SOLANA_RPC_URL: 'https://api.devnet.solana.com' })
    const stored = [
      { chain: env.SOLANA_CHAIN, vault: 'Squads1111111111111111111111111111111111111' },
    ]
    const config = await withKeys(env, stored, fresh())
    expect(config.SOLANA_HOT_WALLET_KEYPAIR).toBeUndefined()
    await expect(buildChains(applySettings(config, stored))).rejects.toThrow(
      'invalid configuration: SOLANA_HOT_WALLET_KEYPAIR',
    )
  })

  it('makes the hot wallet for a chain still waiting for its vault', async () => {
    const config = await withKeys(
      loadConfig({ ADMIN_TOKEN, BASE_CHAIN: 'eip155:84532' }),
      [],
      fresh(),
    )
    expect(config.SOLANA_HOT_WALLET_KEYPAIR).toBeDefined()
    expect(config.BASE_HOT_WALLET_KEY_FILE).toBeDefined()
    expect((await buildChains(config)).size).toBe(0)
  })

  it('keeps them next to the database unless KEYS_DIR says otherwise', () => {
    expect(keysDir(loadConfig({ ADMIN_TOKEN, DATABASE_URL: 'file:/data/guard.db' }))).toBe(
      '/data/keys',
    )
    expect(keysDir(loadConfig({ ADMIN_TOKEN, KEYS_DIR: '/secure/keys' }))).toBe('/secure/keys')
  })

  it('answers the public halves only', async () => {
    const config = await withKeys(
      loadConfig({ ADMIN_TOKEN, BASE_CHAIN: 'eip155:84532' }),
      [],
      fresh(),
    )
    const keys = await publicKeys(config)
    const base = await readEvmKeyFile(String(config.BASE_HOT_WALLET_KEY_FILE))
    expect(keys.hotWallets).toEqual([
      {
        chain: config.SOLANA_CHAIN,
        address: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
      },
      { chain: 'eip155:84532', address: privateKeyToAddress(base) },
    ])
    expect(keys.receiptKey).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.anchorKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    expect(JSON.stringify(keys)).not.toContain(base.slice(2))

    const h = await harness({ keys })
    const owner = await signedIn(h)
    expect((await owner.call('GET', '/v1/owner/keys')).json()).toEqual({
      ...keys,
      agentWallets: [],
    })
    expect((await h.app.inject({ method: 'GET', url: '/v1/owner/keys' })).statusCode).toBe(401)
  })
})

describe('first access by setup code (CR-019)', () => {
  const setup = (h: Harness, setupCode: string, headers: Record<string, string> = PANEL) =>
    h.app.inject({ method: 'POST', url: '/v1/owner/setup', headers, payload: { setupCode } })

  it('issues an enrol link that enrols the first passkey, then dies with setup_done', async () => {
    const h = await harness({ env: { SETUP_CODE } })
    expect((await h.app.inject({ method: 'GET', url: '/v1/owner/setup' })).json()).toEqual({
      needsSetup: true,
    })

    const res = await setup(h, SETUP_CODE)
    expect(res.statusCode).toBe(200)
    const { enrolLink } = res.json() as { enrolLink: string }
    expect(enrolLink).toMatch(/^https:\/\/guard\.example\/panel\/enrol#code=[A-Za-z0-9_-]{32}$/)
    expect(h.auditEvents()).toContain('passkey_code_issued')

    const code = enrolLink.split('#code=')[1]
    const device = softAuthenticator(PASSKEY_RP.id, PASSKEY_RP.origin)
    const options = (
      await h.app.inject({ method: 'POST', url: '/v1/owner/passkeys/options', payload: { code } })
    ).json()
    const enrolled = await h.app.inject({
      method: 'POST',
      url: '/v1/owner/passkeys',
      payload: { code, response: device.register(options.registration.challenge) },
    })
    expect(enrolled.json()).toEqual({ enrolled: true })

    expect((await h.app.inject({ method: 'GET', url: '/v1/owner/setup' })).json()).toEqual({
      needsSetup: false,
    })
    const after = await setup(h, SETUP_CODE)
    expect(after.statusCode).toBe(410)
    expect(after.json()).toEqual({ error: 'setup_done' })
  })

  it('refuses a wrong code and audits it', async () => {
    const h = await harness({ env: { SETUP_CODE } })
    const res = await setup(h, 'x'.repeat(40))
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'setup_code_invalid' })
    expect(h.auditEvents()).toContain('setup_code_refused')
    expect(h.auditEvents()).not.toContain('passkey_code_issued')
  })

  it('stops an address after five tries', async () => {
    const h = await harness({ env: { SETUP_CODE } })
    const codes = []
    for (let i = 0; i < 6; i++) {
      codes.push((await setup(h, 'x'.repeat(40))).statusCode)
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429])
    expect((await setup(h, SETUP_CODE)).statusCode).toBe(429)
  })

  it('takes the request from the panel only', async () => {
    const h = await harness({ env: { SETUP_CODE } })
    expect((await setup(h, SETUP_CODE, {})).statusCode).toBe(403)
  })

  it('answers setup_not_configured without SETUP_CODE', async () => {
    const h = await harness()
    expect((await setup(h, SETUP_CODE)).json()).toEqual({ error: 'setup_not_configured' })
  })
})

describe('hosting behind one public listener (CR-019)', () => {
  it('derives the public address and the passkey settings from RENDER_EXTERNAL_URL', () => {
    const config = loadConfig({ ADMIN_TOKEN, RENDER_EXTERNAL_URL: 'https://dm-owner.onrender.com' })
    expect(config.PUBLIC_URL).toBe('https://dm-owner.onrender.com')
    expect(config.PASSKEY_RP_ID).toBe('dm-owner.onrender.com')
    expect(config.PASSKEY_ORIGIN).toBe('https://dm-owner.onrender.com')
  })

  it('lets PUBLIC_URL and explicit passkey settings win', () => {
    const config = loadConfig({
      ADMIN_TOKEN,
      RENDER_EXTERNAL_URL: 'https://dm-owner.onrender.com',
      PUBLIC_URL: 'https://guard.example',
      PASSKEY_RP_ID: 'example',
      PASSKEY_ORIGIN: 'https://guard.example',
    })
    expect(config.PUBLIC_URL).toBe('https://guard.example')
    expect(config.PASSKEY_RP_ID).toBe('example')
  })

  it('refuses a public address that is not https', () => {
    expect(() => loadConfig({ ADMIN_TOKEN, PUBLIC_URL: 'http://guard.example' })).toThrow(
      'invalid configuration: PUBLIC_URL',
    )
  })

  it('uses PUBLIC_URL as the push contact when VAPID_SUBJECT is unset', () => {
    const file = { ADMIN_TOKEN, VAPID_PRIVATE_KEY_FILE: '/run/defimind/vapid.pem' }
    expect(() => loadConfig(file)).toThrow('invalid configuration: VAPID_SUBJECT')
    expect(() => loadConfig({ ...file, PUBLIC_URL: 'https://guard.example' })).not.toThrow()
  })

  it('leaves /v1/admin/* unregistered with ADMIN_ROUTES=false', async () => {
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` }
    const on = await harness()
    expect((await on.app.inject({ url: '/v1/admin/agents', headers: auth })).statusCode).toBe(200)
    const off = await harness({ env: { ADMIN_ROUTES: 'false' } })
    expect((await off.app.inject({ url: '/v1/admin/agents', headers: auth })).statusCode).toBe(404)
  })

  it('refuses trusting both proxy headers', () => {
    expect(() =>
      loadConfig({ ADMIN_TOKEN, TRUST_FLY_CLIENT_IP: 'true', TRUST_FORWARDED_FOR: 'true' }),
    ).toThrow('invalid configuration: TRUST_FORWARDED_FOR')
  })

  it('limits by the hop the proxy appends, whatever the client put before it', async () => {
    const h = await harness({
      env: { SETUP_CODE, TRUST_FORWARDED_FOR: 'true', RATE_LIMIT_PER_IP: '1000' },
    })
    const from = (forwarded: string) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/owner/setup',
        headers: { ...PANEL, 'x-forwarded-for': forwarded },
        payload: { setupCode: 'x'.repeat(40) },
      })
    for (let i = 0; i < 5; i++) {
      await from(`10.0.0.${i}, 203.0.113.7`)
    }
    expect((await from('10.9.9.9, 203.0.113.7')).statusCode).toBe(429)
    expect((await from('203.0.113.8')).statusCode).toBe(401)
  })
})
