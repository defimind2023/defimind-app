import { CHAINS, HOSTED_SIGN_PAGE, killPageUrl } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { killTargets } from '../src/domain/kill-targets.js'

const env = {
  TELEGRAM_BOT_TOKEN: '123456:ABC-def_ghi',
  OWNER_TELEGRAM_IDS: '1001',
  GUARD_URL: 'http://localhost:8787',
  GUARD_BOT_TOKEN: 'b'.repeat(32),
  BOT_WEBHOOK_SECRET: 'd'.repeat(32),
  ROBINHOOD_CHAIN: CHAINS.robinhood,
}
const safe = '0xF663B0388586f1505796a8ef7ed6974A8d0BE45d'
const hot = '0xE57Cf9d928Ef05AD526444B7a93C8f8b184Bcc2b'

describe('Robinhood kill target (CR-020)', () => {
  it('names the hot wallet on the hosted page, which knows none of its own', () => {
    const config = loadConfig({
      ...env,
      SIGN_PAGE_URL: `${HOSTED_SIGN_PAGE}/`,
      ROBINHOOD_SAFE_ADDRESS: safe,
      ROBINHOOD_HOT_WALLET_ADDRESS: hot,
    })
    const [target] = killTargets(config)
    expect(target).toEqual({ chain: CHAINS.robinhood, safe, hot })
    const link = new URL(killPageUrl(HOSTED_SIGN_PAGE, target!, new Date(0)))
    expect(link.searchParams.get('hot')).toBe(hot)
  })

  it('refuses the hosted page without the hot wallet, as its kill link could only be refused', () => {
    expect(() =>
      loadConfig({ ...env, SIGN_PAGE_URL: HOSTED_SIGN_PAGE, ROBINHOOD_SAFE_ADDRESS: safe }),
    ).toThrow('invalid configuration: ROBINHOOD_HOT_WALLET_ADDRESS')
  })

  it('keeps a page built for this deployment working without it', () => {
    const config = loadConfig({
      ...env,
      SIGN_PAGE_URL: 'https://sign.defimind.example',
      ROBINHOOD_SAFE_ADDRESS: safe,
    })
    expect(killTargets(config)).toEqual([{ chain: CHAINS.robinhood, safe }])
  })
})
