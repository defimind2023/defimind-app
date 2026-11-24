import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ServerSpec } from '../domain/gateway.js'

/** One downstream MCP server the gateway forwards to. */
export interface Downstream {
  name: string
  tools: Tool[]
  call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export function transportFor(spec: ServerSpec): Transport {
  if ('url' in spec) {
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    })
  }
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Only a safe default environment plus what the file names: the agent token stays here.
    env: { ...getDefaultEnvironment(), ...spec.env },
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    stderr: 'inherit',
  })
}

export async function connectDownstream(name: string, transport: Transport): Promise<Downstream> {
  const client = new Client({ name: 'defimind-gateway', version: '0.1.0' })
  await client.connect(transport)
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return {
    name,
    tools,
    call: async (tool, args) =>
      (await client.callTool({ name: tool, arguments: args })) as CallToolResult,
    close: () => client.close(),
  }
}
