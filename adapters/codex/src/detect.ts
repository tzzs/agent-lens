/**
 * §5.1 `detect` — presence + upstream version, read-only and non-throwing (§5.2 rule 3).
 *
 * The version comes from `session_meta.cli_version` (100% present per codex.md §2.2), so
 * the newest rollout file is the closest proxy for "the version that wrote this store".
 * Only the first few lines of at most three files are touched: rollout files average 1.5 MB
 * and reach 22 MB, so reading one whole file per probe would be wasteful.
 */
import { isParseErrorRecord, readIncremental, walkForFiles } from '@agentlens/collector'
import type { Detection, HostContext } from '@agentlens/event-model'
import { rootOf, sessionsDirsOf } from './paths.ts'
import { asRecord, str } from './record.ts'

const NEWEST_SCAN_LIMIT = 400
const PROBE_FILES = 3
const PROBE_LINES = 5

export async function detect(ctx: HostContext): Promise<Detection> {
  const dataRoot = rootOf(ctx)
  const dirs = sessionsDirsOf(ctx)

  let rootExists = false
  try {
    rootExists = (await ctx.stat(dataRoot)) !== null
  } catch {
    rootExists = false
  }
  if (!rootExists) {
    return { present: false, agentVersion: null, dataRoot, reason: `no codex data root at ${dataRoot}` }
  }

  const files: string[] = []
  try {
    for (const dir of dirs) {
      for await (const path of walkForFiles(dir, { pattern: 'rollout-*.jsonl' })) {
        files.push(path)
        if (files.length >= NEWEST_SCAN_LIMIT) break
      }
    }
  } catch (err) {
    return { present: true, agentVersion: null, dataRoot, reason: `unreadable store: ${String(err)}` }
  }

  if (files.length === 0) {
    const readable = await anyDirReadable(ctx, dirs)
    if (!readable) return { present: true, agentVersion: null, dataRoot, reason: `sessions directories unreadable: ${dirs.join(', ')}` }
    return {
      present: true,
      agentVersion: null,
      dataRoot,
      reason: 'sessions directories exist but contain no rollout files (upstream retention)',
    }
  }

  const version = await versionFromNewestFiles(ctx, files)
  return {
    present: true,
    agentVersion: version,
    dataRoot,
    reason: version ? null : 'cli_version absent from every probed session_meta record',
  }
}

async function anyDirReadable(ctx: HostContext, dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    try {
      await ctx.readDir(dir)
      return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

async function versionFromNewestFiles(ctx: HostContext, files: string[]): Promise<string | null> {
  // The thread's own clock is in the file NAME (`rollout-<date>T<time>-<id>.jsonl`), and it
  // beats mtime: archiving or `cp -p` refreshes mtime while the recorded date is immutable.
  // Sorting by mtime alone would also make this probe depend on checkout order.
  const stamped = await Promise.all(
    files.map(async (path) => ({ path, stamp: fileNameStamp(path), mtime: (await safeStat(ctx, path))?.mtimeMs ?? 0 })),
  )
  stamped.sort((a, b) => (a.stamp === b.stamp ? b.mtime - a.mtime : a.stamp < b.stamp ? 1 : -1))
  for (const { path } of stamped.slice(0, PROBE_FILES)) {
    const version = await firstCliVersion(path)
    if (version) return version
  }
  return null
}

const NAME_STAMP_RE = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/

function fileNameStamp(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.match(NAME_STAMP_RE)?.[1] ?? ''
}

/** Reads the first few complete lines only, then closes the handle (§4.3 reader contract). */
async function firstCliVersion(path: string): Promise<string | null> {
  const it = readIncremental(path, 0, { firstSeq: 1 })
  try {
    for (let i = 0; i < PROBE_LINES; i++) {
      const next = await it.next()
      if (next.done) break
      const line = next.value
      if ('oversized' in line) continue
      const parsed = toJson(line.text)
      if (parsed === null || isParseErrorRecord(parsed)) continue
      const rec = asRecord(parsed)
      const payload = asRecord(rec?.payload) ?? rec
      const version = str(payload?.cli_version)
      if (version) return version
    }
  } catch {
    return null // unreadable file: presence is already established by the walk
  } finally {
    await it.return({ nextOffset: 0, nextSeq: 1, residualBytes: 0 })
  }
  return null
}

function toJson(text: string): unknown {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function safeStat(ctx: HostContext, path: string) {
  try {
    return await ctx.stat(path)
  } catch {
    return null
  }
}
