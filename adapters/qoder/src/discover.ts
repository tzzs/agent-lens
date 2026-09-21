/**
 * §5.1 `discover` — one JSONL source per session file (§1.1: single-file
 * multi-session count measured at 0, so one file = one session and the file
 * name is its native sessionId). Deterministically sorted so `source_id`
 * enumeration and fixture tests are stable.
 */
import { basename } from 'node:path'
import { walkForFiles } from '@agentlens/event-model'
import { deriveSourceId, type HostContext, type SourceSpec } from '@agentlens/event-model'
import { AGENT_ID } from './record.ts'
import { projectsDirOf } from './paths.ts'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  const paths: string[] = []
  try {
    for await (const path of walkForFiles(projectsDirOf(ctx), { pattern: '*.jsonl' })) {
      paths.push(path)
    }
  } catch {
    return // an unreadable store discovers nothing; detect() reports the reason
  }
  paths.sort()
  for (const path of paths) {
    yield {
      id: deriveSourceId(AGENT_ID, path),
      path,
      kind: 'jsonl',
      sessionHint: basename(path, '.jsonl'),
    }
  }
}
