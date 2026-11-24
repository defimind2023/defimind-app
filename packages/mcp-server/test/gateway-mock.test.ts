import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashOf, httpRecorder, verify } from '@defimind/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startMockGuard, type MockGuard } from '../examples/mock-guard/server.js'
import { connectDownstream } from '../src/adapters/downstream.js'
import { fileOutbox } from '../src/adapters/outbox.js'
import { createServer } from '../src/server.js'
import { fakeGuard } from './support.js'

const log = pino({ level: 'silent' })
let mock: MockGuard | undefined

afterEach(async () => {
  await mock?.close()
})

describe('gateway against a fake guard-core over HTTP', () => {
  it('records every call in one verifiable chain, and fails closed while guard-core is down', async () => {
    let down = false
    mock = await startMockGuard({ agentId: 'agent-1', token: 'tok', executionsDown: () => down })

    const downstreamServer = new McpServer({ name: 'notes', version: '0.0.0' })
    downstreamServer.registerTool('add', { inputSchema: { text: z.string() } }, ({ text }) => ({
      content: [{ type: 'text', text: `added ${text}` }],
    }))
    const [downClient, downServer] = InMemoryTransport.createLinkedPair()
    await downstreamServer.connect(downServer)

    const server = createServer({
      guard: fakeGuard({}),
      log,
      defaultChain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      gateway: {
        downstreams: [await connectDownstream('notes', downClient)],
        recorder: httpRecorder({ guardUrl: mock.url, token: 'tok' }),
        outbox: fileOutbox(join(mkdtempSync(join(tmpdir(), 'defimind-e2e-')), 'o.jsonl')),
        log,
      },
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const agent = new Client({ name: 'agent', version: '0.0.0' })
    await agent.connect(clientSide)
    const add = async (text: string) =>
      (await agent.callTool({ name: 'notes__add', arguments: { text } })) as {
        content: { text: string }[]
        isError?: boolean
      }

    await add('one')
    down = true
    expect((await add('two')).content.at(-1)?.text).toMatch(
      /^Receipts paused: guard-core refused \(503 unavailable\); retrying\./,
    )
    expect((await add('three')).content[0]?.text).toMatch(/No new tool call is forwarded/)
    down = false
    expect((await add('four')).content[0]?.text).toBe('added four')

    expect(mock.executions.map((receipt) => receipt.requestHash)).toEqual(
      ['one', 'two', 'four'].map((text) => hashOf({ text })),
    )
    const key = (
      (await (await fetch(`${mock.url}/v1/receipts/key`)).json()) as { publicKey: string }
    ).publicKey
    const checks = await verify({ receipts: mock.executions }, { key })
    expect(checks.filter((check) => !check.pass)).toEqual([])
    expect(checks.at(-1)?.detail).toBe('seq 1-3: no gap, every prevHash links')
  })
})
