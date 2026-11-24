import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'

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

const device = (width: number) => openDevice(browser, dist, width)

async function signIn(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  expect(new URL(page.url()).hash).toBe('')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

describe.each([390, 1280])('the panel at %i px', (width) => {
  it('enrols, signs in and approves a payment with a step-up passkey', async () => {
    const { guard, page, violations, close } = await device(width)
    await page.goto(`${guard.origin}/panel/`)
    await page.getByRole('heading', { name: 'Welcome to DefiMind' }).waitFor()
    await signIn(page, guard.origin)

    await page.getByText('Waiting for you (2)').waitFor()
    await page.getByText('$2.50 USDC').click()
    await page.getByRole('heading', { name: '$2.50 USDC' }).waitFor()
    await expect
      .poll(() => page.locator('.flag').textContent())
      .toBe('first payment to this domain')
    await page.getByRole('button', { name: 'Approve with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Approved.')

    expect(guard.state.decisions).toEqual([
      {
        kind: 'intent',
        id: guard.intentId,
        decision: 'approve',
        stepUp: { action: 'approve_intent', body: { intentId: guard.intentId } },
      },
    ])
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width)
    expect(violations).toEqual([])
    await close()
  })

  it('rejects a task budget without a passkey', async () => {
    const { guard, page, close } = await device(width)
    await signIn(page, guard.origin)
    await page.getByText('Task budget $3.00').click()
    await page.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Rejected.')
    expect(guard.state.decisions).toEqual([
      { kind: 'mandate', id: guard.mandateId, decision: 'reject' },
    ])
    expect([...guard.state.challenges.values()].filter(Boolean)).toEqual([])
    await close()
  })

  it('asks for the passkey to loosen the policy and not to tighten it', async () => {
    const { guard, page, close } = await device(width)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'research-bot', exact: true }).click()
    await page.getByLabel('Per day, in dollars').waitFor()
    expect(await page.getByLabel('Per day, in dollars').inputValue()).toBe('5.00')

    await page.getByLabel('Per day, in dollars').fill('20')
    await page.getByRole('button', { name: 'Save policy' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Policy saved. Confirmed with your passkey.')
    const loose = guard.state.puts[0]
    expect(loose?.policy['dailyMax']).toBe('20000000')
    expect(loose?.stepUp).toEqual({
      action: 'loosen_policy',
      body: { agentId: 'research-bot', policy: loose?.policy },
    })

    await page.getByLabel('Per payment, in dollars').fill('0.50')
    await page.getByRole('button', { name: 'Save policy' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Policy saved.')
    expect(guard.state.puts[1]).toEqual({ policy: { ...loose?.policy, perTxMax: '500000' } })

    await page.getByLabel('Per payment, in dollars').fill('a lot')
    await page.getByRole('button', { name: 'Save policy' }).click()
    await expect.poll(() => status(page).textContent()).toMatch(/^Per payment: write an amount/)
    expect(guard.state.puts).toHaveLength(2)
    await close()
  })

  it('stops everything and shows each chain to finish in the wallet', async () => {
    const { guard, page, violations, close } = await device(width)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'Stop everything' }).click()
    await page.getByRole('button', { name: 'Stop everything' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Stopped. 1 agent paused.')
    expect(guard.state.killed).toBe(true)
    expect(await page.getByRole('link', { name: 'Open in Phantom' }).getAttribute('href')).toBe(
      'https://phantom.app/ul/browse/x',
    )
    await page.getByText('Could not build the kill transaction.').waitFor()
    // No link for Solana here, as on a one-click deployment: the owner removes the limit in Squads.
    expect(await page.getByRole('link', { name: 'Open app.squads.so' }).getAttribute('href')).toBe(
      'https://app.squads.so',
    )
    expect(await page.getByRole('link', { name: 'Open app.safe.global' }).count()).toBe(0)
    expect(violations).toEqual([])
    await close()
  })
})

it('sends a signed-out owner to the passkey and back to the link they opened', async () => {
  const { guard, page, close } = await device(390)
  await page.goto(`${guard.origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await page.getByRole('button', { name: 'Sign in with passkey' }).waitFor()
  await page.goto(`${guard.origin}/panel/approvals/${guard.intentId}`)
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('button', { name: 'Approve with passkey' }).waitFor()
  expect(new URL(page.url()).pathname).toBe(`/panel/approvals/${guard.intentId}`)
  await close()
})

it('adds a second passkey only with the first one vouching for it', async () => {
  const { guard, page, close } = await device(390)
  await signIn(page, guard.origin)
  await page.goto(`${guard.origin}/panel/enrol#code=second`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  expect(guard.state.passkeys).toBe(2)
  await close()
})

it('keeps the owner signed in when guard-core refuses a passkey', async () => {
  const { guard, page, close } = await device(390)
  await signIn(page, guard.origin)
  guard.state.refuseNextPasskey = true
  await page.getByText('$2.50 USDC').click()
  await page.getByRole('button', { name: 'Approve with passkey' }).click()
  await expect
    .poll(() => status(page).textContent())
    .toBe('The passkey was not accepted. Try again.')
  expect(new URL(page.url()).pathname).toBe(`/panel/approvals/${guard.intentId}`)
  await page.getByRole('button', { name: 'Approve with passkey' }).click()
  await expect.poll(() => status(page).textContent()).toBe('Approved.')
  await close()
})

describe.each([390, 1280])('the executions screen at %i px', (width) => {
  it('shows the record, says what relayed means and downloads a proof as sent', async () => {
    const { guard, page, violations, close } = await device(width)
    await signIn(page, guard.origin)
    await page.locator('nav').getByRole('link', { name: 'Executions' }).click()
    await page.getByText('✓ Intact: 2 receipts, each one linked and signed.').waitFor()
    await page.getByText('Anchored up to #1 on Solana devnet').waitFor()
    await page.getByText(/^Relayed: reported by the gateway\. DefiMind vouches/).waitFor()
    await page.getByText('#1 github · create_issue').waitFor()
    await page.getByText('#2 Payment $1.75 USDC on Base Sepolia').waitFor()
    await expect.poll(() => page.getByText('Proof once anchored.').count()).toBe(1)

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download proof' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('defimind-proof-1.json')
    const bundle = JSON.parse(await readFile((await file.path())!, 'utf8')) as Record<
      string,
      unknown
    >
    expect(bundle['receipt']).toEqual(guard.receipts[0])
    expect(violations).toEqual([])
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width)
    await close()
  })
})

it('says where the execution record broke', async () => {
  const { guard, page, close } = await device(390)
  guard.state.brokenAt = 2
  await signIn(page, guard.origin)
  await page.goto(`${guard.origin}/panel/executions`)
  await page.getByText(/^✗ Broken at receipt #2/).waitFor()
  await close()
})
