/**
 * §5.1 `detect` — presence + best-effort upstream version (`version` is a
 * top-level key on Qoder records per the §1.1 census), read-only, never throws.
 */
import { walkForFiles } from '@agentlens/event-model'
import type { Detection, HostContext } from '@agentlens/event-model'
import { projectsDirOf, rootOf } from './paths.ts'
import { asRecord, str } from './record.ts'

const NEWEST_SCAN_LIMIT = 400

export async function detect(ctx: HostContext): Promise<Detection> {
  const dataRoot = rootOf(ctx)
  const projects = projectsDirOf(ctx)

  let rootStat: Awaited<ReturnType<HostContext['stat']>> | null = null
  try {
    rootStat = await ctx.stat(projects)
  } catch {
    rootStat = null
  }
  if (rootStat === null) {
    return { present: false, agentVersion: null, dataRoot, reason: `no projects directory at ${projects}` }
  }

  const files: string[] = []
  try {
    for await (const path of walkForFiles(projects, { pattern: '*.jsonl' })) {
      files.push(path)
      if (files.length >= NEWEST_SCAN_LIMIT) break
    }
  } catch (err) {
    return { present: true, agentVersion: null, dataRoot, reason: `unreadable store: ${String(err)}` }
  }

  if (files.length === 0) {
    return {
      present: true,
      agentVersion: null,
      dataRoot,
      reason: 'directory exists but contains no session files (upstream retention, §4.4 row 4)',
    }
  }

  const version = await versionFromFiles(ctx, files)
  return {
    present: true,
    agentVersion: version,
    dataRoot,
    reason: version ? null : 'version field absent from every probed record',
  }
}

async function versionFromFiles(ctx: HostContext, files: string[]): Promise<string | null> {
  const stamped = await Promise.all(
    files.map(async (path) => {
      let m = 0
      try {
        m = (await ctx.stat(path))?.mtimeMs ?? 0
      } catch {
        m = 0
      }
      return { path, mtime: m }
    }),
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
