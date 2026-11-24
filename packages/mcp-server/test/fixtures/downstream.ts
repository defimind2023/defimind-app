import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/** A downstream MCP server over stdio, as a gateway file would start one. */
const server = new McpServer({ name: 'fixture', version: '0.0.0' })
server.registerTool(
  'env',
  {
    description: 'Which of these variables this process can see.',
    inputSchema: { names: z.array(z.string()) },
  },
  ({ names }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(names.filter((name) => process.env[name] !== undefined)),
      },
    ],
  }),
)
await server.connect(new StdioServerTransport())
