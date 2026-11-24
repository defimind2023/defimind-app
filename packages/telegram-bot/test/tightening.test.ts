import { describe, expect, it, vi } from 'vitest'
import type { ControlClient } from '../src/adapters/control.js'
import { PANEL_ONLY } from '../src/domain/text.js'
import {
  buttonData,
  command,
  fakeControl,
  OWNER,
  policy,
  press,
  say,
  sent,
  setup,
} from './support.js'

/**
 * CR-016: the bot only reads and tightens. Whatever TELEGRAM_APPROVALS says, everything that widens
 * what an agent may spend is refused before guard-core is asked to change anything, so a stolen
 * Telegram account cannot create an agent, open it up and drain it.
 */
const text = (call: { payload: Record<string, unknown> } | undefined) =>
  String(call?.payload['text'])
const last = (calls: Parameters<typeof sent>[0]) => sent(calls, 'sendMessage').at(-1)
const untouched = (control: ControlClient) =>
  Object.values(control).every((fn) => vi.mocked(fn).mock.calls.length === 0)

describe.each([false, true])('with TELEGRAM_APPROVALS %s, loosening is refused', (approvals) => {
  const bot = () => setup({ telegramApprovals: approvals })

  it.each([
    '/agent new research-agent',
    '/allow research-agent evil.example.com',
    '/mode research-agent live',
  ])('%s asks guard-core for nothing', async (line) => {
    const { bot: telegram, control, guard, calls } = bot()
    await telegram.handleUpdate(command(OWNER, line))
    expect(untouched(control)).toBe(true)
    expect(guard.budget).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('/resume does not resume the agent', async () => {
    const { bot: telegram, guard, calls } = bot()
    await telegram.handleUpdate(command(OWNER, '/resume research-agent'))
    expect(guard.pause).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('a preset that raises a limit is refused, with no confirm to press', async () => {
    const { bot: telegram, control, calls } = bot()
    await telegram.handleUpdate(command(OWNER, '/policy research-agent'))
    await telegram.handleUpdate(press(OWNER, buttonData(last(calls), 'Standard')))
    expect(control.tighten).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
    expect(last(calls)?.payload['reply_markup']).toBeUndefined()
  })

  it('a raised limit from a reply is refused', async () => {
    const { bot: telegram, control, calls } = bot()
    await telegram.handleUpdate(command(OWNER, '/policy research-agent'))
    await telegram.handleUpdate(press(OWNER, buttonData(last(calls), 'Edit daily max')))
    await telegram.handleUpdate(say(OWNER, '500', last(calls)?.messageId))
    expect(control.tighten).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })
})

describe('tightening still works', () => {
  it('/deny, /mode shadow, a lowering preset, a lower limit, /pause and /agent revoke', async () => {
    const control = fakeControl(policy({ mode: 'live' }))
    const { bot, guard, calls } = setup({ control })
    await bot.handleUpdate(command(OWNER, '/deny research-agent api.example.com'))
    await bot.handleUpdate(command(OWNER, '/mode research-agent shadow'))
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Careful')))
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Edit per payment max')))
    await bot.handleUpdate(say(OWNER, '0.10', last(calls)?.messageId))
    expect(await control.policy('research-agent')).toEqual(
      policy({
        allowedDomains: [],
        perTxMax: '100000',
        dailyMax: '5000000',
        approvalThreshold: '500000',
      }),
    )
    expect(control.tighten).toHaveBeenCalledTimes(4)
    await bot.handleUpdate(command(OWNER, '/pause research-agent'))
    expect(guard.pause).toHaveBeenCalledWith('research-agent')
    await bot.handleUpdate(command(OWNER, '/agent revoke research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Revoke')))
    expect(control.revokeAgent).toHaveBeenCalledWith('research-agent')
  })
})
