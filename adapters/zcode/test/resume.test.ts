/**
 * §4.3 rowid high-water resume + §4.2 replay idempotency for a five-table relational store,
 * and the proof that the collector's generic SQLite path carries ZCode's joined row shape
 * through untouched.
 *
 * WHY a rowid high-water mark is safe here and what it costs: three of the five tables are
 * insert-only ledgers (`model_usage`, `tool_usage`, `part` on append), so "everything above
 * the mark" is exactly "everything new". The cost is that a row UPDATEd in place — a `part`
 * going pending→completed, a `message.data` being rewritten with its token copy — is never
 * re-read, which is precisely why §三 forbids taking usage from those tables.
 */
import { describe, expect, it } from 'vitest'
import {
  scanSource as collectorScan,
  type EventSink,
  type SavedSourceState,
} from '@agentlens/collector'
import type { AgentEvent, ParseFailure, SourceSpec } from '@agentlens/event-model'
import { zcodeAdapter } from '../src/index.ts'
import { TABLE_MODEL_USAGE, TABLE_PART, TABLE_TOOL_USAGE } from '../src/record.ts'
import { appendRows, buildHost, type BuiltHost } from '../fixtures/build-host.ts'
import { FIXED_NOW, normalizeCtx, scanSource, sourceFor } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost({ subdir: 'cli/db' })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

function saved(lastOffset: number, parserVersion = zcodeAdapter.parserVersion): SavedSourceState {
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
  for (const table of [TABLE_MODEL_USAGE, TABLE_TOOL_USAGE, TABLE_PART, 'session', 'message']) {
    it(`${table}: seq equals offset, resumes above the mark, and reports it in the tail`, async () => {
      await withHost(async (host) => {
        const full = await scanSource(host.dbPath, table, 0)
        expect(full.records.length).toBeGreaterThan(0)
        for (const r of full.records) expect(r.seq).toBe(r.offset)
        const highWater = full.tail.nextOffset
        expect(highWater).toBe(Math.max(...full.records.map((r) => r.offset)))
        expect(full.tail).toEqual({ nextOffset: highWater, nextSeq: highWater })

        const mid = Math.floor(highWater / 2)
        const resumed = await scanSource(host.dbPath, table, mid)
        expect(resumed.records.every((r) => r.offset > mid)).toBe(true)
        expect(resumed.records.map((r) => r.offset)).toEqual(full.records.filter((r) => r.offset > mid).map((r) => r.offset))
        expect(resumed.tail.nextOffset).toBe(highWater)

        // Steady state: nothing above the mark, and the mark does not move.
        const quiet = await scanSource(host.dbPath, table, highWater)
        expect(quiet.records).toEqual([])
        expect(quiet.tail).toEqual({ nextOffset: highWater, nextSeq: highWater })
      })
    })
  }

  it('picks up only the rows appended after the last scan', async () => {
    await withHost(async (host) => {
      const first = await scanSource(host.dbPath, TABLE_MODEL_USAGE, 0)
      const highWater = first.tail.nextOffset
      appendRows(host.dbPath, {
        modelUsage: [
          {
            id: 'usage_model_appended_00000001',
            logicalRequestId: 'msg_appended_00000001',
            sessionId: 'sess_fixture_root_0000000001',
            turnId: 'turn_fixture_root_0001',
            querySource: 'main_turn',
            status: 'completed',
            startedAt: FIXED_NOW + 10,
            inputTokens: 900,
            outputTokens: 100,
            cacheReadInputTokens: 600,
            computedTotalTokens: 1_000,
          },
        ],
      })
      const second = await scanSource(host.dbPath, TABLE_MODEL_USAGE, highWater)
      expect(second.records.map((r) => r.offset)).toEqual([highWater + 1])
      expect(second.tail.nextOffset).toBe(highWater + 1)
      // A new row must arrive with its session joins intact, or the root chain would break.
      expect(second.events[0]?.usage).toEqual({
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 600,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      })
      expect(second.events[0]?.threadId).toBe('sess_fixture_root_0000000001')
    })
  })

  it('a resumed pass plus the replayed head reproduces a cold pass', async () => {
    await withHost(async (host) => {
      const ids = (events: AgentEvent[]) => events.map((e) => e.id).sort()
      const cold = await scanSource(host.dbPath, 'message', 0)
      const head = await scanSource(host.dbPath, 'message', 4)
      const firstFour = cold.events.filter((e) => e.rawSeq <= 4)
      const rest = head.events.filter((e) => e.rawSeq > 4)
      expect(ids([...firstFour, ...rest])).toEqual(ids(cold.events))
    })
  })

  it('resumed rows keep the same ids they had in the cold pass', async () => {
    await withHost(async (host) => {
      const cold = await scanSource(host.dbPath, TABLE_MODEL_USAGE, 0)
      const resumed = await scanSource(host.dbPath, TABLE_MODEL_USAGE, 3)
      const byId = new Map(cold.events.map((e) => [e.id, e]))
      for (const e of resumed.events) {
        expect(byId.get(e.id)).toBeDefined()
        expect(byId.get(e.id)).toEqual(e)
      }
    })
  })
})

