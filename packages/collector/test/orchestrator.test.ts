import { mkdtemp, appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentAdapter,
  AgentEvent,
  HostContext,
  NormalizeCtx,
  NormalizeResult,
  ParseFailure,
  RawRecord,
  SourceSpec,
} from '@agentlens/event-model'
import { SCHEMA_VERSION, deriveEventId } from '@agentlens/event-model'
import { parseJsonlRecords } from '../src/parse-jsonl.ts'
import type { EventSink, SavedSourceState, SourceCommit } from '../src/orchestrator.ts'
import { rescanSourceOnVersionDrift, scanSource } from '../src/orchestrator.ts'
import { snapshotPathFor } from '../src/sqlite-snapshot.ts'

let currentTmp: string | null = null

async function tmpPath(name: string): Promise<string> {
  if (!currentTmp) currentTmp = await mkdtemp(join(tmpdir(), 'collector-orch-'))
  return join(currentTmp, name)
}

afterEach(async () => {
  if (currentTmp) await rm(currentTmp, { recursive: true, force: true })
  currentTmp = null
})

/** Minimal pure adapter: `parse` is the default JSONL framing; one message.user event
 * per record; `{"bad":true}` ⇒ ParseFailure. */
function fakeAdapter(parserVersion = 1): AgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    parserVersion,
    aggregation: { mode: 'request_max', subagentsIncluded: true },
    async detect(_ctx: HostContext) {
      return { present: true }
    },
    async *discover(): AsyncIterable<SourceSpec> {},
    // The default JSONL framing: this seam is live, the orchestrator drives it.
    parse: (source, from, ctx) => parseJsonlRecords(source, from, ctx),
    async normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
      const value = record.value as { bad?: boolean; text?: string; timestamp?: number }
      if (value?.bad) {
        return {
          failure: {
            reason: 'unmappable record',
            rawLine: JSON.stringify(value),
            offset: record.offset,
            rawSeq: record.seq,
          } satisfies ParseFailure,
        }
      }
      const event: AgentEvent = {
        id: deriveEventId({
          sourceId: ctx.source.id,
          rawSeq: record.seq,
          type: 'message.user',
          timestamp: record.occurredAt,
          discriminator: value.text ?? null,
        }),
        schemaVersion: SCHEMA_VERSION,
        agentId: ctx.agentId,
        hostId: ctx.hostId,
        sourceId: ctx.source.id,
        sessionId: 'session-1',
        projectId: ctx.resolveProject(null) ?? 'no-project',
        timestamp: record.occurredAt,
        type: 'message.user',
        usageSource: 'missing',
        status: 'ok',
        rawSeq: record.seq,
        rawOffset: record.offset,
        metadata: { text: value.text ?? null },
      }
      return { events: [event] }
    },
  }
}

class FakeSink implements EventSink {
  events: AgentEvent[] = []
  failures: (ParseFailure & { path: string })[] = []
  commits: SourceCommit[] = []
  writeEventsCalls = 0
  /** 1-based call index at which writeEvents throws (simulated crash before commit). */
  throwOnWriteEventsCall: number | null = null
  persisted: SavedSourceState = { lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: 1, linesConsumed: 0 }

  writeEvents(events: readonly AgentEvent[]): void {
    this.writeEventsCalls++
    this.events.push(...events)
    if (this.throwOnWriteEventsCall === this.writeEventsCalls) {
      // The batch never landed: roll back the recording, as a real txn would.
      this.events.splice(this.events.length - events.length, events.length)
      throw new Error('sink exploded mid-batch')
    }
  }
  writeParseFailure(f: ParseFailure & { path: string }): void {
    this.failures.push(f)
  }
  commitSource(p: SourceCommit): void {
    this.commits.push(p)
    this.persisted = {
      lastOffset: p.lastOffset,
      inode: p.inode,
      size: p.size,
      mtimeMs: p.mtimeMs,
      parserVersion: p.parserVersion,
      linesConsumed: this.persisted.linesConsumed + p.rowsIngested,
    }
  }
}

function sourceFor(path: string): SourceSpec {
  return { id: 'src-1', path, kind: 'jsonl' }
}

