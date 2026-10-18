/**
 * Data-root layout. `CODEX_HOME` wins over the host-supplied root because it is the
 * upstream switch for relocating the whole store (same role as `CLAUDE_CONFIG_DIR`).
 *
 * §5.3: model-switching setups leave a second full store beside the canonical one
 * (`~/.codex-deepseek`); `rootsOf` lists every store this adapter should read.
 */
import { isAbsolute, join } from 'node:path'
import { rootsOf as variantRootsOf, type HostContext } from '@agentlens/event-model'

/** The layout marker that makes a sibling directory a real Codex store. */
export const ROOT_MARKERS: readonly string[] = ['sessions']

/** Suffixes that belong to Codex itself or to its regional builds, never to a second store. */
export const NOT_VARIANTS: readonly string[] = ['cn']

export function rootFromEnv(ctx: HostContext): string | null {
  const fromEnv = ctx.env.CODEX_HOME
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : null
}

export function rootOf(ctx: HostContext): string {
  return rootFromEnv(ctx) ?? ctx.dataRoot ?? join(ctx.homedir, '.codex')
}

/** Canonical root first, then every sibling store that holds this agent's layout (§5.3). */
export async function rootsOf(ctx: HostContext): Promise<string[]> {
  return variantRootsOf(ctx, rootOf(ctx), rootFromEnv(ctx) !== null, {
    markers: ROOT_MARKERS,
    notVariants: NOT_VARIANTS,
  })
}

/**
 * codex.md samples BOTH directories (`sessions/**` + `archived_sessions/**`, 379 files):
 * archived threads are real usage, so scanning only `sessions/` would silently drop them.
 */
export const SESSION_DIRS: readonly string[] = ['sessions', 'archived_sessions']

export function sessionsDirsOf(ctx: HostContext, root = rootOf(ctx)): string[] {
  return SESSION_DIRS.map((dir) => join(root, dir))
}

export function hooksFileOf(ctx: HostContext, root = rootOf(ctx)): string {
  return join(root, 'hooks.json')
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
