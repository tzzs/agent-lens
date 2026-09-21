/**
 * §5.1 `discover` + §18 row 7: the trace directory is the only thing this adapter
 * advertises. Its absence of a SQLite source is an assertion rather than an accident —
 * a `kind: 'sqlite'` spec is framed by this adapter's own `parse` (§5.1), and opening
 * this store is what created `-wal`/`-shm` in the user's data directory.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveSourceId, type SourceSpec } from '@agentlens/event-model'
import { workbuddyAdapter } from '../src/index.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

async function collect(root: string): Promise<SourceSpec[]> {
  const out: SourceSpec[] = []
  for await (const spec of workbuddyAdapter.discover(hostCtx({ dataRoot: root, homedir: root }))) {
    out.push(spec)
  }
  return out
}

describe('discover', () => {
  it('finds every trace under projects/**, nested directories included', async () => {
    expect((await collect(HOST_DIR)).map((s) => s.path)).toEqual([
      join(HOST_DIR, 'projects', 'team', 'trace-b.jsonl'),
      join(HOST_DIR, 'projects', 'trace-a.jsonl'),
    ])
  })

  it('ids each source from its path and never hints the file name as a session (§4.1)', async () => {
    for (const spec of await collect(HOST_DIR)) {
      expect(spec.kind).toBe('jsonl')
      expect(spec.id).toBe(deriveSourceId('workbuddy', spec.path))
      expect(spec.sessionHint).toBeNull()
      expect(Object.keys(spec).sort()).toEqual(['id', 'kind', 'path', 'sessionHint'])
    }
  })

  it('advertisements are sorted and identical across runs (§4.2 replay determinism)', async () => {
    const first = await collect(HOST_DIR)
    const second = await collect(HOST_DIR)
    expect(second).toEqual(first)
    expect(first.map((s) => s.path)).toEqual([...first.map((s) => s.path)].sort())
  })

  it('yields no sqlite source and no *.db path, whatever the store looks like', async () => {
    // `host` holds a WAL store, `host-journal` a non-WAL one: the refusal is not
    // conditional on the journal mode, because the column names are unmeasured either way.
    for (const root of [HOST_DIR, join(FIXTURES_DIR, 'host-journal'), join(FIXTURES_DIR, 'host-wal-sidecar')]) {
      for (const spec of await collect(root)) {
        expect(spec.kind).not.toBe('sqlite')
        expect(spec.sqliteTable ?? null).toBeNull()
        expect(spec.path.endsWith('.db')).toBe(false)
      }
    }
    // A root whose only content is the database therefore discovers nothing at all —
    // `host-wal-sidecar` ships a store with its sidecars present and no trace.
    expect(await collect(join(FIXTURES_DIR, 'host-wal-sidecar'))).toEqual([])
    expect((await collect(HOST_DIR)).length).toBeGreaterThan(0)
  })

  it('an empty or absent store discovers nothing instead of failing', async () => {
    expect(await collect(join(FIXTURES_DIR, 'host-empty'))).toEqual([])
    const missing = join(HOST_DIR, 'no-such-root')
    expect(await collect(missing)).toEqual([])
  })
})
