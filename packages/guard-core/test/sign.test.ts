import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PublicKeys } from '../src/adapters/public-keys.js'
import { addWallet, type WalletRow } from '../src/db/wallets.js'
import { CHAIN, harness, MERCHANT } from './harness.js'

const HOT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const ROBINHOOD_HOT = '0x1111111111111111111111111111111111111111'
const keys: PublicKeys = {
  hotWallets: [
    { chain: CHAIN, address: HOT },
    { chain: 'eip155:46630', address: ROBINHOOD_HOT },
  ],
  receiptKey: 'ab'.repeat(32),
}

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-sign-'))
  writeFileSync(
    join(dir, 'index.template.html'),
    '<meta http-equiv="Content-Security-Policy" content="%CSP%"><script type="application/json" id="config">%CONFIG%</script>',
  )
  writeFileSync(join(dir, 'app.js'), 'export {}')
  writeFileSync(join(dir, 'style.css'), 'body{}')
  return dir
}

async function page(dir = build(), wallets: Omit<WalletRow, 'status' | 'agentId'>[] = []) {
  const h = await harness({
    keys,
    env: { SIGN_DIR: dir, SOLANA_RPC_URL: 'https://rpc.example/?api-key=secret' },
  })
  for (const wallet of wallets) {
    addWallet(h.db, { agentId: 'agent-1', ...wallet }, new Date())
  }
  return h.app
}

const config = (html: string) =>
  JSON.parse(/id="config">(.*)<\/script>/.exec(html)?.[1] ?? '{}') as {
    hot: Record<string, string>
    agents: Record<string, string[]>
    rpc: Record<string, string>
    evm: Record<string, { hot?: string; agents?: string[] }>
    maxDailyCap: string
  }

describe('the signing page at /sign (CR-019)', () => {
  it('fills in this deployment own hot wallets, whatever the link says', async () => {
    const app = await page()
    const res = await app.inject({
      url: `/sign/?action=add-limit&cluster=devnet&hot=${'1'.repeat(44)}`,
    })
    expect(res.statusCode).toBe(200)
    const filled = config(res.body)
    expect(filled.hot).toEqual({ devnet: HOT })
    expect(filled.evm['robinhood-testnet']?.hot).toBe(ROBINHOOD_HOT)
    expect(filled.maxDailyCap).toBe('50000000')
    expect(res.body).not.toContain('1'.repeat(44))
  })

  it("adds each agent's own wallet next to the shared one, read when the page is served", async () => {
    const evm = '0x2222222222222222222222222222222222222222'
    const app = await page(build(), [
      { chain: CHAIN, address: MERCHANT },
      { chain: 'eip155:46630', address: evm },
    ])
    const filled = config((await app.inject({ url: '/sign/?action=add-limit' })).body)
    expect(filled.hot).toEqual({ devnet: HOT })
    expect(filled.agents).toEqual({ devnet: [MERCHANT] })
    expect(filled.evm['robinhood-testnet']).toMatchObject({ hot: ROBINHOOD_HOT, agents: [evm] })
  })

  it('serves create and add-limit only; deposit and kill stay on the hosted page', async () => {
    const app = await page()
    expect((await app.inject({ url: '/sign/?action=create&cluster=devnet' })).statusCode).toBe(200)
    for (const url of [
      '/sign/',
      '/sign/?action=deposit',
      '/sign/?action=kill',
      '/sign/?action=create&action=kill',
    ]) {
      const res = await app.inject({ url })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'action_not_served' })
    }
  })

  it('reads the chain through the public RPC, never guard-core own', async () => {
    const res = await (await page()).inject({ url: '/sign/?action=create' })
    expect(config(res.body).rpc['devnet']).toBe('https://api.devnet.solana.com')
    expect(res.body).not.toContain('secret')
  })

  it('serves it under a strict CSP that no other site can frame', async () => {
    const res = await (await page()).inject({ url: '/sign/?action=add-limit' })
    const policy = String(res.headers['content-security-policy'])
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain('connect-src https://api.devnet.solana.com')
    expect(res.headers['x-frame-options']).toBe('DENY')
  })

  it('serves the build files by name and nothing else', async () => {
    const app = await page()
    expect((await app.inject({ url: '/sign' })).headers['location']).toBe('/sign/')
    expect((await app.inject({ url: '/sign/app.js' })).body).toBe('export {}')
    expect((await app.inject({ url: '/sign/style.css' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/sign/index.template.html' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/sign/..%2Fpackage.json' })).statusCode).toBe(404)
  })

  it('answers sign_page_not_built without the build', async () => {
    const res = await (
      await page(join(tmpdir(), 'no-such-sign-dir'))
    ).inject({
      url: '/sign/?action=create',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'sign_page_not_built' })
  })
})
