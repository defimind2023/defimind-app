import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { httpRecorder } from '@defimind/sdk'
import type { Logger } from 'pino'
import { bodyLog } from './adapters/bodies.js'
import { type Downstream, connectDownstream, transportFor } from './adapters/downstream.js'
import { fileOutbox } from './adapters/outbox.js'
import type { Config } from './config.js'
import { serversFile } from './domain/gateway.js'
import type { GatewayDeps } from './tools/gateway.js'

/** How often reports waiting in the outbox are retried between calls. */
const RETRY_MS = 30_000

/**
 * Connects every downstream server named in GATEWAY_FILE. One that cannot be reached stops the
 * start: an agent missing tools it was configured with should be noticed, not half-run.
 */
export async function startGateway(
  config: Config,
  file: string,
  log: Logger,
): Promise<GatewayDeps> {
  const parsed = serversFile.safeParse(readJson(file))
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join(', ')
    throw new Error(`GATEWAY_FILE ${file} is invalid: ${issues}`)
  }
  const downstreams: Downstream[] = []
  for (const [name, spec] of Object.entries(parsed.data.servers)) {
    try {
      downstreams.push(await connectDownstream(name, transportFor(spec)))
    } catch (error) {
      await Promise.all(downstreams.map((downstream) => downstream.close()))
      throw new Error(`gateway: ${name} could not be started or reached`, { cause: error })
    }
    log.info({ server: name, tools: downstreams.at(-1)?.tools.length }, 'gateway server connected')
  }

  mkdirSync(config.GATEWAY_STATE_DIR, { recursive: true, mode: 0o700 })
  const outbox = fileOutbox(join(config.GATEWAY_STATE_DIR, `${config.AGENT_ID}.outbox.jsonl`))
  const recorder = httpRecorder({ guardUrl: config.GUARD_URL, token: config.AGENT_TOKEN })
  setInterval(() => void outbox.drain((report) => recorder.record(report)), RETRY_MS).unref()
  if (outbox.size() > 0) {
    log.warn({ pending: outbox.size() }, 'gateway outbox has unrecorded calls; new calls wait')
  }
  return {
    downstreams,
    recorder,
    outbox,
    log,
    ...(config.GATEWAY_KEEP_BODIES
      ? { keepBody: bodyLog(join(config.GATEWAY_STATE_DIR, `${config.AGENT_ID}.bodies.jsonl`)) }
      : {}),
  }
}

function readJson(file: string): unknown {
  try {
    // Validated with zod by the caller before anything uses it.
    // eslint-disable-next-line no-restricted-properties
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`GATEWAY_FILE ${file} is not a readable JSON file`)
  }
}
