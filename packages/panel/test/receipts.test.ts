import { describe, expect, it } from 'vitest'
import { byHash } from '../src/adapters/receipts.js'
import { canonicalJson } from '../src/domain/canonical.js'

/** A receipt and the hash the sdk's node:crypto canonicalJson gives it: the panel must agree. */
const receipt = {
  intent: {
    id: 'i',
    chain: 'eip155:84532',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '2500000',
    extra: [1, { b: 2, a: 1 }],
  },
  policyHash: 'p',
  simulation: 's',
  approvedBy: 'policy',
  issuedAt: '2026-11-19T00:00:00.000Z',
  signature: 'sig',
}
const HASH = '1450c53831f9b8038aa55dca686fb53deafea2382be82eb23f88390bffe3e1f2'

describe('payment receipts', () => {
  it('writes the same canonical JSON as guard-core and the sdk', () => {
    expect(canonicalJson(receipt)).toBe(
      '{"approvedBy":"policy","intent":{"amount":"2500000","chain":"eip155:84532",' +
        '"extra":[1,{"a":1,"b":2}],"id":"i","token":"0x036CbD53842c5426634e7929541eC2318f3dCF7e"},' +
        '"issuedAt":"2026-11-19T00:00:00.000Z","policyHash":"p","signature":"sig","simulation":"s"}',
    )
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('finds each receipt by its hash, counting the fields the panel does not read', async () => {
    const index = await byHash([receipt, { not: 'a receipt' }])
    expect([...index.keys()]).toEqual([HASH])
    expect(index.get(HASH)).toEqual({
      chain: 'eip155:84532',
      token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: '2500000',
    })
    const changed = await byHash([{ ...receipt, simulation: 't' }])
    expect(changed.has(HASH)).toBe(false)
  })
})
