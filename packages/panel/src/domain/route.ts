import { isStep, type StepId } from './guide.js'

/** Every screen of the panel. guard-core serves index.html for any path under the base. */
export type Route =
  | { name: 'overview' }
  | { name: 'login' }
  | { name: 'enrol'; code: string }
  | { name: 'approval'; id: string }
  | { name: 'mandate'; id: string }
  | { name: 'agents' }
  | { name: 'agent'; id: string }
  | { name: 'trade'; id: string }
  | { name: 'report' }
  | { name: 'doctor' }
  | { name: 'executions' }
  | { name: 'passkeys' }
  | { name: 'settings' }
  | { name: 'kill' }
  | { name: 'portfolio' }
  | { name: 'setup' }
  | { name: 'deposit' }
  | { name: 'guide'; step?: StepId }
  | { name: 'missing' }

export const BASE = '/panel/'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AGENT_ID = /^\S{1,64}$/
const SIMPLE = [
  'login',
  'agents',
  'report',
  'doctor',
  'executions',
  'passkeys',
  'settings',
  'kill',
  'portfolio',
  'setup',
  'deposit',
] as const

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

/**
 * The route of a location. The enrol code is read from the fragment only: it never reaches a
 * request line, a referrer or a log.
 */
export function parseRoute(pathname: string, hash = ''): Route {
  if (!pathname.startsWith(BASE)) {
    return pathname === BASE.slice(0, -1) ? { name: 'overview' } : { name: 'missing' }
  }
  const parts = pathname.slice(BASE.length).split('/').filter(Boolean)
  const [first, second, ...rest] = parts
  if (rest.length > 0) {
    const id = second === undefined ? undefined : decode(second)
    // CR-025: an agent's manual trade screen, the only three-part path.
    return first === 'agents' && rest.join('/') === 'trade' && id !== undefined && AGENT_ID.test(id)
      ? { name: 'trade', id }
      : { name: 'missing' }
  }
  if (first === undefined) {
    return { name: 'overview' }
  }
  if (second === undefined) {
    if (first === 'enrol') {
      const code = new URLSearchParams(hash.replace(/^#/, '')).get('code')
      return code ? { name: 'enrol', code } : { name: 'missing' }
    }
    if (first === 'start') {
      return { name: 'guide' }
    }
    const simple = SIMPLE.find((name) => name === first)
    return simple ? { name: simple } : { name: 'missing' }
  }
  const id = decode(second)
  if (first === 'approvals' && id !== undefined && UUID.test(id)) {
    return { name: 'approval', id }
  }
  if (first === 'mandates' && id !== undefined && UUID.test(id)) {
    return { name: 'mandate', id }
  }
  if (first === 'agents' && id !== undefined && AGENT_ID.test(id)) {
    return { name: 'agent', id }
  }
  if (first === 'start' && id !== undefined && isStep(id)) {
    return { name: 'guide', step: id }
  }
  return { name: 'missing' }
}

/** The path of a route; parseRoute(href(route)) gives the same route back. */
export function href(route: Route): string {
  switch (route.name) {
    case 'overview':
    case 'missing':
      return BASE
    case 'enrol':
      return `${BASE}enrol#${new URLSearchParams({ code: route.code })}`
    case 'approval':
      return `${BASE}approvals/${route.id}`
    case 'mandate':
      return `${BASE}mandates/${route.id}`
    case 'agent':
      return `${BASE}agents/${encodeURIComponent(route.id)}`
    case 'trade':
      return `${BASE}agents/${encodeURIComponent(route.id)}/trade`
    case 'guide':
      return `${BASE}start${route.step === undefined ? '' : `/${route.step}`}`
    default:
      return `${BASE}${route.name}`
  }
}
