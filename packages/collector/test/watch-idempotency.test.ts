import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  deriveEventId,
  deriveSourceId,
  type AgentAdapter,
  type AgentEvent,
  type NormalizeCtx,
  type NormalizeResult,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase, updateSourceProgress, dumpTable, type SourceProgress } from '@agentlens/storage'
import { parseJsonlRecords } from '@agentlens/event-model'
import { scanSource, type EventSink, type SavedSourceState } from '../src/orchestrator.ts'
import { createWatcher, type WatchTarget } from '../src/watch.ts'

const adapter: AgentAdapter = {
  id: 'fake',
  displayName: 'Fake',
  parserVersion: 1,
  aggregation: { mode: 'per_record_sum', subagentsIncluded: false },
  async detect() {
    return { present: true }
  },
  async *discover(): AsyncIterable<SourceSpec> {},
  parse: (source, from, ctx) => parseJsonlRecords(source, from, ctx),
  async normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
    const value = record.value as { text?: string }
    const event: AgentEvent = {
      id: deriveEventId({ sourceId: ctx.source.id, rawSeq: record.seq, type: 'message.user', timestamp: record.occurredAt, discriminator: value.text ?? null }),
      schemaVersion: SCHEMA_VERSION,
      agentId: ctx.agentId,
      hostId: ctx.hostId,
      sourceId: ctx.source.id,
      sessionId: 'sess-1',
      projectId: 'proj-1',
      timestamp: record.occurredAt,
      ingestedAt: 1_700_000_000_000,
      type: 'message.user',
      usageSource: 'missing',
      status: 'ok',
      rawSeq: record.seq,
      rawOffset: record.offset,
    }
    return { events: [event] }
  },
}

const rec = (n: number): string => JSON.stringify({ text: `msg-${n}`, timestamp: 1_700_000_000_000 + n })
const body = (...ns: number[]): string => ns.map((n) => rec(n) + '\n').join('')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function makeTarget(db: ReturnType<typeof openDatabase>, path: string): { target: WatchTarget; rescanFromZero: () => void } {
  const source: SourceSpec = { id: deriveSourceId('fake', path), path, kind: 'jsonl' }
  const state: SavedSourceState = { lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: 1, linesConsumed: 0 }
  const target: WatchTarget = {
    id: source.id,
    agentId: 'fake',
    adapter,
    source,
    saved: { inode: 0, size: 0, mtimeMs: 0, lastOffset: 0 },
    scan: async () => {
      const sink: EventSink = {
        writeEvents: (evs) => insertEvents(db, evs),
        writeParseFailure: () => {},
        commitSource: (p) => {
          const prev = db.prepare('SELECT rows_ingested FROM sources WHERE id = ?').get(p.id) as { rows_ingested: number | null } | undefined
          const progress: SourceProgress = {
            id: p.id, agentId: 'fake', path: p.path, kind: 'jsonl',
            inode: p.inode, size: p.size, mtimeMs: p.mtimeMs, lastOffset: p.lastOffset,
            parserVersion: p.parserVersion, sessionIdHint: null, status: p.status,
            rowsIngested: (prev?.rows_ingested ?? 0) + p.rowsIngested,
            scanStartedAt: p.scanStartedAt, scanFinishedAt: p.scanFinishedAt, lastError: p.lastError,
          }
          updateSourceProgress(db, progress)
          Object.assign(state, {
            lastOffset: p.lastOffset, inode: p.inode, size: p.size, mtimeMs: p.mtimeMs,
            parserVersion: p.parserVersion, linesConsumed: state.linesConsumed + p.rowsIngested,
          })
          target.saved = { inode: p.inode, size: p.size, mtimeMs: p.mtimeMs, lastOffset: p.lastOffset }
        },
      }
      return scanSource(adapter, source, {
        sink,
        saved: state,
        agentId: 'fake',
        hostId: 'fake',
        resolveProject: () => 'proj-1',
        now: () => 1_700_000_000_000,
      })
    },
  }
  // §4.2 "rescan from offset 0": drop the in-memory + watcher-visible position; the file is untouched.
  const rescanFromZero = (): void => {
    Object.assign(state, { lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, linesConsumed: 0 })
    target.saved = { inode: 0, size: 0, mtimeMs: 0, lastOffset: 0 }
  }
  return { target, rescanFromZero }
}

/** Byte-comparable projection of the idempotent tables (§4.2). */
function snapshot(db: ReturnType<typeof openDatabase>): string {
  // `sources` bookkeeping (scan_*, rows_ingested) is per-scan telemetry and legitimately
  // changes; events/sessions converge via INSERT OR IGNORE + recomputed event_count.
  const sources = dumpTable(db, 'sources').map((r) => ({ id: r.id, last_offset: r.last_offset, status: r.status }))
  return JSON.stringify({
    events: dumpTable(db, 'events'),
    sessions: dumpTable(db, 'sessions'),
    sources,
  })
}

const eventCount = (db: ReturnType<typeof openDatabase>): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n

describe('watch idempotency across cycles (§4.2)', () => {
  it('replaying the same bytes on a later watch cycle leaves the DB byte-identical', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-watch-idem-'))
    dirs.push(dir)
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, body(1, 2, 3))

    const db = openDatabase(join(dir, 'agentlens.db'))
    migrate(db)
    const { target, rescanFromZero } = makeTarget(db, path)
    const w = createWatcher({ targets: [target], useFsWatch: false, discoverIntervalMs: 0 })

    await w.tick()
    const afterFirst = snapshot(db)
    expect(eventCount(db)).toBe(3)

    // Cycle 2 with no file change ⇒ needsRescan skips; nothing touched.
    const skip = await w.tick()
    expect(skip.scanned).toHaveLength(0)
    expect(snapshot(db)).toBe(afterFirst)

    // §4.2 replay: re-scan the untouched file from offset 0. Deterministic ids make every
    // insert an OR-IGNORE no-op, so the DB is byte-identical to the first pass.
    rescanFromZero()
    const replay = await w.tick()
    expect(replay.scanned[0]?.events).toBe(3) // whole file re-read
    expect(eventCount(db)).toBe(3)
    expect(snapshot(db)).toBe(afterFirst)

    db.close()
  })
})
