/**
 * §5.1 `detect` — presence + best-effort upstream version, without ever writing
 * to the data root (§5.2 rule 3) and without throwing on unreadable directories.
 *
 * §5.3: detection covers every root the adapter will actually read, so a machine whose only
 * usage lives in `~/.claude-deepseek` is "installed", not "not detected". `variantRoots`
 * carries the extra stores so `doctor` can say so out loud.
 */
import { join } from 'node:path'
import { walkForFiles } from '@agentlens/event-model'
import type { Detection, HostContext } from '@agentlens/event-model'
import { asRecord, str } from './record.ts'
import { projectsDirOf, rootOf, rootsOf } from './paths.ts'

const NEWEST_SCAN_LIMIT = 400

export async function detect(ctx: HostContext): Promise<Detection> {
  const dataRoot = rootOf(ctx)
  const roots = await rootsOf(ctx)
  const variantRoots = roots.filter((r) => r !== dataRoot)

  const files: string[] = []
  let sawProjectsDir = false
  let unreadable: string | null = null
  for (const root of roots) {
    const projects = projectsDirOf(ctx, root)
    if ((await safeStat(ctx, projects)) !== null) sawProjectsDir = true
    try {
      for await (const path of walkForFiles(projects, { pattern: '*.jsonl' })) {
        files.push(path)
        if (files.length >= NEWEST_SCAN_LIMIT) break
      }
    } catch (err) {
      unreadable ??= `unreadable store at ${projects}: ${String(err)}`
    }
  }

  if (!sawProjectsDir) {
    return {
      present: false,
      agentVersion: null,
      dataRoot,
      variantRoots,
      reason: `no projects directory at ${projectsDirOf(ctx)}`,
    }
  }

  if (files.length === 0) {
    return {
      present: true,
      agentVersion: null,
      dataRoot,
      variantRoots,
      reason: unreadable ?? 'directory exists but contains no session files (upstream retention, §4.4 row 4)',
    }
  }

  const version = (await versionFromNewestFile(ctx, files)) ?? (await versionFromInstallHint(ctx))
  return {
    present: true,
    agentVersion: version,
    dataRoot,
    variantRoots,
    reason: version ? null : 'version field absent from every probed record',
  }
}

/** Records carry their own `version` (§2.1); the newest file's first record is the closest proxy. */
async function versionFromNewestFile(ctx: HostContext, files: string[]): Promise<string | null> {
  const stamped = await Promise.all(
    files.map(async (path) => ({ path, mtime: (await safeStat(ctx, path))?.mtimeMs ?? 0 })),
  )
  stamped.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1))
  for (const { path } of stamped.slice(0, 3)) {
    let text: string
    try {
      text = await ctx.readFile(path)
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const v = str(asRecord(JSON.parse(line))?.version)
        if (v) return v
      } catch {
        break
      }
    }
  }
  return null
}

async function versionFromInstallHint(ctx: HostContext): Promise<string | null> {
  for (const path of [
    ...(ctx.dataRoot ? [join(ctx.dataRoot, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json')] : []),
    join(ctx.homedir, '.claude.json'),
  ]) {
    let text: string
    try {
      text = await ctx.readFile(path)
    } catch {
      continue
    }
    try {
      const parsed = asRecord(JSON.parse(text))
      const hint = str(parsed?.version) ?? str(parsed?.installMethod)
      if (hint) return hint
    } catch {
      /* a hint file we cannot read is simply no hint */
    }
  }
  return null
}

async function safeStat(ctx: HostContext, path: string): Promise<{ size: number; mtimeMs: number; inode: number } | null> {
  try {
    return await ctx.stat(path)
  } catch {
    return null
  }
}
