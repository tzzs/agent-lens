/**
 * §5.2 rule 3 and §18 row 7 in one proof: run the entire adapter surface over the
 * fixture store, then show the tree is byte- and metadata-identical afterwards and that
 * no SQLite sidecar appeared next to any database file.
 *
 * All three shapes the guard recognises are exercised (WAL, non-WAL, WAL with the
 * sidecars already materialised) because the case the incident was measured on is the one
 * that must not change: a WAL store with no siblings in place.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveSourceId,
  isParseFailure,
  type NormalizeCtx,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { workbuddyAdapter } from '../src/index.ts'
import { sqliteDiagnostics } from '../src/sqlite.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx, resetStateFor } from './helpers.ts'

/** Full tree fingerprint: names, kinds, sizes, mtimes, inodes, modes, link counts. */
async function snapshot(root: string): Promise<string[]> {
  const rows: string[] = []
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      // `expected/` is this run's own output, written in parallel by the snapshot suites;
      // everything under it is a source of truth, this directory is not.
      if (name === 'expected' && dir === root) continue
      const path = join(dir, name)
      const s = await stat(path)
      rows.push(
        `${path.slice(root.length)}|${s.isDirectory() ? 'd' : 'f'}|${s.size}|${s.mtimeMs}|${s.ino}|${(s.mode & 0o777).toString(8)}|${s.nlink}`,
      )
      if (s.isDirectory()) await walk(path)
    }
  }
  await walk(root)
  return rows
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

const HOSTS = [
  HOST_DIR,
  join(FIXTURES_DIR, 'host-journal'),
  join(FIXTURES_DIR, 'host-wal-sidecar'),
  join(FIXTURES_DIR, 'host-empty'),
]

function normalizeCtxFor(spec: SourceSpec): NormalizeCtx {
  return {
    source: spec,
    agentId: 'workbuddy',
    hostId: 'workbuddy',
    sessionHint: spec.sessionHint ?? null,
    resolveProject: () => null,
    now: () => 1_760_000_000_000,
  }
}

describe('read-only guarantee (§5.2 rule 3)', () => {
  it('detect + discover + parse + normalize + diagnostics change nothing on disk', async () => {
    const before = await snapshot(FIXTURES_DIR)
    let events = 0
    let failures = 0
    let sources = 0

    for (const root of HOSTS) {
      const host = hostCtx({ dataRoot: root, homedir: root })
      const detection = await workbuddyAdapter.detect(host)
      expect(detection.present).toBe(true)
      for (const d of await sqliteDiagnostics(host)) expect(d.opened).toBe(false)

      for await (const spec of workbuddyAdapter.discover(host)) {
        sources++
        const records: RawRecord[] = []
        const stream = workbuddyAdapter.parse(
          spec,
          { offset: 0 },
          { source: spec, agentId: 'workbuddy', hostId: 'workbuddy' },
        )
        while (true) {
          const next = await stream.next()
          if (next.done) break
          records.push(next.value)
        }
        const ctx = normalizeCtxFor(spec)
        resetStateFor(ctx)
        for (const record of records) {
          const result = await workbuddyAdapter.normalize(record, ctx)
          if (isParseFailure(result)) failures++
          else events += result.events.length
        }
      }
    }

    expect(sources).toBeGreaterThan(0)
    expect(events).toBeGreaterThan(0)
    // Nothing on disk is unreadable, so a failure here would be the adapter's own bug.
    expect(failures).toBe(0)
    expect(await snapshot(FIXTURES_DIR)).toEqual(before)
  })

  it('refusing to open the store leaves no -wal/-shm behind', async () => {
    // The pre-run state is the fixture state: only `host-wal-sidecar` ships sidecars, and
    // that directory is what the "already materialised" branch reads.
    for (const root of HOSTS) {
      const db = join(root, 'workbuddy.db')
      const wal = `${db}-wal`
      const shm = `${db}-shm`
      const hadWal = await exists(wal)
      const hadShm = await exists(shm)
      const diagnostics = await sqliteDiagnostics(hostCtx({ dataRoot: root, homedir: root }))
      expect(diagnostics.map((d) => d.path)).toContain(db)
      expect((await exists(wal)) || !hadWal).toBe(true)
      expect((await exists(shm)) || !hadShm).toBe(true)
      expect(await exists(wal)).toBe(hadWal)
      expect(await exists(shm)).toBe(hadShm)
    }
    expect(await exists(join(HOST_DIR, 'workbuddy.db'))).toBe(true)
    expect(await exists(join(HOST_DIR, 'workbuddy.db-wal'))).toBe(false)
    expect(await exists(join(HOST_DIR, 'workbuddy.db-shm'))).toBe(false)
    expect(await exists(join(FIXTURES_DIR, 'host-journal', 'workbuddy.db-wal'))).toBe(false)
  })

  it('the JSONL sources are opened read-only by the same code path that reads them', async () => {
    const root = join(FIXTURES_DIR, 'host-journal')
    const before = await snapshot(root)
    const spec: SourceSpec = {
      id: deriveSourceId('workbuddy', join(root, 'projects', 'trace-j.jsonl')),
      path: join(root, 'projects', 'trace-j.jsonl'),
      kind: 'jsonl',
      sessionHint: null,
    }
    const ctx = normalizeCtxFor(spec)
    resetStateFor(ctx)
    for await (const record of workbuddyAdapter.parse(
      spec,
      { offset: 0 },
      { source: spec, agentId: 'workbuddy', hostId: 'workbuddy' },
    )) {
      await workbuddyAdapter.normalize(record, ctx)
    }
    expect(await snapshot(root)).toEqual(before)
  })

  it('the adapter exposes only the read-side AgentAdapter surface', () => {
    expect(Object.keys(workbuddyAdapter).sort()).toEqual([
      'aggregation',
      'detect',
      'discover',
      'displayName',
      'id',
      'normalize',
      'parse',
      'parserVersion',
    ])
  })
})
