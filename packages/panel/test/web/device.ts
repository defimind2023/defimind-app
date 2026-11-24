import type { Browser, Page } from 'playwright'
import { guardCore } from './guard.js'

/** A page with a platform passkey that always verifies the owner, and every CSP violation kept. */
export async function openDevice(
  browser: Browser,
  dist: string,
  width: number,
  fresh = false,
  trading = false,
  wallets = false,
) {
  const guard = await guardCore(dist, { fresh, trading, wallets })
  const context = await browser.newContext({ viewport: { width, height: 844 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const violations: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/.test(message.text())) {
      violations.push(message.text())
    }
  })
  return { guard, page, violations, close: () => Promise.all([context.close(), guard.close()]) }
}

export const status = (page: Page) => page.locator('#status')
