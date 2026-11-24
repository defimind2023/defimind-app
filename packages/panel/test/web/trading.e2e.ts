import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'
import { MINT } from './trading.js'

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

async function signIn(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth)

describe.each([390, 1280])('trading at %i px', (width) => {
  it('shows a swap whole, every flag explained, and approves it with a passkey', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    await signIn(page, guard.origin)
    await page.getByText('Waiting for you (3)').waitFor()
    await page.getByText('Buy with $25.00 USDC').click()
    await page.getByRole('heading', { name: 'Buy with $25.00 USDC' }).waitFor()

    const app = page.locator('#app')
    await app.getByText(MINT, { exact: true }).waitFor()
    await app.getByText(`1,843.920113 JUP (mint ${MINT})`).waitFor()
    await app.getByText('up to 0.50%').waitFor()
    await app.getByText('0.12%').waitFor()
    expect(await page.locator('.flag').allTextContents()).toEqual([
      'NEW_TOKEN: First buy of this token by any of your agents.',
      'MINT_AUTHORITY: The token can still be minted: its supply is not fixed.',
    ])
    await app.getByText('Nothing leaves your vault until you approve.').waitFor()
    expect(await fits(page)).toBeLessThanOrEqual(width)

    await page.getByRole('button', { name: 'Approve with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Approved.')
    const id = guard.trading!.intentId
    expect(guard.state.decisions).toEqual([
      {
        kind: 'intent',
        id,
        decision: 'approve',
        stepUp: { action: 'approve_intent', body: { intentId: id } },
      },
    ])
    expect(violations).toEqual([])
    await close()
  })

  it('lists holdings at cost against the day', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    await signIn(page, guard.origin)
    await page.getByRole('link', { name: 'Portfolio' }).click()
    await page.getByRole('heading', { name: 'Portfolio' }).waitFor()
    await page.getByText(`1,843.920113 JUP (mint ${MINT})`).waitFor()
    await page.getByText('$25.00 on Solana Devnet', { exact: false }).waitFor()
    await page.getByText('$35.00 of $100.00').waitFor()
    expect(await fits(page)).toBeLessThanOrEqual(width)
    expect(violations).toEqual([])
    await close()
  })

  it('asks for the passkey to turn trading on and not to tighten it', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'research-bot', exact: true }).click()
    await page.getByLabel('Let this agent trade').check()
    await page.getByLabel('Tokens it may buy').fill(MINT)
    await page.getByLabel('Each buy, in dollars').fill('25')
    await page.getByLabel('All buys in a day, in dollars').fill('100')
    await page.getByLabel('Held in one token at cost, in dollars').fill('50')
    await page.getByRole('button', { name: 'Save trading' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Trading saved. Confirmed with your passkey.')
    const loose = guard.state.puts[0]
    expect(loose?.policy['trading']).toEqual({
      enabled: true,
      venues: ['jupiter'],
      tokens: [MINT],
      allowAnyToken: false,
      maxTradeUsd: '25000000',
      dailyTradeMax: '100000000',
      maxPositionUsd: '50000000',
      maxSlippageBps: 100,
      maxPriceImpactBps: 300,
    })
    expect(loose?.stepUp?.action).toBe('loosen_policy')

    await page.getByLabel('Slippage up to, in percent').fill('0.5')
    await page.getByRole('button', { name: 'Save trading' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trading saved.')
    expect(guard.state.puts[1]?.stepUp).toBeUndefined()

    await page.getByLabel('Price impact up to, in percent').fill('lots')
    await page.getByRole('button', { name: 'Save trading' }).click()
    await expect.poll(() => status(page).textContent()).toMatch(/write a percent/)
    expect(guard.state.puts).toHaveLength(2)
    // A refusal keeps what the owner typed.
    expect(await page.getByLabel('Price impact up to, in percent').inputValue()).toBe('lots')
    expect(await page.getByLabel('Each buy, in dollars').inputValue()).toBe('25.00')

    // An iPhone in pt-BR types a comma.
    await page.getByLabel('Price impact up to, in percent').fill('2,5')
    await page.getByLabel('Each buy, in dollars').fill('2,00')
    await page.getByRole('button', { name: 'Save trading' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trading saved.')
    expect(guard.state.puts[2]?.policy['trading']).toMatchObject({
      maxTradeUsd: '2000000',
      maxPriceImpactBps: 250,
    })
    await close()
  })

  it('closes every position from the Stop screen with a passkey', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'Stop everything' }).click()
    await page.getByRole('button', { name: 'Close positions with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Selling 2 tokens.')
    expect(guard.trading!.state.closes).toEqual([{ action: 'close_positions', body: {} }])
    await page.getByText(`1,843.920113 JUP (mint ${MINT})`).waitFor()
    await page.getByText(/^9,120,000 tokens \(mint /).waitFor()
    expect(violations).toEqual([])
    await close()
  })

  it('leaves Close positions out where guard-core has no trading', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'Stop everything' }).click()
    await page.getByRole('button', { name: 'Stop everything' }).waitFor()
    expect(await page.getByRole('button', { name: 'Close positions with passkey' }).count()).toBe(0)
    await close()
  })

  it('says trading is not available where guard-core has no portfolio route', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width)
    await signIn(page, guard.origin)
    await page.getByRole('link', { name: 'Portfolio' }).click()
    await page.getByText(/^Trading is not available on this DefiMind yet/).waitFor()
    expect(await status(page).textContent()).toBe('')
    expect(violations).toEqual([])
    await close()
  })

  it('shows no tab cut in half against Stop', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    await signIn(page, guard.origin)
    for (const scroll of [0, 120, 10_000]) {
      await page.locator('nav').evaluate((nav, x) => nav.scrollTo(x, 0), scroll)
      await expect
        .poll(() =>
          page.evaluate(() => {
            const nav = document.querySelector('nav')!
            const edge = nav.querySelector('a.stop')!.getBoundingClientRect().left
            const left = nav.getBoundingClientRect().left
            return [...nav.querySelectorAll('a:not(.stop)')].filter((tab) => {
              const box = tab.getBoundingClientRect()
              const partial = box.right > edge + 1 || box.left < left - 1
              return partial && box.left < edge && getComputedStyle(tab).opacity !== '0'
            }).length
          }),
        )
        .toBe(0)
    }
    await close()
  })

  it('shows Stop at once while the portfolio read hangs', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    await signIn(page, guard.origin)
    await page.route('**/v1/owner/portfolio', () => undefined)
    await page.locator('#app').getByRole('link', { name: 'Stop everything' }).click()
    await page.getByRole('button', { name: 'Stop everything' }).click({ timeout: 2000 })
    await expect.poll(() => status(page).textContent()).toBe('Stopped. 1 agent paused.')
    expect(guard.state.killed).toBe(true)
    expect(await page.getByRole('button', { name: 'Close positions with passkey' }).count()).toBe(0)
    await close()
  })
})