/** §5.1 sqlite framing done the way a real adapter does it: `parse` runs the row
 * query (rowid high-water in, rowid-keyed records out); the orchestrator never reads
 * columns. Like every honest adapter it reads `ctx.storePath`, not `source.path`. */
function sqliteParseAdapter(parserVersion = 1): AgentAdapter {
  const base = fakeAdapter(parserVersion)
  return {
    ...base,
    parse: (source, from, ctx) =>
      (async function* () {
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(ctx.storePath ?? source.path, { open: true, readOnly: true })
        let lastRowid = from.offset
        try {
          const sql = `SELECT rowid AS r, payload AS p FROM "${source.sqliteTable}" WHERE rowid > ? ORDER BY rowid ASC`
          for (const row of db.prepare(sql).iterate(from.offset) as Iterable<{ r: number; p: string }>) {
            const rowid = Number(row.r)
            if (rowid > lastRowid) lastRowid = rowid
            yield { seq: rowid, offset: rowid, occurredAt: 1700000000000 + rowid, value: JSON.parse(String(row.p)) }
          }
        } finally {
          db.close()
        }
        return { nextOffset: lastRowid, nextSeq: lastRowid }
      })(),
  }
}

function ctxFor(sink: FakeSink, source: SourceSpec) {
  return {
    sink,
    saved: sink.persisted,
    agentId: 'fake',
    hostId: 'fake-cli',
    resolveProject: () => 'proj-1',
    now: () => 1700000000000,
    source,
  }
}

const rec = (n: number) => JSON.stringify({ text: `msg-${n}`, timestamp: 1700000000000 + n })

