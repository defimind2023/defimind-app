import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ExecutionReport, type Recorder, RecordError, hashOf } from '@defimind/sdk'
import type { ExecutionReceipt } from '@defimind/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bodyLog } from '../src/adapters/bodies.js'
import { connectDownstream, transportFor } from '../src/adapters/downstream.js'
import { fileOutbox } from '../src/adapters/outbox.js'
import { gatewayName, serversFile } from '../src/domain/gateway.js'
import { createServer } from '../src/server.js'
import { type GatewayDeps, errorFields, paused } from '../src/tools/gateway.js'
import { fakeGuard } from './support.js'

const log = pino({ level: 'silent' })

/** A downstream server with three tools, and a count of the calls it really received. */
async function fakeDownstream() {
  const calls: unknown[] = []
  const server = new McpServer({ name: 'issues', version: '0.0.0' })
  server.registerTool(
    'create_issue',
    {
      description: 'Opens an issue.',
      inputSchema: { title: z.string(), labels: z.array(z.string()).optional() },
    },
    (args) => {
      calls.push(args)
      return { content: [{ type: 'text', text: `opened: ${args.title}` }] }
    },
  )
  server.registerTool('fails', { description: 'Always fails.' }, () => {
    calls.push('fails')
    return { content: [{ type: 'text', text: 'no such repo' }], isError: true }
  })
  server.registerTool(
    `x${'y'.repeat(60)}`,
    { description: 'Name too long once prefixed.' },
    () => ({
      content: [],
    }),
  )
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  return { downstream: await connectDownstream('issues', clientSide), calls }
}

function recorder() {
  const reports: ExecutionReport[] = []
  let down = false
  const record: Recorder = {
    record: async (report) => {
      if (down) {
        throw new RecordError('refused', 401, 'unauthorized')
      }
      reports.push(report)
      return { seq: reports.length, hash: 'a'.repeat(64) } as ExecutionReceipt
    },
  }
  return { record, reports, setDown: (value: boolean) => (down = value) }
}

async function gateway(extra: Partial<GatewayDeps> = {}) {
  const { downstream, calls } = await fakeDownstream()
  const rec = recorder()
  const dir = mkdtempSync(join(tmpdir(), 'defimind-gateway-'))
  const outbox = fileOutbox(join(dir, 'agent.outbox.jsonl'))
  const server = createServer({
    guard: fakeGuard({}),
    log,
    defaultChain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    gateway: { downstreams: [downstream], recorder: rec.record, outbox, log, ...extra },
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'agent', version: '0.0.0' })
  await client.connect(clientSide)
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[]
      isError?: boolean
      _meta?: Record<string, unknown>
    }
  return { client, call, calls, rec, outbox, dir }
}

describe('gateway', () => {
  it('exposes downstream tools as <server>__<tool>, beside the DefiMind tools', async () => {
    const { client } = await gateway()
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining(['paid_fetch', 'issues__create_issue', 'issues__fails']),
    )
    expect(names.some((name) => name.startsWith('issues__xyy'))).toBe(false)
    const create = tools.find((tool) => tool.name === 'issues__create_issue')
    expect(create?.description).toBe('[via issues] Opens an issue.')
    expect(create?.inputSchema.properties).toHaveProperty('title')
    expect(create?.inputSchema.required).toEqual(['title'])
  })

  it('forwards the call, reports hashes only, and returns the result with its receipt', async () => {
    const { call, calls, rec } = await gateway()
    const args = { title: 'bug', labels: ['p1'] }
    const result = await call('issues__create_issue', args)
    expect(calls).toEqual([args])
    expect(result.content).toEqual([{ type: 'text', text: 'opened: bug' }])
    expect(result._meta?.['defimind/receipt']).toEqual({ seq: 1, hash: 'a'.repeat(64) })
    expect(rec.reports).toEqual([
      {
        server: 'issues',
        tool: 'create_issue',
        requestHash: hashOf(args),
        responseHash: hashOf({ content: [{ type: 'text', text: 'opened: bug' }] }),
        outcome: 'ok',
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      },
    ])
    expect(JSON.stringify(rec.reports)).not.toContain('bug')
  })

  it('reports a downstream error result as "error"', async () => {
    const { call, rec } = await gateway()
    const result = await call('issues__fails')
    expect(result.isError).toBe(true)
    expect(rec.reports[0]?.outcome).toBe('error')
  })

  it('fails closed while guard-core is down: one result kept, then no call forwarded', async () => {
    const { call, calls, rec, outbox } = await gateway()
    rec.setDown(true)
    const first = await call('issues__create_issue', { title: 'one' })
    expect(first.content[0]?.text).toBe('opened: one')
    expect(first.content.at(-1)?.text).toMatch(
      /^Receipts paused: guard-core refused \(401 unauthorized\); the operator must act\. This call ran/,
    )
    expect(outbox.size()).toBe(1)

    const second = await call('issues__create_issue', { title: 'two' })
    expect(second.isError).toBe(true)
    expect(second.content[0]?.text).toBe(paused(new RecordError('refused', 401, 'unauthorized')))
    expect(calls).toHaveLength(1)

    rec.setDown(false)
    const third = await call('issues__create_issue', { title: 'three' })
    expect(third.content[0]?.text).toBe('opened: three')
    expect(outbox.size()).toBe(0)
    expect(rec.reports.map((report) => report.requestHash)).toEqual([
      hashOf({ title: 'one' }),
      hashOf({ title: 'three' }),
    ])
  })

  it('keeps bodies only when asked, with the receipt they belong to', async () => {
    const kept: unknown[] = []
    const { call } = await gateway({ keepBody: (entry) => kept.push(entry) })
    await call('issues__create_issue', { title: 'bug' })
    expect(kept).toEqual([
      expect.objectContaining({
        receipt: { seq: 1, hash: 'a'.repeat(64) },
        arguments: { title: 'bug' },
        result: { content: [{ type: 'text', text: 'opened: bug' }] },
      }),
    ])
  })
})

