import { chainName } from './chains.js'
import { BASE } from './route.js'

const TITLES = {
  approval: 'A payment waits for you',
  mandate: 'A task budget waits for you',
  executed: 'Payment sent',
  attack: 'Payment blocked as an attack',
  breaker: 'Agent paused by the breaker',
  passkey_enrolled: 'A passkey was added',
  kill: 'Everything stopped',
  chain_broken: 'The execution record is broken',
  backup_failed: 'The database backup failed',
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A push payload as the notification shows it. Plain checks rather than zod keep the worker a few
 * kilobytes. Anything unexpected still shows a notification: the browser requires one per push.
 */
export function notification(data: unknown) {
  const field = (key: string, max: number) => {
    const value = typeof data === 'object' && data !== null ? Reflect.get(data, key) : undefined
    return typeof value === 'string' && value.length <= max ? value : undefined
  }
  const kind = field('kind', 32)
  const intentId = field('intentId', 36)
  const agentId = field('agentId', 64)
  const chain = field('chain', 64)
  const where = [agentId, chain && chainName(chain)].filter(Boolean).join(' on ')
  const approval = kind === 'approval' && intentId !== undefined && UUID.test(intentId)
  return {
    title:
      kind !== undefined && Object.hasOwn(TITLES, kind)
        ? TITLES[kind as keyof typeof TITLES]
        : 'DefiMind',
    body: where ? `${where}. Open the panel to see it.` : 'Open the panel to see it.',
    tag: approval ? intentId : (kind ?? 'defimind'),
    path: approval ? `${BASE}approvals/${intentId}` : BASE,
  }
}
