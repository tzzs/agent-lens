/**
 * §5.2 rule 3: every source-file access is read-only. Proof by snapshot — run the whole
 * adapter surface over the fixture store and show the tree is identical afterwards, name,
 * size, mtime, inode, mode and link count alike.
 *
 * The rule is not ceremony: Codex rollout files are append-only logs a live agent is
 * writing, and a prior task left SQLite WAL sidecars in another agent's data dir by
 * opening it "read-only" (§ docs/plan-v2.md §5.2). No SQLite file exists in this fixture
 * tree, and none is opened.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isParseFailure, type RawRecord, type SourceSpec } from '@agentlens/event-model'
import { codexAdapter } from '../src/index.ts'
import { ctxFor, FIXTURES_DIR, HOST_DIR, hostCtx, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

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

/** One file's identity: name, size, mtime, inode, mode, link count. */
async function rowOf(path: string): Promise<string> {
  const s = await stat(path)
  return `${basename(path)}|${s.size}|${s.mtimeMs}|${s.ino}|${(s.mode & 0o777).toString(8)}|${s.nlink}`
}

/** Only the store is snapshotted per test: `fixtures/expected` is written by the snapshot tests. */
describe('read-only guarantee (§5.2 rule 3)', () => {
  it('detect + discover + parse + normalize + capabilities change nothing on disk', async () => {
    const before = await snapshot(HOST_DIR)
    const host = hostCtx()
    const sources: SourceSpec[] = []
    const counted = { events: 0, failures: 0 }

    await codexAdapter.detect(host)
    for await (const spec of codexAdapter.discover(host)) sources.push(spec)
    expect(sources.length).toBe(3)

    for (const spec of sources) {
      const records: RawRecord[] = []
      const it = codexAdapter.parse(spec, { offset: 0 }, { source: spec, agentId: 'codex', hostId: 'codex-desktop' })
      for (;;) {
        const next = await it.next()
        if (next.done) break
        records.push(next.value)
      }
      expect(records.length).toBeGreaterThan(0)
      const ctx = ctxFor(spec.path.slice(HOST_DIR.length + 1), spec.sessionHint, spec.path)
      resetStateFor(ctx)
      for (const record of records) {
        const result = await codexAdapter.normalize(record, ctx)
        if (isParseFailure(result)) counted.failures++
        else counted.events += result.events.length
      }
    }
    const catalog = await codexAdapter.capabilities!(host)

    expect(counted.events).toBeGreaterThan(0)
    expect(catalog.length).toBeGreaterThan(0)
    expect(await snapshot(HOST_DIR)).toEqual(before)
  })

  it('scenario fixtures are read as data and stay untouched', async () => {
    const names = ['per-call-and-cumulative.jsonl', 'hosts.jsonl', 'parse-failure.jsonl', 'compacted.jsonl']
    const before = await Promise.all(names.map(async (n) => rowOf(join(FIXTURES_DIR, n))))
    const listingBefore = (await readdir(FIXTURES_DIR)).sort()
    for (const name of names) {
      const ctx = ctxFor(name)
      resetStateFor(ctx)
      for (const record of recordsFromJsonl(await readFixture(name))) {
        await codexAdapter.normalize(record, ctx)
      }
    }
    expect(await Promise.all(names.map(async (n) => rowOf(join(FIXTURES_DIR, n))))).toEqual(before)
    expect((await readdir(FIXTURES_DIR)).sort()).toEqual(listingBefore)
  })

  it('the fixture store holds no database file the adapter could open', async () => {
    const rows = await snapshot(HOST_DIR)
    expect(rows.filter((r) => /\.(db|sqlite|sqlite3|db-wal|db-shm)$/.test(r.split('|')[0]!))).toEqual([])
  })

  it('the adapter exposes only the read-side AgentAdapter surface', () => {
    expect(Object.keys(codexAdapter).sort()).toEqual([
      'aggregation',
      'capabilities',
      'detect',
      'discover',
      'displayName',
      'id',
      'normalize',
      'parse',
      'parserVersion',
    ])
    expect(codexAdapter.id).toBe('codex')
    expect(codexAdapter.displayName).toBe('Codex')
    expect(codexAdapter.parserVersion).toBe(2)
    // §18 row 2: the fold is declared on the adapter, and it is NOT the default
    expect(codexAdapter.aggregation).toEqual({ mode: 'last_call_sum', subagentsIncluded: false })
    expect(Object.isFrozen(codexAdapter.aggregation)).toBe(true)
  })
})
