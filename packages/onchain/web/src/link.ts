import { USDC_DECIMALS } from '@defimind/shared'
import { z } from 'zod'
import { formatUnits } from '../../src/svm/transfer.js'
import { config } from './config.js'
import { askAmount } from './view.js'

// A kill link is good for 15 minutes; a few minutes of clock skew either way are forgiven.
const KILL_LINK_TTL_S = 15 * 60
const FUTURE_SLACK_S = 5 * 60

// Unix seconds when the bot made the link. A kill button left in an old message, or kept by a bot
// that restarted, must not remove the limit out of step with guard-core.
export const issued = z
  .string()
  .regex(/^\d{1,12}$/, 'unix seconds')
  .transform(Number)
  .refine((at) => at <= Date.now() / 1000 + FUTURE_SLACK_S, 'issued in the future')

export const expired = (at: number) => Date.now() / 1000 - at > KILL_LINK_TTL_S

export const EXPIRED =
  'This link expired. Press Stop everything in your DefiMind panel, or send /kill to the bot, for a fresh one.'

/** A link that does not parse, as the owner should read it. */
export const problems = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')

const ceiling = () => BigInt(config.maxDailyCap)

const baseUnits = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, 'a positive whole number of base units')
  .transform(BigInt)

/**
 * A daily cap in base units, at most the page's ceiling. A link may leave it out, and then the owner
 * types one on the page.
 */
export const cap = baseUnits
  .refine(
    (amount) => amount <= ceiling(),
    `above this page's maximum daily cap of ${config.maxDailyCap} base units`,
  )
  .optional()

/** A deposit in base units: no ceiling, since it moves the owner's own money into their own vault. */
export const deposit = baseUnits.optional()

export const askDeposit = (symbol: string, initial?: bigint) =>
  askAmount({
    initial,
    title: 'Deposit into the vault',
    lines: ['How much to move from your wallet into the vault the agent draws on.'],
    label: 'Amount',
    symbol,
  })

export const askCap = (symbol: string) =>
  askAmount({
    title: 'Set the daily cap',
    lines: [
      'The most the agent may draw from your vault in any 24 hours.',
      `During the beta the cap is at most ${formatUnits(ceiling(), USDC_DECIMALS)} ${symbol} a ` +
        'day. That ceiling is temporary, for the beta only.',
    ],
    label: 'Daily cap',
    symbol,
    max: ceiling(),
  })
