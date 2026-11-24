import { ApiError, Cancelled, ownerApi } from './adapters/api.js'
import { browserAuthenticator } from './adapters/webauthn.js'
import { BASE, href, parseRoute, type Route } from './domain/route.js'
import { agent } from './ui/agent.js'
import { agents } from './ui/agents.js'
import { approval, mandate } from './ui/approval.js'
import type { Context, Screen } from './ui/context.js'
import { el } from './ui/dom.js'
import { kill } from './ui/kill.js'
import { wholeTabs } from './ui/nav.js'
import { deposit } from './ui/deposit.js'
import { guide } from './ui/guide.js'
import { enrol, login, setup } from './ui/login.js'
import { manualTrade } from './ui/manual-trade.js'
import { overview } from './ui/overview.js'
import { portfolio } from './ui/portfolio.js'
import { executions } from './ui/executions.js'
import { doctor, report } from './ui/report.js'
import { settings } from './ui/settings.js'

const view = document.getElementById('app')!
const status = document.getElementById('status')!

/** Where to go once signed in: the screen a notification or a link opened. */
let after: Route = { name: 'overview' }

const ERRORS: Record<string, string> = {
  step_up_required: 'This needs your passkey. Try again.',
  passkey_not_verified: 'The passkey was not accepted. Try again.',
  bad_origin: 'Open the panel from its own address, not through another site.',
  code_not_valid: 'This enrol link is used or expired. Ask for a new one.',
  passkey_exists: 'This passkey is already enrolled.',
  already_decided: 'Already decided.',
  not_pending: 'Already decided.',
  expired: 'It expired before the decision.',
  exists: 'An agent with that name exists.',
  not_found: 'Not found.',
  invalid_request: 'guard-core did not accept that request.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  vault_not_ours:
    "That vault's limit does not name this DefiMind. Check the address, or set the daily limit first.",
  setup_done: 'This DefiMind is already set up. Sign in with your passkey.',
  no_vault: 'This chain has no vault yet. Set one up first, in the guided setup.',
  set_by_env: "That setting comes from your host's configuration. Change it there, not here.",
}

const ctx: Context = {
  api: ownerApi(browserAuthenticator),
  go(route, replace = false) {
    // A message belongs to the screen it was said on: a refusal must not greet the next one.
    ctx.say('')
    history[replace ? 'replaceState' : 'pushState'](null, '', href(route))
    return render()
  },
  say(message, tone = 'info') {
    status.textContent = message
    status.dataset['tone'] = tone
  },
}

function fail(error: unknown) {
  if (error instanceof ApiError && error.noSession) {
    void ctx.go({ name: 'login' }, true)
  } else if (error instanceof Cancelled) {
    ctx.say('Passkey cancelled: nothing was sent.')
  } else if (error instanceof ApiError) {
    const known = error.status === 429 ? 'rate_limited' : error.code
    ctx.say(ERRORS[known] ?? `guard-core refused it (${error.code}).`, 'stop')
  } else {
    ctx.say(error instanceof Error ? error.message : 'Something went wrong.', 'stop')
  }
}

function screen(route: Route): Screen {
  switch (route.name) {
    case 'login':
      return login(ctx, async () => {
        await ctx.go(after, true)
        ctx.say('')
      })
    case 'enrol':
      return enrol(ctx, route.code)
    case 'overview':
      return overview(ctx)
    case 'approval':
      return approval(ctx, route.id)
    case 'mandate':
      return mandate(ctx, route.id)
    case 'agents':
      return agents(ctx)
    case 'agent':
      return agent(ctx, route.id)
    case 'trade':
      return manualTrade(ctx, route.id)
    case 'report':
      return report(ctx)
    case 'doctor':
      return doctor(ctx)
    case 'executions':
      return executions(ctx)
    case 'settings':
    case 'passkeys':
      return settings(ctx)
    case 'kill':
      return kill(ctx)
    case 'portfolio':
      return portfolio(ctx)
    case 'setup':
      return setup(ctx)
    case 'deposit':
      return deposit(ctx)
    case 'guide':
      return guide(ctx, route.step)
    case 'missing':
      return Promise.resolve([el('h1', {}, 'Nothing here'), el('a', { href: BASE }, 'Overview')])
  }
}

async function render() {
  const route = parseRoute(location.pathname, location.hash)
  if (!['login', 'enrol', 'setup'].includes(route.name)) {
    after = route
  }
  document.body.dataset['screen'] = route.name
  view.setAttribute('aria-busy', 'true')
  try {
    view.replaceChildren(
      ...(await screen(route)).filter(
        (child) => typeof child === 'string' || child instanceof Node,
      ),
    )
    window.scrollTo(0, 0)
  } catch (error) {
    fail(error)
  } finally {
    view.removeAttribute('aria-busy')
  }
}

/** Buttons run their action outside render: their errors land here. */
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  fail(event.reason)
})

document.addEventListener('click', (event) => {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  if (anchor && anchor.origin === location.origin && anchor.pathname.startsWith(BASE)) {
    event.preventDefault()
    status.textContent = ''
    history.pushState(null, '', anchor.pathname + anchor.hash)
    wholeTabs(document.querySelector('nav')!)
    void render()
  }
})
window.addEventListener('popstate', () => {
  ctx.say('')
  wholeTabs(document.querySelector('nav')!)
  void render()
})

if ('serviceWorker' in navigator) {
  // Offline support only: a failure here must not overwrite what the status line says.
  navigator.serviceWorker
    .register(`${BASE}sw.js`, { scope: BASE })
    .catch((error: unknown) => console.warn('service worker not registered', error))
}
wholeTabs(document.querySelector('nav')!)
void render()
