import { chmod, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { type BucketConfig, upload } from '../adapters/bucket.js'
import { backupDb } from '../db/backup.js'
import { dbFile, type Db } from '../db/client.js'

const KEEP = 14
const DAY_MS = 86_400_000
export const BACKUP_NAME = /^guard-.*\.db$/
/** Holds the time of the last upload, for the doctor. Not a backup: BACKUP_NAME skips it. */
export const UPLOADED = 'last-upload'

export interface BackupDeps {
  db: Db
  databaseUrl: string
  now: () => Date
  log: Pick<FastifyBaseLogger, 'info' | 'error'>
  fetch: typeof fetch
  bucket?: BucketConfig | undefined
}

/** Beside the database, on the same volume: the one disk a deployment already keeps. */
export function backupsDir(databaseUrl: string): string | undefined {
  const file = dbFile(databaseUrl)
  return file === ':memory:' ? undefined : join(dirname(file), 'backups')
}

/**
 * Today's backup, made once: a restart the same day keeps the first. Older ones beyond the newest
 * 14 go. With a bucket, the day's backup is also uploaded, sealed.
 */
export async function backUp(deps: BackupDeps): Promise<string | undefined> {
  const dir = backupsDir(deps.databaseUrl)
  if (dir === undefined) {
    return undefined
  }
  const name = `guard-${deps.now().toISOString().slice(0, 10)}.db`
  const file = join(dir, name)
  if (existsSync(file)) {
    return file
  }
  await backupDb(deps.db, file)
  await chmod(file, 0o600)
  await prune(dir)
  deps.log.info({ backup: name }, 'database backed up')
  if (deps.bucket !== undefined) {
    await upload(deps.bucket, name, await readFile(file), deps.fetch, deps.now())
    await writeFile(join(dir, UPLOADED), deps.now().toISOString(), { mode: 0o600 })
    deps.log.info({ backup: name }, 'database backup uploaded')
  }
  return file
}

/** Names sort by date, so the newest are last. */
export async function prune(dir: string, keep = KEEP): Promise<void> {
  const backups = (await readdir(dir)).filter((name) => BACKUP_NAME.test(name)).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    await unlink(join(dir, name))
  }
}

/** Milliseconds from `now` to the next `hour`:00 UTC, never zero. */
export function untilHour(now: Date, hour: number): number {
  const next = new Date(now)
  next.setUTCHours(hour, 0, 0, 0)
  const wait = next.getTime() - now.getTime()
  return wait > 0 ? wait : wait + DAY_MS
}

/**
 * Runs the backup every day at `hour` UTC. A failure is logged and tried again the next day; the
 * error is the backup's or the upload's status, never a URL or a key.
 */
export function scheduleBackups(
  deps: BackupDeps,
  hour: number,
  run: (deps: BackupDeps) => Promise<unknown> = backUp,
): { stop: () => void } {
  let timer: NodeJS.Timeout
  const next = () => {
    timer = setTimeout(
      async () => {
        try {
          await run(deps)
        } catch (error) {
          deps.log.error({ err: error }, 'database backup failed')
        }
        next()
      },
      untilHour(deps.now(), hour),
    )
    timer.unref()
  }
  next()
  return { stop: () => clearTimeout(timer) }
}
