/**
 * Codex adapter (§5.1, docs/plan-v2.md §15 M2). A pure translator: it reads `~/.codex`,
 * never the database, never a price table, never writes to a source file (§5.2).
 *
 * This is the second adapter on purpose: Codex differs from Claude Code on every axis the
 * first adapter's abstraction assumed (usage granularity, cache-token dialect, session vs
 * thread grain, host axis, absence of hooks, absence of `mcp__` names).
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { capabilities } from './capabilities.ts'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID, HOST_CLI_RS, HOST_DESKTOP, HOST_EXEC, HOST_TUI, HOST_UNKNOWN } from './record.ts'

/** Bump when the mapping rules change: a mismatch forces a full rescan (§5.3). */
export const PARSER_VERSION = 1

/**
 * §18 row 2 — the fold this adapter declares, and the reason it exists as a named export:
 * the same policy is what the storage/query layer keys its `aggregation_policy` row by.
 *
 * `last_call_sum`: only per-call rows (`last_token_usage` / `usage`) may be summed; the
 * cumulative `total`/`turn`/`thread` objects are copied into metadata and never reach the
 * aggregation layer (folding them inflates ~1971x on the measured machine).
 * `subagentsIncluded: false`: 257 of 379 thread files are subagent threads and ccusage
 * excludes them — reconciliation without the exclusion is +77% (codex.md §五). Events of
 * those threads carry `metadata.subagentThread = true` so the SQL side can switch too.
 */
export const CODEX_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'last_call_sum',
  subagentsIncluded: false,
})

export const codexAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'Codex',
  parserVersion: PARSER_VERSION,
  aggregation: CODEX_AGGREGATION,
  detect,
  discover,
  parse,
  normalize,
  capabilities,
}

export { capabilities } from './capabilities.ts'
export { detect } from './detect.ts'
export { discover, ROLLOUT_PATTERN } from './discover.ts'
export { normalize, CODEX_ENVELOPE_TYPES, UNATTRIBUTED_PROJECT_ID } from './normalize.ts'
export { parse } from './parse.ts'
export { resolveHost, slugOriginator } from './record.ts'
export { ScanState, forgetState, stateFor, type ThreadContext } from './state.ts'
export { hooksFileOf, rootOf, sessionsDirsOf, threadHintFromPath } from './paths.ts'
export {
  AGENT_ID,
  HOST_CLI_RS,
  HOST_DESKTOP,
  HOST_EXEC,
  HOST_TUI,
  HOST_UNKNOWN,
  CUMULATIVE_FIELDS,
  PER_CALL_FIELDS,
} from './record.ts'

export default codexAdapter
