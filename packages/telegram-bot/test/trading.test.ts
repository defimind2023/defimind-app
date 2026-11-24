import type { PayIntent } from '@defimind/shared'
import { CHAINS, getAddress } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { Alerts } from '../src/domain/alerts.js'
import { FLAG_DESCRIPTIONS } from '../src/domain/codes.js'
import { tokenAmount } from '../src/domain/swap.js'
import { approvalText, executedText } from '../src/domain/text.js'
import { buildServer } from '../src/http/server.js'
import { sign } from '../src/domain/signature.js'
import { approval, intent, NOW, SECRET, sent, setup, silent } from './support.js'

const usd = getAddress(CHAINS.solanaDevnet, 'usd')!
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const swap = {
  venue: 'jupiter',
  tokenOut: MINT,
  minAmountOut: '1843920113',
  slippageBps: 50,
  priceImpactBps: 12,
  decimalsIn: 6,
  decimalsOut: 6,
  symbolOut: 'JUP',
  quotedAt: NOW.toISOString(),
}
const buy = (overrides: Partial<PayIntent> = {}): Partial<PayIntent> => ({
  kind: 'swap',
  token: usd,
  amount: '25000000',
  domain: undefined,
  swap,
  ...overrides,
})
const sell = buy({
  token: MINT,
  amount: '1843920113',
  swap: { ...swap, tokenOut: usd, minAmountOut: '24000000', decimalsIn: 6, symbolIn: 'JUP' },
})

describe('swaps on Telegram', () => {
  it('shows a buy whole: dollars spent, the least it gets with its mint, and the limits', () => {
    const text = approvalText(approval(buy()))
    expect(text).toContain(
      `Buy with <b>$25.00</b> USDC, at least <b>1,843.920113</b> JUP (mint <code>${MINT}</code>)`,
    )
    expect(text).toContain('Slippage: up to 0.50% · Price impact: 0.12%')
    expect(text).toContain('Venue: jupiter')
    expect(text).not.toContain('Recipient:')
  })

  it('shows a sell in the token and its proceeds in dollars', () => {
    expect(executedText(intent({ ...sell, status: 'executed', txId: 'sig' }))).toContain(
      `Sell <b>1,843.920113</b> JUP (mint <code>${MINT}</code>) for at least <b>$24.00</b> USDC`,
    )
  })

  it('never lets a symbol pass for markup or stand without its mint', () => {
    const text = approvalText(approval(buy({ swap: { ...swap, symbolOut: '<b>USDC</b>' } })))
    expect(text).toContain(`&lt;b&gt;USDC&lt;/b&gt; (mint <code>${MINT}</code>)`)
    const bare = approvalText(approval(buy({ swap: { ...swap, symbolOut: undefined } })))
    expect(bare).toContain(`<b>1,843.920113</b> tokens (mint <code>${MINT}</code>)`)
  })

  it('places the decimal point with bigint', () => {
    expect(tokenAmount('1843920113', 6)).toBe('1,843.920113')
    expect(tokenAmount('912000000000', 5)).toBe('9,120,000')
    expect(tokenAmount('5', 9)).toBe('0.000000005')
    expect(tokenAmount('7', 0)).toBe('7')
  })

  it('explains NEW_TOKEN as a first buy by any of the owner agents', () => {
    expect(FLAG_DESCRIPTIONS.NEW_TOKEN).toBe(
      'New token: none of your agents has bought this token before.',
    )
    const text = approvalText({ ...approval(buy()), flags: ['NEW_TOKEN', 'MINT_AUTHORITY'] })
    expect(text).toContain(`⚠️ <b>${FLAG_DESCRIPTIONS.NEW_TOKEN}</b>`)
    expect(text).toContain(`⚠️ <b>${FLAG_DESCRIPTIONS.MINT_AUTHORITY}</b>`)
  })

  it('weighs an executed sell by its dollars, not its token units', () => {
    const alerts = (payment: PayIntent) => new Alerts(25_000_000n).for(payment, NOW)
    const executed = { ...sell, status: 'executed' as const }
    expect(alerts(intent(executed))).toHaveLength(0)
    const big = { ...executed, swap: { ...swap, tokenOut: usd, minAmountOut: '25000000' } }
    expect(alerts(intent(big))[0]).toContain('<b>Trade executed</b>')
  })
})

describe('swaps from guard-core', () => {
  async function harness() {
    const parts = setup({ telegramApprovals: true })
    const app = await buildServer({
      secret: SECRET,
      handlers: {
        approvalRequest: (request) => parts.desk.post(request),
        intentEvent: (event) => parts.desk.event(event),
        alert: (event) => parts.desk.alert(event),
      },
      logger: silent,
    })
    const deliver = (path: string, body: unknown) => {
      const raw = JSON.stringify(body)
      return app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', 'x-guard-signature': sign(raw, SECRET) },
        payload: raw,
      })
    }
    return { ...parts, deliver }
  }

  it('takes a swap waiting for the owner to Telegram, MINT_AUTHORITY explained', async () => {
    const { calls, deliver } = await harness()
    const request = { ...approval(buy()), flags: ['NEW_TOKEN', 'MINT_AUTHORITY'] }
    expect((await deliver('/hooks/approval-request', request)).statusCode).toBe(200)
    const text = String(sent(calls, 'sendMessage')[0]?.payload['text'])
    expect(text).toContain(FLAG_DESCRIPTIONS.MINT_AUTHORITY)
    expect(text).toContain('Buy with <b>$25.00</b> USDC')
  })

  it.each(['executed', 'rejected', 'shadowed'] as const)(
    'accepts a %s swap event',
    async (status) => {
      const { deliver } = await harness()
      const event = {
        intent: intent({ ...buy(), id: crypto.randomUUID(), status, txId: 'sig' }),
        sentAt: NOW.toISOString(),
      }
      expect((await deliver('/hooks/intent-event', event)).statusCode).toBe(200)
    },
  )

  it('refuses a swap whose slippage is not basis points', async () => {
    const { deliver } = await harness()
    const request = approval(buy({ swap: { ...swap, slippageBps: 10_001 } }))
    expect((await deliver('/hooks/approval-request', request)).statusCode).toBe(400)
  })
})
