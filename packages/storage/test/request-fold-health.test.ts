/**
 * §11's read of §19's materialised stage 1: what `agl doctor` and `GET /api/doctor` print when
 * the durable fold stops describing `events`.
 *
 * The cube declines a fold it cannot trust, so a red verdict here costs speed rather than
 * correctness — which is exactly why the check has to exist: the decline is silent on every
 * other surface. The last test is the load-bearing one: it asserts the doctor's verdict and the
 * reader's behaviour are the same fact measured twice, not two rules that happen to agree today.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, type AgentEvent } from '@agentlens/event-model'
import {
  insertEvents,
  loadAgentAggregations,
  migrate,
  openDatabase,
  requestFoldHealth,
  requestFoldSentence,
  setAgentAggregations,
} from '../src/index.ts'
import { foldPasses, query, resetFoldPasses } from '@agentlens/query'

const NOW = Date.now()

/** Two requests of two duplicated blocks, plus one per-call Codex row: five events, three groups. */
function fixture(): AgentEvent[] {
  const mk = (agentId: string, requestId: string, id: string, ts: number): AgentEvent => ({
    id,
    schemaVersion: SCHEMA_VERSION,
    agentId,
    hostId: agentId,
    sourceId: `src-${agentId}`,
    sessionId: `sess-${agentId}`,
    projectId: `proj-${agentId}`,
    requestId,
    timestamp: ts,
    ingestedAt: NOW,
    type: 'generation.end',
    model: { provider: 'anthropic', name: 'test-model' },
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    usageSource: 'reported',
    status: 'ok',
    durationMs: 500,
    rawSeq: 1,
    rawOffset: 100,
  })
  return [
    mk('claude-code', 'req-a', 'a1', NOW - 4000),
    mk('claude-code', 'req-a', 'a2', NOW - 3000),
    mk('claude-code', 'req-b', 'b1', NOW - 2000),
    mk('claude-code', 'req-b', 'b2', NOW - 1500),
    mk('codex', 'cx-1', 'cx1', NOW - 1000),
  ]
}

function store(): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  setAgentAggregations(db, {
    'claude-code': { mode: 'request_max', subagentsIncluded: true },
    codex: { mode: 'per_record_sum', subagentsIncluded: false },
  })
  insertEvents(db, fixture())
  return db
}

/** One cube call that would use the fast path, and whether it actually did. */
function servedFromTheTable(db: DatabaseSync): boolean {
  resetFoldPasses()
  query(
    db as never,
    { metrics: ['tokens_total'], dims: ['agent'] } as never,
    { aggregation: loadAgentAggregations(db) } as never,
  )
  const p = foldPasses()
  return p.persisted > 0 && p.inline === 0
}

describe('§11 doctor: the materialised stage 1 describes `events`', () => {
  it('a maintained store reads healthy, with the counts in the sentence', () => {
    const h = requestFoldHealth(store())
    expect(h).toEqual({ present: true, rows: 3, members: 5, events: 5, policyMatches: true })
    const v = requestFoldSentence(h)
    expect(v.ok).toBe(true)
    expect(v.text).toContain('3 request rows over 5 events')
  })

  it('digits are grouped by the owner, so the terminal and the page print one string', () => {
    const v = requestFoldSentence({ present: true, rows: 1234567, members: 7654321, events: 7654321, policyMatches: true })
    expect(v.text).toBe('stage 1 materialised: 1,234,567 request rows over 7,654,321 events')
  })

  it('events removed around the fold surface as drift, and the reader declines in the same breath', () => {
    const db = store()
    // Not `prune`: that path repairs the fold, which `request-fold.test.ts` covers. This is the
    // out-of-band delete the table has no foreign key against.
    db.prepare("DELETE FROM events WHERE id IN ('a1','a2')").run()
    const h = requestFoldHealth(db)
    expect({ members: h.members, events: h.events }).toEqual({ members: 5, events: 3 })
    const v = requestFoldSentence(h)
    expect(v.ok).toBe(false)
    expect(v.text).toContain('accounts for 5 of 3 events')
    // The verdict and the behaviour are one fact: a store the doctor warns about is a store the
    // cube refuses to serve from the table.
    expect(servedFromTheTable(db)).toBe(false)
  })

  it('a grouping that no longer matches the stored policies warns, and the reader declines', () => {
    const db = store()
    expect(servedFromTheTable(db)).toBe(true)
    // `setAgentAggregations` re-folds (the §18 row 2 path); a policy that moved without a scan —
    // a restored `agents` row, an edited config — is the case the fingerprint check has to catch.
    db.prepare("UPDATE agents SET aggregation_mode = 'request_max' WHERE id = 'codex'").run()
    const h = requestFoldHealth(db)
    expect({ present: h.present, members: h.members, events: h.events, policyMatches: h.policyMatches }).toEqual({
      present: true,
      members: 5,
      events: 5,
      policyMatches: false,
    })
    const v = requestFoldSentence(h)
    expect(v.ok).toBe(false)
    expect(v.text).toContain('different §18 grouping')
    expect(servedFromTheTable(db)).toBe(false)
  })

  it('a store without the table says so rather than reporting an empty fold as healthy', () => {
    const db = store()
    db.exec('DROP TABLE requests')
    const h = requestFoldHealth(db)
    expect({ present: h.present, rows: h.rows, members: h.members }).toEqual({ present: false, rows: 0, members: 0 })
    const v = requestFoldSentence(h)
    expect(v.ok).toBe(false)
    expect(v.text).toContain('no materialised stage 1')
    expect(servedFromTheTable(db)).toBe(false)
  })
})
