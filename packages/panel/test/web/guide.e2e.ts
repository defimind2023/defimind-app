import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS, getAddress } from '@defimind/shared'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'
import { SETUP_CODE, VAULT } from './setup.js'

let browser: Browser
let dist: string

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'defimind-guide-'))
  await buildPanel(dist)
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

const step = (page: Page, n: number, title: string) =>
  Promise.all([
    page.getByText(`Step ${n} of 9`).waitFor(),
    page.getByRole('heading', { name: title }).waitFor(),
  ])

describe.each([390, 1280])('the guided setup at %i px', (width) => {
  it('takes a fresh DefiMind from the setup code to a live agent', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, true)

    // First access: only the host's setup code opens the enrol screen.
    await page.goto(`${guard.origin}/panel/`)
    await page.getByLabel('Setup code').fill('a wrong code')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.poll(() => status(page).textContent()).toContain('That code is not right')
    await page.getByLabel('Setup code').fill(SETUP_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('heading', { name: 'Add your passkey' }).waitFor()
    // The refusal belonged to the setup screen: the next one starts clean.
    expect(await status(page).textContent()).toBe('')
    await page.getByRole('button', { name: 'Create passkey' }).click()
    await page.getByRole('button', { name: 'Sign in with passkey' }).click()
    await page.getByRole('heading', { name: 'Overview' }).waitFor()
    await page.getByText('No vault yet: finish the guided setup.').waitFor()
    await page.getByText('1 of 9 steps done.').waitFor()

    // The guide resumes at the first step guard-core does not report done.
    await page.goto(`${guard.origin}/panel/start`)
    await step(page, 2, 'Connect Phantom')
    expect(await page.locator('progress').getAttribute('value')).toBe('1')
    await page.getByRole('button', { name: 'I have Phantom' }).click()

    await step(page, 3, 'Create your vault')
    const create = await page
      .getByRole('link', { name: 'Create on this computer' })
      .getAttribute('href')
    expect(create).toBe(`${guard.origin}/sign/?action=create&cluster=devnet`)
    expect(
      await page.getByRole('link', { name: 'Create in Phantom' }).getAttribute('href'),
    ).toMatch(/^https:\/\/phantom\.app\/ul\/browse\//)
    await page.getByLabel(/Your vault address/).fill(VAULT)
    await page.getByRole('button', { name: 'Next' }).click()

    await step(page, 4, 'Set a daily limit')
    expect(
      await page.getByRole('link', { name: 'Set the limit on this computer' }).getAttribute('href'),
    ).toBe(`${guard.origin}/sign/?action=add-limit&cluster=devnet&multisig=${VAULT}`)
    await page.getByRole('button', { name: 'Save vault with passkey' }).click()

    await step(page, 5, 'Add money')
    expect(guard.setup.saved.at(-1)).toEqual({
      chains: [{ chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', vault: VAULT }],
      stepUp: {
        action: 'change_settings',
        body: { chains: [{ chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', vault: VAULT }] },
      },
    })
    await page.getByText('About 3 days at the daily limit.').waitFor()
    await page.locator('svg.qr path').waitFor()
    await page.getByText(VAULT, { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Deposit with Phantom' }).waitFor()
    await page.getByRole('button', { name: 'Next' }).click()

    await step(page, 6, 'Connect your agent')
    await page.getByLabel('A name for your agent').fill('my-agent')
    await page.getByRole('button', { name: 'Create with passkey' }).click()
    await page
      .getByText(
        `--guard-url ${guard.origin} --agent-id my-agent --chain solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 --check`,
      )
      .waitFor()
    expect(guard.state.tokens).toEqual([
      { agentId: 'my-agent', stepUp: { action: 'create_agent', body: { agentId: 'my-agent' } } },
    ])
    await page.getByRole('button', { name: 'Next' }).click()

    await step(page, 7, 'Choose the rules')
    await page.getByRole('button', { name: 'Use Careful' }).click()

    await step(page, 8, 'Try it safely')
    // The agent started deny-all: the preset opens the vaulted chain and its dollar.
    expect(guard.state.puts.at(-1)?.policy).toMatchObject({
      chains: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
      tokens: [getAddress(CHAINS.solanaDevnet, 'usd')],
      dailyMax: '5000000',
    })
    await page.getByRole('button', { name: 'Next' }).click()

    await step(page, 9, 'Go live')
    await page.getByRole('button', { name: 'Go live with passkey' }).click()
    await page.getByRole('heading', { name: 'You are set up' }).waitFor()
    expect(guard.state.puts.at(-1)?.stepUp?.action).toBe('loosen_policy')
    expect(guard.state.policy['mode']).toBe('live')

    // The agent's screen shows where it may pay, as boxes over this deployment's chains.
    await page.goto(`${guard.origin}/panel/agents/my-agent`)
    expect(await page.getByLabel('Solana devnet, in its dollar').isChecked()).toBe(true)

    // Leaving and coming back lands on any step, done ones marked.
    await page.goto(`${guard.origin}/panel/start/deposit`)
    await step(page, 5, 'Add money')

    const width_ = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width_).toBeLessThanOrEqual(width)
    expect(violations).toEqual([])
    await close()
  })

  it('names the vault guard-core refuses', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, true)
    await page.goto(`${guard.origin}/panel/`)
    await page.getByLabel('Setup code').fill(SETUP_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Create passkey' }).click()
    await page.getByRole('button', { name: 'Sign in with passkey' }).click()
    await page.getByRole('heading', { name: 'Overview' }).waitFor()
    await page.goto(`${guard.origin}/panel/start/vault`)
    await page.getByLabel(/Your vault address/).fill('So11111111111111111111111111111111111111112')
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Save vault with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toContain('does not name this DefiMind')
    await close()
  })
})
