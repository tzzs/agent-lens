/**
 * §5.1 `detect` — presence and upstream version, read-only (§5.2 rule 3). Pi has no
 * SQLite store at all (docs/research/pi.md §一), so there is no sidecar hazard to assess
 * here and nothing to refuse.
 *
 * `agentVersion` comes from `settings.json#lastChangelogVersion` — the only version
 * marker the census found. It records "the changelog the user has been shown", not a
 * binary stamp, so it is reported as a version proxy and §5.3 drift detection rests on
 * `parserVersion` plus the unknown-type count regardless.
 */
import { walkForFiles } from '@agentlens/event-model'
import type { Detection, HostContext } from '@agentlens/event-model'
import { sessionsDirOf, settingsFileOf, rootOf } from './paths.ts'
import { asRecord, str } from './record.ts'

const FILE_SCAN_LIMIT = 500

export async function detect(ctx: HostContext): Promise<Detection> {
  const dataRoot = rootOf(ctx)
  const sessions = sessionsDirOf(ctx)
  const reasons: string[] = []

  let sessionsPresent = false
  try {
    sessionsPresent = (await ctx.stat(sessions)) !== null
  } catch {
    sessionsPresent = false
  }

  if (!sessionsPresent) {
    return {
      present: false,
      agentVersion: null,
      dataRoot,
      reason: `no Pi session directory at ${sessions}`,
    }
  }

  const files: string[] = []
  try {
    for await (const path of walkForFiles(sessions, { pattern: '*.jsonl' })) {
      files.push(path)
      if (files.length >= FILE_SCAN_LIMIT) break
    }
  } catch (err) {
    reasons.push(`unreadable session directory: ${String(err)}`)
  }

  if (files.length === 0) {
    reasons.push('directory exists but holds no session traces (upstream retention)')
  } else {
    reasons.push(`${files.length} session file(s) capped at ${FILE_SCAN_LIMIT}`)
  }

  const version = await readVersion(ctx)
  if (version === null) reasons.push('no settings.json#lastChangelogVersion; agentVersion unknown')

  return { present: true, agentVersion: version, dataRoot, reason: reasons.join('; ') }
}

async function readVersion(ctx: HostContext): Promise<string | null> {
  let text: string
  try {
    text = await ctx.readFile(settingsFileOf(ctx))
  } catch {
    return null
  }
  try {
    const settings = asRecord(JSON.parse(text))
    return settings ? str(settings.lastChangelogVersion) : null
  } catch {
    return null
  }
}
