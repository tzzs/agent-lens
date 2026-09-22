/**
 * §19's materialised stage 1 — the write path's half of the promise.
 *
 * The cube may answer from `requests` instead of folding `events` only while the table says
 * what `events` says. `packages/storage/test/idempotency.test.ts` already proves the append
 * half (the whole-DB snapshot in `helpers.ts` now includes `requests`, so every replay
 * assertion in this directory asserts the derived table too), so this file covers the three
 * things that are NOT appends and can break it: the §5.3 repair that moves a row's derived
 * columns, §6's prune that deletes rows, and a policy that moves under stored data (§18 row 2).
 *
 * Timestamps hang off `Date.now()` because §6's prune cuts on it.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_AGGREGATION,
  SCHEMA_VERSION,
  type AgentEvent,
  type AggregationPolicy,
} from '@agentlens/event-model'
import {
  backfillRequestFold,
  insertEvents,
  loadAgentAggregations,
  migrate,
  openDatabase,
  prune,
  rebuildRequestFoldIfPolicyMoved,
  requestFoldFingerprint,
  requestFoldIsConsistent,
  requestFoldKeysForCutoff,
  requestFoldRowCount,
  requestFoldState,
  repairRequestFoldAfterPrune,
  setAgentAggregations,
} from '../src/index.ts'
import { query, resetFoldPasses, foldPasses } from '@agentlens/query'

const DAY = 86_400_000
const NOW = Date.now()

const POLICIES: Record<string, AggregationPolicy> = {
  'claude-code': { mode: 'request_max', subagentsIncluded: true },
  codex: { mode: 'per_record_sum', subagentsIncluded: false },
}

/** One API response split over content blocks: §3.1's duplicate-usage shape. */
function blocks(
  agentId: string,
  requestId: string,
  startTs: number,
  seed: string,
  count = 3,
): AgentEvent[] {
  return Array.from({ length: count }, (_, b) => ({
    id: `${seed}-b${b}`,
    schemaVersion: SCHEMA_VERSION,
    agentId,
    hostId: agentId,
    sourceId: `src-${agentId}`,
    sessionId: `sess-${agentId}`,
    projectId: `proj-${agentId}`,
    requestId,
    timestamp: startTs + b,
    ingestedAt: NOW,
    type: 'generation.end' as const,
    model: { provider: 'anthropic', name: 'test-model' },
    usage: { inputTokens: 100 + b, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 0 },
    usageSource: 'reported' as const,
    status: 'ok' as const,
    durationMs: 500 + b,
    rawSeq: b + 1,
    rawOffset: b * 100,
  }))
}

function fixture(): AgentEvent[] {
  return [
    ...blocks('claude-code', 'req-a', NOW - 10 * DAY, 'cc'),
    ...blocks('claude-code', 'req-b', NOW - DAY, 'cc2'),
    // Codex counts every per-call row; collapsing these would be the §18 row 2 bug.
    ...blocks('codex', 'cx-1', NOW - DAY, 'cx1', 1),
    ...blocks('codex', 'cx-2', NOW - 2 * DAY, 'cx2', 1),
    // A usage-less row in req-a: the group's MAX must not be dragged around by NULLs.
    {
      ...blocks('claude-code', 'req-a', NOW - 10 * DAY, 'plain', 1)[0]!,
      id: 'plain-1',
      type: 'tool.start' as const,
      usage: undefined,
      usageSource: 'missing' as const,
      durationMs: 12,
      capability: { type: 'tool' as const, name: 'Bash', provider: null },
      costReported: null,
    },
  ]
}

function store(events: AgentEvent[], policies = POLICIES): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  setAgentAggregations(db, policies)
  insertEvents(db, events)
  return db
}

const select = (db: DatabaseSync, sql: string): Record<string, unknown>[] =>
  (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r }))
const dump = (db: DatabaseSync): string =>
  JSON.stringify(select(db, 'SELECT * FROM requests ORDER BY agent_key, req_key'))