describe('pause notes', () => {
  it('say who must act, from the status and code alone', () => {
    expect(paused(new RecordError('x', 503, 'unavailable'))).toMatch(
      /^Receipts paused: guard-core refused \(503 unavailable\); retrying\. No new tool call/,
    )
    expect(paused(new RecordError('x'))).toMatch(
      /^Receipts paused: guard-core could not be reached; retrying\./,
    )
    expect(paused(new Error('odd'))).toMatch(/^Receipts paused: guard-core did not record the call/)
  })
})

describe('pause log', () => {
  it('logs the status and code of a refused report, and not the body', async () => {
    const lines: string[] = []
    const logged = pino({ level: 'info' }, { write: (line: string) => lines.push(line) })
    const rec = recorder()
    rec.setDown(true)
    const { downstream } = await fakeDownstream()
    const server = createServer({
      guard: fakeGuard({}),
      log: logged,
      defaultChain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      gateway: {
        downstreams: [downstream],
        recorder: rec.record,
        outbox: fileOutbox(join(mkdtempSync(join(tmpdir(), 'defimind-log-')), 'o.jsonl')),
        log: logged,
      },
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'agent', version: '0.0.0' })
    await client.connect(clientSide)
    await client.callTool({ name: 'issues__create_issue', arguments: { title: 'private title' } })
    const entry = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((item) => item['msg'] === 'receipts paused: call not recorded, kept in outbox')
    expect(entry).toMatchObject({ httpStatus: 401, code: 'unauthorized', server: 'issues' })
    expect(lines.join('')).not.toContain('private title')
  })
})

describe('errorFields', () => {
  it('keeps the name and code of an error, never its message', () => {
    const error = Object.assign(new Error('GET https://u:secret@host/x failed'), {
      code: 'ECONNRESET',
    })
    expect(errorFields(error)).toEqual({ errName: 'Error', errCode: 'ECONNRESET' })
    expect(errorFields(new TypeError('Bearer abc'))).toEqual({ errName: 'TypeError' })
    expect(errorFields('raw string')).toEqual({ errName: 'string' })
  })
})

describe('outbox on disk', () => {
  const report: ExecutionReport = {
    server: 's',
    tool: 't',
    requestHash: '0'.repeat(64),
    responseHash: '1'.repeat(64),
    outcome: 'ok',
    startedAt: '2026-11-19T00:00:00.000Z',
    endedAt: '2026-11-19T00:00:01.000Z',
  }

  it('survives a restart and drains oldest first, stopping at a failure', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'defimind-outbox-')), 'o.jsonl')
    const first = fileOutbox(path)
    first.add(report)
    first.add({ ...report, tool: 'second' })
    const again = fileOutbox(path)
    expect(again.size()).toBe(2)
    const sent: string[] = []
    await again.drain(async (item) => {
      sent.push(item.tool)
      if (item.tool === 'second') {
        throw new Error('down')
      }
    })
    expect(sent).toEqual(['t', 'second'])
    expect(fileOutbox(path).size()).toBe(1)
  })

  it('refuses to start from a damaged outbox rather than drop calls', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'defimind-outbox-')), 'o.jsonl')
    writeFileSync(path, '{"server":"s"}\n')
    expect(() => fileOutbox(path)).toThrow('line 1 is not a report')
  })

  it('writes bodies to a file only the owner can read', async () => {
    const { statSync, readFileSync } = await import('node:fs')
    const path = join(mkdtempSync(join(tmpdir(), 'defimind-bodies-')), 'b.jsonl')
    bodyLog(path)({
      server: 's',
      tool: 't',
      requestHash: 'r',
      responseHash: 'h',
      arguments: {},
      result: {},
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toContain('"tool":"t"')
  })
})

