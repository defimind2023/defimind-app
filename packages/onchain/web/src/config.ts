import { z } from 'zod'
import type { PageConfig } from '../page.js'
import { show } from './view.js'

const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value)

const schema = z.object({
  rpc: record(z.string()),
  usdc: record(z.string()),
  hot: record(z.string()),
  agents: record(z.array(z.string())),
  maxDailyCap: z.string().regex(/^[1-9]\d*$/),
  evm: record(
    z.object({
      chainId: z.number().int(),
      module: z.string(),
      usd: z.string(),
      symbol: z.string(),
      hot: z.string().optional(),
      agents: z.array(z.string()).optional(),
    }),
  ),
}) satisfies z.ZodType<PageConfig>

/**
 * Read once, from the page that served this script: never from the link. A page served without one,
 * such as the unfilled template, says so and acts for no one.
 */
function read(): PageConfig {
  try {
    // eslint-disable-next-line no-restricted-properties -- parsed by the schema just below
    return schema.parse(JSON.parse(document.getElementById('config')?.textContent ?? 'null'))
  } catch (error) {
    show(
      'This page is not configured',
      ['It has no addresses to act for. Sign nothing here.'],
      'stop',
    )
    throw error
  }
}

export const config = read()

/** A configured value for the cluster, by its own name only. */
export const configured = <T>(map: Record<string, T>, cluster: string) =>
  Object.hasOwn(map, cluster) ? map[cluster] : undefined
