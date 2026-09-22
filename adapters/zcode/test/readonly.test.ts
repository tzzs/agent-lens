/**
 * §5.2 rule 3 and §18 row 7 stated the way this project states them: a WAL store is never
 * opened, whether or not its `-wal`/`-shm` siblings already exist (attaching rewrites them),
 * and our own opens stay side-effect free.
 *
 * ZCode's live store is WAL on this machine (`db.sqlite` 30.0MB with a 0B `-wal` and a 32KB
 * `-shm`), so this suite is the adapter's own copy of the guard the collector already runs:
 * the journal mode comes from the file header, the sibling inventory is compared by
 * size+mtime rather than existence, and the refusal is a visible fact.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceFor } from './helpers.ts'
import { zcodeAdapter } from '../src/index.ts'
import { WAL_REASON, readJournalMode, sidecarPaths } from '../src/safety.ts'
import { buildHost, writePluginCatalog } from '../fixtures/build-host.ts'
import { ctxFor, hostCtx, scanAll } from './helpers.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

/** size + mtime + inode + mode: any write of ours shows up here. */
async function stamp(path: string): Promise<string> {
  const s = await stat(path)
  return `${s.size}|${s.mtimeMs}|${s.ino}|${(s.mode & 0o777).toString(8)}`
}

async function stamps(dbPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    out[p.slice(dbPath.length)] = (await exists(p)) ? await stamp(p) : 'absent'
  }
  return out
}

describe('read-only guarantee (§5.2 rule 3)', () => {
  it('detect + discover + parse + normalize + capabilities leave the store byte-identical', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      await writePluginCatalog(host.dir)
      const storeDir = host.root
      const before = await listing(storeDir)
      const beforeStamp = await stamp(host.dbPath)
      const beforeSidecars = await stamps(host.dbPath)

      const detection = await zcodeAdapter.detect(hostCtx(host.dir))
      expect(detection.present).toBe(true)
      for await (const spec of zcodeAdapter.discover(hostCtx(host.dir))) {
        await scanAll(host.dbPath)
        expect(spec.path).toBe(host.dbPath)
      }
      const { events } = await scanAll(host.dbPath)
      expect(events.length).toBeGreaterThan(30)
      expect(await zcodeAdapter.capabilities?.(hostCtx(host.dir))).not.toHaveLength(0)

      expect(await stamp(host.dbPath)).toBe(beforeStamp)
      expect(await stamps(host.dbPath)).toEqual(beforeSidecars)
      expect(await listing(storeDir)).toEqual(before)
      const { wal, shm } = sidecarPaths(host.dbPath)
      expect(await exists(wal)).toBe(false)
      expect(await exists(shm)).toBe(false)
    } finally {
      await host.close()
    }
  })

  it('refuses a WAL store even when the app already created its -wal/-shm', async () => {
    // The state ZCode's live store is actually in, and the one an earlier generation of
    // adapters treated as safe to attach to: attaching rewrites the app's own -shm, which is
    // a write into its data directory either way (§18 row 7).
    const host = await buildHost({ subdir: 'cli/db', wal: true, retainWriter: true })
    try {
      expect(await readJournalMode(host.dbPath)).toBe('wal')
      const { wal, shm } = sidecarPaths(host.dbPath)
      expect(await exists(wal)).toBe(true)
      const beforeStamps = await stamps(host.dbPath)
      const beforeListing = await listing(host.root)

      const detection = await zcodeAdapter.detect(hostCtx(host.dir))
      expect(detection.present).toBe(true)
      expect(detection.reason).toBe(WAL_REASON)
      // Null WITH a reason, never a guessed version: the real 0.16.5 is reachable per row.
      expect(detection.agentVersion).toBeNull()

      // The five sources are still listed, so the agent stays visible and the refusal is a
      // reported fact per source rather than a silent zero (§5.2 rule 1).
      const tables: string[] = []
      for await (const spec of zcodeAdapter.discover(hostCtx(host.dir))) tables.push(spec.sqliteTable ?? '')
      expect(tables).toEqual(['session', 'message', 'part', 'model_usage', 'tool_usage'])

      // `parse` keeps refusing, and the refusal is an error rather than an empty read.
      const source = sourceFor(host.dbPath, 'model_usage')
      await expect(zcodeAdapter.parse(source, { offset: 0 }, ctxFor(source)).next()).rejects.toThrow(/WAL/)

      expect(await stamps(host.dbPath)).toEqual(beforeStamps)
      expect(await listing(host.root)).toEqual(beforeListing)
    } finally {
      await host.close()
    }
  })

  it('refuses a WAL store that would grow -wal/-shm from our read', async () => {
    const host = await buildHost({ subdir: 'cli/db', wal: true })
    const { dbPath, root } = host
    // A clean close checkpoints and deletes the sidecars, leaving header=wal + no siblings:
    // precisely the state where a read-only open writes into the app's directory.
    host.closeConnections()
    expect(await readJournalMode(dbPath)).toBe('wal')
    expect(await exists(`${dbPath}-wal`)).toBe(false)
    // `root` is `<dir>/cli/db`; the data root `detect`/`discover` resolve from is `<dir>`.
    const dirRoot = host.dir

    const detection = await zcodeAdapter.detect(hostCtx(dirRoot))
    expect(detection.present).toBe(true)
    expect(detection.reason).toBe(WAL_REASON)

    let discovered = 0
    for await (const spec of zcodeAdapter.discover(hostCtx(dirRoot))) {
      discovered++
      expect(spec.kind).toBe('sqlite')
      const source = sourceFor(dbPath, spec.sqliteTable ?? '')
      await expect(zcodeAdapter.parse(source, { offset: 0 }, ctxFor(source)).next()).rejects.toThrow(/WAL/)
    }
    expect(discovered).toBe(5)
    // The refusal is real: nothing appeared next to the database.
    expect(await exists(`${dbPath}-wal`)).toBe(false)
    expect(await exists(`${dbPath}-shm`)).toBe(false)
    await rm(dirRoot, { recursive: true, force: true })
  })
})
