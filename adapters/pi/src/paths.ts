/**
 * Data-root layout (docs/research/pi.md §一 — the only measured evidence).
 *
 * `~/.pi/agent` is the single root the probe found. Pi documents no relocation env
 * var for it, so none is invented here: the host-supplied `dataRoot` is the only
 * override, which is also how the fixture tests point the adapter at a synthetic store.
 *
 * Unlike WorkBuddy/OpenCode there is no SQLite store at all — sessions are plain
 * JSONL — so the WAL sidecar hazard (pi.md 净结论 row 1) does not exist on this source.
 */
import { join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export const SESSIONS_DIR = 'sessions'
export const SKILLS_DIR = 'skills'
export const EXTENSIONS_DIR = 'extensions'
export const SETTINGS_FILE = 'settings.json'

/** A skill is a directory holding SKILL.md (measured: 58/62 on the live machine). */
export const SKILL_MARKER_FILE = 'SKILL.md'

export function rootOf(ctx: HostContext): string {
  if (ctx.dataRoot) return ctx.dataRoot
  return join(ctx.homedir, '.pi', 'agent')
}

export function sessionsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), SESSIONS_DIR)
}

export function skillsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), SKILLS_DIR)
}

export function extensionsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), EXTENSIONS_DIR)
}

export function settingsFileOf(ctx: HostContext): string {
  return join(rootOf(ctx), SETTINGS_FILE)
}
