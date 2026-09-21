/**
 * §11 doctor checks that BOTH doctors share (§14: the CLI and the Web must not disagree).
 * Everything here is derived from synthetic rows in a temp DB — no real agent log is read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, Usage } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase, setAgentAggregations, updateSourceProgress } from '../src/index.ts'
import {
  parserVersionDrift,
  sourceRetention,
  subagentOrphans,
  timestampGuesses,
  usageQuality,
} from '../src/doctor-checks.ts'

const DIR = mkdtempSync(join(tmpdir(), 'agentlens-doctor-checks-'))
let db: DatabaseSync

function usage(input: number, output: number): Usage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function ev(over: Partial<AgentEvent> & { id: string; agentId: string }): AgentEvent {
  return {
    schemaVersion: 1,
    hostId: over.agentId,
    sourceId: `src-${over.agentId}`,
    sessionId: `sess-${over.agentId}`,
    projectId: 'proj-1',
    timestamp: 1_700_000_000_000,
    type: 'message.assistant',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

beforeAll(() => {
  db = openDatabase(join(DIR, 'test.db'))
  migrate(db)
  insertEvents(db, [
    // §3.1 shape: one request logged twice with the same usage — a fold must collapse it.
    ev({ id: 'a1', agentId: 'claude-code', requestId: 'r1', usage: usage(1000, 100) }),
    ev({ id: 'a2', agentId: 'claude-code', requestId: 'r1', usage: usage(1000, 100), rawSeq: 2 }),
    ev({ id: 'a3', agentId: 'claude-code', requestId: null, usage: usage(50, 5), usageSource: 'estimated', rawSeq: 3 }),
    ev({ id: 'a4', agentId: 'claude-code', usage: null, usageSource: 'missing', type: 'tool.start', rawSeq: 4 }),
    // §18 row 2 shape: per-call rows, so any request-style fold LOSES tokens.
    ev({ id: 'b1', agentId: 'codex', requestId: 'r9', usage: usage(200, 20), rawSeq: 1 }),
    ev({ id: 'b2', agentId: 'codex', requestId: 'r9', usage: usage(300, 30), rawSeq: 2 }),
    // No policy persisted for this agent: the default applies and the report says so.
    ev({ id: 'c1', agentId: 'legacy', requestId: 'r7', usage: usage(5, 5), rawSeq: 1 }),
    ev({ id: 'c2', agentId: 'legacy', requestId: 'r7', usage: usage(5, 5), rawSeq: 2 }),
    // §4.4 row 8: subagent links, one orphan per agent, plus a thread-marked row.
    ev({ id: 'a5', agentId: 'claude-code', type: 'subagent.start', usage: null, usageSource: 'missing', parentEventId: null, rawSeq: 5 }),
    ev({ id: 'a6', agentId: 'claude-code', type: 'subagent.end', usage: null, usageSource: 'missing', parentEventId: 'a5', rawSeq: 6 }),
    ev({ id: 'b3', agentId: 'codex', type: 'message.assistant', usage: null, usageSource: 'missing', parentEventId: null, metadata: { subagentThread: true }, rawSeq: 3 }),
  ])
  setAgentAggregations(db, {
    'claude-code': { mode: 'request_max', subagentsIncluded: true },
    codex: { mode: 'last_call_sum', subagentsIncluded: false },
  })
})

afterAll(() => {
  db.close()
  rmSync(DIR, { recursive: true, force: true })
})

const forAgent = (rows: ReturnType<typeof usageQuality>, id: string) => rows.find((r) => r.agentId === id)!

describe('usageQuality (§11 Usage quality, §18 row 2)', () => {
  const cubeTotals = [
    { agentId: 'claude-code', events: 6, tokensTotal: 1155 },
    { agentId: 'codex', events: 2, tokensTotal: 550 },
    { agentId: 'legacy', events: 2, tokensTotal: 10 },
  ]

  it('folds each agent under its own persisted policy, never a global rule', () => {
    const rows = usageQuality(db, cubeTotals)
    const claude = forAgent(rows, 'claude-code')
    expect(claude.policy).toEqual({ mode: 'request_max', subagentsIncluded: true })
    expect(claude.policySource).toBe('persisted')
    expect(claude.usageRows).toBe(3)
    // raw 1100 + 1100 (one request twice) + 55 → folded 1100 + 55.
    expect(claude.naive).toBe(2255)
    expect(claude.modelFolded).toBe(1155)
    expect(claude.groups).toBe(2)
    const codex = forAgent(rows, 'codex')
    expect(codex.policy.mode).toBe('last_call_sum')
    expect(codex.naive).toBe(550)
    expect(codex.modelFolded).toBe(550)
    // What a single global request_max would have printed for the same rows.
    expect(codex.globalFolded).toBe(330)
    const legacy = forAgent(rows, 'legacy')
    expect(legacy.policySource).toBe('default')
    expect(legacy.policy.mode).toBe('request_max')
    expect(legacy.naive).toBe(20)
    expect(legacy.modelFolded).toBe(10)
    expect(rows.map((r) => r.agentId)).toEqual(['claude-code', 'codex', 'legacy'])
  })

  it('takes the reported total from the caller\'s cube so a disagreement stays visible', () => {
    const rows = usageQuality(db, [{ agentId: 'codex', events: 2, tokensTotal: 999 }])
    const codex = forAgent(rows, 'codex')
    expect(codex.folded).toBe(999)
    expect(codex.modelFolded).toBe(550)
  })

  it('counts request_id-less rows, usage-source buckets, and the installed declaration separately', () => {
    const rows = usageQuality(
      db,
      cubeTotals,
      { 'claude-code': { mode: 'per_record_sum', subagentsIncluded: true }, codex: { mode: 'last_call_sum', subagentsIncluded: false } },
    )
    const claude = forAgent(rows, 'claude-code')
    expect(claude.reported).toBe(2)
    expect(claude.estimated).toBe(1)
    expect(claude.missing).toBe(3)
    expect(claude.noRequestId).toBe(4)
    expect(claude.noRequestIdWithUsage).toBe(1)
    expect(claude.events).toBe(6)
    // The stored rows say request_max; the adapter now claims per_record_sum. Both are reported.
    expect(claude.declared).toEqual({ mode: 'per_record_sum', subagentsIncluded: true })
    expect(forAgent(rows, 'codex').declared).toEqual({ mode: 'last_call_sum', subagentsIncluded: false })
    expect(forAgent(rows, 'legacy').declared).toBe(null)
  })
})

describe('parserVersionDrift (§5.3 drift signal)', () => {
  function progress(id: string, agentId: string, parserVersion: number | null, status: 'active' | 'gone' | 'error' | 'rotated') {
    updateSourceProgress(db, {
      id,
      agentId,
      path: join(DIR, `${id}.jsonl`),
      kind: 'jsonl',
      inode: 10 + Number(id.length),
      size: 10,
      mtimeMs: 1,
      lastOffset: 10,
      parserVersion,
      sessionIdHint: null,
      status,
      rowsIngested: 1,
      scanStartedAt: 0,
      scanFinishedAt: 1,
      lastError: null,
    })
  }

  beforeAll(() => {
    progress('p-cur-a', 'claude-code', 3, 'active')
    progress('p-cur-b', 'claude-code', 3, 'active')
    progress('p-stale', 'claude-code', 2, 'active')
    progress('p-other', 'codex', 1, 'active')
    progress('p-unscanned', 'legacy', null, 'gone')
    progress('p-rotated', 'legacy', 1, 'rotated')
  })

  it('names stale sources, skips never-scanned ones and admits unmapped agents', () => {
    const drift = parserVersionDrift(db, { 'claude-code': 3, codex: 1, legacy: 1 })
    expect(drift.checked).toBe(5)
    expect(drift.drifted).toBe(1)
    expect(drift.unmapped).toBe(0)
    // The never-scanned side also counts the FK placeholder rows `insertEvents` leaves behind.
    expect(drift.unscanned).toBe(4)
    expect(drift.stale).toEqual([{ agentId: 'claude-code', parserVersion: 2, sources: 1 }])
  })

  it('counts a source it cannot map as unknowable rather than as current', () => {
    const drift = parserVersionDrift(db, { codex: 1 })
    expect(drift.checked).toBe(1)
    expect(drift.drifted).toBe(0)
    expect(drift.unmapped).toBe(4)
  })
})

describe('subagentOrphans (§4.4 row 8)', () => {
  it('reports the orphan rate per agent over subagent-shaped rows', () => {
    const rows = subagentOrphans(db)
    expect(rows).toEqual([
      { agentId: 'claude-code', total: 2, orphan: 1 },
      { agentId: 'codex', total: 1, orphan: 1 },
    ])
  })
})

describe('sourceRetention (§4.4 row 4)', () => {
  it('separates sources the collector gave up on from those read to their end', () => {
    const r = sourceRetention(db)
    expect(r.gone).toBe(1)
    expect(r.rotated).toBe(1)
    // The 4 versioned sources plus the FK placeholders `insertEvents` leaves per agent.
    expect(r.active).toBe(7)
  })
})

describe('timestampGuesses (§5.2, §19)', () => {
  it('counts the events whose source stated no time, and keeps the scan-clock case apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-timestamp-guesses-'))
    const gdb = openDatabase(join(dir, 'guesses.db'))
    try {
      migrate(gdb)
      insertEvents(gdb, [
        ev({ id: 'g1', agentId: 'claude-code', metadata: { timestampGuess: 'ingest-clock' }, rawSeq: 1 }),
        ev({ id: 'g2', agentId: 'claude-code', metadata: { timestampGuess: 'file-mtime' }, rawSeq: 2 }),
        ev({ id: 'g3', agentId: 'claude-code', metadata: { subagentThread: true }, rawSeq: 3 }),
        ev({ id: 'g4', agentId: 'claude-code', rawSeq: 4 }),
        // An unrelated key must not count, and one agent's doubt must not leak into another's row.
        ev({ id: 'g5', agentId: 'codex', metadata: { timestampGuess: null }, rawSeq: 5 }),
        ev({ id: 'g6', agentId: 'codex', metadata: { other: 'ingest-clock' }, rawSeq: 6 }),
      ])
      expect(timestampGuesses(gdb)).toEqual([
        { agentId: 'claude-code', events: 4, guessed: 2, fromIngestClock: 1 },
      ])
    } finally {
      gdb.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says nothing about the shared report DB, where every row states its own time', () => {
    expect(timestampGuesses(db)).toEqual([])
  })
})
