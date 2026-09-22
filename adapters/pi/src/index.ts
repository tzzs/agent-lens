/**
 * Pi adapter (§5.1). A pure translator: it reads the local session traces under
 * `~/.pi/agent/sessions` (plain JSONL), never the database, never a price table, and
 * never writes to a source file (§5.2). Pi keeps no SQLite store (docs/research/pi.md
 * §一), so unlike the WorkBuddy/OpenCode adapters there is no WAL source to refuse —
 * and `auth.json` under the same root is a credential file this adapter never reads.
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { capabilities } from './capabilities.ts'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID, HOST_PI } from './record.ts'

/** Bump when the mapping rules below change: a mismatch forces a full rescan (§5.3). */
// §5.3: identity derivation changed (tier-3 session bucket, §5.2 timestamp provenance),
// so stored rows must be replayed and repaired rather than left at the old ids.
export const PARSER_VERSION = 2

/**
 * §18 row 2: the fold the Pi trace rows require.
 *
 * `request_max`, grouped by the native `responseId`. Measured (pi.md §三): one assistant
 * record is one API response and usage appears exactly once per record — but an unseen
 * Pi build re-stating the same response's usage across rows (the Claude-family shape) is
 * collapsed correctly by MAX over the shared native id, while distinct responses carry
 * distinct ids and survive. The rows lacking `responseId` (5/160, all zero-usage
 * error/aborts) fall to per-event accounting and cannot move a total.
 *
 * `subagentsIncluded: true` is a statement of fact: the census shows no subagent marker
 * anywhere (pi.md §四), so no row is ever flagged `subagentThread` and an exclusion
 * would filter nothing.
 */
export const PI_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'request_max',
  subagentsIncluded: true,
})

export const piAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'Pi',
  parserVersion: PARSER_VERSION,
  aggregation: PI_AGGREGATION,
  detect,
  discover,
  parse,
  normalize,
  capabilities,
}

export { capabilities } from './capabilities.ts'
export { detect } from './detect.ts'
export { discover, sessionHintOf, specFor } from './discover.ts'
export { RECORD_TYPES, UNATTRIBUTED_PROJECT_ID, normalize } from './normalize.ts'
export { parse } from './parse.ts'
export {
  EXTENSIONS_DIR,
  SESSIONS_DIR,
  SETTINGS_FILE,
  SKILLS_DIR,
  extensionsDirOf,
  rootOf,
  sessionsDirOf,
  settingsFileOf,
  skillsDirOf,
} from './paths.ts'
export { HOST_PI, MEASURED_TRACE_VERSION } from './record.ts'
export { ScanState, forgetState, stateFor } from './state.ts'
export { AGENT_ID } from './record.ts'

export default piAdapter
