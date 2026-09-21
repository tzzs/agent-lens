/**
 * §5.1 `discover` — one JSONL source per Codex thread file.
 *
 * `sessions/**` holds live threads and `archived_sessions/**` archived ones: codex.md's
 * sample covers both (379 files), and archived threads carry real usage, so scanning only
 * `sessions/` would under-report. Sorted so `source_id` enumeration stays deterministic.
 */
import { basename } from 'node:path'
import { walkForFiles } from '@agentlens/collector'
import { deriveSourceId, type HostContext, type SourceSpec } from '@agentlens/event-model'
import { sessionsDirsOf, threadHintFromPath } from './paths.ts'
import { AGENT_ID } from './record.ts'

export const ROLLOUT_PATTERN = 'rollout-*.jsonl'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  const paths: string[] = []
  for (const dir of sessionsDirsOf(ctx)) {
    for await (const path of walkForFiles(dir, { pattern: ROLLOUT_PATTERN })) {
      paths.push(path)
    }
  }
  paths.sort()
  for (const path of paths) {
    yield {
      id: deriveSourceId(AGENT_ID, path),
      path,
      kind: 'jsonl',
      // §18 row 3: the file is a THREAD, not a session. The hint is only the filename's
      // thread token, used when a resumed scan starts after this file's session_meta.
      sessionHint: threadHintFromPath(path) ?? basename(path, '.jsonl'),
    }
  }
}

export { rootOf } from './paths.ts'
