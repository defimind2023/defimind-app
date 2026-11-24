import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  ADMIN_TOKEN: 'a'.repeat(64),
  BOT_TOKEN: 'b'.repeat(64),
  BOT_URL: 'http://bot.local',
  BOT_WEBHOOK_SECRET: 'c'.repeat(64),
}

const withOrigin =
  (origin: string, rpId = 'guard.example') =>
  () =>
    loadConfig({ ...base, PASSKEY_RP_ID: rpId, PASSKEY_ORIGIN: origin })

describe('the passkey origin', () => {
  it.each(['https://guard.example', 'https://pay.guard.example', 'https://guard.example:8443'])(
    'accepts %s for guard.example',
    (origin) => {
      expect(withOrigin(origin)).not.toThrow()
    },
  )

  it.each([
    'https://guard.example/',
    'https://guard.example/owner',
    'https://evilguard.example',
    'https://guard.example.evil',
    'https://example',
  ])('refuses %s for guard.example', (origin) => {
    expect(withOrigin(origin)).toThrow()
  })
})

describe('anchoring', () => {
  const anchor = {
    ANCHOR_CHAIN: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ANCHOR_RPC_URL: 'https://api.devnet.solana.com',
    ANCHOR_KEY_FILE: '/run/defimind/anchor.json',
  }

  it('takes the cluster and its RPC, with or without a key file, which is made when absent', () => {
    expect(() => loadConfig({ ...base, ...anchor })).not.toThrow()
    expect(() => loadConfig({ ...base, ...anchor, ANCHOR_KEY_FILE: '' })).not.toThrow()
  })

  it('refuses the cluster without its RPC, or the RPC without a cluster', () => {
    expect(() => loadConfig({ ...base, ANCHOR_CHAIN: anchor.ANCHOR_CHAIN })).toThrow(
      'invalid configuration: ANCHOR_RPC_URL',
    )
    expect(() => loadConfig({ ...base, ANCHOR_RPC_URL: anchor.ANCHOR_RPC_URL })).toThrow()
  })

  it('refuses a chain that is not a Solana cluster', () => {
    expect(() =>
      loadConfig({
        ...base,
        ...anchor,
        ANCHOR_CHAIN: 'eip155:8453',
        RECEIPT_SIGNING_KEY_FILE: '/run/defimind/receipt.pem',
      }),
    ).toThrow()
  })
})
