/**
 * Claude Code adapter (§5.1). A pure translator: it reads `~/.claude`, never the
 * database, never a price table, and never writes to a source file (§5.2).
 */
import type { AgentAdapter } from '@agentlens/event-model'
import { capabilities } from './capabilities.ts'
import { detect } from './detect.ts'
import { discover } from './discover.ts'
import { normalize } from './normalize.ts'
import { parse } from './parse.ts'
import { AGENT_ID } from './record.ts'

/** Bump when the mapping rules below change: a mismatch forces a full rescan (§5.3). */
export const PARSER_VERSION = 1

export const claudeCodeAdapter: AgentAdapter = {
  id: AGENT_ID,
  displayName: 'Claude Code',
  parserVersion: PARSER_VERSION,
  detect,
  discover,
  parse,
  normalize,
  capabilities,
}

export { capabilities } from './capabilities.ts'
export { detect } from './detect.ts'
export { discover, HISTORY_SOURCE_FILE } from './discover.ts'
export { normalize, HOST_METADATA_TYPES, UNATTRIBUTED_PROJECT_ID } from './normalize.ts'
export { parse } from './parse.ts'
export { resolveHost } from './record.ts'
export { ScanState, forgetState, stateFor } from './state.ts'
export {
  AGENT_ID,
  HOST_CLI,
  HOST_DESKTOP,
  SYNTHETIC_MODEL,
} from './record.ts'
export {
  historyFileOf,
  installedPluginsFileOf,
  projectsDirOf,
  rootOf,
  skillsDirOf,
  userConfigFileOf,
} from './paths.ts'

export default claudeCodeAdapter