describe('scanSource', () => {
  it('full scan → events committed, offset at last line boundary', async () => {
    const path = await tmpPath('a.jsonl')
    const body = [rec(1), rec(2), rec(3)].map((s) => s + '\n').join('')
    await writeFile(path, body + '{"n": 9')
    const sink = new FakeSink()
    const source = sourceFor(path)
    const result = await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    expect(result.action).toBe('append')
    expect(result.events).toBe(3)
    expect(sink.events.map((e) => (e.metadata as { text: string }).text)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(result.nextOffset).toBe(Buffer.byteLength(body))
    expect(sink.commits).toHaveLength(1)
    expect(sink.commits[0]!.status).toBe('active')
    expect(sink.commits[0]!.lastOffset).toBe(Buffer.byteLength(body))
  })

  it('crash-safety (§4.2): writeEvents throws on the second batch ⇒ offset stays behind; re-scan is identical', async () => {
    const path = await tmpPath('a.jsonl')
    await writeFile(path, [rec(1), rec(2), rec(3)].map((s) => s + '\n').join(''))
    const sink = new FakeSink()
    const source = sourceFor(path)
    await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    const offsetAfterFirst = sink.persisted.lastOffset
    const eventsAfterFirst = [...sink.events]
    expect(offsetAfterFirst).toBeGreaterThan(0)

    await appendFile(path, [rec(4), rec(5)].map((s) => s + '\n').join(''))
    sink.throwOnWriteEventsCall = 2
    await expect(scanSource(fakeAdapter(), source, ctxFor(sink, source))).rejects.toThrow('sink exploded')
    expect(sink.persisted.lastOffset).toBe(offsetAfterFirst) // NOT advanced
    expect(sink.commits).toHaveLength(1) // no second commit
    expect(sink.events).toEqual(eventsAfterFirst)

    // Re-run the failed scan: identical events, seq numbering continues from the PERSISTED state.
    sink.throwOnWriteEventsCall = null
    const ctx = ctxFor(sink, source)
    const again = await scanSource(fakeAdapter(), source, ctx)
    expect(again.events).toBe(2)
    expect(again.nextSeq).toBe(6)
    const replayed = sink.events.slice(eventsAfterFirst.length)
    expect(replayed).toHaveLength(2)
    sink.events = []
    sink.writeEventsCalls = 0
    await scanSource(fakeAdapter(), source, { ...ctx, saved: { ...sink.persisted, lastOffset: 0, linesConsumed: 0 } })
    expect(sink.events).toEqual([...eventsAfterFirst, ...replayed])
  })

  it('M0 acceptance at collector level: rescanning the same file twice from offset 0 yields identical events', async () => {
    const path = await tmpPath('a.jsonl')
    await writeFile(path, [rec(1), rec(2), rec(3), rec(4)].map((s) => s + '\n').join(''))
    const source = sourceFor(path)
    const sinkA = new FakeSink()
    await scanSource(fakeAdapter(), source, ctxFor(sinkA, source))
    const sinkB = new FakeSink()
    await scanSource(fakeAdapter(), source, ctxFor(sinkB, source))
    expect(sinkB.events).toEqual(sinkA.events)
    expect(sinkB.commits[0]).toEqual(sinkA.commits[0])
  })

  it('malformed JSON line becomes a ParseFailure and does not abort the batch', async () => {
    const path = await tmpPath('a.jsonl')
    await writeFile(path, `${rec(1)}\n{oops not json\n${rec(2)}\n{"bad":true}\n${rec(3)}\n`)
    const sink = new FakeSink()
    const source = sourceFor(path)
    const result = await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    expect(result.events).toBe(3)
    expect(result.failures).toBe(2)
    expect(sink.failures).toHaveLength(2)
    expect(sink.failures[0]!.reason).toContain('json-parse')
    expect(sink.failures[0]!.path).toBe(path)
    expect(sink.failures[0]!.rawLine).toBe('{oops not json')
    expect(sink.failures[1]!.reason).toBe('unmappable record') // adapter-level failure, batch continued
    expect(sink.commits).toHaveLength(1)
  })

  it('skip decision performs no reads and no commits', async () => {
    const path = await tmpPath('a.jsonl')
    const body = rec(1) + '\n'
    await writeFile(path, body)
    const source = sourceFor(path)
    const sink = new FakeSink()
    await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    const callsBefore = sink.writeEventsCalls
    const result = await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    expect(result.action).toBe('skip')
    expect(sink.writeEventsCalls).toBe(callsBefore)
    expect(sink.commits).toHaveLength(1) // unchanged from first scan
  })

  it('rotation: rescans from 0 and the commit carries status rotated', async () => {
    const path = await tmpPath('a.jsonl')
    await writeFile(path, [rec(1), rec(2)].map((s) => s + '\n').join(''))
    const source = sourceFor(path)
    const sink = new FakeSink()
    await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    await writeFile(path, rec(9) + '\n') // same path, new (smaller) content
    const result = await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    expect(result.action).toBe('rotated')
    expect(sink.commits.at(-1)!.status).toBe('rotated')
    const last = sink.events.at(-1)!
    expect(last.rawSeq).toBe(1) // numbering restarts for the new file
    expect(last.metadata).toEqual({ text: 'msg-9' })
  })

  it('missing file ⇒ commit with status gone, offset preserved', async () => {
    const path = await tmpPath('gone.jsonl')
    await writeFile(path, rec(1) + '\n')
    const source = sourceFor(path)
    const sink = new FakeSink()
    await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    await rm(path)
    const result = await scanSource(fakeAdapter(), source, ctxFor(sink, source))
    expect(result.action).toBe('gone')
    expect(sink.commits.at(-1)).toMatchObject({ status: 'gone', lastOffset: sink.persisted.lastOffset })
  })

  it('parser version drift ⇒ full rescan from 0 even when stat says skip (§5.3)', async () => {
    const path = await tmpPath('a.jsonl')
    await writeFile(path, [rec(1), rec(2), rec(3)].map((s) => s + '\n').join(''))
    const source = sourceFor(path)
    const sink = new FakeSink()
    await scanSource(fakeAdapter(1), source, ctxFor(sink, source))
    expect(rescanSourceOnVersionDrift(fakeAdapter(2), 1)).toBe(true)
    expect(rescanSourceOnVersionDrift(fakeAdapter(2), 2)).toBe(false)
    const result = await scanSource(fakeAdapter(2), source, ctxFor(sink, source))
    expect(result.action).toBe('version-drift')
    expect(result.linesConsumed).toBe(3) // whole file, not just new bytes
    expect(sink.commits.at(-1)!.parserVersion).toBe(2)
  })

  it('sqlite source: rowid high-water mark replaces byte offsets', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const path = await tmpPath('agent.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE messages (payload TEXT)')
    const ins = db.prepare('INSERT INTO messages (payload) VALUES (?)')
    ins.run(rec(1))
    ins.run(rec(2))
    db.close()
    const source: SourceSpec = { id: 'src-sql', path, kind: 'sqlite', sqliteTable: 'messages' }
    const sink = new FakeSink()
    const ctx = ctxFor(sink, source)
    const r1 = await scanSource(sqliteParseAdapter(), source, ctx)
    expect(r1.events).toBe(2)
    expect(sink.commits.at(-1)!.lastOffset).toBe(2) // rowid high-water
    const db2 = new DatabaseSync(path)
    db2.prepare('INSERT INTO messages (payload) VALUES (?)').run(rec(3))
    db2.close()
    const r2 = await scanSource(sqliteParseAdapter(), source, { ...ctx, saved: sink.persisted })
    expect(r2.events).toBe(1)
    expect(sink.events.at(-1)!.metadata).toEqual({ text: 'msg-3' })
    expect(sink.commits.at(-1)!.lastOffset).toBe(3)
  })

  it('sqlite source in WAL mode: reported as a refusal, offset untouched, nothing created', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const path = await tmpPath('agent-wal.db')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE messages (payload TEXT)')
    db.prepare('INSERT INTO messages (payload) VALUES (?)').run(rec(1))
    // Checkpoint and close so the store is WAL by header with no sidecar on disk: the
    // only thing that would let a reader in is the sidecar this scan must not create.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    const rmSync = (await import('node:fs')).rmSync
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })

    const source: SourceSpec = { id: 'src-wal', path, kind: 'sqlite', sqliteTable: 'messages' }
    const sink = new FakeSink()
    const ctx = ctxFor(sink, source)
    const result = await scanSource(sqliteParseAdapter(), source, ctx)

    expect(result.events).toBe(0)
    expect(result.action).toBe('skip')
    expect(result.refusal).toMatch(/WAL mode/)
    const commit = sink.commits.at(-1)!
    expect(commit.status).toBe('error')
    expect(commit.lastOffset).toBe(0) // §4.2: nothing was read, so nothing advances
    expect(commit.lastError).toMatch(/WAL mode/)
    const { existsSync } = await import('node:fs')
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
  })
})

