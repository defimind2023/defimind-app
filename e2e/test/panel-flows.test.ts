import type { Receipt } from '@defimind/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offer, paidApi, type PaidApi } from './support/paid-api.js'
import { owner as signIn } from './support/owner.js'
import { intentIdIn, stack, type Stack } from './support/stack.js'

// CR-012: with the default TELEGRAM_APPROVALS=false, a payment over the threshold is approved
// only in the owner panel, with a passkey; a Telegram tap can still reject but never approve.

let s: Stack
let api: PaidApi

beforeEach(async () => {
  s = await stack({ panel: true })
  api = await paidApi()
  s.setPolicy()
})

afterEach(async () => {
  await api.close()
  await s.close()
})

describe('owner panel approvals', () => {
  it('refuses an approval from Telegram, then pays once the owner approves in the panel', async () => {
    api.quote = [offer({ amount: '3000000' })]
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())

    await s.telegram.press(id, 'approve')
    expect(s.telegram.lastAnswer()).not.toBe('Approved')
    expect((await s.intent(id)).status).toBe('pending_approval')

    const panel = await signIn(s)
    const decided = await panel.approve(id)
    expect(decided.status).toBe(200)

    const second = await s.tool('paid_fetch', { url: api.url })
    expect(second).toContain(': executed.')
    expect(api.payments).toHaveLength(1)

    const receipt = await fetch(new URL(`/v1/agent/intents/${id}/receipt`, s.guardUrl), {
      headers: { authorization: `Bearer ${s.agentToken}` },
    })
    expect(((await receipt.json()) as Receipt).approvedBy).toBe('passkey')
  })

  it('needs the passkey: an approval without one moves nothing', async () => {
    api.quote = [offer({ amount: '3000000' })]
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())

    const panel = await signIn(s)
    const bare = await panel.call(`/v1/owner/intents/${id}/decision`, { decision: 'approve' })
    expect(bare.status).toBe(403)
    expect(bare.body['error']).toBe('step_up_required')
    expect((await s.intent(id)).status).toBe('pending_approval')
    expect(api.payments).toHaveLength(0)
  })

  it('still lets Telegram reject', async () => {
    api.quote = [offer({ amount: '3000000' })]
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())

    await s.telegram.press(id, 'reject')
    expect(s.telegram.lastAnswer()).toBe('Rejected')
    expect((await s.intent(id)).status).toBe('rejected')
    expect(api.payments).toHaveLength(0)
  })
})
