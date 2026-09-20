/**
 * Data-root layout. `CLAUDE_CONFIG_DIR` wins over the host-supplied root because
 * it is the upstream switch for relocating the whole store.
 */
import { isAbsolute, join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export function rootOf(ctx: HostContext): string {
  const fromEnv = ctx.env.CLAUDE_CONFIG_DIR
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  if (ctx.dataRoot) return ctx.dataRoot
  return join(ctx.homedir, '.claude')
}

export function projectsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'projects')
}

export function historyFileOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'history.jsonl')
}

export function skillsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'skills')
}

export function installedPluginsFileOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'plugins', 'installed_plugins.json')
}

/** MCP servers live in the user-facing config file, not under the data root. */
export function userConfigFileOf(ctx: HostContext): string {
  return join(ctx.homedir, '.claude.json')
}
