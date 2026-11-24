import { describe, expect, it, vi } from 'vitest'
import {
  buttonData,
  command,
  fakeControl,
  fakeGuard,
  NOW,
  OTHER_OWNER,
  OWNER,
  policy,
  press,
  say,
  sent,
  setup,
} from './support.js'

const text = (call: { payload: Record<string, unknown> } | undefined) =>
  String(call?.payload['text'])
const last = (calls: Parameters<typeof sent>[0]) => sent(calls, 'sendMessage').at(-1)
const BUDGET = {
  spentToday: '0',
  dailyMax: '10000000',
  perTxMax: '2000000',
  hotWalletBalances: {},
  paused: false,
}

describe('/agent', () => {
  it('shows its usage for anything it does not do', async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/agent rename x'))
    expect(text(last(calls))).toBe('Usage: /agent list, /agent revoke &lt;id&gt;')
  })

  it('lists agents with their mode', async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/agent list'))
    expect(text(last(calls))).toBe('<b>Agents</b> (1)\n• <code>research-agent</code>: shadow')
  })

  it('revokes only from the confirm button, and only once', async () => {
    const { bot, control, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/agent revoke research-agent'))
    expect(control.revokeAgent).not.toHaveBeenCalled()
    const data = buttonData(last(calls), 'Revoke')
    await bot.handleUpdate(press(OWNER, data))
    await bot.handleUpdate(press(OTHER_OWNER, data))
    expect(control.revokeAgent).toHaveBeenCalledTimes(1)
    expect(text(sent(calls, 'editMessageText')[0])).toContain('Revoked <code>research-agent</code>')
    expect(sent(calls, 'answerCallbackQuery').at(-1)?.payload['text']).toContain('expired')
  })

  it('does nothing when Cancel is pressed', async () => {
    const { bot, control, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/agent revoke research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Cancel')))
    expect(control.revokeAgent).not.toHaveBeenCalled()
    expect(text(sent(calls, 'editMessageText')[0])).toBe('Cancelled. Nothing changed.')
  })
})

describe('/policy', () => {
  it('shows the policy in dollars with the preset and edit buttons', async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    const shown = last(calls)
    expect(text(shown)).toContain('Per payment: up to $2.00')
    expect(text(shown)).toContain('Owner approval: at or above $1.00')
    expect(text(shown)).toContain('Domains: <code>api.example.com</code>')
    expect(() => buttonData(shown, 'Careful')).not.toThrow()
    expect(() => buttonData(shown, 'Edit daily max')).not.toThrow()
  })

  it('applies a preset that only lowers limits at once', async () => {
    const { bot, control, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Careful')))
    expect(control.tighten).toHaveBeenCalledWith('research-agent', {
      perTxMax: '1000000',
      dailyMax: '5000000',
      approvalThreshold: '500000',
    })
    expect(text(last(calls))).toMatch(/^Saved\.\n<b>Policy<\/b>/)
  })

  it('edits one field from a reply in dollars, with bigint units', async () => {
    const { bot, control, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Edit per payment max')))
    const prompt = last(calls)
    expect(text(prompt)).toBe(
      'New per payment max for <code>research-agent</code>, in dollars (like 2.50):',
    )
    expect(prompt?.payload['reply_markup']).toEqual({ force_reply: true })

    await bot.handleUpdate(say(OWNER, '-1', prompt?.messageId))
    expect(text(last(calls))).toContain('Send an amount in dollars')
    await bot.handleUpdate(say(OWNER, '$0.75', prompt?.messageId))
    expect(control.tighten).toHaveBeenCalledWith('research-agent', { perTxMax: '750000' })

    // The prompt is answered: a later reply to it is an ordinary message.
    await bot.handleUpdate(say(OWNER, '9', prompt?.messageId))
    expect(control.tighten).toHaveBeenCalledTimes(1)
  })

  it('answers for an unknown agent', async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command(OWNER, '/policy ghost'))
    expect(text(last(calls))).toBe('No agent <code>ghost</code>.')
  })
})

describe('/deny', () => {
  it('removes a domain, lowercased', async () => {
    const { bot, control } = setup()
    await bot.handleUpdate(command(OWNER, '/deny research-agent API.example.com'))
    expect(control.tighten).toHaveBeenLastCalledWith('research-agent', {
      removeDomains: ['api.example.com'],
    })
    expect((await control.policy('research-agent'))?.allowedDomains).toEqual([])
  })

  it('refuses what is not a hostname', async () => {
    const { bot, control, calls } = setup()
    for (const bad of ['https://api.example.com', 'localhost', '-x.example.com', 'a..b']) {
      await bot.handleUpdate(command(OWNER, `/deny research-agent ${bad}`))
    }
    expect(control.tighten).not.toHaveBeenCalled()
    expect(text(last(calls))).toContain('Usage: /deny')
  })
})

