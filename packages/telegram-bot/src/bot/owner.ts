import { type Bot, InlineKeyboard } from 'grammy'
import type { Logger } from 'pino'
import type { ControlClient } from '../adapters/control.js'
import type { GuardClient } from '../adapters/guard.js'
import { Confirms } from '../domain/confirms.js'
import { pages } from '../domain/pages.js'
import { agentsText, doctorBlocks } from '../domain/policy.js'
import { PANEL_ONLY } from '../domain/text.js'
import type { Desk } from './desk.js'
import { args, code, guarded, HTML, type Press, validAgent } from './owner-kit.js'
import { registerPolicies } from './policies.js'

export interface OwnerDeps {
  control: ControlClient
  guard: GuardClient
  desk: Desk
  log: Logger
  now: () => Date
}

/**
 * CR-016: the first passkey comes from the machine. From Telegram, whoever held this account first
 * could become the panel owner.
 */
const ENROL_ON_MACHINE =
  'Enrol your passkey from the guard-core machine: run ' +
  '<code>pnpm --filter @defimind/guard-core passkey-code</code> there and open the link it prints.'

/**
 * The owner's commands that read or tighten: agents, policies, mode and the doctor. Creating an
 * agent and everything else that widens what one may spend is the panel's, behind a passkey.
 * Every button carries only a random id; what it does stays here, and works once.
 */
export function registerOwner(bot: Bot, { control, guard, desk, log, now }: OwnerDeps) {
  const confirms = new Confirms<Press>()

  const button = (run: Press, ttlMs?: number) => `own:${confirms.add(run, now(), ttlMs)}`

  bot.callbackQuery(/^own:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    if (id === 'cancel') {
      await ctx.answerCallbackQuery({ text: 'Cancelled' })
      await ctx.editMessageText('Cancelled. Nothing changed.')
      return
    }
    const run = confirms.take(id, now())
    if (run === undefined) {
      await ctx.answerCallbackQuery({ text: 'This button has expired. Run the command again.' })
      return
    }
    await ctx.answerCallbackQuery()
    await guarded(ctx, log, () => run(ctx))
  })

  bot.command('agent', (ctx) => {
    const [action, agentId] = args(ctx)
    if (action === 'list') {
      return guarded(ctx, log, async () => {
        await ctx.reply(agentsText(await control.listAgents()), HTML)
      })
    }
    if (action === 'new') {
      return ctx.reply(PANEL_ONLY)
    }
    if (action !== 'revoke' || !validAgent(agentId)) {
      return ctx.reply('Usage: /agent list, /agent revoke &lt;id&gt;', HTML)
    }
    const keyboard = new InlineKeyboard()
      .text(
        'Revoke',
        button(async (press) => {
          const done = await control.revokeAgent(agentId)
          log.warn({ agentId, owner: press.from.id, done }, 'agent revoked')
          await press.editMessageText(
            done
              ? `Revoked ${code(agentId)}. Its token stops working at its next request.`
              : `No agent ${code(agentId)}.`,
            HTML,
          )
        }),
      )
      .text('Cancel', 'own:cancel')
    return ctx.reply(`Revoke ${code(agentId)}? Its token stops working for good.`, {
      ...HTML,
      reply_markup: keyboard,
    })
  })

  bot.command('passkey', (ctx) => ctx.reply(ENROL_ON_MACHINE, HTML))

  bot.command('doctor', (ctx) =>
    guarded(ctx, log, async () => {
      const blocks = doctorBlocks(await control.doctor())
      for (const page of pages('<b>Doctor</b>', blocks)) {
        await ctx.reply(page, HTML)
      }
    }),
  )

  const policies = registerPolicies(bot, { control, guard, desk, log, now, button })

  /** Runs on the sweep timer. */
  return { sweep: () => policies.offerGraduation() }
}
