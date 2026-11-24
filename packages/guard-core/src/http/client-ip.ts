import type { FastifyRequest } from 'fastify'
import { isIP } from 'node:net'
import type { Config } from '../config.js'
import type { Surface } from './server.js'

/**
 * Behind a host's proxy every request comes from the proxy, so the per-IP limit would be one limit
 * for the whole internet. Only a listener that sits behind that proxy believes its header: Fly's
 * Fly-Client-IP on the public listener, or, on a one-listener host such as Render (CR-019), the last
 * X-Forwarded-For hop, the one the proxy appends after whatever the client sent.
 */
export function clientIp(surface: Surface, config: Config): (request: FastifyRequest) => string {
  if (surface === 'private') {
    return (request) => request.ip
  }
  if (config.TRUST_FORWARDED_FOR === 'true') {
    return (request) => lastHop(request.headers['x-forwarded-for']) ?? request.ip
  }
  if (surface === 'public' && config.TRUST_FLY_CLIENT_IP === 'true') {
    return (request) => {
      const header = request.headers['fly-client-ip']
      return typeof header === 'string' && isIP(header) !== 0 ? header : request.ip
    }
  }
  return (request) => request.ip
}

function lastHop(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header.join(',') : header
  const hop = value?.split(',').at(-1)?.trim()
  return hop !== undefined && isIP(hop) !== 0 ? hop : undefined
}
