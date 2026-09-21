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
import { parseJsonlRecords } from '@agentlens/event-model'
import type { EventSink, ScanCtx, SavedSourceState, SourceCommit } from '../src/orchestrator.ts'
import { rescanSourceOnVersionDrift, scanSource } from '../src/orchestrator.ts'
import { snapshotPathFor } from '../src/sqlite-snapshot.ts'
import { insertEvents, migrate, openDatabase, updateSourceProgress, type SourceProgress } from '@agentlens/storage'

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
    expect(rescanSourceOnVersionDrift(fakeAdapter(2), { parserVersion: 1 })).toBe(true)
    expect(rescanSourceOnVersionDrift(fakeAdapter(2), { parserVersion: 2 })).toBe(false)
    const result = await scanSource(fakeAdapter(2), source, ctxFor(sink, source))
    expect(result.action).toBe('version-drift')
    expect(result.linesConsumed).toBe(3) // whole file, not just new bytes
    expect(sink.commits.at(-1)!.parserVersion).toBe(2)
  })

  it('reports a first ingest as an append, and a version-0 row that has progress as drift (§5.3)', async () => {
    const path = await tmpPath('first.jsonl')
    await writeFile(path, [rec(1), rec(2)].map((s) => s + '\n').join(''))
    const source = sourceFor(path)
    const sink = new FakeSink()
    // No `sources` row yet: parser_version 0 is the absence of a record, not a mismatch.
    const first = await scanSource(
      fakeAdapter(3),
      source,
      { ...ctxFor(sink, source), saved: { ...sink.persisted, parserVersion: 0, seen: false } },
    )
    expect(first.action).toBe('append')
    expect(first.linesConsumed).toBe(2)
    // A row that did make progress under an older parser still has to be re-read whole.
    const legacy = await scanSource(
      fakeAdapter(3),
      source,
      { ...ctxFor(sink, source), saved: { ...sink.persisted, parserVersion: 0, seen: true } },
    )
    expect(legacy.action).toBe('version-drift')
    expect(legacy.linesConsumed).toBe(2)
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
    expect(sink.commits.at(-1)!.sqliteTable).toBe('messages') // the table it counts (§4.3)
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

describe('sqlite scan persists the table its watermark counts (§4.3)', () => {
  /** A sink that writes the real `sources` row through storage, mirroring the CLI's. */
  function storageSink(db: ReturnType<typeof openDatabase>, source: SourceSpec, agentId: string): EventSink {
    return {
      writeEvents: () => {},
      writeParseFailure: () => {},
      commitSource: (p: SourceCommit) => {
        const prev = db.prepare('SELECT rows_ingested FROM sources WHERE id = ?').get(p.id) as
          { rows_ingested: number | null } | undefined
        const progress: SourceProgress = {
          id: p.id, agentId, path: p.path, kind: source.kind,
          inode: p.inode, size: p.size, mtimeMs: p.mtimeMs,
          lastOffset: p.lastOffset, parserVersion: p.parserVersion,
          sessionIdHint: source.sessionHint ?? null,
          sqliteTable: p.sqliteTable ?? null,
          status: p.status, rowsIngested: (prev?.rows_ingested ?? 0) + p.rowsIngested,
          scanStartedAt: p.scanStartedAt, scanFinishedAt: p.scanFinishedAt, lastError: p.lastError,
        }
        updateSourceProgress(db, progress)
      },
    }
  }
  const freshSaved = (): SavedSourceState => ({
    lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: 1, linesConsumed: 0,
  })

  it('records the table name beside the rowid high-water after a real scan', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const storePath = await tmpPath('persist.db')
    const store = new DatabaseSync(storePath)
    store.exec('CREATE TABLE messages (payload TEXT)')
    store.prepare('INSERT INTO messages (payload) VALUES (?)').run(rec(1))
    store.prepare('INSERT INTO messages (payload) VALUES (?)').run(rec(2))
    store.close()

    const db = openDatabase(':memory:')
    migrate(db)
    const source: SourceSpec = { id: 'src-persist', path: storePath, kind: 'sqlite', sqliteTable: 'messages' }
    await scanSource(sqliteParseAdapter(), source, {
      sink: storageSink(db, source, 'fake'),
      saved: freshSaved(),
      agentId: 'fake',
      hostId: 'fake',
      resolveProject: () => 'proj-1',
      now: () => 1700000000000,
    })
    const row = db.prepare("SELECT sqlite_table, last_offset FROM sources WHERE id = 'src-persist'").get() as
      { sqlite_table: string | null; last_offset: number }
    expect(row.sqlite_table).toBe('messages') // the table the watermark counts
    expect(row.last_offset).toBe(2)
    db.close()
  })

  it('leaves the column NULL for a jsonl source', async () => {
    const path = await tmpPath('persist.jsonl')
    await writeFile(path, rec(1) + '\n')
    const db = openDatabase(':memory:')
    migrate(db)
    const source = sourceFor(path)
    await scanSource(fakeAdapter(), source, {
      sink: storageSink(db, source, 'fake'),
      saved: freshSaved(),
      agentId: 'fake',
      hostId: 'fake',
      resolveProject: () => 'proj-1',
      now: () => 1700000000000,
    })
    const row = db.prepare('SELECT sqlite_table FROM sources WHERE id = ?').get(source.id) as
      { sqlite_table: string | null }
    expect(row.sqlite_table).toBeNull()
    db.close()
  })
})

/**
 * §5.3 + §4.2: a `parser_version` bump re-scans from offset 0, and the ONLY thing that makes
 * that safe is the write path. For an *additive* parser change, `INSERT OR IGNORE` suffices —
 * the replayed ids all exist and land on themselves. But the very change the version exists to
 * cover — a re-derivation of an already-stored row's derived identity columns (session/project/
 * thread) — collides on `event.id` (a fingerprint that omits them) and would be thrown away,
 * leaving the source on the *old* ids and the store silently mixing two schemes. The write must
 * therefore REPAIR the derived columns on conflict, not ignore them.
 */
describe('§5.3 drift repairs a stored row\'s derived columns', () => {
  /** Same records, but the "v2" parser derives session/project/thread differently — the
   * only honest simulation of a parser change without touching a real adapter. */
  function driftingAdapter(v2: boolean, parserVersion: number): AgentAdapter {
    return {
      id: 'fake',
      displayName: 'Fake',
      parserVersion,
      aggregation: { mode: 'request_max', subagentsIncluded: true },
      async detect(_ctx: HostContext) {
        return { present: true }
      },
      async *discover(): AsyncIterable<SourceSpec> {},
      parse: (source, from, ctx) => parseJsonlRecords(source, from, ctx),
      async normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
        const value = record.value as { text?: string }
        const tag = v2 ? 'new' : 'old'
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
          sessionId: `sess-${tag}`,
          projectId: `proj-${tag}`,
          threadId: `thread-${tag}`,
          timestamp: record.occurredAt,
          type: 'message.user',
          usageSource: 'missing',
          status: 'ok',
          rawSeq: record.seq,
          rawOffset: record.offset,
        }
        return { events: [event] }
      },
    }
  }

  /** A sink that writes the real rows through storage, as the CLI does. */
  function dbSink(db: ReturnType<typeof openDatabase>): { sink: EventSink; saved: SavedSourceState } {
    const saved: SavedSourceState = {
      lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: 1, linesConsumed: 0,
    }
    const sink: EventSink = {
      writeEvents: (evs) => { insertEvents(db, evs) },
      writeParseFailure: () => {},
      commitSource: (p) => {
        const prev = db.prepare('SELECT rows_ingested FROM sources WHERE id = ?').get(p.id) as
          { rows_ingested: number | null } | undefined
        updateSourceProgress(db, {
          id: p.id, agentId: 'fake', path: p.path, kind: 'jsonl',
          inode: p.inode, size: p.size, mtimeMs: p.mtimeMs,
          lastOffset: p.lastOffset, parserVersion: p.parserVersion,
          sessionIdHint: null, sqliteTable: null, status: p.status,
          rowsIngested: (prev?.rows_ingested ?? 0) + p.rowsIngested,
          scanStartedAt: p.scanStartedAt, scanFinishedAt: p.scanFinishedAt, lastError: p.lastError,
        })
        Object.assign(saved, {
          lastOffset: p.lastOffset, inode: p.inode, size: p.size, mtimeMs: p.mtimeMs,
          parserVersion: p.parserVersion, linesConsumed: saved.linesConsumed + p.rowsIngested, seen: true,
        })
      },
    }
    return { sink, saved }
  }

  const cols = (db: ReturnType<typeof openDatabase>) =>
    db.prepare('SELECT session_id, project_id, thread_id FROM events ORDER BY raw_seq').all()
      .map((r) => ({ s: String(r.session_id), p: String(r.project_id), t: String(r.thread_id) }))
  const eventCountOf = (db: ReturnType<typeof openDatabase>, session: string): number => {
    const row = db.prepare('SELECT event_count FROM sessions WHERE id = ?').get(session) as
      { event_count: number } | undefined
    return row?.event_count ?? -1
  }
  const byteState = (db: ReturnType<typeof openDatabase>) =>
    JSON.stringify({
      events: db.prepare('SELECT rowid AS _r, id, session_id, project_id, thread_id, type, status FROM events ORDER BY rowid').all(),
      sessions: db.prepare('SELECT rowid AS _r, id, event_count FROM sessions ORDER BY rowid').all(),
    })

  async function firstScan(): Promise<{ store: ReturnType<typeof openDatabase>; source: SourceSpec; ctx: ScanCtx }> {
    const path = await tmpPath('drift-repair.jsonl')
    await writeFile(path, [rec(1), rec(2), rec(3)].map((s) => s + '\n').join(''))
    const store = openDatabase(':memory:')
    migrate(store)
    const source: SourceSpec = { id: 'src-drift', path, kind: 'jsonl' }
    const { sink, saved } = dbSink(store)
    const ctx: ScanCtx = {
      sink, saved,
      agentId: 'fake', hostId: 'fake-cli', resolveProject: () => null, now: () => 1700000000000,
    }
    await scanSource(driftingAdapter(false, 1), source, ctx)
    return { store, source, ctx }
  }

  it('the first pass stores the old derivation', async () => {
    const { store } = await firstScan()
    expect(cols(store)).toEqual([
      { s: 'sess-old', p: 'proj-old', t: 'thread-old' },
      { s: 'sess-old', p: 'proj-old', t: 'thread-old' },
      { s: 'sess-old', p: 'proj-old', t: 'thread-old' },
    ])
    store.close()
  })

  it('a version bump re-scan overwrites session/project/thread instead of keeping the stale ids', async () => {
    const { store, ctx, source } = await firstScan()
    const second = await scanSource(driftingAdapter(true, 2), source, ctx)
    expect(second.action).toBe('version-drift')
    expect(second.events).toBe(3) // whole source re-read from offset 0
    // The repair lands: stored rows now carry the NEW derivation, not the collide-and-drop old one.
    expect(cols(store)).toEqual([
      { s: 'sess-new', p: 'proj-new', t: 'thread-new' },
      { s: 'sess-new', p: 'proj-new', t: 'thread-new' },
      { s: 'sess-new', p: 'proj-new', t: 'thread-new' },
    ])
    // …and the session the events just left stops claiming them.
    expect(eventCountOf(store, 'sess-old')).toBe(0)
    expect(eventCountOf(store, 'sess-new')).toBe(3)
    store.close()
  })

  it('re-scanning the repaired parser from offset 0 is a byte-identical no-op (§4.2)', async () => {
    const { store, ctx, source } = await firstScan()
    await scanSource(driftingAdapter(true, 2), source, ctx)
    const afterRepair = byteState(store)
    // Force a from-zero re-read with the SAME parser version (mirrors watch's rescanFromZero):
    // the whole batch is rewritten, so this exercises the conflict guard, not a stat-based skip.
    const replay = await scanSource(driftingAdapter(true, 2), source, {
      ...ctx,
      saved: { lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: 2, linesConsumed: 0, seen: true },
    })
    expect(replay.events).toBe(3) // whole file re-read and written again
    expect(byteState(store)).toBe(afterRepair)
    store.close()
  })
})
