/**
 * The §19 read path: answer stage 2 from the persisted stage-1 table instead of folding
 * `events` again.
 *
 * This module's whole job is the *eligibility* question, because the shortcut is only the same
 * answer when the filter cannot split a group. Stage 1 is `MAX(...) GROUP BY (agent, request)`
 * over the rows the filter selects, so a filter that keeps some but not all members of a
 * group changes that MAX — and reading a pre-folded row would then be a different question,
 * not a faster one. Three things have to hold:
 *
 *  1. the grouping on disk is the grouping this caller wants (`requests_state`'s policy
 *     fingerprint vs the injected §18 map — §18 row 2),
 *  2. the filter is expressed in columns that are constant within a group or that the reader
 *     can prove the whole group satisfies: `agent_id` is a grouping column, so filtering on it
 *     is exact, and `since`/`until` are exact for a group that lies ENTIRELY inside the window
 *     (the `min_ts`/`max_ts`/`ts_count` certificate). Everything else — project, session, model,
 *     status, capability, type, the §18 subagent switch, which read `metadata` — splits groups
 *     and keeps folding live,
 *  3. the table still describes `events` (`SUM(member_count) == COUNT(*) FROM events`), which
 *     is the cheap certificate that `events` was not written around this module.
 *
 * On any doubt the answer is `null` and the caller runs the fold it always ran. That is why
 * this can be turned on for every surface at once: the fallback is today's byte-identical path,
 * so a decline costs time and never costs a number.
 */
import type { DatabaseSync } from 'node:sqlite'
import { foldPolicyFingerprint, type AggregationPolicy } from '@agentlens/event-model'
import { hasRequestFoldTable, requestFoldIsConsistent, requestFoldState } from '@agentlens/storage'
import type { FoldCache } from './fold-cache.ts'
import type { QueryFilter } from './spec.ts'

export interface PersistedFold {
  /** SQL usable directly as `FROM <relation> r`; a bare table name when nothing narrows it. */
  relation: string
  /** Values bound inside that relation, in order. */
  params: unknown[]
}

export interface PersistedFoldRequest {
  filter: QueryFilter | undefined
  /** Resolved bounds of the window, in ms. `undefined` = unbounded on that side. */
  sinceTs: number | undefined
  untilTs: number | undefined
  aggregation: Record<string, AggregationPolicy> | undefined
  /** A scope that outlives one cube call may check the certificate once for all of them. */
  scope?: FoldCache
}

/** Certificate verdicts, one per read scope: it is a whole-table equality, not free. */
const certificateMemo = new WeakMap<FoldCache, boolean>()

/** Which filters a group cannot be split by. Anything else declines. */
const GROUP_SAFE_KEYS = new Set(['since', 'until', 'agent'])

export function persistedFold(db: DatabaseSync, req: PersistedFoldRequest): PersistedFold | null {
  if (!hasRequestFoldTable(db)) return null
  const state = requestFoldState(db)
  if (!state) return null

  // (1) the grouping on disk must be the grouping this caller means (§18 row 2).
  if (state.policyFingerprint !== foldPolicyFingerprint(req.aggregation)) return null

  // (2) every filter predicate must be one a group cannot be cut by.
  const filter = req.filter
  if (filter) {
    for (const key of Object.keys(filter)) if (!GROUP_SAFE_KEYS.has(key)) return null
    const agents = filter.agent
    if (agents && agents.length > 0) {
      // An empty-string agent id would match the `agent_key` of rows whose agent is NULL,
      // where the inline path's `agent_id IN ('')` matches nothing at all (§18's own guard).
      if (agents.some((a: string) => a === '')) return null
    }
  }

  // (3) the table must still say what `events` says.
  const { scope, sinceTs, untilTs } = req
  let consistent: boolean | undefined
  if (scope) consistent = certificateMemo.get(scope)
  if (consistent === undefined) {
    consistent = requestFoldIsConsistent(db)
    if (scope) certificateMemo.set(scope, consistent)
  }
  if (!consistent) return null

  // WHEN the table is worth reading at all, given that `fold-cache.ts` already exists.
  //
  // A windowed query inside a scope that shares one materialisation is the case the table
  // does NOT win: the materialised temp table holds only the window's groups, so its sixteen
  // stage-2 scans read less than this table's full 367k-row relation with three predicates on
  // each. Measured on the maintained store: `GET /api/projects?since=30d` 2.0 s -> 2.2 s and
  // `GET /api/overview?since=30d` 2.6 s -> 3.1 s when the shortcut was forced there, versus
  // 6.2 s -> 4.7 s with no window (`docs/research/probe-request-fold.mjs`, best of five
  // interleaved runs, whose three declined routes are the noise control: identical code in both
  // arms still differs by up to 12%). So a window declines when a scope would reuse one fold,
  // and takes the shortcut when nothing would — a CLI command has no fold cache, and without it
  // each statement folds the whole window again (six folds per `agl usage`).
  if ((sinceTs !== undefined || untilTs !== undefined) && req.scope) return null

  const where: string[] = []
  const params: unknown[] = []
  if (filter?.agent) {
    where.push(`agent_key IN (${filter.agent.map(() => '?').join(', ')})`)
    params.push(...filter.agent)
  }
  if (sinceTs !== undefined || untilTs !== undefined) {
    // A group is wholly inside the window when every member carries a timestamp (else the
    // inline path would drop the NULL ones) and its span sits between the bounds. Anything
    // straddling a bound would fold to a different MAX, so the whole query declines rather
    // than splicing the boundary in: correctness never depends on how tidy the data happens
    // to be, and a straddling request is rare enough that this is a cost, not a cliff.
    const clean: string[] = ['ts_count = member_count']
    if (sinceTs !== undefined) {
      clean.push('min_ts >= ?')
      params.push(sinceTs)
    }
    if (untilTs !== undefined) {
      clean.push('max_ts <= ?')
      params.push(untilTs)
    }
    where.push(...clean)
    // A group with a member inside the window that the clean predicate above rejects is a
    // straddler: the inline fold would see a subset of it, so the whole query declines.
    const probe = db.prepare(
      `SELECT 1 FROM main.requests
        WHERE ${overlapSql(sinceTs !== undefined, untilTs !== undefined)}
          AND NOT (${clean.join(' AND ')})
        LIMIT 1`,
    )
    const probeParams: unknown[] = []
    if (sinceTs !== undefined) probeParams.push(sinceTs)
    if (untilTs !== undefined) probeParams.push(untilTs)
    // The same bounds again, for the NOT(...) half of the predicate.
    const bound = [...probeParams, ...probeParams] as never[]
    if (probe.get(...bound) !== undefined) return null
  }

  if (where.length === 0) return { relation: 'main.requests', params: [] }
  return { relation: `(SELECT * FROM main.requests WHERE ${where.join(' AND ')})`, params }
}

/** Groups with AT LEAST ONE member inside the window: the ones a straddle could cut. A group
 *  with no timestamp at all has no member in any window, so it is never a straddler. */
function overlapSql(hasSince: boolean, hasUntil: boolean): string {
  const parts: string[] = []
  if (hasSince) parts.push('max_ts >= ?')
  if (hasUntil) parts.push('min_ts <= ?')
  return parts.length ? parts.join(' AND ') : '1'
}
