import { z } from 'zod'
import { isLoopback } from './loopback.js'

const SEPARATOR = '__'
// MCP clients accept tool names of these characters, at most 64 of them.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

const serverName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and -, at most 32')

const stdio = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().min(1).optional(),
})

const http = z.strictObject({
  url: z.string().refine((value) => {
    try {
      const { protocol, hostname } = new URL(value)
      return protocol === 'https:' || (protocol === 'http:' && isLoopback(hostname))
    } catch {
      return false
    }
  }, 'expected https://, or http:// to this machine'),
  headers: z.record(z.string(), z.string()).default({}),
})

export const serversFile = z.strictObject({
  servers: z
    .record(serverName, z.union([stdio, http]))
    .refine((servers) => Object.keys(servers).length > 0, 'list at least one server'),
})

export type ServersFile = z.infer<typeof serversFile>
export type ServerSpec = ServersFile['servers'][string]

/** The name the agent sees. undefined when a downstream tool cannot be named safely. */
export function gatewayName(server: string, tool: string): string | undefined {
  const name = `${server}${SEPARATOR}${tool}`
  return TOOL_NAME.test(name) ? name : undefined
}
