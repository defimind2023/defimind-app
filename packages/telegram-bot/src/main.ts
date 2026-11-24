import { pino } from 'pino'
import { httpControlClient } from './adapters/control.js'
import { httpGuardClient } from './adapters/guard.js'
import { createBot } from './bot/index.js'
import { loadConfig } from './config.js'
import { phantomKill } from '@defimind/shared'
import { killTargets } from './domain/kill-targets.js'
import { buildServer } from './http/server.js'

const EXPIRY_SWEEP_MS = 15_000

const config = loadConfig()
const log = pino({
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers["x-guard-signature"]'],
})

if (config.GUARD_PUBLIC_URL === undefined) {
  log.warn('GUARD_PUBLIC_URL is not set: a payment that needs a passkey can only be rejected here')
}

if (config.GUARD_ADMIN_TOKEN !== undefined) {
  log.warn('GUARD_ADMIN_TOKEN is set and ignored: the bot only uses GUARD_BOT_TOKEN. Remove it')
}

const guardOptions = { url: config.GUARD_URL, botToken: config.GUARD_BOT_TOKEN }
const guard = httpGuardClient(guardOptions)
const control = httpControlClient(guardOptions)

const { SIGN_PAGE_URL } = config
const targets = killTargets(config)
const phantomKills = SIGN_PAGE_URL
  ? targets.map((target) => phantomKill(SIGN_PAGE_URL, target))
  : undefined

const { bot, desk, commands, owner } = createBot({
  token: config.TELEGRAM_BOT_TOKEN,
  owners: config.OWNER_TELEGRAM_IDS,
  guard,
  control,
  notifyAbove: config.NOTIFY_ABOVE_AMOUNT,
  log,
  phantomKills,
  guardPublicUrl: config.GUARD_PUBLIC_URL,
  telegramApprovals: config.TELEGRAM_APPROVALS,
  weekly:
    config.REPORT_WEEKDAY === undefined || config.REPORT_HOUR_UTC === undefined
      ? undefined
      : { weekday: config.REPORT_WEEKDAY, hourUtc: config.REPORT_HOUR_UTC },
})

const server = await buildServer({
  secret: config.BOT_WEBHOOK_SECRET,
  handlers: {
    approvalRequest: (request) => desk.post(request),
    intentEvent: (event) => desk.event(event),
    alert: (event) => desk.alert(event),
  },
  logger: log,
  rateLimitPerMinute: config.HOOK_RATE_LIMIT_PER_MINUTE,
})

const sweep = setInterval(() => {
  Promise.all([
    desk.expire(),
    desk.flushAlerts(),
    commands.expireKillOffers(),
    commands.weeklyReport(),
    owner.sweep(),
  ]).catch((err: unknown) => log.error({ err }, 'sweep failed'))
}, EXPIRY_SWEEP_MS)

await server.listen({ port: config.PORT, host: config.HOST })

async function shutdown() {
  clearInterval(sweep)
  await bot.stop()
  await server.close()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

// Long polling: the bot needs no public URL, only guard-core needs to reach the hooks.
await bot.start({ allowed_updates: ['message', 'callback_query'] })
