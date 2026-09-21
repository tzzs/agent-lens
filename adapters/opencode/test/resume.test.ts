/**
 * §4.3 rowid high-water mark + §4.2 replay idempotency — the properties that make
 * a SQLite source safe to scan repeatedly, and the proof of the collector's
 * generic SQLite path on a real-shaped relational store.
 */
import { describe, expect, it } from 'vitest'
import { scanSource as collectorScan, type EventSink, type SavedSourceState } from '@agentlens/collector'
import type { AgentEvent, ParseFailure, SourceSpec } from '@agentlens/event-model'
import { openCodeAdapter } from '../src/index.ts'
import { buildHost, type BuiltHost } from '../fixtures/build-host.ts'
import { FIXED_NOW, normalizeCtx, scanSource, sourceFor } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost()
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

function saved(lastOffset: number, parserVersion = openCodeAdapter.parserVersion): SavedSourceState {
  return { lastOffset, inode: 0, size: 0, mtimeMs: 0, parserVersion, linesConsumed: lastOffset }
}

function recorder(): { sink: EventSink; events: AgentEvent[]; failures: ParseFailure[]; commits: number[] } {
  const events: AgentEvent[] = []
  const failures: ParseFailure[] = []
  const commits: number[] = []
  return {
    events,
    failures,
    commits,
    sink: {
      writeEvents: (batch) => events.push(...batch),
      writeParseFailure: (f) => failures.push(f),
      commitSource: (c) => commits.push(c.lastOffset),
    },
  }
}

describe('rowid high-water resume (§4.3)', () => {
  it('only returns rows above the stored rowid and reports the new one in the tail', async () => {
    await withHost(async (host) => {
      const full = await scanSource(host.dbPath, 'part', 0)
      expect(full.records.length).toBeGreaterThan(3)
      const highWater = full.tail.nextOffset
      expect(highWater).toBe(Math.max(...full.records.map((r) => r.offset)))

      const mid = Math.floor(highWater / 2)
      const resumed = await scanSource(host.dbPath, 'part', mid)
      expect(resumed.records.every((r) => r.offset > mid)).toBe(true)
      expect(resumed.records.map((r) => r.offset)).toEqual(full.records.filter((r) => r.offset > mid).map((r) => r.offset))
      expect(resumed.tail.nextOffset).toBe(highWater)

      // Steady state: nothing above the high-water mark, and it does not move.
      const quiet = await scanSource(host.dbPath, 'part', highWater)
      expect(quiet.records).toEqual([])
      expect(quiet.tail).toEqual({ nextOffset: highWater, nextSeq: highWater })
    })
  })

  it('appends only the new rows after a live insert', async () => {
    await withHost(async (host) => {
      const first = await scanSource(host.dbPath, 'part', 0)
      const { appendRows } = await import('../fixtures/build-host.ts')
      appendRows(host.dbPath, [
        {
          id: 'prt_added0000000000000000001',
          messageId: 'msg_asst00000000000000000001',
          sessionId: 'ses_root0000000000000000000A',
          data: { type: 'step-finish', cost: 0.5, tokens: { input: 7, output: 3, cache: { read: 11, write: 0 } } },
          created: FIXED_NOW + 10,
        },
      ])
      const second = await scanSource(host.dbPath, 'part', first.tail.nextOffset)
      expect(second.records.map((r) => r.offset)).toEqual([first.tail.nextOffset + 1])
      expect(second.tail.nextOffset).toBe(first.tail.nextOffset + 1)
    })
  })

  it('resumed scan yields the same rows as a scan from zero', async () => {
    await withHost(async (host) => {
      const ids = (events: AgentEvent[]) => events.map((e) => e.id).sort()
      const cold = await scanSource(host.dbPath, 'message', 0)
      const head = await scanSource(host.dbPath, 'message', 2)
      const tail = await scanSource(host.dbPath, 'message', 0)
      // Row 1-2 replayed + rows 3..n from the resumed pass == the cold pass.
      const firstTwo = cold.events.filter((e) => (e.rawSeq as number) <= 2)
      const rest = head.events.filter((e) => (e.rawSeq as number) > 2)
      expect(ids([...firstTwo, ...rest])).toEqual(ids(tail.events))
    })
  })
})

describe('replay idempotency (§4.2)', () => {
  it('normalizing the same rows twice yields identical event ids', async () => {
    await withHost(async (host) => {
      for (const table of ['session', 'message', 'part'] as const) {
        const a = await scanSource(host.dbPath, table, 0)
        const b = await scanSource(host.dbPath, table, 0)
        expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id))
        expect(new Set(a.events.map((e) => e.id)).size).toBe(a.events.length)
      }
    })
  })

  it('rawSeq and rawOffset both carry the rowid, so INSERT OR IGNORE replays are no-ops', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part', 0)
      for (const e of events.slice(0, 5)) {
        expect(e.rawSeq).toBeGreaterThan(0)
        expect(e.rawOffset).toBe(e.rawSeq)
      }
    })
  })
})

describe("collector's SQLite source path (§4.3)", () => {
  it('scans an OpenCode table, advances last_offset to the rowid high-water mark', async () => {
    await withHost(async (host) => {
      const source: SourceSpec = sourceFor(host.dbPath, 'part')
      const ctx = normalizeCtx(host.dbPath, 'part')
      const rec = recorder()
      const result = await collectorScan(
        openCodeAdapter,
        source,
        {
          sink: rec.sink,
          saved: saved(0),
          agentId: 'opencode',
          hostId: 'opencode',
          resolveProject: ctx.resolveProject,
          now: () => FIXED_NOW,
          sqlite: { rowidColumn: 'rowid', column: 'data' },
        },
      )
      expect(result.action).toBe('append')
      expect(result.linesConsumed).toBeGreaterThan(0)
      expect(result.nextOffset).toBe(result.nextSeq)
      expect(rec.commits).toEqual([result.nextOffset])

      // Second pass from the committed high-water mark ingests nothing.
      const rec2 = recorder()
      const again = await collectorScan(
        openCodeAdapter,
        source,
        {
          sink: rec2.sink,
          saved: saved(result.nextOffset),
          agentId: 'opencode',
          hostId: 'opencode',
          resolveProject: ctx.resolveProject,
          now: () => FIXED_NOW,
          sqlite: { rowidColumn: 'rowid', column: 'data' },
        },
      )
      expect(again.linesConsumed).toBe(0)
      expect(again.events).toBe(0)
      expect(rec2.events).toEqual([])
    })
  })

  it('the single-column path loses every join column, and the adapter says so', async () => {
    await withHost(async (host) => {
      // `readSqliteIncremental` hands over one column's JSON only, so a part row
      // arrives without session_id / message role: degradation must be visible.
      const { parseJson } = await import('../src/record.ts')
      const value = parseJson(
        JSON.stringify({ type: 'step-finish', cost: 0.1, tokens: { input: 5, output: 1, cache: { read: 9, write: 0 } } }),
      )
      const result = await openCodeAdapter.normalize(
        { seq: 7, offset: 7, occurredAt: FIXED_NOW, value: value ?? {} },
        normalizeCtx(host.dbPath, 'part'),
      )
      expect('events' in result).toBe(true)
      if ('events' in result) {
        const [event] = result.events
        expect(event?.type).toBe('generation.end')
        expect(event?.metadata?.diagnostics).toContain('partial_row')
        expect(event?.sessionId).toBeTruthy()
        expect(event?.threadId ?? null).toBe(null)
      }
    })
  })
})
