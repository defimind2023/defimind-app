import { CHAINS } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { gasText, lowGas, sameOrigin } from '../src/domain/wallets.js'

const origin = 'https://guard.example'

describe('agent wallets', () => {
  it('shows gas in the native coin, 9 decimals on Solana and 18 on EVM', () => {
    expect(gasText(CHAINS.solanaDevnet, '2500000', 'SOL')).toBe('0.0025 SOL')
    expect(gasText(CHAINS.baseSepolia, '2000000000000000', 'ETH')).toBe('0.002 ETH')
  })

  it('calls the gas low only below the minimum', () => {
    expect(lowGas({ balance: '1', minimum: '2' })).toBe(true)
    expect(lowGas({ balance: '2', minimum: '2' })).toBe(false)
  })

  it('links only to the signing page of this origin', () => {
    expect(sameOrigin('/sign/?action=add-limit', origin)).toBe(`${origin}/sign/?action=add-limit`)
    expect(sameOrigin(`${origin}/sign/x`, origin)).toBe(`${origin}/sign/x`)
    expect(sameOrigin('https://evil.example/sign/', origin)).toBeUndefined()
    expect(sameOrigin('/panel/', origin)).toBeUndefined()
    expect(sameOrigin('http://[bad', origin)).toBeUndefined()
    expect(sameOrigin(undefined, origin)).toBeUndefined()
  })
})
