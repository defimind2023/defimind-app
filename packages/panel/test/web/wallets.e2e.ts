import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'
import { AGENT_WALLET } from './wallets.js'

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

async function agentPage(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
  await page.goto(`${origin}/panel/agents/research-bot`)
  await page.getByRole('heading', { name: 'Own wallet' }).waitFor()
}

describe.each([390, 1280])('agent wallets at %i px (CR-022)', (width) => {
  it('creates an agent wallet with a passkey, then shows the limit to sign and the gas', async () => {
    const open = await openDevice(browser, dist, width, false, false, true)
    const { guard, page, violations, close } = open
    await agentPage(page, guard.origin)
    await page.getByText(/this agent's problem stays within its own cap/).waitFor()
    await page.getByText(/sum of every daily limit/).waitFor()

    await page.getByRole('button', { name: 'Give it its own wallet on Solana devnet' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Wallet created. Now sign its limit.')
    expect(guard.wallets!.state.created).toEqual([
      {
        action: 'agent_wallet',
        body: { agentId: 'research-bot', chain: guard.wallets!.state.wallets[0]!.chain },
      },
    ])
    await page.getByText(AGENT_WALLET, { exact: true }).waitFor()
    await page.getByText('Waiting for its limit').waitFor()
    expect(
      await page
        .getByRole('link', { name: 'Sign the limit on this computer' })
        .getAttribute('href'),
    ).toBe(`${guard.origin}/sign/?action=add-limit&wallet=${AGENT_WALLET}`)
    await page.getByText(/Send a little SOL to the address above/).waitFor()
    await page.getByText('0 SOL (needs at least 0.002 SOL)').waitFor()

    guard.wallets!.state.wallets[0]!.status = 'active'
    await page.reload()
    await page.getByText('Active', { exact: true }).waitFor()
    expect(await page.getByRole('link', { name: /Sign the limit/ }).count()).toBe(0)
    expect(await page.getByText(/Send a little SOL/).count()).toBe(0)
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width)
    expect(violations).toEqual([])
    await close()
  })

  it('stops one agent and lists its own limits to remove', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, false, true)
    await agentPage(page, guard.origin)
    await page.getByRole('button', { name: 'Give it its own wallet on Solana devnet' }).click()
    await page.getByText(AGENT_WALLET, { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stop this agent' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Stopped research-bot.')
    expect(guard.wallets!.state.killed).toEqual(['research-bot'])
    await page.getByText("Remove the limit of research-bot's wallet.", { exact: true }).waitFor()
    await page.locator('#app').getByText(AGENT_WALLET, { exact: true }).last().waitFor()
    await page.getByText(/^research-bot is paused\. To be sure/).waitFor()
    expect(guard.state.killed).toBe(false)
    await close()
  })

  it('leaves both cards out where guard-core has no agent wallets', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    await page.goto(`${guard.origin}/panel/enrol#code=one-time`)
    await page.getByRole('button', { name: 'Create passkey' }).click()
    await page.getByRole('button', { name: 'Sign in with passkey' }).click()
    await page.getByRole('heading', { name: 'Overview' }).waitFor()
    await page.goto(`${guard.origin}/panel/agents/research-bot`)
    await page.getByRole('button', { name: 'Save policy' }).waitFor()
    expect(await page.getByRole('heading', { name: 'Own wallet' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Stop this agent' }).count()).toBe(0)
    await close()
  })
})
