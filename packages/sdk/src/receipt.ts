import type { ExecutionReceipt } from '@defimind/shared'
import { hashOf } from './domain/canonical.js'
import { type Recorder, type RecorderOptions, httpRecorder } from './adapters/recorder.js'

/** Throw this from the wrapped function when it declines to act: the receipt says "refused". */
export class Refused extends Error {}

/**
 * The call ran but its receipt was not recorded. Fail closed: the caller decides what to do with
 * an unrecorded action, which `result` (or `cause`, for a call that threw) still holds.
 */
export class ReceiptError extends Error {
  constructor(
    message: string,
    readonly result?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface ReceiptsOptions {
  recorder: Recorder
  onReceipt?: (receipt: ExecutionReceipt) => void
  now?: () => Date
}

export type Wrapped<I, O> = (input: I) => Promise<O>

export function receipts({ recorder, onReceipt, now = () => new Date() }: ReceiptsOptions) {
  return {
    withReceipt<I, O>(server: string, tool: string, fn: Wrapped<I, O>): Wrapped<I, O> {
      return async (input) => {
        const requestHash = hashOf(input)
        const startedAt = now().toISOString()
        let outcome: ExecutionReceipt['outcome'] = 'ok'
        let result: O | undefined
        let thrown: unknown
        try {
          result = await fn(input)
        } catch (error) {
          thrown = error
          outcome = error instanceof Refused ? 'refused' : 'error'
        }
        const report = {
          server,
          tool,
          requestHash,
          // What a holder of the error message can reproduce; the message itself stays here.
          responseHash: hashOf(outcome === 'ok' ? result : { error: messageOf(thrown) }),
          outcome,
          startedAt,
          endedAt: now().toISOString(),
        }
        let receipt: ExecutionReceipt
        try {
          receipt = await recorder.record(report)
        } catch (error) {
          throw new ReceiptError(
            `${server}__${tool} ran, but its receipt was not recorded.`,
            result,
            {
              cause: outcome === 'ok' ? error : thrown,
            },
          )
        }
        onReceipt?.(receipt)
        if (outcome !== 'ok') {
          throw thrown
        }
        return result as O
      }
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reports to the DefiMind named by GUARD_URL, as the agent AGENT_TOKEN names. */
export function withReceipt<I, O>(server: string, tool: string, fn: Wrapped<I, O>): Wrapped<I, O> {
  let wrapped: Wrapped<I, O> | undefined
  return async (input) => {
    wrapped ??= receipts({ recorder: httpRecorder(fromEnv(process.env)) }).withReceipt(
      server,
      tool,
      fn,
    )
    return wrapped(input)
  }
}

function fromEnv(env: NodeJS.ProcessEnv): RecorderOptions {
  const guardUrl = env['GUARD_URL']
  const token = env['AGENT_TOKEN']
  if (!guardUrl || !token) {
    throw new Error(
      'withReceipt needs GUARD_URL and AGENT_TOKEN, or use receipts() with a recorder',
    )
  }
  return { guardUrl, token }
}
