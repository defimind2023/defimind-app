import { describe, expect, it } from 'vitest'
import {
  checkFacts,
  dollars,
  identicon,
  listed,
  onchainFacts,
  parseUnits,
  type Risk,
  venueFacts,
} from '../src/domain/tokens.js'

const risk: Risk = {
  freezeAuthority: true,
  mintAuthority: true,
  extensions: ['TransferHook'],
  risks: ['TOKEN_FREEZABLE', 'SOMETHING_NEW'],
  flags: ['MINT_AUTHORITY'],
  exit: null,
  venue: { verified: false },
}

describe('tokens', () => {
  it('draws a mirrored pattern and a hue from the mint alone', () => {
    const a = identicon('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')
    expect(a).toEqual(identicon('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'))
    expect(a).not.toEqual(identicon('JUPfake1111111111111111111111111111111111111'))
    expect(a.cells).toHaveLength(25)
    for (let row = 0; row < 5; row++) {
      expect(a.cells[row * 5]).toBe(a.cells[row * 5 + 4])
      expect(a.cells[row * 5 + 1]).toBe(a.cells[row * 5 + 3])
    }
    expect(a.hue).toBeGreaterThanOrEqual(0)
    expect(a.hue).toBeLessThan(360)
  })

  it('states what the chain says, never that a token is safe', () => {
    const facts = onchainFacts(risk)
    expect(facts).toEqual([
      "Its issuer can freeze any holder's tokens.",
      'Its issuer can still mint more: the supply is not fixed.',
      'Token-2022 extensions: TransferHook.',
      'No route was found to sell it back to the dollar.',
    ])
    const all = [...facts, ...checkFacts(risk), ...venueFacts(risk)].join(' ')
    expect(all).not.toMatch(/\bsafe\b/i)
  })

  it('says why a buy is refused or waits, unknown codes included', () => {
    expect(checkFacts(risk)).toEqual([
      'A buy is refused: its issuer can freeze holders (TOKEN_FREEZABLE).',
      'A buy is refused: SOMETHING_NEW (SOMETHING_NEW).',
      'A buy waits for you: The token can still be minted: its supply is not fixed. (MINT_AUTHORITY)',
    ])
  })

  it("labels the venue's numbers and leaves out what it did not say", () => {
    expect(venueFacts(risk)).toEqual(['Not verified by Jupiter.'])
    const venue = {
      verified: true,
      holders: 812000,
      liquidityUsd: '41250000',
      organicScore: 91.4,
      createdAt: '2024-01-31T00:00:00Z',
    }
    expect(venueFacts({ ...risk, venue })).toEqual([
      'Verified by Jupiter.',
      '812,000 holders.',
      'Liquidity $41,250,000.00.',
      'Organic score 91 of 100.',
      'Listed since 2024-01-31.',
    ])
  })

  it("shows the venue's decimal dollars as dollars", () => {
    expect(dollars('41250000.5')).toBe('$41,250,000.50')
    expect(dollars('0')).toBe('$0.00')
  })

  it('lists verified tokens first, unverified only when asked', () => {
    const tokens = [
      { verified: false, id: 1 },
      { verified: true, id: 2 },
    ]
    expect(listed(tokens, false).map((t) => t.id)).toEqual([2])
    expect(listed(tokens, true).map((t) => t.id)).toEqual([2, 1])
  })

  it("reads an amount in a token's units exactly, a comma accepted", () => {
    expect(parseUnits('1.5', 6)).toBe('1500000')
    expect(parseUnits('1,5', 6)).toBe('1500000')
    expect(parseUnits('2', 9)).toBe('2000000000')
    expect(parseUnits('0.000001', 6)).toBe('1')
    for (const bad of ['', '0', '0.0', '1.0000001', '1,000', '1.234,56', 'abc', '-1']) {
      expect(parseUnits(bad, 6)).toBeUndefined()
    }
  })
})
