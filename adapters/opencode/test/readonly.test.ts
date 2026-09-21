/**
 * §18 row 7 — the hard read-only rule. Two halves: our opens must be side-effect
 * free, and a WAL store whose `-wal`/`-shm` machinery is not already on disk must
 * be refused outright (that is exactly the WorkBuddy write we were shown not to do).
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openCodeAdapter } from '../src/index.ts'
import { WAL_REASON, readJournalMode, sidecarPaths } from '../src/safety.ts'
import { buildHost } from '../fixtures/build-host.ts'
import { hostCtx, scanSource } from './helpers.ts'

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

async function stamp(path: string): Promise<string> {
  const s = await stat(path)
  return `${s.size}|${s.mtimeMs}|${s.ino}|${(s.mode & 0o777).toString(8)}`
}

describe('read-only guarantee (§5.2 rule 3)', () => {
  it('detect + discover + parse + capabilities leave the store byte-identical and create no sidecars', async () => {
    const host = await buildHost()
    try {
      const before = await listing(host.root)
      const stampBefore = await stamp(host.dbPath)

      await openCodeAdapter.detect(hostCtx(host.root))
      for await (const spec of openCodeAdapter.discover(hostCtx(host.root))) {
        await scanSource(host.dbPath, spec.sqliteTable ?? 'part', 0)
      }
      await openCodeAdapter.capabilities?.(hostCtx(host.root))

      expect(await stamp(host.dbPath)).toBe(stampBefore)
      expect(await listing(host.root)).toEqual(before)
      const { wal, shm } = sidecarPaths(host.dbPath)
      expect(await exists(wal)).toBe(false)
      expect(await exists(shm)).toBe(false)
    } finally {
      await host.close()
    }
  })

  it('attaches to a WAL store whose sidecars the app already created', async () => {
    const host = await buildHost({ wal: true, retainWriter: true })
    try {
      expect(await readJournalMode(host.dbPath)).toBe('wal')
      expect(await exists(join(host.root, 'opencode.db-wal'))).toBe(true)
      const detection = await openCodeAdapter.detect(hostCtx(host.root))
      expect(detection.present).toBe(true)
      expect(detection.reason).toBeNull()
      const sources: string[] = []
      for await (const spec of openCodeAdapter.discover(hostCtx(host.root))) sources.push(spec.sqliteTable ?? '')
      expect(sources).toEqual(['session', 'message', 'part'])
      const scanned = await scanSource(host.dbPath, 'part', 0)
      expect(scanned.events.length).toBeGreaterThan(0)
      expect(await exists(join(host.root, 'opencode.db-wal'))).toBe(true)
    } finally {
      await host.close()
    }
  })

  it('refuses a WAL store that would grow -wal/-shm from our read', async () => {
    const host = await buildHost({ wal: true })
    const dbPath = host.dbPath
    const root = host.root
    // A clean close checkpoints and deletes the sidecars, leaving header=wal + no
    // siblings — precisely the state where a read-only open writes into the app's dir.
    host.closeConnections()
    expect(await readJournalMode(dbPath)).toBe('wal')
    expect(await exists(`${dbPath}-wal`)).toBe(false)

    const detection = await openCodeAdapter.detect(hostCtx(root))
    expect(detection.present).toBe(true)
    expect(detection.reason).toBe(WAL_REASON)

    let discovered = 0
    for await (const spec of openCodeAdapter.discover(hostCtx(root))) {
      discovered++
      expect(spec.kind).toBe('sqlite')
    }
    expect(discovered).toBe(0)
    expect(await openCodeAdapter.capabilities?.(hostCtx(root))).toEqual([])

    // The refusal is real: nothing appeared next to the database.
    expect(await exists(`${dbPath}-wal`)).toBe(false)
    expect(await exists(`${dbPath}-shm`)).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
