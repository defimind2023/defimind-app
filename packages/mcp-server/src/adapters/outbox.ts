import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ExecutionReport } from '@defimind/sdk'
import { z } from 'zod'

const hex64 = z.string().regex(/^[0-9a-f]{64}$/)

const report = z.strictObject({
  server: z.string().min(1),
  tool: z.string().min(1),
  requestHash: hex64,
  responseHash: hex64,
  outcome: z.enum(['ok', 'error', 'refused']),
  startedAt: z.string(),
  endedAt: z.string(),
}) satisfies z.ZodType<ExecutionReport>

/** Reports DefiMind has not recorded yet, kept on disk so a restart does not lose them. */
export interface Outbox {
  size(): number
  add(report: ExecutionReport): void
  /**
   * Sends the oldest first and stops at the first that fails, so the chain keeps their order.
   * Resolves to that failure, or undefined once the outbox is empty.
   */
  drain(send: (report: ExecutionReport) => Promise<unknown>): Promise<unknown>
}

export function fileOutbox(path: string): Outbox {
  const pending: ExecutionReport[] = existsSync(path) ? load(path) : []
  const save = () => {
    const temp = `${path}.${randomBytes(6).toString('hex')}`
    writeFileSync(temp, pending.map((item) => `${JSON.stringify(item)}\n`).join(''), {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temp, path)
  }
  let draining: Promise<unknown> | undefined
  return {
    size: () => pending.length,
    add(item) {
      pending.push(item)
      save()
    },
    drain(send) {
      draining ??= (async () => {
        try {
          while (pending[0] !== undefined) {
            await send(pending[0])
            pending.shift()
            save()
          }
          return undefined
        } catch (error) {
          // Still pending; the next call or the next retry tries again.
          return error
        } finally {
          draining = undefined
        }
      })()
      return draining
    },
  }
}

function load(path: string): ExecutionReport[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line, i) => {
      let value: unknown
      try {
        // Validated by the schema below before it is used.
        // eslint-disable-next-line no-restricted-properties
        value = JSON.parse(line)
      } catch {
        value = undefined
      }
      const parsed = report.safeParse(value)
      if (!parsed.success) {
        // A damaged outbox must stop the gateway, not be dropped: those calls happened.
        throw new Error(`gateway outbox ${path} line ${i + 1} is not a report`)
      }
      return parsed.data
    })
}