describe('/mode', () => {
  it('goes to shadow at once', async () => {
    const control = fakeControl(policy({ mode: 'live' }))
    const { bot } = setup({ control })
    await bot.handleUpdate(command(OWNER, '/mode research-agent shadow'))
    expect(control.tighten).toHaveBeenLastCalledWith('research-agent', { mode: 'shadow' })
  })
})

describe('/doctor', () => {
  it('gives one line per check, with the fix under each warning or failure', async () => {
    const doctor = vi.fn(async () => [
      { id: 'db', status: 'ok' as const, message: 'Database writable' },
      {
        id: 'gas',
        status: 'warn' as const,
        message: 'Hot wallet gas is low <0.01 SOL>',
        fix: 'Send 0.05 SOL to the hot wallet',
      },
      { id: 'bot', status: 'fail' as const, message: 'Bot unreachable', fix: 'Check BOT_URL' },
    ])
    const { bot, calls } = setup({ control: fakeControl(policy(), { doctor }) })
    await bot.handleUpdate(command(OWNER, '/doctor'))
    expect(text(last(calls))).toBe(
      [
        '<b>Doctor</b>',
        '✅ Database writable',
        '⚠️ Hot wallet gas is low &lt;0.01 SOL&gt;',
        '    Fix: Send 0.05 SOL to the hot wallet',
        '❌ Bot unreachable',
        '    Fix: Check BOT_URL',
      ].join('\n'),
    )
  })

  it('says guard-core did not answer', async () => {
    const doctor = vi.fn().mockRejectedValue(new Error('down'))
    const { bot, calls } = setup({ control: fakeControl(policy(), { doctor }) })
    await bot.handleUpdate(command(OWNER, '/doctor'))
    expect(text(last(calls))).toBe('guard-core did not answer. Nothing changed: try again.')
  })
})

describe('shadow graduation', () => {
  const shadowSince = (since: Date) =>
    vi.fn(async () => ({
      ...BUDGET,
      shadow: { since: since.toISOString(), total: '2500000', count: 2 },
    }))

  it('tells the owners once, three days after the first shadowed payment, to go live in the panel', async () => {
    let now = new Date(NOW.getTime() + 3 * 86_400_000 - 1)
    const budget = shadowSince(NOW)
    const { owner, control, calls } = setup({ now: () => now, guard: fakeGuard({ budget }) })
    await owner.sweep()
    expect(sent(calls, 'sendMessage')).toHaveLength(0)

    // guard-core is asked at most every five minutes.
    now = new Date(NOW.getTime() + 3 * 86_400_000)
    await owner.sweep()
    expect(sent(calls, 'sendMessage')).toHaveLength(0)
    now = new Date(now.getTime() + 5 * 60_000)
    await owner.sweep()
    now = new Date(now.getTime() + 5 * 60_000)
    await owner.sweep()
    const offers = sent(calls, 'sendMessage')
    expect(offers.map((call) => call.payload['chat_id'])).toEqual([OWNER.id, OTHER_OWNER.id])
    expect(text(offers[0])).toBe(
      'Your agent <code>research-agent</code> would have spent $2.50 in 2 payments. ' +
        'Go live in the DefiMind panel.',
    )
    expect(offers[0]?.payload['reply_markup']).toBeUndefined()
    expect(control.tighten).not.toHaveBeenCalled()
  })

  it('skips an agent that is live or has no shadow total', async () => {
    const listAgents = vi.fn(async () => [
      { agentId: 'live-agent', paused: false, mode: 'live' as const },
      { agentId: 'quiet-agent', paused: false, mode: 'shadow' as const },
    ])
    const budget = vi.fn(async () => BUDGET)
    const later = new Date(NOW.getTime() + 30 * 86_400_000)
    const { owner, calls } = setup({
      now: () => later,
      control: fakeControl(policy(), { listAgents }),
      guard: fakeGuard({ budget }),
    })
    await owner.sweep()
    expect(budget).toHaveBeenCalledWith('quiet-agent')
    expect(budget).not.toHaveBeenCalledWith('live-agent')
    expect(calls).toHaveLength(0)
  })
})

describe('/passkey', () => {
  it('points to the machine and asks guard-core for nothing', async () => {
    const { bot, control, calls } = setup({ guardPublicUrl: 'https://guard.example' })
    await bot.handleUpdate(command(OWNER, '/passkey enrol'))
    expect(text(last(calls))).toContain(
      '<code>pnpm --filter @defimind/guard-core passkey-code</code>',
    )
    expect(Object.values(control).every((fn) => vi.mocked(fn).mock.calls.length === 0)).toBe(true)
  })
})
