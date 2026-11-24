import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { base58 } from '../src/domain/base58.js'
import { killTargets } from '../src/kill-targets.js'
import { ADMIN_TOKEN, CHAIN, harness } from './harness.js'
import { signedIn } from './owner.js'

const PAGE = 'https://sign.example'
const target = { chain: CHAIN, multisig: 'Msig111', hot: 'Hot111' }

describe('base58', () => {
  it.each([
    [[], ''],
    [[0], '1'],
    [[0, 0, 1], '112'],
    [[255], '5Q'],
    [Array.from('hello world', (c) => c.charCodeAt(0)), 'StV1DL6CwTryKyV'],
  ])('encodes %j as %s', (bytes, text) => {
    expect(base58(Uint8Array.from(bytes))).toBe(text)
  })
})

describe('kill targets', () => {
  it('takes the Solana hot wallet key from the last 32 bytes of its keypair file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kp-')), 'hot.json')
    const bytes = [...Array(32).fill(7), ...Array(31).fill(0), 1]
    writeFileSync(file, JSON.stringify(bytes))
    const config = loadConfig({
      ADMIN_TOKEN: 'a'.repeat(64),
      BOT_TOKEN: 'b'.repeat(64),
      BOT_URL: 'http://bot.local',
      BOT_WEBHOOK_SECRET: 'c'.repeat(64),
      SQUADS_MULTISIG: 'Msig111',
      SOLANA_HOT_WALLET_KEYPAIR: file,
    })
    const [solana] = await killTargets(config)
    expect(solana).toMatchObject({
      multisig: 'Msig111',
      hot: base58(Uint8Array.from(bytes.slice(32))),
    })
  })
})

describe('the owner kill links', () => {
  it('links each chain with a target to the signing page, and the admin kill never does', async () => {
    const h = await harness({ signPage: PAGE, killTargets: [target] })
    const owner = await signedIn(h)
    const [tx] = (await owner.call('POST', '/v1/owner/kill', {})).json().ownerTransactions
    expect(tx.pageLink).toMatch(
      /^https:\/\/sign\.example\/\?action=kill&cluster=devnet&multisig=Msig111&hot=Hot111&issued=\d+$/,
    )
    expect(tx.link).toMatch(/^https:\/\/phantom\.app\/ul\/browse\//)
    const admin = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/kill',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(admin.json().ownerTransactions[0]).not.toHaveProperty('link')
  })

  it('carries no links without SIGN_PAGE_URL', async () => {
    const h = await harness({ killTargets: [target] })
    const owner = await signedIn(h)
    const [tx] = (await owner.call('POST', '/v1/owner/kill', {})).json().ownerTransactions
    expect(tx).not.toHaveProperty('link')
    expect(tx).not.toHaveProperty('pageLink')
  })
})
