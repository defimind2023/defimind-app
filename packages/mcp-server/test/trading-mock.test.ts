import { afterEach, describe, expect, it } from 'vitest'
import { startMockGuard, type MockGuard } from '../examples/mock-guard/server.js'
import { httpGuard } from '../src/adapters/guard.js'
import { call, connect } from './support.js'

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
let mock: MockGuard | undefined

afterEach(async () => {
  await mock?.close()
})

describe('trading tools against a fake guard-core over HTTP', () => {
  it('quotes, buys, shows the position, sells, and is refused an untradable token', async () => {
    mock = await startMockGuard({ agentId: 'agent-1', token: 'tok', tradable: [BONK] })
    const client = await connect(httpGuard({ baseUrl: mock.url, agentId: 'agent-1', token: 'tok' }))

    const quoted = await call(client, 'quote', { from: 'USDC', to: BONK, amountUsd: '2' })
    expect(quoted.text).toContain(`Expected: 100 of ${BONK} (100000000 smallest units)`)
    expect(quoted.text).toContain('- NEW_TOKEN: the first buy of this token')

    const bought = await call(client, 'swap', {
      from: 'USDC',
      to: BONK,
      amountUsd: '2',
      reason: 'demo',
    })
    expect(bought.text).toContain(`Buy ${BONK} with $2.00 USDC on Solana devnet`)
    expect(bought.text).toContain(': executed.')

    const held = await call(client, 'get_portfolio')
    expect(held.text).toContain('Traded today: $2.00 of $20.00')
    expect(held.text).toContain(
      `- 100 of ${BONK} (100000000 smallest units) on Solana devnet, cost $2.00 USDC`,
    )

    const sold = await call(client, 'swap', {
      from: BONK,
      to: 'USDC',
      amount: '50000000',
      reason: 'demo',
    })
    expect(sold.text).toContain(': executed.')

    const refused = await call(client, 'swap', {
      from: 'USDC',
      to: 'So11111111111111111111111111111111111111112',
      amountUsd: '1',
      reason: 'demo',
    })
    expect(refused.text).toContain(
      '- TOKEN_NOT_TRADABLE: the policy does not allow trading this token',
    )
    expect(refused.text).toContain('Tell the user the owner has to allow it.')
  })
})
