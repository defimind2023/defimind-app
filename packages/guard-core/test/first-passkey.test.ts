import { describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, harness, PASSKEY_RP, type Harness } from './harness.js'
import { enrolPasskey } from './owner.js'
import { softAuthenticator } from './webauthn.js'

const SETUP_CODE = 's'.repeat(40)
const admin = (h: Harness, url: string, payload?: object) =>
  h.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    ...(payload === undefined ? {} : { payload }),
  })

describe('the first passkey with SETUP_CODE set (CR-022)', () => {
  it.each(['/v1/admin/passkeys/options', '/v1/admin/passkeys/code'])(
    'refuses the admin token at %s, audits it and alerts the owner',
    async (url) => {
      const h = await harness({ env: { SETUP_CODE } })
      const res = await admin(h, url)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: 'use_setup_code' })
      expect(h.auditEvents()).toContain('admin_enrol_refused')
      expect(h.bot.alert).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'admin_loosen_refused' }),
      )
    },
  )

  it('refuses the admin token enrolling a passkey outright', async () => {
    const h = await harness({ env: { SETUP_CODE } })
    const device = softAuthenticator(PASSKEY_RP.id, PASSKEY_RP.origin)
    const res = await admin(h, '/v1/admin/passkeys', { response: device.register('AAAA') })
    expect(res.json()).toEqual({ error: 'use_setup_code' })
  })

  it('lets the setup code enrol the first one', async () => {
    const h = await harness({ env: { SETUP_CODE } })
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/owner/setup',
      headers: { origin: PASSKEY_RP.origin, 'x-defimind-request': '1' },
      payload: { setupCode: SETUP_CODE },
    })
    expect(res.statusCode).toBe(200)
  })

  it('leaves a run without SETUP_CODE as before', async () => {
    const h = await harness()
    await enrolPasskey(h)
    expect(h.auditEvents()).toContain('passkey_enrolled')
  })
})