describe('scanSource · WAL store through a snapshot copy (§18 row 7)', () => {
  let cleanupDirs: string[] = []

  afterEach(async () => {
    for (const d of cleanupDirs) await rm(d, { recursive: true, force: true })
    cleanupDirs = []
  })

  /** A foreign store left exactly as a live app keeps it: WAL header, `-wal` and `-shm` on disk. */
  async function walFixture(): Promise<{ path: string; dir: string; close(): void }> {
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdtemp } = await import('node:fs/promises')
    const dir = await mkdtemp(join(tmpdir(), 'collector-wal-foreign-'))
    cleanupDirs.push(dir)
    const path = join(dir, 'opencode.db')
    // The connection that wrote the rows stays open, because that is what a live
    // OpenCode is: closing it would checkpoint and delete `-wal`, and the fixture
    // would no longer look like a WAL store at all.
    const writer = new DatabaseSync(path)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('CREATE TABLE messages (payload TEXT)')
    const ins = writer.prepare('INSERT INTO messages (payload) VALUES (?)')
    ins.run(rec(1))
    ins.run(rec(2))
    return { path, dir, close: () => writer.close() }
  }

  async function stamps(path: string): Promise<Record<string, string>> {
    const { statSync } = await import('node:fs')
    const out: Record<string, string> = {}
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        const s = statSync(p)
        out[p.slice(path.length)] = `${s.size}:${s.mtimeMs}:${s.ino}`
      } catch {
        out[p.slice(path.length)] = 'absent'
      }
    }
    return out
  }

  function walSource(path: string): SourceSpec {
    return { id: 'src-wal-snap', path, kind: 'sqlite', sqliteTable: 'messages' }
  }

  it('events flow end-to-end and the foreign directory is provably untouched', async () => {
    const { existsSync, readdirSync } = await import('node:fs')
    const { mkdtemp } = await import('node:fs/promises')
    const { journalModeOf } = await import('../src/sqlite-source.ts')
    const host = await walFixture()
    const snapDir = await mkdtemp(join(tmpdir(), 'collector-wal-snap-'))
    cleanupDirs.push(snapDir)
    await chmod(snapDir, 0o700)
    try {
      expect(existsSync(`${host.path}-wal`)).toBe(true)
      expect(existsSync(`${host.path}-shm`)).toBe(true)
      const beforeStamps = await stamps(host.path)
      const beforeListing = readdirSync(host.dir).sort()

      const source = walSource(host.path)
      const sink = new FakeSink()
      const ctx = { ...ctxFor(sink, source), snapshotDir: snapDir }
      const result = await scanSource(sqliteParseAdapter(), source, ctx)

      expect(result.events).toBe(2)
      expect(sink.events.map((e) => (e.metadata as { text: string }).text)).toEqual(['msg-1', 'msg-2'])
      expect(sink.commits.at(-1)!.lastOffset).toBe(2) // rowid high-water from the copy
      // Foreign store untouched at the byte level …
      expect(await stamps(host.path)).toEqual(beforeStamps)
      // … and no new path appeared in its directory.
      expect(readdirSync(host.dir).sort()).toEqual(beforeListing)
      // The snapshot is a plain, sidecar-free rollback database — that is what lets
      // adapters keep their own read-only guard.
      const copy = snapshotPathFor(host.path, snapDir)
      expect(journalModeOf(copy)).toBe('rollback')
      expect(existsSync(`${copy}-wal`)).toBe(false)
      expect(existsSync(`${copy}-shm`)).toBe(false)
    } finally {
      await chmod(snapDir, 0o700)
      host.close()
    }
  })

  it('a second scan of an unchanged store performs no copy at all', async () => {
    const { statSync } = await import('node:fs')
    const { mkdtemp } = await import('node:fs/promises')
    const host = await walFixture()
    const snapDir = await mkdtemp(join(tmpdir(), 'collector-wal-snap-'))
    cleanupDirs.push(snapDir)
    try {
      const source = walSource(host.path)
      const sink = new FakeSink()
      const ctx = { ...ctxFor(sink, source), snapshotDir: snapDir }
      await scanSource(sqliteParseAdapter(), source, ctx)
      const copy = snapshotPathFor(host.path, snapDir)
      const firstCopy = statSync(copy)

      // Make ANY write into the snapshot directory fatal: deleting or re-copying the
      // snapshot needs write permission. An unchanged signature must hit the cache instead.
      await chmod(snapDir, 0o500)
      const second = await scanSource(sqliteParseAdapter(), source, { ...ctx, saved: sink.persisted })
      await chmod(snapDir, 0o700)

      expect(second.linesConsumed).toBe(0)
      expect(second.events).toBe(0)
      const after = statSync(copy)
      expect(after.ino).toBe(firstCopy.ino) // same file, not a fresh copy
      expect(after.mtimeMs).toBe(firstCopy.mtimeMs)
    } finally {
      await chmod(snapDir, 0o700)
      host.close()
    }
  })

  it('a store that grew gets a fresh copy and only the new rows', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdtemp } = await import('node:fs/promises')
    const host = await walFixture()
    const snapDir = await mkdtemp(join(tmpdir(), 'collector-wal-snap-'))
    cleanupDirs.push(snapDir)
    try {
      const source = walSource(host.path)
      const sink = new FakeSink()
      const ctx = { ...ctxFor(sink, source), snapshotDir: snapDir }
      await scanSource(sqliteParseAdapter(), source, ctx)
      const appender = new DatabaseSync(host.path)
      appender.prepare('INSERT INTO messages (payload) VALUES (?)').run(rec(3))
      appender.close()
      const second = await scanSource(sqliteParseAdapter(), source, { ...ctx, saved: sink.persisted })
      expect(second.events).toBe(1)
      expect(sink.events.at(-1)!.metadata).toEqual({ text: 'msg-3' })
      expect(sink.commits.at(-1)!.lastOffset).toBe(3)
    } finally {
      host.close()
    }
  })

  async function chmod(path: string, mode: number): Promise<void> {
    const { chmod } = await import('node:fs/promises')
    await chmod(path, mode)
  }
})
