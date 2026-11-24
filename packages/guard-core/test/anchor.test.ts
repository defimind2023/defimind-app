import { generateKeyPairSync } from 'node:crypto'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, schema, type Db } from '../src/db/client.js'
import { hashesBetween } from '../src/db/anchors.js'
import { merkleRoot } from '../src/domain/merkle.js'
import { ANCHOR_EVERY_MS, anchorJob, type AnchorPublisher } from '../src/service/anchor.js'
import { appendExecution, checkChain } from '../src/service/executions.js'
import { withAnchors } from '../src/service/integrity.js'
import { NOW } from './harness.js'

const key = generateKeyPairSync('ed25519').privateKey
const entry = {
  agentId: 'agent-1',
  kind: 'tool_call' as const,
  server: 'web',
  tool: 'search',
  requestHash: 'a'.repeat(64),
  responseHash: 'b'.repeat(64),
  outcome: 'ok' as const,
  assurance: 'relayed' as const,
  startedAt: NOW.toISOString(),
  endedAt: NOW.toISOString(),
}

let db: Db
let clock: { now: Date }
let memos: string[]
let publisher: AnchorPublisher
const job = () =>
  anchorJob({ db, publisher, now: () => clock.now, log: { warn: vi.fn(), info: vi.fn() } })
const append = (n: number) => {
  for (let i = 0; i < n; i++) {
    appendExecution(db, key, entry, clock.now)
  }
}
const later = (ms: number) => {
  clock.now = new Date(clock.now.getTime() + ms)
}
const integrity = () => withAnchors(db, checkChain(db, key))

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db, { migrationsFolder: 'migrations' })
  clock = { now: NOW }
  memos = []
  publisher = {
    chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    publish: vi.fn(async (memo: string) => {
      memos.push(memo)
      return `tx-${memos.length}`
    }),
  }
})

describe('the anchor job', () => {
  it('anchors nothing when there is no receipt', async () => {
    later(2 * ANCHOR_EVERY_MS)
    expect(await job().tick()).toBeUndefined()
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it('waits for the hour, then anchors every receipt since the last anchor', async () => {
    append(3)
    const anchors = job()
    expect(await anchors.tick()).toBeUndefined()
    later(ANCHOR_EVERY_MS)
    const anchor = await anchors.tick()
    const root = merkleRoot(hashesBetween(db, 1, 3))
    expect(anchor).toMatchObject({ fromSeq: 1, toSeq: 3, root, txId: 'tx-1' })
    expect(memos).toEqual([`defimind:anchor:v1:1-3:${root}`])
    append(2)
    later(ANCHOR_EVERY_MS)
    expect(await anchors.tick()).toMatchObject({ fromSeq: 4, toSeq: 5 })
  })

  it('anchors at once when 1,000 receipts wait, and at most 1,000 in one', async () => {
    append(1_001)
    const anchor = await job().tick()
    expect(anchor).toMatchObject({ fromSeq: 1, toSeq: 1_000 })
  })

  it('stores nothing when publication fails, and tries again on the next tick', async () => {
    append(2)
    later(ANCHOR_EVERY_MS)
    vi.mocked(publisher.publish).mockRejectedValueOnce(
      new Error('https://rpc.example/?api-key=SECRET'),
    )
    const anchors = job()
    expect(await anchors.tick()).toBeUndefined()
    expect(db.select().from(schema.anchors).all()).toEqual([])
    expect(await anchors.tick()).toMatchObject({ fromSeq: 1, toSeq: 2 })
  })
})

describe('integrity with anchors', () => {
  beforeEach(async () => {
    append(3)
    later(ANCHOR_EVERY_MS)
    await job().tick()
  })

  it('holds for an intact chain and names the last anchor', () => {
    expect(integrity()).toMatchObject({ lastSeq: 3, lastAnchor: { toSeq: 3 } })
    expect(integrity().brokenAt).toBeUndefined()
  })

  it('finds the newest receipt deleted after an anchor, which the chain alone cannot', () => {
    db.delete(schema.executions).where(eq(schema.executions.seq, 3)).run()
    expect(checkChain(db, key).brokenAt).toBeUndefined()
    expect(integrity().brokenAt).toBe(3)
  })

  it('finds an anchored range whose root no longer matches', () => {
    db.update(schema.anchors)
      .set({ root: 'f'.repeat(64) })
      .run()
    expect(integrity().brokenAt).toBe(1)
  })
})
