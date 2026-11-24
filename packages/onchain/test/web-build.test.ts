import { CHAINS, getAddress } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { csp, evmChains, fromSignPage, hotWallets, maxDailyCap, pageHtml } from '../web/page.js'

describe('the signing page build', () => {
  it('caps a daily limit at 50 USDC unless the build says otherwise', () => {
    expect(maxDailyCap({})).toBe('50000000')
    expect(maxDailyCap({ MAX_DAILY_CAP: '25000000' })).toBe('25000000')
    expect(() => maxDailyCap({ MAX_DAILY_CAP: '50 USDC' })).toThrow(/MAX_DAILY_CAP/)
  })

  it('knows a hot wallet only for the clusters the build names', () => {
    expect(hotWallets({})).toEqual({})
    const key = '11111111111111111111111111111112'
    expect(hotWallets({ SOLANA_HOT_WALLET_DEVNET: key })).toEqual({ devnet: key })
  })

  it('fails the build on a hot wallet that is not a public key', () => {
    expect(() => hotWallets({ SOLANA_HOT_WALLET_MAINNET: 'Hot111' })).toThrow(
      'the hot wallet for mainnet-beta is not a Solana public key: Hot111',
    )
  })

  it('lets the page connect to its RPC endpoints and nothing else', () => {
    const policy = csp({ devnet: 'https://api.devnet.solana.com/', x: 'https://rpc.example/key' })
    expect(policy).toContain('connect-src https://api.devnet.solana.com https://rpc.example;')
    expect(policy).toMatch(/^default-src 'none'; script-src 'self' 'unsafe-eval';/)
  })

  it("relaxes only script-src, and only by 'unsafe-eval', which Phantom's provider needs", () => {
    const directives = csp({ devnet: 'https://api.devnet.solana.com' }).split('; ')
    expect(directives).toEqual([
      "default-src 'none'",
      "script-src 'self' 'unsafe-eval'",
      "style-src 'self'",
      'connect-src https://api.devnet.solana.com',
      "img-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
  })
})

describe("guard-core's /sign", () => {
  const sol = '11111111111111111111111111111112'
  const evmHot = '0x00000000000000000000000000000000000000B0'

  it('takes the RPC and hot wallet per cluster, and the tokens and modules from shared', () => {
    const config = fromSignPage({
      solana: { devnet: { rpc: 'https://devnet.example/', hot: sol } },
      evm: { robinhood: { rpc: 'https://rh.example/', hot: evmHot } },
      maxDailyCap: '50000000',
    })
    expect(config.rpc).toEqual({
      devnet: 'https://devnet.example/',
      robinhood: 'https://rh.example/',
    })
    expect(config.hot).toEqual({ devnet: sol })
    expect(config.usdc['devnet']).toBe(getAddress(CHAINS.solanaDevnet, 'usd'))
    expect(config.evm['robinhood']).toEqual({ ...evmChains({})['robinhood'], hot: evmHot })
  })

  it("takes every agent's own hot wallet next to the shared one (CR-022)", () => {
    const agentSol = '11111111111111111111111111111113'
    const agentEvm = '0x00000000000000000000000000000000000000B1'
    const config = fromSignPage({
      solana: { devnet: { rpc: 'https://devnet.example/', hot: sol, agents: [agentSol] } },
      evm: { robinhood: { rpc: 'https://rh.example/', agents: [agentEvm] } },
      maxDailyCap: '50000000',
    })
    expect(config.hot).toEqual({ devnet: sol })
    expect(config.agents).toEqual({ devnet: [agentSol] })
    expect(config.evm['robinhood']).toEqual({ ...evmChains({})['robinhood'], agents: [agentEvm] })
  })

  it.each([
    [
      'an agent wallet that is not a key',
      { evm: { robinhood: { rpc: 'https://x.example', agents: ['0x12'] } } },
    ],
    ['an unknown cluster', { solana: { localnet: { rpc: 'https://x.example' } } }],
    ['a token of its own', { solana: { devnet: { rpc: 'https://x.example', usdc: sol } } }],
    [
      'a hot wallet that is not a key',
      { solana: { devnet: { rpc: 'https://x.example', hot: 'x' } } },
    ],
    ['an RPC that is not http', { evm: { robinhood: { rpc: 'javascript:alert(1)' } } }],
  ])('refuses %s', (_case, input) => {
    expect(() => fromSignPage({ maxDailyCap: '1', ...input } as never)).toThrow()
  })

  it('writes the config so that no value can close its script element', () => {
    const config = fromSignPage({ maxDailyCap: '1' })
    config.hot['x'] = '</script><script>alert(1)</script>'
    const html = pageHtml('<meta content="%CSP%"><script id="config">%CONFIG%</script>', config)
    expect(html).not.toContain('</script><script>')
    const json = /<script id="config">(.*)<\/script>/.exec(html)![1]!
    expect(JSON.parse(json)).toEqual(config)
  })
})
