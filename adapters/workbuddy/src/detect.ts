/**
 * §5.1 `detect` — presence, upstream version, and the SQLite refusal, without ever
 * opening a database or writing to the data root (§5.2 rule 3).
 *
 * There is no version field in the WorkBuddy trace census (§四), and the two places a
 * version could live — `workbuddy.db`'s `migration_meta` table and the daemon logs — are
 * respectively unreadable-without-side-effects (§二) and undocumented in shape. So
 * `agentVersion` stays null and §5.3's drift detection rests on `parserVersion` plus the
 * unknown-type count instead of pretending to know a version.
 */
import { walkForFiles } from '@agentlens/event-model'
import type { Detection, HostContext } from '@agentlens/event-model'
import { projectsDirOf, rootOf } from './paths.ts'
import { sqliteDiagnostics } from './sqlite.ts'

const FILE_SCAN_LIMIT = 500

export async function detect(ctx: HostContext): Promise<Detection> {
  const dataRoot = rootOf(ctx)
  const projects = projectsDirOf(ctx)
  const diagnostics = await sqliteDiagnostics(ctx)
  const reasons: string[] = []
  for (const d of diagnostics) if (d.refused) reasons.push(`${d.code}: ${d.message}`)

  const projectsPresent = await pathPresent(ctx, projects)
  const dbDiscovered = diagnostics.some((d) => d.discovered)

  if (!projectsPresent && !dbDiscovered) {
    return {
      present: false,
      agentVersion: null,
      dataRoot,
      reason: `no WorkBuddy data root at ${dataRoot}: neither ${projects} nor a *.db store exists`,
    }
  }

  const files: string[] = []
  if (projectsPresent) {
    try {
      for await (const path of walkForFiles(projects, { pattern: '*.jsonl' })) {
        files.push(path)
        if (files.length >= FILE_SCAN_LIMIT) break
      }
    } catch (err) {
      reasons.push(`unreadable trace directory: ${String(err)}`)
    }
  } else {
    reasons.push(`no trace directory at ${projects}; only the SQLite store was found`)
  }

  if (files.length === 0) {
    reasons.push('directory exists but holds no session traces (upstream retention, §4.4 row 4)')
  } else {
    reasons.push(`${files.length} trace file(s) capped at ${FILE_SCAN_LIMIT}`)
  }

  return { present: true, agentVersion: null, dataRoot, reason: reasons.join('; ') }
}

async function pathPresent(ctx: HostContext, path: string): Promise<boolean> {
  try {
    return (await ctx.stat(path)) !== null
  } catch {
    return false
  }
}
