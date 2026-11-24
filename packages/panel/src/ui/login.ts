import { ApiError } from '../adapters/api.js'
import { href, parseRoute } from '../domain/route.js'
import type { Context, Screen } from './context.js'
import { button, card, el } from './dom.js'

export async function login(ctx: Context, next: () => Promise<void>): Screen {
  if ((await ctx.api.setup()).needsSetup) {
    // Shown in place: navigating from inside a render would race this one.
    history.replaceState(null, '', href({ name: 'setup' }))
    return setup(ctx)
  }
  return [
    el('h1', {}, 'DefiMind'),
    el('p', {}, 'Sign in with the passkey on this device.'),
    button(
      'Sign in with passkey',
      async () => {
        await ctx.api.login()
        await next()
      },
      'primary',
    ),
  ]
}

/** The enrol route of a link guard-core issued, only for this same panel. */
function enrolRoute(link: string) {
  const url = new URL(link)
  const route = parseRoute(url.pathname, url.hash)
  return url.origin === location.origin && route.name === 'enrol' ? route : undefined
}

/**
 * CR-019 first access: until a passkey exists, the setup code from the host's dashboard opens the
 * enrol screen. Once one does, guard-core never takes the code again.
 */
export async function setup(ctx: Context): Screen {
  const input = el('input', {
    id: 'setup-code',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '256',
  })
  const claim = async () => {
    try {
      const { enrolLink } = await ctx.api.claim(input.value.trim())
      const route = enrolRoute(enrolLink)
      if (route === undefined) {
        ctx.say(
          'guard-core sent a link for another address. Open the panel from its own address.',
          'stop',
        )
        return
      }
      await ctx.go(route, true)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'setup_done') {
        await ctx.go({ name: 'login' }, true)
        ctx.say('This DefiMind is already set up. Sign in with your passkey.')
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        ctx.say("That code is not right. Copy it again from your host's dashboard.", 'stop')
      } else {
        throw error
      }
    }
  }
  return [
    el('h1', {}, 'Welcome to DefiMind'),
    el(
      'p',
      {},
      'DefiMind lets your AI agents pay for things, only within the limits you set, and asks you before anything unusual.',
    ),
    card(
      el('h2', {}, 'First, prove this is your DefiMind'),
      el(
        'p',
        {},
        'Your host made a setup code when it started DefiMind. Find SETUP_CODE in its dashboard, under Environment, and paste it here.',
      ),
      el('label', { for: 'setup-code' }, 'Setup code'),
      input,
      button('Continue', claim, 'primary'),
    ),
    el(
      'p',
      { class: 'muted' },
      'The code works only until you add your passkey on the next screen.',
    ),
  ]
}

export async function enrol(ctx: Context, code: string): Screen {
  return [
    el('h1', {}, 'Add your passkey'),
    el(
      'p',
      {},
      'This makes a passkey on this device for DefiMind. It approves payments from now on, so use a device only you unlock.',
    ),
    el('p', { class: 'muted' }, 'The link works once and for 10 minutes.'),
    button(
      'Create passkey',
      async () => {
        await ctx.api.enrol(code)
        // The code is spent: replace the entry so it leaves the history.
        await ctx.go({ name: 'login' }, true)
        ctx.say('Passkey saved. Sign in with it.', 'done')
      },
      'primary',
    ),
  ]
}
