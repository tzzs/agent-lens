/**
 * Data-root layout (§5.1) — measured in docs/research/zcode.md §一: the session and
 * usage store is `~/.zcode/cli/db/db.sqlite`, the capability surface is under
 * `~/.zcode/cli/plugins/`, and the subagent parent-link evidence is the file tree under
 * `~/.zcode/cli/agents/` (§八·5a). Root resolution order is `ctx.dataRoot`, then
 * `ZCODE_HOME`, then `~/.zcode`.
 *
 * WHY `cli/` in the path is not a host axis: every one of this machine's 10 root
 * sessions is a desktop-app task (`v2/tasks-index.sqlite.tasks.task_id` hits 10/10),
 * so the directory name describes where the engine keeps data, not who launched it
 * (§二). `host_id` stays the single `'zcode'`.
 *
 * Never read from this module: `v2/credentials.json`, `v2/provider_config.json` and
 * `v2/bot-*.json` are credential files (§一), and `~/Library/Application Support/
 * ZCode/session/` is the Electron browser profile, not session data.
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export const DEFAULT_ROOT_NAME = '.zcode'
/** The one database every SQLite source in this adapter is a table of (§一). */
export const DB_RELATIVE_PATH = join('cli', 'db', 'db.sqlite')
export const PLUGINS_RELATIVE_DIR = join('cli', 'plugins')
export const INSTALLED_PLUGINS_FILE = 'installed_plugins.json'
export const PLUGIN_DATA_DIR = 'data'
/**
 * §一/§八·5a: the sixth source is a file tree, not a table —
 * `cli/agents/<parentSessionId>/agent_<agentId>/metadata.json`, one pretty-printed document
 * per subagent run (28 files measured, 21 keys on the completed ones and 18 on the failed
 * ones, which is why §三's fifth usage copy has a directory of its own).
 */
export const AGENTS_RELATIVE_DIR = join('cli', 'agents')
export const AGENTS_METADATA_FILE = 'metadata.json'
/** A spawn directory is named `agent_<agentId>`; anything else is not a run we understand. */
export const AGENT_SPAWN_DIR_PREFIX = 'agent_'

export interface ZcodeStore {
  /** The agent data root (`~/.zcode`), not the directory holding the file. */
  dataRoot: string
  dbPath: string
}

/** `ctx.dataRoot ?? env.ZCODE_HOME ?? ~/.zcode`, honouring only absolute candidates. */
export function rootOf(ctx: HostContext): string {
  const seeded = ctx.dataRoot
  if (seeded && isAbsolute(seeded)) return seeded
  const fromEnv = ctx.env.ZCODE_HOME
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  return join(ctx.homedir, DEFAULT_ROOT_NAME)
}

export function dbPathOf(ctx: HostContext): string {
  return join(rootOf(ctx), DB_RELATIVE_PATH)
}

export function pluginsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), PLUGINS_RELATIVE_DIR)
}

export function installedPluginsFileOf(ctx: HostContext): string {
  return join(pluginsDirOf(ctx), INSTALLED_PLUGINS_FILE)
}

export function pluginDataDirOf(ctx: HostContext): string {
  return join(pluginsDirOf(ctx), PLUGIN_DATA_DIR)
}

/**
 * `cli/agents`, the root of the subagent spawn tree. Deliberately NOT behind `resolveStore`:
 * the documents are plain files, so a store that §18 row 7 makes us refuse must not also hide
 * the foreign key that closes the parent link.
 */
export function agentsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), AGENTS_RELATIVE_DIR)
}

/** Presence = the file exists as a file; nothing here opens it (§18 row 7). */
export async function resolveStore(ctx: HostContext): Promise<ZcodeStore | null> {
  const dataRoot = rootOf(ctx)
  const dbPath = join(dataRoot, DB_RELATIVE_PATH)
  try {
    const s = await stat(dbPath)
    if (!s.isFile()) return null
    return { dataRoot, dbPath }
  } catch {
    return null
  }
}
