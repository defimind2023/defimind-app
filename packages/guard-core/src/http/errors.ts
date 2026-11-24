import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

/** A refusal with a status code. The error handler sends `message` as the error and nothing else. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

/** A zod refusal is the caller's 400; another error under 500 is sent as is; the rest is ours. */
export function errorHandler(
  error: FastifyError | z.ZodError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    return reply.code(400).send({ error: 'invalid_request', issues })
  }
  if (error.statusCode !== undefined && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ error: error.message })
  }
  request.log.error({ err: error }, 'unhandled error')
  return reply.code(500).send({ error: 'internal_error' })
}
