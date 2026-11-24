import { describe, expect, it } from 'vitest'
import { changedSettings } from '../src/domain/settings.js'

const devnet = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const robinhood = 'eip155:4663'

describe('changedSettings', () => {
  it('leaves out an RPC the env set, as GET showed it', () => {
    const before = [{ chain: devnet, rpcUrl: 'https://rpc.example' }]
    const form = [{ chain: devnet, rpcUrl: 'https://rpc.example', vault: 'V1' }]
    expect(changedSettings(before, form)).toEqual([{ chain: devnet, vault: 'V1' }])
  })

  it('sends no chain for an unchanged form', () => {
    const before = [
      { chain: devnet, rpcUrl: 'https://rpc.example', vault: 'V1' },
      { chain: robinhood },
    ]
    const form = [
      { chain: devnet, rpcUrl: ' https://rpc.example ', vault: 'V1' },
      { chain: robinhood, rpcUrl: '', vault: '' },
    ]
    expect(changedSettings(before, form)).toEqual([])
  })

  it('keeps only the chains and fields the owner changed, trimmed', () => {
    const before = [{ chain: devnet, vault: 'V1' }, { chain: robinhood }]
    const form = [
      { chain: devnet, rpcUrl: '', vault: 'V1' },
      { chain: robinhood, rpcUrl: ' https://rh.example ', vault: '0xSafe' },
    ]
    expect(changedSettings(before, form)).toEqual([
      { chain: robinhood, rpcUrl: 'https://rh.example', vault: '0xSafe' },
    ])
  })

  it('leaves out a field emptied, as SPEC has no way to clear one', () => {
    expect(
      changedSettings([{ chain: devnet, vault: 'V1' }], [{ chain: devnet, rpcUrl: '', vault: '' }]),
    ).toEqual([])
  })
})
