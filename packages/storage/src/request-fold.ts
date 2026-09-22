/**
 * The materialised §3.1/§18 stage-1 fold (§19's "立方体在 343k 事件下的量级" direction):
 * one durable row per (agent, request), maintained by the write path.
 *
 * Reading this table instead of re-folding `events` is only sound while it says the same
 * thing `events` says, so every rule that keeps it true lives HERE, next to the one SQL
 * statement that produces the rows:
 *
 *  - **One fold, three consumers.** `foldStatement()` is the only place that turns events
 *    into request rows: the upgrade backfill, the per-batch incremental merge and the
 *    authoritative recompute all call it with a different agent/key narrowing. A second
 *    implementation is the §14 failure this repo already guards against elsewhere.
 *  - **Merge vs recompute (§4.2).** Appending a member to a group is a running MAX, so it
 *    merges. CHANGING or DELETING a member can lower that MAX, so it must be a DELETE plus a
 *    re-read of the whole group. `insertEvents` therefore splits the keys a batch touches into
 *    "merged" (each newly written event's group) and "recomputed" (each group an existing row
 *    belonged to before a §5.3 repair moved it, and each group `prune` takes members from),
 *    and a byte-identical replay produces NEITHER: the repair guard's `changes()` stays 0, so
 *    this module writes nothing and the table is a no-op under replay like the rest of the
 *    store.
 *  - **The grouping is part of the data (§18 row 2).** Rows are keyed by whichever column the
 *    agent's persisted policy names (`requestKeySql`, shared with the cube), and
 *    `requests_state` records the policy fingerprint they were folded under. A reader holding
 *    a different map declines the fast path; a scan that actually moves a policy re-folds
 *    everything through `rebuildRequestFoldIfPolicyMoved`.
 *  - **The window certificate.** `member_count`/`ts_count`/`min_ts`/`max_ts` let the reader
 *    prove a group lies wholly inside a timestamp window, which is what makes filtering the
 *    materialised row identical to filtering its events. Straddling groups are not special
 *    cased: a query whose window cuts one keeps folding live.
 *  - **Nothing is counted twice.** `SUM(member_count)` equals `COUNT(*) FROM events`, and the
 *    reader checks that equality before trusting the table, so a store written around this
 *    module degrades to today's fold instead of answering from a stale one.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_FOLD_MODE,
  REQUEST_FOLD_DIM_COLUMNS,
  REQUEST_FOLD_TOKEN_SOURCE,
  REQUEST_FOLD_VALUE_COLUMNS,
  assertAggregationMode,
  fingerprintFromModes,
  requestKeySql,
  type AggregationMode,
} from '@agentlens/event-model'

/** Columns of `requests`, in insert order: key, folded values, window certificate, dims. */
const FOLD_COLUMNS: readonly string[] = [
  'agent_key',
  'req_key',
  'rep_id',
  ...REQUEST_FOLD_VALUE_COLUMNS,
  'member_count',
  'ts_count',
  'min_ts',
  'max_ts',
  ...REQUEST_FOLD_DIM_COLUMNS,
]

const TOKEN_BUCKETS = REQUEST_FOLD_VALUE_COLUMNS.filter((c) => c in REQUEST_FOLD_TOKEN_SOURCE)

/** Bound-parameter chunk: far under SQLite's variable limit, wide enough to batch a scan. */
/**
 * Keys per fold statement. The per-statement cost is dominated by re-preparing the fold and by
 * the representative-row join, so a wide chunk amortises it: the cold-ingest arm of
 * `docs/research/probe-request-fold.mjs` measured ~2x the insert cost at 400 and no measurable
 * gap at 4000 on a 40k-event sample. Still far under SQLite's variable limit — a `request_max`
 * chunk binds the key list three times.
 */
const KEY_CHUNK = 4000

export interface RequestFoldState {
  policyFingerprint: string
  builtAt: number
  rebuiltAt: number | null
}

function rowsOf(db: DatabaseSync, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  const out = params.length ? stmt.all(...(params as never[])) : stmt.all()
  return (out as Record<string, unknown>[]).map((r) => ({ ...r }))
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined
  return row === undefined ? 0 : Number(Object.values(row)[0] ?? 0)
}

