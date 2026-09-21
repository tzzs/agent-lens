/**
 * Data-root layout (§一/§四 of docs/research/workbuddy.md — the only measured evidence).
 *
 * `~/.workbuddy` is the single root the probe found. No relocation env var is
 * documented for WorkBuddy, so none is invented here: the host-supplied
 * `dataRoot` is the only override, which is also how the fixture tests point the
 * adapter at a synthetic store.
 *
 * Two sources live under it, with very different safety properties:
 *  - `projects/*.jsonl` — local execution traces, read with no side effects.
 *  - `workbuddy.db` — the primary store, a WAL-mode SQLite file that must never
 *    be opened (see sqlite.ts).
 */
import { join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export const DB_FILE = 'workbuddy.db'

/** Directory names observed under the data root by the probe; only these are ever listed. */
export const PROJECTS_DIR = 'projects'

export function rootOf(ctx: HostContext): string {
  if (ctx.dataRoot) return ctx.dataRoot
  return join(ctx.homedir, '.workbuddy')
}

export function projectsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), PROJECTS_DIR)
}

export function dbPathOf(ctx: HostContext): string {
  return join(rootOf(ctx), DB_FILE)
}
