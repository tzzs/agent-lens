/**
 * WorkBuddy adapter (§5.1, milestone M5).
 *
 * Scope of what this adapter reads: the local execution traces at
 * `~/.workbuddy/projects/*.jsonl`. It is a pure translator — it never opens the database,
 * never prices a model, never writes to a source file (§5.2) — and it never imports
 * another adapter, including the Claude Code one it superficially resembles (§5.4).
 *
 * What it refuses: `workbuddy.db`, the primary store. Measured on the live machine
 * (docs/research/workbuddy.md §二, §18 row 7), a `readOnly` connection to it creates
 * `workbuddy.db-wal`/`-shm` inside the user's data directory, and its `session_usage`
 * token/cache column names were consequently never read. So the SQLite side of this
 * adapter discovers the store, declines to open it, and emits a machine-readable
 * diagnostic for `agentlens doctor` — see `sqlite.ts`. The token numbers this adapter
 * produces therefore come from the trace source only.
 *
 * Where the guard belongs: the collector frames `kind: 'sqlite'` sources through the
 * adapter's own `parse` (§5.1), so yielding one would put this adapter in charge of
 * opening `workbuddy.db` — which §18 row 7 forbids. `packages/collector` keeps its own
 * journal-mode guard for adapters that do read row stores; here the adapter withholds
 * the source and `sqlite.ts` reports why.
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID, HOST_WORKBUDDY } from './record.ts'

/** Bump when the mapping rules below change: a mismatch forces a full rescan (§5.3). */
// §5.3: identity derivation changed (tier-3 session bucket, §5.2 timestamp provenance),
// so stored rows must be replayed and repaired rather than left at the old ids.
export const PARSER_VERSION = 2

/**
 * §18 row 2: the fold this adapter's trace rows require.
 *
 * `request_max`. The measured census is one row per entity (15 calls / 15 results /
 * 12 reasoning / 6 messages) and `providerData` is per-record, so nothing duplicated was
 * observed — but the census does not say which row of a call/result pair carries the
 * usage, and a `function_call_result` that re-states the usage of the response that
 * produced it is precisely the Claude-family shape this CodeBuddy-derived format comes
 * from. MAX per `request_id` is the only fold that is exact under both readings: distinct
 * requests have distinct native ids and survive as their own group, a re-stated usage
 * collapses to one copy. Declaring `per_record_sum` instead would risk the +80% inflation
 * §4.4 row 2 measured, which is the failure this product cannot afford.
 *
 * `subagentsIncluded: true` is a statement of fact, not a switch: WorkBuddy traces show
 * no subagent marker at all (§四), so no row is ever flagged `subagentThread` and there is
 * nothing for an exclusion to filter. It flips to false only if the SQLite store — whose
 * `sessions` table is relational and parent-linked (§三) — ever becomes readable.
 *
 * Declared on the adapter as §18 row 2 requires, and exported by name so the CLI/cube can
 * wire it by `agent_id` without importing the whole adapter object (§7).
 */
export const WORKBUDDY_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'request_max',
  subagentsIncluded: true,
})

export const workbuddyAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'WorkBuddy',
  parserVersion: PARSER_VERSION,
  aggregation: WORKBUDDY_AGGREGATION,
  detect,
  discover,
  parse,
  normalize,
  // `capabilities()` is intentionally unimplemented. The only static list the report
  // shows is `~/.workbuddy/connectors-marketplace/connectors/*`, which is a marketplace:
  // whether an entry is installed, available, or merely offered is not measured, and the
  // 55-record sample cannot say whether sessions record connector calls at all (§四).
  // "Installed but never used" (§11) is exactly the claim that must not be guessed.
}

export { detect } from './detect.ts'
export { discover } from './discover.ts'
export {
  RECORD_TYPES,
  UNATTRIBUTED_PROJECT_ID,
  normalize,
} from './normalize.ts'
export { parse } from './parse.ts'
export { DB_FILE, dbPathOf, projectsDirOf, rootOf } from './paths.ts'
export { CODEBUDDY_LOCAL_MARKER, HOST_WORKBUDDY, resolveHost } from './record.ts'
export {
  SQLITE_DIAGNOSTIC_SCHEMA,
  WAL_REASON,
  assessSqliteSource,
  diagnoseSqliteSource,
  readSqliteJournalMode,
  sidecarPaths,
  sqliteDiagnostics,
  type JournalMode,
  type SqliteRefusalCode,
  type SqliteSourceDiagnostic,
} from './sqlite.ts'
export { ScanState, forgetState, stateFor } from './state.ts'
export { AGENT_ID } from './record.ts'

export default workbuddyAdapter