/** False on a database that has not been migrated to 008 yet — every entry point no-ops. */
export function hasRequestFoldTable(db: DatabaseSync): boolean {
  return tableExists(db, 'requests')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

export function requestFoldState(db: DatabaseSync): RequestFoldState | null {
  if (!tableExists(db, 'requests_state')) return null
  const row = db.prepare('SELECT * FROM main.requests_state WHERE slot = 0').get() as Record<string, unknown> | undefined
  if (!row) return null
  const r = { ...row }
  return {
    policyFingerprint: String(r.policy_fingerprint ?? ''),
    builtAt: Number(r.built_at ?? 0),
    rebuiltAt: r.rebuilt_at === null || r.rebuilt_at === undefined ? null : Number(r.rebuilt_at),
  }
}

/** Modes as stored (§18: the persisted policy is the one that folds stored rows). */
function modesByAgent(db: DatabaseSync): Map<string, AggregationMode> {
  const map = new Map<string, AggregationMode>()
  for (const r of rowsOf(db, 'SELECT id, aggregation_mode FROM agents WHERE aggregation_mode IS NOT NULL')) {
    map.set(String(r.id), assertAggregationMode(String(r.aggregation_mode)))
  }
  return map
}

function modeFor(modes: Map<string, AggregationMode>, agent: string | null): AggregationMode {
  return agent === null ? DEFAULT_FOLD_MODE : modes.get(agent) ?? DEFAULT_FOLD_MODE
}

/** The fingerprint of the grouping the table currently holds. */
export function requestFoldFingerprint(db: DatabaseSync): string {
  const modes: Record<string, string> = {}
  for (const [id, mode] of modesByAgent(db)) modes[id] = mode
  return fingerprintFromModes(modes)
}

export interface FoldScope {
  /** `null` means the partition whose events carry no `agent_id`. */
  agent: string | null
  /** The grouping rule this agent's rows fold under (§18 row 2). */
  mode: AggregationMode
  /** Groups to (re)read, or `null` for every group of this agent. */
  keys: readonly string[] | null
}

/**
 * The ONE statement shape that folds events into request rows.
 *
 * The key predicate is written so the planner keeps both access paths it has:
 * `idx_events_request` for a request-keyed group, the primary key for an event-keyed one. The
 * OUTER `req_key IN (…)` is what makes a narrowing exact — an event whose id happens to sit in
 * the chunk while it keys on some other request must not contribute a half-seen group to a row
 * nobody asked about.
 */
function foldStatement(scope: FoldScope, conflictSql: string): { sql: string; params: unknown[] } {
  const mode = scope.mode
  const tokenMaxes = TOKEN_BUCKETS.map(
    (c) => `MAX(COALESCE(e.${REQUEST_FOLD_TOKEN_SOURCE[c]}, 0)) AS ${c}`,
  ).join(', ')
  const params: unknown[] = []
  const predicates: string[] = []
  if (scope.agent === null) predicates.push('e.agent_id IS NULL')
  else {
    predicates.push('e.agent_id = ?')
    params.push(scope.agent)
  }
  if (scope.keys) {
    const ph = scope.keys.map(() => '?').join(', ')
    if (mode === 'request_max') {
      predicates.push(`(e.request_id IN (${ph}) OR e.id IN (${ph}))`)
      params.push(...scope.keys, ...scope.keys)
    } else {
      predicates.push(`e.id IN (${ph})`)
      params.push(...scope.keys)
    }
  }
  const outer = scope.keys ? `WHERE r.req_key IN (${scope.keys.map(() => '?').join(', ')})` : ''
  if (scope.keys) params.push(...scope.keys)
  const valCols = [...REQUEST_FOLD_VALUE_COLUMNS, 'member_count', 'ts_count', 'min_ts', 'max_ts']
  const repCols = REQUEST_FOLD_DIM_COLUMNS.map((c) => `rep.${c}`)
  return {
    sql: `INSERT INTO main.requests (${FOLD_COLUMNS.join(', ')})
      SELECT ${['r.agent_key', 'r.req_key', 'r.rep_id', ...valCols, ...repCols].join(', ')}
      FROM (
        SELECT COALESCE(e.agent_id, '') AS agent_key,
        ${requestKeySql('e', mode)} AS req_key,
        MAX(e.id) AS rep_id,
        ${tokenMaxes},
        MAX(COALESCE(e.duration_ms, 0)) AS duration,
        MAX(e.cost_reported) AS rep_cost,
        COUNT(*) AS member_count,
        COUNT(e.timestamp) AS ts_count,
        MIN(e.timestamp) AS min_ts,
        MAX(e.timestamp) AS max_ts
        FROM main.events e
        WHERE ${predicates.join(' AND ')}
        GROUP BY agent_key, req_key
      ) r
      JOIN main.events rep ON rep.id = r.rep_id
      ${outer}
      ${conflictSql}`,
    params,
  }
}

/**
 * The group is RE-RUN, not merged: the statement below always folds every event that carries
 * the key, so its output is already the complete group. That is what makes the write path
 * idempotent and order-free without a running-MAX arithmetic that cannot express "a member
 * left" — `member_count` is a count, not a MAX, and adding it twice was the first bug this
 * table's tests caught.
 *
 * No `ON CONFLICT` clause: the caller deletes the keys first (see `maintainRequestFold`), and
 * a collision would then be a logic error worth hearing about rather than overwriting.
 */
function run(db: DatabaseSync, sql: string, params: unknown[]): void {
  const stmt = db.prepare(sql)
  if (params.length) stmt.run(...(params as never[]))
  else stmt.run()
}

/** Fold one scope (agent × optional key list) into the table. Keys must already be deleted. */
function fold(db: DatabaseSync, scope: FoldScope): void {
  const { sql, params } = foldStatement(scope, '')
  run(db, sql, params)
}

function deleteGroups(db: DatabaseSync, agentKey: string, keys: readonly string[]): void {
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK)
    const ph = chunk.map(() => '?').join(', ')
    db.prepare(`DELETE FROM main.requests WHERE agent_key = ? AND req_key IN (${ph})`).run(
      agentKey,
      ...(chunk as never[]),
    )
  }
}