describe("collector's SQLite source path (§4.3)", () => {
  it('scans a table and advances last_offset to the rowid high-water mark', async () => {
    await withHost(async (host) => {
      const source: SourceSpec = sourceFor(host.dbPath, TABLE_MODEL_USAGE)
      const ctx = normalizeCtx(host.dbPath, TABLE_MODEL_USAGE)
      const rec = recorder()
      const result = await collectorScan(zcodeAdapter, source, {
        sink: rec.sink,
        saved: saved(0),
        agentId: 'zcode',
        hostId: 'zcode',
        resolveProject: ctx.resolveProject,
        now: () => FIXED_NOW,
      })
      expect(result.action).toBe('append')
      expect(result.linesConsumed).toBe(6)
      expect(result.events).toBe(6)
      // The undecodable-JSON row is a counted failure, not a lost row (§5.2 rule 1).
      expect(result.failures).toBe(0)
      expect(result.nextOffset).toBe(result.nextSeq)
      expect(rec.commits).toEqual([result.nextOffset])

      const rec2 = recorder()
      const again = await collectorScan(zcodeAdapter, source, {
        sink: rec2.sink,
        saved: saved(result.nextOffset),
        agentId: 'zcode',
        hostId: 'zcode',
        resolveProject: ctx.resolveProject,
        now: () => FIXED_NOW,
      })
      expect(again.linesConsumed).toBe(0)
      expect(again.events).toBe(0)
      expect(rec2.events).toEqual([])
    })
  })

  it('the part table reports its one undecodable row through the collector too', async () => {
    await withHost(async (host) => {
      const source: SourceSpec = sourceFor(host.dbPath, TABLE_PART)
      const ctx = normalizeCtx(host.dbPath, TABLE_PART)
      const rec = recorder()
      const result = await collectorScan(zcodeAdapter, source, {
        sink: rec.sink,
        saved: saved(0),
        agentId: 'zcode',
        hostId: 'zcode',
        resolveProject: ctx.resolveProject,
        now: () => FIXED_NOW,
      })
      expect(result.failures).toBe(1)
      expect(rec.failures[0]?.reason).toContain('json-parse')
      expect(result.nextOffset).toBe(21)
    })
  })

  it('a row delivered without its join columns degrades visibly', async () => {
    await withHost(async (host) => {
      // What a framing that skipped `parse`'s joins would carry: `data` alone.
      const result = await zcodeAdapter.normalize(
        { seq: 7, offset: 7, occurredAt: FIXED_NOW, value: { type: 'step-finish', tokens: { total: 10, input: 8, output: 2 } } },
        normalizeCtx(host.dbPath, TABLE_PART),
      )
      expect('events' in result).toBe(true)
      if ('events' in result) {
        const [event] = result.events
        expect(event?.type).toBe('unknown')
        expect(event?.metadata?.diagnostics).toContain('partial_row')
        expect(event?.metadata?.diagnostics).toContain('session_unresolved')
        expect(event?.sessionId).toBeTruthy()
        expect(event?.threadId ?? null).toBe(null)
      }
    })
  })
})
