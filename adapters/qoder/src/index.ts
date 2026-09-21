/**
 * Qoder adapter (§5.1, milestone M5). A pure translator over Qoder's JSONL
 * store (§18: Qoder is a Claude Code fork writing JSONL, not SQLite). It never
 * reads the database, never prices a model, never writes to a source file
 * (§5.2) — and never imports the Claude Code adapter (§5.4).
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { capabilities } from './capabilities.ts'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID, HOST_QODER } from './record.ts'

/** Bump when the mapping rules below change: a mismatch forces a full rescan (§5.3). */
export const PARSER_VERSION = 1

/**
 * §18 row 2: Qoder measurement shows exactly one usage per request_id (0 dup
 * groups), so MAX-per-request is a no-op today — declaring it is drift
 * insurance against the fork re-introducing Claude's block-split duplication.
 */
export const QODER_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'request_max',
  // Sidechains (isSidechain, 3,361 measured) carry their own request_id/usage
  // and live in the same files; totals include them (same as the Claude basis).
  subagentsIncluded: true,
})

export const qoderAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'Qoder',
  parserVersion: PARSER_VERSION,
  aggregation: QODER_AGGREGATION,
  detect,
  discover,
  parse,
  normalize,
  capabilities,
}

export { capabilities } from './capabilities.ts'
export { detect } from './detect.ts'
export { discover } from './discover.ts'
export { normalize, HOST_METADATA_TYPES, UNATTRIBUTED_PROJECT_ID } from './normalize.ts'
export { parse } from './parse.ts'
export { resolveHost } from './record.ts'
export { ScanState, forgetState, stateFor } from './state.ts'
export { AGENT_ID, HOST_QODER, SYNTHETIC_MODEL } from './record.ts'
export { mcpRouterFileOf, projectsDirOf, rootOf, skillsDirOf } from './paths.ts'

export default qoderAdapter
