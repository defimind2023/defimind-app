import type { Anchor } from '@defimind/shared'
import { and, asc, desc, gte, lte } from 'drizzle-orm'
import type { Db } from './client.js'
import { anchors, executions } from './schema.js'

export function saveAnchor(db: Db, anchor: Anchor): void {
  db.insert(anchors).values(anchor).run()
}

export function lastAnchor(db: Db): Anchor | undefined {
  return db.select().from(anchors).orderBy(desc(anchors.toSeq)).limit(1).get()
}

export function allAnchors(db: Db): Anchor[] {
  return db.select().from(anchors).orderBy(asc(anchors.fromSeq)).all()
}

export function anchorsBetween(db: Db, from: Date, to: Date): Anchor[] {
  return db
    .select()
    .from(anchors)
    .where(
      and(gte(anchors.anchoredAt, from.toISOString()), lte(anchors.anchoredAt, to.toISOString())),
    )
    .orderBy(asc(anchors.fromSeq))
    .all()
}

/** The receipt hashes of fromSeq..toSeq, in seq order: the leaves of that anchor's tree. */
export function hashesBetween(db: Db, fromSeq: number, toSeq: number): string[] {
  return db
    .select({ hash: executions.hash })
    .from(executions)
    .where(and(gte(executions.seq, fromSeq), lte(executions.seq, toSeq)))
    .orderBy(asc(executions.seq))
    .all()
    .map((row) => row.hash)
}

/** The first receipt not yet under an anchor, for how long it has waited. */
export function firstUnanchored(db: Db, afterSeq: number) {
  return db
    .select({ seq: executions.seq, issuedAt: executions.issuedAt })
    .from(executions)
    .where(gte(executions.seq, afterSeq + 1))
    .orderBy(asc(executions.seq))
    .limit(1)
    .get()
}

/** The anchor whose range holds this seq, if one does yet. */
export function anchorFor(db: Db, seq: number): Anchor | undefined {
  return db
    .select()
    .from(anchors)
    .where(and(lte(anchors.fromSeq, seq), gte(anchors.toSeq, seq)))
    .get()
}