const group = (db: DatabaseSync, reqKey: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM requests WHERE req_key = ?').get(reqKey) as Record<string, unknown>
const n = (v: unknown): number => Number(v)

describe('materialised stage 1 (§19)', () => {
  it('folds one row per request per agent and accounts for every event once', () => {
    const db = store(fixture())
    const rows = select(db, 'SELECT agent_key, req_key, member_count, tokens_input FROM requests ORDER BY agent_key, req_key')
    // claude-code: 2 requests (three duplicated blocks + the usage-less row in req-a);
    // codex: one row PER EVENT. Four groups, from six events.
    expect(rows.map((r) => `${r.agent_key}/${r.req_key}`)).toEqual([
      'claude-code/req-a',
      'claude-code/req-b',
      'codex/cx1-b0',
      'codex/cx2-b0',
    ])
    expect(n(rows[0]!.member_count)).toBe(4)
    expect(n(rows[0]!.tokens_input)).toBe(102) // MAX per request, never a SUM (§3.1)
    expect(n(rows[2]!.tokens_input)).toBe(100) // per-record: its own row, counted once
    expect(requestFoldIsConsistent(db)).toBe(true)
    expect(requestFoldRowCount(db)).toBe(4)
  })

  it('backfills an existing store during the upgrade, with no rescan (§6)', () => {
    const db = store(fixture())
    const before = dump(db)
    // Become, faithfully, a store that has not seen 007 yet.
    db.exec("DELETE FROM schema_migrations WHERE id = '008_persisted_request_fold.sql'")
    db.exec('DROP TABLE requests')
    db.exec('DROP TABLE requests_state')
    expect(requestFoldState(db)).toBeNull()

    expect(migrate(db)).toEqual(['008_persisted_request_fold.sql'])
    expect(requestFoldIsConsistent(db)).toBe(true)
    expect(requestFoldState(db)?.policyFingerprint).toBe(requestFoldFingerprint(db))
    // Re-folded from the rows already on disk: identical to what the write path built.
    expect(dump(db)).toBe(before)
  })

  it('a second migrate() re-folds nothing, and an explicit backfill is a no-op', () => {
    const db = store(fixture())
    const before = dump(db)
    expect(migrate(db)).toEqual([])
    expect(backfillRequestFold(db)).toBe(0)
    expect(dump(db)).toBe(before)
  })

  it('a replay writes zero rows and leaves the table byte-identical (§4.2)', () => {
    const db = store(fixture())
    const before = dump(db)
    const beforeRows = requestFoldRowCount(db)
    expect(insertEvents(db, fixture()).inserted).toBe(0)
    expect(dump(db)).toBe(before)
    expect(requestFoldRowCount(db)).toBe(beforeRows)
    expect(requestFoldIsConsistent(db)).toBe(true)
  })

  /**
   * The case a real scan produces and a single batch cannot: a response's content blocks
   * arriving in SEPARATE batches (a watch tick that sees two of three lines, then the third).
   * Each batch merges into the group, so a wrong merge is a number that is quietly high or
   * low, and it is invisible to a test that inserts the whole batch at once.
   */
  it('a group that arrives across batches lands the same answer as one batch', () => {
    const all = fixture()
    const once = store(all)
    const cols = 'agent_key, req_key, tokens_input, tokens_output, duration, member_count, ts_count, min_ts, max_ts, rep_id, session_id, project_id'
    for (const order of [all, [...all].reverse()]) {
      const piecewise = openDatabase(':memory:')
      migrate(piecewise)
      setAgentAggregations(piecewise, POLICIES)
      for (const ev of order) insertEvents(piecewise, [ev])
      expect(dumpCols(piecewise, cols)).toBe(dumpCols(once, cols))
      insertEvents(piecewise, order) // and the replay on top of it is still the same table
      expect(dumpCols(piecewise, cols)).toBe(dumpCols(once, cols))
      expect(requestFoldIsConsistent(piecewise)).toBe(true)
    }
  })

  it('arrival order cannot change a group: reversed batches converge', () => {
    const policies = { 'claude-code': DEFAULT_AGGREGATION }
    const events = fixture().filter((e) => e.agentId === 'claude-code')
    const a = store(events, policies)
    const b = store([...events].reverse(), policies)
    insertEvents(b, [...events].reverse())
    const cols = 'agent_key, req_key, tokens_input, tokens_output, duration, rep_cost, member_count, min_ts, max_ts, rep_id'
    expect(dumpCols(b, cols)).toBe(dumpCols(a, cols))
  })

  /**
   * §5.3: a parser_version bump replays a source from offset 0 and the replayed rows can
   * carry DIFFERENT derived columns — which is exactly the case a running MAX cannot survive,
   * since the tallest row may leave. The write path routes every row that was already present
   * through delete-and-refold; these are the assertions that routing buys.
   */
  it('a repair that moves a row between groups re-reads both, so a MAX can fall', () => {
    const db = store(fixture())
    expect(n(group(db, 'req-a').tokens_input)).toBe(102)
    expect(n(group(db, 'req-a').member_count)).toBe(4)

    const repaired = fixture().map((e) =>
      e.id === 'cc-b2'
        ? { ...e, requestId: 'req-z', projectId: 'proj-moved', parentEventId: 'plain-1', timestamp: e.timestamp + 3 * DAY }
        : e,
    )
    insertEvents(db, repaired)

    expect(n(group(db, 'req-a').member_count)).toBe(3) // the moved row left its old group
    expect(n(group(db, 'req-a').tokens_input)).toBe(101) // and the MAX fell with it
    const moved = group(db, 'req-z')
    expect(n(moved.tokens_input)).toBe(102)
    expect(String(moved.rep_id)).toBe('cc-b2')
    expect(String(moved.project_id)).toBe('proj-moved')
    expect(requestFoldIsConsistent(db)).toBe(true)
    expect(requestFoldRowCount(db)).toBe(5)
  })

  it('a repair that re-times or re-homes the representative row moves the dims with it', () => {
    const db = store(fixture())
    const before = group(db, 'req-b')
    expect(String(before.rep_id)).toBe('cc2-b2')
    expect(String(before.session_id)).toBe('sess-claude-code')
    // Re-ingest req-b with a new session and a window three days later.
    insertEvents(db, blocks('claude-code', 'req-b', NOW + 2 * DAY, 'cc2').map((e) => ({ ...e, sessionId: 'sess-moved' })))
    const after = group(db, 'req-b')
    expect(String(after.rep_id)).toBe(String(before.rep_id)) // MAX(id) is still b2
    expect(String(after.session_id)).toBe('sess-moved')
    expect(n(after.min_ts)).toBe(NOW + 2 * DAY)
    expect(n(after.max_ts)).toBe(NOW + 2 * DAY + 2)
    expect(requestFoldIsConsistent(db)).toBe(true)
  })

  it('prune drops a group whose members all go, and keeps no phantom row (§6)', () => {
    const db = store(fixture())
    expect(requestFoldRowCount(db)).toBe(4)
    const res = prune(db, { olderThanDays: 5 }) // req-a's four rows are 10 days old; nothing else is
    expect(res.eventsDeleted).toBe(4)

    expect(select(db, 'SELECT req_key FROM requests ORDER BY req_key').map((r) => String(r.req_key))).toEqual([
      'cx1-b0',
      'cx2-b0',
      'req-b',
    ])
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = requests.rep_id)')
      .get() as { n: number }
    expect(orphans.n).toBe(0)
    expect(requestFoldIsConsistent(db)).toBe(true)
  })

  it('prune of a partial group lowers the MAX instead of dropping the row', () => {
    // One request whose TALLEST block is old enough to be pruned.
    const straddling: AgentEvent[] = [
      ...blocks('claude-code', 'req-x', NOW - 40 * DAY, 'old', 1), // input 100
      // Taller, but young: pruning the old row must not take the group with it.
      ...blocks('claude-code', 'req-x', NOW - 5 * DAY, 'new', 2).map((e, i) => ({
        ...e,
        usage: { inputTokens: 900, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      })),
    ]
    const db = store(straddling)
    expect(n(group(db, 'req-x').tokens_input)).toBe(900)
    prune(db, { olderThanDays: 30 })
    const after = group(db, 'req-x')
    expect(n(after.member_count)).toBe(2) // the group survived its own member
    expect(String(after.rep_id)).toBe('new-b1')
    expect(requestFoldIsConsistent(db)).toBe(true)
    // And the same re-fold is what `prune` drives, called out to pin the helper's contract.
    // The helper pair `prune` drives is idempotent on its own: re-collecting the keys of what
    // is already gone re-folds the same answer.
    repairRequestFoldAfterPrune(db, requestFoldKeysForCutoff(db, NOW - 30 * DAY))
    expect(n(group(db, 'req-x').member_count)).toBe(2)
    expect(requestFoldIsConsistent(db)).toBe(true)
  })

  it('a policy that moves re-folds the table, because the stored grouping is data (§18 row 2)', () => {
    const db = store(fixture())
    expect(requestFoldState(db)?.policyFingerprint).toBe('codex=per_record_sum')
    expect(select(db, "SELECT req_key FROM requests WHERE agent_key = 'codex'").map((r) => String(r.req_key))).toEqual([
      'cx1-b0',
      'cx2-b0',
    ])

    setAgentAggregations(db, { codex: { mode: 'request_max', subagentsIncluded: false } })
    expect(requestFoldState(db)?.policyFingerprint).toBe('')
    // Codex's two per-call rows are now grouped by their request ids.
    expect(select(db, "SELECT req_key FROM requests WHERE agent_key = 'codex'").map((r) => String(r.req_key))).toEqual([
      'cx-1',
      'cx-2',
    ])
    expect(requestFoldIsConsistent(db)).toBe(true)
    // Re-writing the same policies is not a policy move.
    expect(rebuildRequestFoldIfPolicyMoved(db)).toBeNull()
    const stamp = requestFoldState(db)?.rebuiltAt
    setAgentAggregations(db, { codex: { mode: 'request_max', subagentsIncluded: false } })
    expect(requestFoldState(db)?.rebuiltAt).toBe(stamp)
  })

  it('a reader whose policy map disagrees with the table declines instead of guessing', () => {
    const db = store(fixture())
    const spec = { metrics: ['tokens_total'], dims: ['agent'] }
    resetFoldPasses()
    query(db as never, spec as never, { aggregation: loadAgentAggregations(db) })
    expect(foldPasses().persisted).toBe(1)
    expect(foldPasses().inline).toBe(0)

    resetFoldPasses()
    query(db as never, spec as never, { aggregation: { codex: { mode: 'request_max', subagentsIncluded: false } } })
    expect(foldPasses().persisted).toBe(0)
    expect(foldPasses().inline, 'declined: it folded live instead').toBeGreaterThan(0)
  })
})

function dumpCols(db: DatabaseSync, cols: string): string {
  return JSON.stringify(select(db, `SELECT ${cols} FROM requests ORDER BY agent_key, req_key`))
}