/** Every agent that currently owns events; `null` is the partition with no `agent_id`. */
function agentsWithEvents(db: DatabaseSync): (string | null)[] {
  return rowsOf(db, 'SELECT DISTINCT agent_id FROM events').map((r) =>
    r.agent_id === null || r.agent_id === undefined ? null : String(r.agent_id),
  )
}

/** Drop and re-fold the whole table: the upgrade path, and the answer to a moved policy. */
export function rebuildRequestFold(db: DatabaseSync, now = Date.now()): number {
  if (!hasRequestFoldTable(db)) return 0
  const modes = modesByAgent(db)
  db.exec('DELETE FROM main.requests')
  // The `agent_id IS NULL` partition is folded too: on a store without such rows it writes
  // nothing, and it is the only way a `NULL` agent can be represented at all.
  const agents: (string | null)[] = [...new Set<string | null>([...agentsWithEvents(db), null])]
  for (const agent of agents) {
    fold(db, { agent, mode: modeFor(modes, agent), keys: null })
  }
  db.prepare(
    `INSERT INTO main.requests_state (slot, policy_fingerprint, built_at, rebuilt_at)
     VALUES (0, ?, ?, ?)
     ON CONFLICT(slot) DO UPDATE SET
       policy_fingerprint = excluded.policy_fingerprint,
       rebuilt_at = excluded.rebuilt_at`,
  ).run(requestFoldFingerprint(db), now, now)
  return count(db, 'SELECT COUNT(*) FROM main.requests')
}

/**
 * Populate the table when migration 008 lands, so upgrading a store does not ask anybody to
 * re-scan their logs (§6). Idempotent: the sentinel row proves the fold ran over the events
 * that exist, and its absence is the only case that costs work.
 */
export function backfillRequestFold(db: DatabaseSync, now = Date.now()): number {
  if (!hasRequestFoldTable(db) || requestFoldState(db)) return 0
  return rebuildRequestFold(db, now)
}

/** True when the table accounts for exactly the rows `events` holds. */
export function requestFoldIsConsistent(db: DatabaseSync): boolean {
  if (!hasRequestFoldTable(db) || !requestFoldState(db)) return false
  return (
    count(db, 'SELECT COUNT(*) FROM main.events') ===
    count(db, 'SELECT COALESCE(SUM(member_count), 0) FROM main.requests')
  )
}

/** The groups a batch touched, by `agent_key` (`''` for a NULL agent). */
export type TouchedGroups = Map<string, Set<string>>

export function emptyTouchedGroups(): TouchedGroups {
  return new Map()
}

/** Record that one group's answer has to be re-derived from `events`. */
export function markGroup(touched: TouchedGroups, agentKey: string, reqKey: string): void {
  const set = touched.get(agentKey)
  if (set) set.add(reqKey)
  else touched.set(agentKey, new Set([reqKey]))
}

/**
 * The request key of one row, per the policy that folds its agent (§18 row 2). Exported so
 * the write path and `prune` derive the same key from the same inputs.
 */
export function requestGroupKey(mode: AggregationMode, event: { id: string; requestId?: string | null }): string {
  return mode === 'request_max' ? event.requestId || event.id : event.id
}

/** Policy of one agent as stored; the default when it has declared nothing. */
export function storedAggregationMode(db: DatabaseSync, agent: string | null): AggregationMode {
  return modeFor(modesByAgent(db), agent)
}

/**
 * One read of `agents`, then a lookup: a batch asks the question per row, and re-querying the
 * table each time would cost more than the fold it is deciding.
 */
