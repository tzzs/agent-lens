/**
 * Data-root layout. `CODEX_HOME` wins over the host-supplied root because it is the
 * upstream switch for relocating the whole store (same role as `CLAUDE_CONFIG_DIR`).
 */
import { isAbsolute, join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export function rootOf(ctx: HostContext): string {
  const fromEnv = ctx.env.CODEX_HOME
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  if (ctx.dataRoot) return ctx.dataRoot
  return join(ctx.homedir, '.codex')
}

/**
 * codex.md samples BOTH directories (`sessions/**` + `archived_sessions/**`, 379 files):
 * archived threads are real usage, so scanning only `sessions/` would silently drop them.
 */
export const SESSION_DIRS: readonly string[] = ['sessions', 'archived_sessions']

export function sessionsDirsOf(ctx: HostContext): string[] {
  return SESSION_DIRS.map((dir) => join(rootOf(ctx), dir))
}

export function hooksFileOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'hooks.json')
}

/**
 * Codex names a rollout file `rollout-<date>T<time>-<thread id>.jsonl` (codex.md §目录布局).
 * The trailing token is used ONLY as a thread hint when a resumed scan starts after the
 * file's `session_meta` record, so a misparse costs a hint, never a wrong token count.
 * The class excludes `-` on purpose: the timestamp in the same name is dash-separated, and
 * a permissive class swallows `2026-09-15T09-00-00-` into the "thread id".
 */
const THREAD_HINT_RE = /-([0-9A-Za-z]{20,})\.jsonl$/

export function threadHintFromPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const m = THREAD_HINT_RE.exec(name)
  return m?.[1] ?? null
}
