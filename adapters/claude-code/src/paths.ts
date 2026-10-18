/**
 * Data-root layout. `CLAUDE_CONFIG_DIR` wins over the host-supplied root because
 * it is the upstream switch for relocating the whole store.
 *
 * §5.3: a model-switching setup (`CC Switch`, a gateway, an alias with
 * `CLAUDE_CONFIG_DIR=~/.claude-deepseek`) leaves a *second* full store beside the canonical
 * one. `rootsOf` lists them; everything that used to take the single root takes a root
 * argument so one adapter can serve all of them.
 */
import { isAbsolute, join } from 'node:path'
import { rootsOf as variantRootsOf, type HostContext } from '@agentlens/event-model'

/** The layout marker that makes a sibling directory a real Claude Code store. */
export const ROOT_MARKERS: readonly string[] = ['projects']

/**
 * Suffixes that belong to Claude Code itself or to the desktop/CLI split, never to a
 * second store. `-ide` is the editor companion; `-cn` is a regional build.
 */
export const NOT_VARIANTS: readonly string[] = ['ide', 'cn']

export function rootFromEnv(ctx: HostContext): string | null {
  const fromEnv = ctx.env.CLAUDE_CONFIG_DIR
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : null
}

/** The canonical root: env switch, then the host's answer, then `~/.claude`. */
export function rootOf(ctx: HostContext): string {
  return rootFromEnv(ctx) ?? ctx.dataRoot ?? join(ctx.homedir, '.claude')
}

/** Canonical root first, then every sibling store that holds this agent's layout (§5.3). */
export async function rootsOf(ctx: HostContext): Promise<string[]> {
  return variantRootsOf(ctx, rootOf(ctx), rootFromEnv(ctx) !== null, {
    markers: ROOT_MARKERS,
    notVariants: NOT_VARIANTS,
  })
}

export function projectsDirOf(ctx: HostContext, root = rootOf(ctx)): string {
  return join(root, 'projects')
}

export function historyFileOf(ctx: HostContext, root = rootOf(ctx)): string {
  return join(root, 'history.jsonl')
}

export function skillsDirOf(ctx: HostContext, root = rootOf(ctx)): string {
  return join(root, 'skills')
}

export function installedPluginsFileOf(ctx: HostContext, root = rootOf(ctx)): string {
  return join(root, 'plugins', 'installed_plugins.json')
}

/** MCP servers live in the user-facing config file, not under the data root. */
export function userConfigFileOf(ctx: HostContext): string {
  return join(ctx.homedir, '.claude.json')
}
