import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Surface } from './server.js'

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1']

/** The hostname of a Host header, lower-cased, without its port; IPv6 keeps its brackets. */
function hostname(header: string): string {
  const host = header.trim().toLowerCase()
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '')
}

/**
 * The hosts a listener answers to (CR-022): the public address the owner opens, and, for a single
 * listener on loopback, the loopback names and HOST. Empty when nothing names the address: then
 * there is nothing to check against.
 */
export function allowedHosts(surface: Surface, config: Config): Set<string> {
  const hosts = new Set<string>()
  for (const url of [config.PUBLIC_URL, config.PASSKEY_ORIGIN]) {
    if (url !== undefined) {
      hosts.add(new URL(url).hostname.toLowerCase())
    }
  }
  const loopback = LOOPBACK_NAMES.includes(config.HOST.toLowerCase()) || /^127\./.test(config.HOST)
  if (surface === 'all' && config.PUBLIC_PORT === undefined && loopback) {
    for (const name of [...LOOPBACK_NAMES, config.HOST.toLowerCase()]) {
      hosts.add(name)
    }
  }
  return hosts
}

/**
 * A request whose Host names another site is refused with 421, so a DNS-rebinding page or a
 * misrouted proxy cannot reach the API under a name the owner never gave it. /health answers any
 * Host: the host's own checks call it by an internal name.
 */
export function hostCheck(hosts: Set<string>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (hosts.size === 0 || request.url === '/health') {
      return
    }
    const header = request.headers.host
    if (header === undefined || !hosts.has(hostname(header))) {
      return reply.code(421).send({ error: 'misdirected' })
    }
  }
}
