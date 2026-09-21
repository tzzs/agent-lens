/**
 * Data-root layout (§5.1) — the telemetry store lives under the XDG data dir, not
 * under `~/.opencode` (that path is an install directory: node_modules/skills).
 *
 * `HostContext.dataRoot` is ambiguous in practice (some callers hand us the agent
 * root, others the parent share dir), so the store is resolved by probing the
 * candidate roots for `opencode.db` instead of assuming a shape.
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export const DB_FILE = 'opencode.db'

export interface OpenCodeStore {
  /** The directory holding `opencode.db`. */
  dataRoot: string
  dbPath: string
}

/** Candidate agent roots, most specific first, deduplicated. */
export function candidateRoots(ctx: HostContext): string[] {
  const out: string[] = []
  const push = (path: string | undefined): void => {
    if (path && isAbsolute(path) && !out.includes(path)) out.push(path)
  }
  const xdg = ctx.env.XDG_DATA_HOME
  if (xdg && isAbsolute(xdg)) push(join(xdg, 'opencode'))
  push(ctx.dataRoot ?? undefined)
  if (ctx.dataRoot) push(join(ctx.dataRoot, 'opencode'))
  push(join(ctx.homedir, '.local', 'share', 'opencode'))
  push(join(ctx.homedir, '.opencode'))
  return out
}

/** The default root to report when nothing was found. */
export function rootOf(ctx: HostContext): string {
  return candidateRoots(ctx)[0] ?? join(ctx.homedir, '.local', 'share', 'opencode')
}

export function dbPathOf(ctx: HostContext): string {
  return join(rootOf(ctx), DB_FILE)
}

async function hasStore(root: string): Promise<boolean> {
  try {
    const s = await stat(join(root, DB_FILE))
    return s.isFile()
  } catch {
    return false
  }
}

/** First candidate that really holds an `opencode.db`; null when the agent is absent. */
export async function resolveStore(ctx: HostContext): Promise<OpenCodeStore | null> {
  for (const root of candidateRoots(ctx)) {
    if (await hasStore(root)) return { dataRoot: root, dbPath: join(root, DB_FILE) }
  }
  return null
}