describe('gateway file', () => {
  it('takes stdio and https servers', () => {
    const parsed = serversFile.parse({
      servers: {
        github: { command: 'npx', args: ['-y', 'some-server'] },
        search: { url: 'https://search.example.com/mcp', headers: { authorization: 'Bearer x' } },
        local: { url: 'http://127.0.0.1:9000/mcp' },
      },
    })
    expect(Object.keys(parsed.servers)).toEqual(['github', 'search', 'local'])
  })

  it.each([
    [{ servers: {} }, 'at least one'],
    [{ servers: { Bad_Name: { command: 'x' } } }, 'lowercase'],
    [{ servers: { a__b: { command: 'x' } } }, 'lowercase'],
    [{ servers: { remote: { url: 'http://example.com/mcp' } } }, 'https://'],
    [{ servers: { odd: { command: 'x', shell: true } } }, ''],
  ])('refuses %j', (file, message) => {
    const parsed = serversFile.safeParse(file)
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain(message)
  })

  it('names tools within the 64 characters clients accept', () => {
    expect(gatewayName('github', 'create_issue')).toBe('github__create_issue')
    expect(gatewayName('github', 'x'.repeat(60))).toBeUndefined()
    expect(gatewayName('github', 'has space')).toBeUndefined()
  })
})

describe('stdio downstream', () => {
  it('starts the command with a safe environment: the agent token never reaches it', async () => {
    process.env['AGENT_TOKEN'] = 'secret'
    const fixture = join(import.meta.dirname, 'fixtures', 'downstream.ts')
    const downstream = await connectDownstream(
      'fixture',
      transportFor({
        command: process.execPath,
        args: ['--import', 'tsx', fixture],
        env: { GIVEN: 'yes' },
      }),
    )
    try {
      const result = await downstream.call('env', { names: ['AGENT_TOKEN', 'GIVEN', 'PATH'] })
      expect(result.content).toEqual([{ type: 'text', text: '["GIVEN","PATH"]' }])
    } finally {
      await downstream.close()
      delete process.env['AGENT_TOKEN']
    }
  })
})

describe('startGateway', () => {
  const config = {
    GUARD_URL: 'http://127.0.0.1:1',
    AGENT_ID: 'agent-1',
    AGENT_TOKEN: 'tok',
    GATEWAY_KEEP_BODIES: false,
  }

  it('stops the start on an invalid or unreadable file', async () => {
    const { startGateway } = await import('../src/gateway.js')
    const dir = mkdtempSync(join(tmpdir(), 'defimind-gwfile-'))
    const file = join(dir, 'servers.json')
    writeFileSync(file, JSON.stringify({ servers: { Bad: { command: 'x' } } }))
    const full = { ...config, GATEWAY_STATE_DIR: dir } as Parameters<typeof startGateway>[0]
    await expect(startGateway(full, file, log)).rejects.toThrow(/servers.Bad/)
    await expect(startGateway(full, join(dir, 'missing.json'), log)).rejects.toThrow(
      'is not a readable JSON file',
    )
  })

  it('starts the listed servers, with bodies kept when asked', async () => {
    const { startGateway } = await import('../src/gateway.js')
    const dir = mkdtempSync(join(tmpdir(), 'defimind-gwfile-'))
    const file = join(dir, 'servers.json')
    const fixture = join(import.meta.dirname, 'fixtures', 'downstream.ts')
    writeFileSync(
      file,
      JSON.stringify({
        servers: { fx: { command: process.execPath, args: ['--import', 'tsx', fixture] } },
      }),
    )
    const full = { ...config, GATEWAY_STATE_DIR: dir, GATEWAY_KEEP_BODIES: true } as Parameters<
      typeof startGateway
    >[0]
    const deps = await startGateway(full, file, log)
    try {
      expect(deps.downstreams.map((d) => d.tools.map((t) => t.name))).toEqual([['env']])
      expect(deps.keepBody).toBeTypeOf('function')
      expect(deps.outbox.size()).toBe(0)
    } finally {
      await Promise.all(deps.downstreams.map((d) => d.close()))
    }
  })

  it('stops the start when a listed server cannot be started', async () => {
    const { startGateway } = await import('../src/gateway.js')
    const dir = mkdtempSync(join(tmpdir(), 'defimind-gwfile-'))
    const file = join(dir, 'servers.json')
    writeFileSync(
      file,
      JSON.stringify({ servers: { gone: { command: join(dir, 'no-such-binary') } } }),
    )
    const full = { ...config, GATEWAY_STATE_DIR: dir } as Parameters<typeof startGateway>[0]
    await expect(startGateway(full, file, log)).rejects.toThrow(
      'gateway: gone could not be started',
    )
  })
})

describe('a downstream that throws', () => {
  it('returns an error result and reports it as "error"', async () => {
    const rec = recorder()
    const outbox = fileOutbox(join(mkdtempSync(join(tmpdir(), 'defimind-gw-')), 'o.jsonl'))
    const server = createServer({
      guard: fakeGuard({}),
      log,
      defaultChain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      gateway: {
        downstreams: [
          {
            name: 'flaky',
            tools: [{ name: 'go', inputSchema: { type: 'object' } }],
            call: async () => {
              throw new Error('connection closed')
            },
            close: async () => {},
          },
        ],
        recorder: rec.record,
        outbox,
        log,
      },
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'agent', version: '0.0.0' })
    await client.connect(clientSide)
    const result = (await client.callTool({ name: 'flaky__go', arguments: {} })) as {
      isError?: boolean
      content: { text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('flaky did not complete the call.')
    expect(rec.reports[0]?.outcome).toBe('error')
  })
})
