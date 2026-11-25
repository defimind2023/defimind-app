import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'
import { HOT_WALLET } from './guard.js'
import { VAULT } from './setup.js'

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

describe.each([390, 1280])('the spending wallet at %i px', (width) => {
  it('shows the shared wallet in full in the guide, after the limit, with its SOL', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, true)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    guard.setup.vault = VAULT
    guard.state.hotGas = { balance: '1000000', minimum: '5000000', symbol: 'SOL' }
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/start/deposit`)
    await page.getByRole('heading', { name: 'Spending wallet · Solana devnet' }).waitFor()
    await page.getByText(HOT_WALLET, { exact: true }).waitFor()
    await page.getByText('0.001 SOL', { exact: true }).waitFor()
    await page.getByText('0.005 SOL', { exact: true }).waitFor()
    await page.getByText('Send SOL to the address above.').waitFor()
    await page.getByText('About $1 of SOL covers fees and new token accounts.').waitFor()
    await page.getByRole('button', { name: 'Copy address' }).last().click()
    await expect.poll(() => status(page).textContent()).toBe('Address copied.')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(HOT_WALLET)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
    expect(violations).toEqual([])
    await close()
  })

  it('shows it in Settings, pointing to Doctor while guard-core does not send its SOL', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, true)
    await signIn(page, guard.origin)
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('heading', { name: 'Spending wallet · Solana devnet' }).waitFor()
    await page.getByText(HOT_WALLET, { exact: true }).waitFor()
    await page.getByText('Doctor shows whether it has enough.').waitFor()
    expect(await page.getByText('Needs at least').count()).toBe(0)
    await close()
  })

  it('keeps "Try it safely" open while the spending wallet is short of SOL', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    guard.state.hotGas = { balance: '1000000', minimum: '5000000', symbol: 'SOL' }
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/start/shadow`)
    await page
      .getByText(/^Before going live, send a little SOL to the spending wallet on Solana devnet/)
      .waitFor()
    await page.getByRole('button', { name: 'Back to Add money' }).waitFor()
    expect(await page.getByRole('button', { name: 'Next' }).count()).toBe(0)

    guard.state.hotGas = { balance: '9000000', minimum: '5000000', symbol: 'SOL' }
    await page.reload()
    await page.getByRole('button', { name: 'Next' }).waitFor()
    expect(await page.getByText(/^Before going live/).count()).toBe(0)
    await close()
  })
})
