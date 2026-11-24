import { describe, expect, it } from 'vitest'
import { CHAINS } from '../src/constants.js'
import { killPageUrl } from '../src/kill-links.js'
import { HOSTED_SIGN_PAGE, inPhantom, signCluster, signPageUrl } from '../src/sign-links.js'

describe('signing-page links', () => {
  it('names each chain the page serves by its cluster, and Base by none', () => {
    expect(signCluster(CHAINS.solanaMainnet)).toBe('mainnet-beta')
    expect(signCluster(CHAINS.solanaDevnet)).toBe('devnet')
    expect(signCluster(CHAINS.robinhood)).toBe('robinhood')
    expect(signCluster(CHAINS.robinhoodTestnet)).toBe('robinhood-testnet')
    expect(signCluster(CHAINS.base)).toBeUndefined()
  })

  it('puts the action, then the cluster, then the rest, whatever the trailing slashes', () => {
    expect(
      signPageUrl('https://sign.example//', CHAINS.solanaMainnet, {
        multisig: 'M',
        action: 'deposit',
      }),
    ).toBe('https://sign.example/?action=deposit&cluster=mainnet-beta&multisig=M')
  })

  it('makes no link for a chain the page does not serve', () => {
    expect(signPageUrl('https://sign.example', CHAINS.base, { action: 'create' })).toBeUndefined()
  })

  it('cannot be steered to another cluster by a parameter of the same name', () => {
    const url = signPageUrl('https://sign.example', CHAINS.solanaMainnet, { cluster: 'devnet' })
    expect(new URL(url!).searchParams.getAll('cluster')).toEqual(['mainnet-beta'])
  })

  it('opens the page inside Phantom with the page itself as the referrer', () => {
    const link = 'https://g.example/sign/?action=create&cluster=devnet'
    expect(inPhantom(link)).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent(link)}?ref=${encodeURIComponent('https://g.example')}`,
    )
  })

  it('names the hot wallet in an EVM kill link for the hosted page, and only when given', () => {
    const issued = new Date('2026-11-20T00:00:00Z')
    const safe = '0x' + '5'.repeat(40)
    const hot = '0x' + 'a'.repeat(40)
    const withHot = new URL(
      killPageUrl(HOSTED_SIGN_PAGE, { chain: CHAINS.robinhood, safe, hot }, issued),
    )
    expect(withHot.origin).toBe('https://defimind-sign.vercel.app')
    expect(Object.fromEntries(withHot.searchParams)).toEqual({
      action: 'kill',
      cluster: 'robinhood',
      safe,
      hot,
      issued: String(issued.getTime() / 1000),
    })
    const without = new URL(
      killPageUrl(HOSTED_SIGN_PAGE, { chain: CHAINS.robinhood, safe }, issued),
    )
    expect(without.searchParams.has('hot')).toBe(false)
  })
})
