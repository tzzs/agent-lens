import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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
import { parseJsonlRecords } from '@agentlens/collector'
import { migrate, openDatabase } from '@agentlens/storage'
import { CLI_FLAG_SCHEMA, parseArgs } from '../src/args.ts'
import type { Ctx } from '../src/context.ts'
import { runWatch } from '../src/commands/watch.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-watch-e2e-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const rec = (n: number): string => JSON.stringify({ text: `msg-${n}`, timestamp: 1_700_000_000_000 + n })

function fakeAdapter(root: string, sources: SourceSpec[]): AgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    parserVersion: 1,
    aggregation: { mode: 'per_record_sum', subagentsIncluded: false },
    async detect() {
      return { present: true, dataRoot: root }
    },
    async *discover(): AsyncIterable<SourceSpec> {
      for (const s of sources) yield s
    },
    parse: (source, from, ctx) => parseJsonlRecords(source, from, ctx),
    async normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
      const value = record.value as { text?: string }
      const event: AgentEvent = {
        id: deriveEventId({ sourceId: ctx.source.id, rawSeq: record.seq, type: 'message.user', timestamp: record.occurredAt, discriminator: value.text ?? null }),
        schemaVersion: SCHEMA_VERSION,
        agentId: ctx.agentId,
        hostId: ctx.hostId,
        sourceId: ctx.source.id,
        sessionId: 'sess-e2e',
        projectId: 'proj-e2e',
        timestamp: record.occurredAt,
        ingestedAt: record.occurredAt,
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

function captureCtx(): Ctx & { lines: string[] } {
  const lines: string[] = []
  return {
    argv: [],
    lines,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
  }
}

describe('agentlens watch (lifecycle, §9)', () => {
  it('starts, performs the initial scan, and shuts down on stop leaving no handles', async () => {
    const dir = mkdtempSync(join(tmp, 'src-'))
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, [rec(1), rec(2), rec(3)].map((s) => s + '\n').join(''))
    const source: SourceSpec = { id: deriveSourceId('fake', path), path, kind: 'jsonl' }
    const adapter = fakeAdapter(dir, [source])

    const dbPath = join(dir, 'agentlens.db')
    const db = openDatabase(dbPath)
    migrate(db)
    const flags = parseArgs(['--interval', '3600000'], CLI_FLAG_SCHEMA).flags
    const ctx = captureCtx()

    let stop!: () => void
    const run = await runWatch(db, flags, ctx, {
      adapters: [adapter],
      printInitialSummary: false,
      registerShutdown: (s) => {
        stop = s
        return () => {}
      },
    })

    // Initial scan happens on the first cycle; the three lines are ingested exactly once.
    await run.watcher.tick()
    const count = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    expect(count).toBe(3)
    expect(run.targetCount).toBe(1)
    expect(ctx.lines.join('\n')).toContain('watching 1 source(s)')

    // The loop holds at least the poll timer while resident.
    expect(run.watcher.openHandleCount).toBeGreaterThan(0)

    // Graceful shutdown: stop() clears timers + fs.watch handles, done resolves with 0.
    stop()
    expect(await run.done).toBe(0)
    expect(run.watcher.stopped).toBe(true)
    expect(run.watcher.openHandleCount).toBe(0)
    expect(ctx.lines.join('\n')).toContain('stopped')

    db.close()
  })
})
