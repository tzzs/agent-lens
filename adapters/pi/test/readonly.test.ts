/**
 * §5.2 rule 3 in one proof: run the entire adapter surface over the fixture store, then
 * show the tree is byte- and metadata-identical afterwards. Pi keeps no SQLite store
 * (docs/research/pi.md §一), so the WAL-sidecar hazard the WorkBuddy guard refuses has
 * no analogue here — and that absence is itself asserted: no `.db`, `-wal` or `-shm`
 * file may appear anywhere in the tree.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isParseFailure,
  type NormalizeCtx,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { piAdapter } from '../src/index.ts'
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

function normalizeCtxFor(spec: SourceSpec): NormalizeCtx {
  return {
    source: spec,
    agentId: 'pi',
    hostId: 'pi',
    sessionHint: spec.sessionHint ?? null,
    resolveProject: () => null,
    now: () => 1_760_000_000_000,
  }
}

describe('read-only guarantee (§5.2 rule 3)', () => {
  it('detect + discover + parse + normalize + capabilities change nothing on disk', async () => {
    const before = await snapshot(FIXTURES_DIR)
    let events = 0
    let failures = 0
    let sources = 0

    for (const root of [HOST_DIR, join(FIXTURES_DIR, 'host-empty')]) {
      const host = hostCtx({ dataRoot: root, homedir: root })
      const detection = await piAdapter.detect(host)
      expect(detection.present).toBe(true)
      await piAdapter.capabilities?.(host)

      for await (const spec of piAdapter.discover(host)) {
        sources++
        const records: RawRecord[] = []
        const stream = piAdapter.parse(
          spec,
          { offset: 0 },
          { source: spec, agentId: 'pi', hostId: 'pi' },
        )
        while (true) {
          const next = await stream.next()
          if (next.done) break
          records.push(next.value)
        }
        const ctx = normalizeCtxFor(spec)
        resetStateFor(ctx)
        for (const record of records) {
          const result = await piAdapter.normalize(record, ctx)
          if (isParseFailure(result)) failures++
          else events += result.events.length
        }
      }
    }

    expect(sources).toBe(2)
    expect(events).toBeGreaterThan(0)
    // Nothing on disk is unreadable, so a failure here would be the adapter's own bug.
    expect(failures).toBe(0)
    expect(await snapshot(FIXTURES_DIR)).toEqual(before)
  })

  it('Pi has no SQLite surface, and the scan did not create one', async () => {
    const rows = await snapshot(HOST_DIR)
    expect(rows.filter((r) => /\.(db|sqlite3?)(-wal|-shm)?\|/.test(r))).toEqual([])
  })

  it('the session layout stays exactly as shipped', async () => {
    expect((await readdir(join(HOST_DIR, 'sessions/work-alpha'))).length).toBe(1)
    expect((await readdir(join(HOST_DIR, 'sessions'))).sort()).toEqual(['team', 'work-alpha'])
  })
})
