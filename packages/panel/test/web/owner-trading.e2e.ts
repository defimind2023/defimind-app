import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS, getAddress } from '@defimind/shared'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'
import { FAKE, MINT } from './trading.js'

let browser: Browser
let dist: string

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'defimind-panel-'))
  await buildPanel(dist)
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

const chain = CHAINS.solanaDevnet
const usd = getAddress(chain, 'usd')!
const trading = (tokens: string[]) => ({
  enabled: true,
  venues: ['jupiter'],
  tokens,
  allowAnyToken: false,
  maxTradeUsd: '50000000',
  dailyTradeMax: '100000000',
  maxPositionUsd: '100000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
})

async function signIn(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

describe.each([390, 1280])('owner trading tools at %i px (CR-025)', (width) => {
  it('finds a token verified first, shows its risk, and allows it with the passkey', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['trading'] = trading([])
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot`)
    await page.getByLabel('Name, symbol or mint address').fill('jup')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByText(MINT, { exact: true }).waitFor()
    expect(await page.getByText(FAKE, { exact: true }).count()).toBe(0)
    await page.getByText('1 unverified not shown.').waitFor()

    await page.getByLabel('Show unverified tokens').check()
    await page.getByText(/copies of real ones, under the same name and symbol/).waitFor()
    await page.getByText(FAKE, { exact: true }).waitFor()
    await page.getByText('Not verified by Jupiter').waitFor()

    await page.getByRole('button', { name: 'Check risk' }).first().click()
    await page.getByText('No one can mint more: the supply is fixed.').waitFor()
    await page
      .getByText(/Selling \$10\.00 of it back to the dollar now would move the price by 0\.08%/)
      .waitFor()
    await page.getByText('812,000 holders.').waitFor()
    await page.getByText(/A buy waits for you: First buy of this token/).waitFor()
    const card = await page.locator('.risk').textContent()
    expect(card).not.toMatch(/\bsafe\b/i)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )

    await page.getByRole('button', { name: 'Allow this token with passkey' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('JUP allowed. Confirmed with your passkey.')
    const put = guard.state.puts.at(-1)
    expect((put?.policy['trading'] as { tokens: string[] }).tokens).toEqual([MINT])
    expect(put?.stepUp?.action).toBe('loosen_policy')
    expect(violations).toEqual([])
    await close()
  })

  it('quotes a buy, shows the exact amounts, and trades with the passkey every time', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading([MINT])
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot`)
    await page.getByRole('link', { name: 'Trade by hand' }).click()
    await page.getByRole('heading', { name: 'Trade for research-bot' }).waitFor()
    await page.getByLabel('Spend, in dollars').fill('25')
    await page.getByRole('button', { name: 'Get quote' }).click()
    await page.getByRole('heading', { name: 'Confirm' }).waitFor()
    await page.getByText('$25.00', { exact: true }).waitFor()
    await page.getByText(`1,843.920113 tokens (mint ${MINT})`).waitFor()
    await page.getByText('up to 0.50%').waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )

    await page.getByRole('button', { name: 'Trade with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trade executed.')
    const order = {
      agentId: 'research-bot',
      chain,
      tokenIn: usd,
      tokenOut: MINT,
      amountIn: '25000000',
      minAmountOut: '1843920113',
    }
    expect(guard.trading!.state.trades[0]?.bound).toEqual({ action: 'manual_trade', body: order })
    expect(violations).toEqual([])
    await close()
  })

  it('sells in the token units, a comma accepted', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading([MINT])
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/trade`)
    await page.getByLabel('Trade', { exact: true }).selectOption('sell')
    await page.getByLabel("Sell, in the token's units").fill('1,5')
    await page.getByRole('button', { name: 'Get quote' }).click()
    await page.getByRole('heading', { name: 'Confirm' }).waitFor()
    expect(guard.trading!.state.quotes[0]).toMatchObject({
      tokenIn: MINT,
      tokenOut: usd,
      amountIn: '1500000',
    })
    await page.getByText(`1.5 tokens (mint ${MINT})`).waitFor()
    await page.getByRole('button', { name: 'Change' }).click()
    await page.getByRole('button', { name: 'Get quote' }).waitFor()
    await close()
  })

  it('points to the trading settings while no token is allowed', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/trade`)
    await page.getByText(/Turn trading on and allow at least one token/).waitFor()
    expect(await page.getByRole('button', { name: 'Get quote' }).count()).toBe(0)
    await close()
  })

  it('shows neither search nor trade where guard-core has no owner trading routes', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading([MINT])
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot`)
    await page.getByRole('button', { name: 'Save trading' }).waitFor()
    expect(await page.getByRole('heading', { name: 'Find a token' }).count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Trade by hand' }).count()).toBe(0)
    await page.goto(`${guard.origin}/panel/agents/research-bot/trade`)
    await page.getByText('Trading by hand is not available on this DefiMind yet.').waitFor()
    expect(await page.getByRole('button', { name: 'Get quote' }).count()).toBe(0)
    expect(await status(page).textContent()).toBe('')
    expect(violations).toEqual([])
    await close()
  })
})
