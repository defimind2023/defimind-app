import { softAuthenticator } from '../../../packages/guard-core/test/webauthn.js'
import { PANEL_RP, type Stack } from './stack.js'

const PANEL = { origin: PANEL_RP.origin, 'x-defimind-request': '1' }

/**
 * The owner in the panel: the first passkey enrolled, a session opened with it, and every
 * step-up signed by that same device. Needs a stack built with `panel: true`.
 */
export async function owner(s: Stack) {
  const device = softAuthenticator(PANEL_RP.id, PANEL_RP.origin)
  const enrol = await s.admin('POST', '/v1/admin/passkeys/options')
  const { challenge } = enrol.body as { challenge: string }
  await s.admin('POST', '/v1/admin/passkeys', { response: device.register(challenge) })

  let cookie = ''
  const send = (url: string, payload: object, method: 'GET' | 'POST') =>
    s.guard.inject({
      method,
      url,
      headers: { ...PANEL, cookie },
      ...(method === 'POST' ? { payload } : {}),
    })
  const call = async (
    url: string,
    payload: object = {},
    method: 'GET' | 'POST' = 'POST',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await send(url, payload, method)
    return { status: res.statusCode, body: res.json<Record<string, unknown>>() }
  }
  const options = await call('/v1/owner/session/options')
  const signIn = await send(
    '/v1/owner/session',
    { assertion: device.assert(String(options.body['challenge'])) },
    'POST',
  )
  cookie = /dm_session=[^;]*/.exec(String(signIn.headers['set-cookie']))?.[0] ?? ''

  /** The passkey's assertion for exactly this action and body. */
  async function stepUp(action: string, body: object) {
    const step = await call('/v1/owner/challenge', { action, body })
    return device.assert(String(step.body['challenge']))
  }

  return {
    call,
    stepUp,
    signedIn: cookie !== '',
    async approve(intentId: string) {
      const assertion = await stepUp('approve_intent', { intentId })
      return call(`/v1/owner/intents/${intentId}/decision`, { decision: 'approve', assertion })
    },
  }
}
