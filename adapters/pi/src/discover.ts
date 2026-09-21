/**
 * §5.1 `discover` — one JSONL source per Pi session trace under
 * `~/.pi/agent/sessions/<project-dir>` (plain JSONL files), deterministically ordered so
 * `source_id` enumeration and the fixture tests are stable (§4.2).
 *
 * `sessionHint` is the uuid embedded in the file name (`<iso>_<uuid>.jsonl`). Measured
 * 6/6 it equals the `session` header's native id (docs/research/pi.md §二.1), so it is a
 * faithful fallback for a file whose header was lost — the header itself always wins in
 * `normalize()`.
 */
import { walkForFiles } from '@agentlens/event-model'
import { basename } from 'node:path'
import { deriveSourceId, type HostContext, type SourceSpec } from '@agentlens/event-model'
import { AGENT_ID } from './record.ts'
import { sessionsDirOf } from './paths.ts'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  const paths: string[] = []
  try {
    for await (const path of walkForFiles(sessionsDirOf(ctx), { pattern: '*.jsonl' })) {
      paths.push(path)
    }
  } catch {
    return // an unreadable store discovers nothing; detect() reports why
  }
  paths.sort()
  for (const path of paths) yield specFor(path)
}

export function specFor(path: string): SourceSpec {
  return {
    id: deriveSourceId(AGENT_ID, path),
    path,
    kind: 'jsonl',
    sessionHint: sessionHintOf(path),
  }
}

/** `2026-05-29T12-44-14-706Z_019e73c3-….jsonl` → the uuid tail, or null if unrecognised. */
export function sessionHintOf(path: string): string | null {
  const name = basename(path, '.jsonl')
  const underscore = name.indexOf('_')
  if (underscore < 0) return null
  const uuid = name.slice(underscore + 1)
  return /^[0-9a-fA-F-]{8,}$/.test(uuid) ? uuid : null
}