export function aggregationModeLookup(db: DatabaseSync): (agent: string | null | undefined) => AggregationMode {
  const modes = modesByAgent(db)
  return (agent) => modeFor(modes, agent ?? null)
}

/**
 * Keep the materialised fold in step with a batch that was just written; called inside
 * `insertEvents`' transaction, after the event rows and the session tallies land.
 *
 * Every touched key is deleted and re-folded from `events`, which is the one operation that
 * is correct for all three ways a batch can change a group: an added member raises it, a
 * repaired member can lower it, and a member that moved to another group can empty the one it
 * left (an empty group must have NO row, which a merge could not express). A replay that
 * changed nothing produces no touched keys at all, so §4.2's no-op holds here too.
 */
export function maintainRequestFold(db: DatabaseSync, touched: TouchedGroups): void {
  if (!hasRequestFoldTable(db)) return
  if (touched.size === 0) return
  if (!requestFoldState(db)) {
    // No sentinel: the store predates the fold or its upgrade was interrupted mid-way.
    // Re-folding everything is the one moment it is cheap to notice.
    rebuildRequestFold(db)
    return
  }
  for (const [agentKey, keys] of touched) {
    deleteGroups(db, agentKey, [...keys])
    refoldKeys(db, agentKey, keys)
  }
}

function refoldKeys(db: DatabaseSync, agentKey: string, keys: Iterable<string>): void {
  const agent = agentKey === '' ? null : agentKey
  const mode = storedAggregationMode(db, agent)
  const list = [...keys]
  for (let i = 0; i < list.length; i += KEY_CHUNK) {
    fold(db, { agent, mode, keys: list.slice(i, i + KEY_CHUNK) })
  }
}

/**
 * §6 prune: events are going away, so their groups must be re-read rather than merged — the
 * group's MAX can fall, and a group that loses every member must lose its row. Call this
 * BEFORE the delete (the keys come from the rows that are still there) and
 * `repairRequestFoldAfterPrune` after it, inside the same transaction.
 */
export function requestFoldKeysForCutoff(db: DatabaseSync, eventCutoff: number): { agentKey: string; keys: string[] }[] {
  if (!hasRequestFoldTable(db)) return []
  const modes = modesByAgent(db)
  const out: { agentKey: string; keys: string[] }[] = []
  for (const agent of agentsWithEvents(db)) {
    const mode = modeFor(modes, agent)
    const rows = rowsOf(
      db,
      `SELECT DISTINCT ${requestKeySql('e', mode)} AS k FROM main.events e WHERE ${
        agent === null ? 'e.agent_id IS NULL' : 'e.agent_id = ?'
      } AND e.timestamp < ?`,
      ...(agent === null ? ([eventCutoff] as unknown[]) : ([agent, eventCutoff] as unknown[])),
    )
    if (rows.length) out.push({ agentKey: agent ?? '', keys: rows.map((r) => String(r.k)) })
  }
  return out
}

/** Re-fold the groups `prune` took members from: rows shrink, empty groups disappear. */
export function repairRequestFoldAfterPrune(
  db: DatabaseSync,
  groups: { agentKey: string; keys: readonly string[] }[],
): void {
  if (!hasRequestFoldTable(db)) return
  for (const g of groups) {
    deleteGroups(db, g.agentKey, g.keys)
    refoldKeys(db, g.agentKey, g.keys)
  }
  // A group whose members are all gone folds to nothing, so the DELETE above is what removes
  // it; sweep any row whose representative event is gone too, which is the shape an
  // out-of-band delete leaves behind and the reason `doctor` can report drift.
  run(db, 'DELETE FROM main.requests WHERE rep_id IS NULL OR NOT EXISTS (SELECT 1 FROM main.events e WHERE e.id = main.requests.rep_id)', [])
}

/**
 * `setAgentAggregations` calls this when a scan persists a different fold for an agent: the
 * rows in `requests` were grouped under the old rule, so they are re-folded here instead of
 * silently answering from the wrong grain. A policy move is a §5.3-scale event, and this is
 * the drift path doing the work rather than a new command.
 */
export function rebuildRequestFoldIfPolicyMoved(db: DatabaseSync, now = Date.now()): number | null {
  const state = requestFoldState(db)
  if (!state || !hasRequestFoldTable(db)) return null
  if (state.policyFingerprint === requestFoldFingerprint(db)) return null
  return rebuildRequestFold(db, now)
}

/** Rows in the table; for diagnostics and the scan summary line. */
export function requestFoldRowCount(db: DatabaseSync): number {
  if (!hasRequestFoldTable(db)) return 0
  return count(db, 'SELECT COUNT(*) FROM main.requests')
}
