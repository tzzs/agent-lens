/**
 * OpenCode adapter (§5.1) — the project's first SQLite-backed source. A pure
 * translator: read-only opens only, no database writes, no price lookups (§5.2, §18 row 7).
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { capabilities } from './capabilities.ts'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID, HOST_ID } from './record.ts'

/** Bump when the mapping rules change: a mismatch forces a full rescan (§5.3). */
// §5.3: identity derivation changed (tier-3 session bucket, §5.2 timestamp provenance),
// so stored rows must be replayed and repaired rather than left at the old ids.
export const PARSER_VERSION = 2

/**
 * §18 row 2 — the fold OpenCode's rows are honest about.
 *
 * `per_record_sum`: a `part` row of type `step-finish` states exactly one API call's
 * tokens and cost; it is not cumulative. The cumulative shapes the store also has
 * (`message.data.tokens`, `session.cost`/`session.tokens`) are copied into
 * `metadata.rollup` for reconciliation and never reach `usage`, so summing the rows
 * cannot double count. Each step also gets its own `request_id`
 * (`<message_id>/<part_id>`), which makes `request_max` arithmetically identical — the
 * declared mode is the one that states the grain rather than relying on grouping.
 *
 * `subagentsIncluded: false`: a subagent runs as a child `session` row and its steps are
 * separate rows carrying `metadata.subagentThread`, so no stored number already contains
 * them; excluding flagged rows would delete real work instead of de-duplicating it.
 */
export const OPENCODE_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'per_record_sum',
  subagentsIncluded: false,
})

export const openCodeAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'OpenCode',
  parserVersion: PARSER_VERSION,
  aggregation: OPENCODE_AGGREGATION,
  detect,
  discover,
  parse,
  normalize,
  capabilities,
}

export { capabilities } from './capabilities.ts'
export { detect } from './detect.ts'
export { discover } from './discover.ts'
export {
  KNOWN_PART_TYPES,
  UNATTRIBUTED_PROJECT_ID,
  normalize,
} from './normalize.ts'
export { parse } from './parse.ts'
export { dbPathOf, rootOf } from './paths.ts'
export { AGENT_ID, HOST_ID, TABLES } from './record.ts'
export {
  WAL_REASON,
  assessReadOnly,
  openReadOnly,
  readJournalMode,
  sidecarPaths,
} from './safety.ts'

export default openCodeAdapter
