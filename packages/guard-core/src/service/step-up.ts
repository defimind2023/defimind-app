import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import { createHash } from 'node:crypto'
import type { Db } from '../db/client.js'
import { canonicalJson } from '../domain/canonical.js'
import { assertionOptions, type PasskeySetup, verifyAssertion } from './passkeys.js'

export type OwnerAction =
  | 'approve_intent'
  | 'approve_mandate'
  | 'loosen_policy'
  | 'resume'
  | 'create_agent'
  | 'change_settings'
  | 'close_positions'
  | 'manual_trade'
  | 'agent_wallet'

const STEP_UP_MS = 5 * 60_000
type Address = Pick<PasskeySetup, 'rpId' | 'origin'>

/**
 * The challenge is keyed by the hash of the action and its body, so an assertion answers one exact
 * request: the same action on another intent, or the same agent with another policy, finds no
 * challenge out for it.
 */
function purpose(action: OwnerAction, body: unknown): string {
  const hash = createHash('sha256').update(canonicalJson({ action, body })).digest('hex')
  return `owner:${action}:${hash}`
}

export function stepUpChallenge(
  db: Db,
  setup: Pick<PasskeySetup, 'rpId'>,
  action: OwnerAction,
  body: unknown,
  now: Date,
) {
  return assertionOptions(
    db,
    setup,
    purpose(action, body),
    new Date(now.getTime() + STEP_UP_MS),
    now,
  )
}

/**
 * The passkey that signed for this action and body, or undefined. `body` is rebuilt from the
 * request that carries the assertion, never taken from the panel's word for what it signed.
 */
export function verifyStepUp(
  db: Db,
  setup: Address,
  action: OwnerAction,
  body: unknown,
  assertion: unknown,
  now: Date,
): Promise<string | undefined> {
  return verifyAssertion(
    db,
    setup,
    purpose(action, body),
    assertion as AuthenticationResponseJSON,
    now,
  )
}
