/**
 * ZCode adapter (§5.1) — the second SQLite-backed source in the project and the seventh
 * adapter. A pure translator: read-only opens of a snapshot copy only, no database writes,
 * no price lookups, no throws out of `normalize` (§5.2, §18 row 7).
 *
 * ZCode's `session`/`message`/`part` trio is literally OpenCode-shaped, so this package
 * mirrors `adapters/opencode`'s layout and its read-only WAL posture, and then departs from
 * it wherever the measurement says the two stores disagree (docs/research/zcode.md):
 * the token containment direction (§四), the five-fold usage duplication (§三), the plan-zero
 * cost column (§四), the semantics-not-role dispatch (§五) and the two insert-only usage
 * tables that make `model_usage`/`tool_usage` the only sources worth trusting.
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { capabilities } from './capabilities.ts'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID, HOST_ID } from './record.ts'

/** Bump when the mapping rules change: a mismatch forces a full rescan (§5.3). */
// v3: `session.time_compacting` became a `context.compact` event instead of a field hidden in
// one row's metadata, so a store that compacts must be replayed for the dimension to appear.
// (v2 was the ingest-wide identity/provenance bump, §4.1/§5.2.)
export const PARSER_VERSION = 3

/**
 * §18 row 2 — the fold ZCode's rows are honest about.
 *
 * `per_record_sum`: `model_usage` carries exactly one row per model call, measured
 * `COUNT(*) = COUNT(DISTINCT id) = COUNT(DISTINCT logical_request_id) = 1395` with
 * `attempt_index` all 0, and the table is insert-only — unlike `part`/`message`, whose rows
 * are UPDATEd in place and therefore cannot be the ledger. One row states one call's tokens
 * once, so summing the rows cannot double count. Because each row also carries its own
 * `logical_request_id`, `request_max` is arithmetically identical here; the declared mode is
 * the one that states the grain instead of relying on grouping, and it keeps working if a
 * future build starts writing retry rows.
 *
 * `subagentsIncluded: true` is a measurement, not a switch: ccusage's zcode headline for
 * this machine (167,593,984 total tokens) includes the 367 `query_source='subagent'` rows
 * worth 15,657,611 tokens, so excluding flagged rows would under-report real spend by 9.3%
 * (docs/research/zcode.md §四/§五).
 */
export const ZCODE_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'per_record_sum',
  subagentsIncluded: true,
})

export const zcodeAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'ZCode',
  parserVersion: PARSER_VERSION,
  aggregation: ZCODE_AGGREGATION,
  detect,
  discover,
  parse,
  normalize,
  capabilities,
}

export { capabilities, capabilitiesRootOf } from './capabilities.ts'
export { detect } from './detect.ts'
export { discover } from './discover.ts'
export { UNATTRIBUTED_PROJECT_ID, normalize } from './normalize.ts'
export { parse } from './parse.ts'
export { DB_RELATIVE_PATH, dbPathOf, pluginDataDirOf, pluginsDirOf, rootOf } from './paths.ts'
export {
  AGENT_ID,
  COST_REASON,
  HOST_ID,
  KNOWN_PART_TYPES,
  NON_SOURCE_TABLES,
  TABLES,
  TABLE_MESSAGE,
  TABLE_MODEL_USAGE,
  TABLE_PART,
  TABLE_SESSION,
  TABLE_TOOL_USAGE,
} from './record.ts'
export { WAL_REASON, assessReadOnly, openReadOnly, readJournalMode, sidecarPaths } from './safety.ts'

export default zcodeAdapter
