import type { LightMyRequestResponse } from 'fastify'
import { ADMIN_TOKEN, PASSKEY_RP, type Harness } from './harness.js'
import { softAuthenticator } from './webauthn.js'

export const PANEL = { origin: PASSKEY_RP.origin, 'x-defimind-request': '1' }
export type Device = ReturnType<typeof softAuthenticator>
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** The owner's first passkey, enrolled through the admin routes. */
export async function enrolPasskey(h: Harness): Promise<Device> {
  const device = softAuthenticator(PASSKEY_RP.id, PASSKEY_RP.origin)
  const admin = { authorization: `Bearer ${ADMIN_TOKEN}` }
  const options = (
    await h.app.inject({ method: 'POST', url: '/v1/admin/passkeys/options', headers: admin })
  ).json()
  await h.app.inject({
    method: 'POST',
    url: '/v1/admin/passkeys',
    headers: admin,
    payload: { response: device.register(options.challenge) },
  })
  return device
}

/** An owner signed in to the panel, calling it the way the panel does. */
export async function signedIn(h: Harness) {
  const device = await enrolPasskey(h)
  const options = (
    await h.app.inject({ method: 'POST', url: '/v1/owner/session/options', headers: PANEL })
  ).json()
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/owner/session',
    headers: PANEL,
    payload: { assertion: device.assert(options.challenge) },
  })
  const token = /dm_session=([^;]*)/.exec(String(res.headers['set-cookie']))?.[1] ?? ''
  const call = (method: Method, url: string, payload?: object): Promise<LightMyRequestResponse> =>
    h.app.inject({
      method,
      url,
      headers: { ...PANEL, cookie: `dm_session=${token}` },
      ...(payload === undefined ? {} : { payload }),
    })
  /** A passkey assertion over the challenge for this action and body. */
  const stepUp = async (action: string, body: unknown, signer: Device = device) =>
    signer.assert((await call('POST', '/v1/owner/challenge', { action, body })).json().challenge)
  return { device, call, stepUp, cookie: `dm_session=${token}` }
}
