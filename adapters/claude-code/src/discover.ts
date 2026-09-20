/**
 * §5.1 `discover` — one JSONL source per session file, plus the coverage-recovery
 * history index (§4.4 row 4: sessions whose file was deleted upstream are still
 * known here). Sorted output so `source_id` enumeration and fixture tests are stable.
 */
import { basename } from 'node:path'
import { walkForFiles } from '@agentlens/collector'
import { deriveSourceId, type HostContext, type SourceSpec } from '@agentlens/event-model'
import { AGENT_ID } from './record.ts'
import { historyFileOf, projectsDirOf } from './paths.ts'

export const HISTORY_SOURCE_FILE = 'history.jsonl'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  const paths: string[] = []
  for await (const path of walkForFiles(projectsDirOf(ctx), { pattern: '*.jsonl' })) {
    paths.push(path)
  }
  paths.sort()
  for (const path of paths) {
    yield {
      id: deriveSourceId(AGENT_ID, path),
      path,
      kind: 'jsonl',
      // §2.1: one file is one session and the file name is its native sessionId.
      sessionHint: basename(path, '.jsonl'),
    }
  }

  const history = historyFileOf(ctx)
  try {
    if ((await ctx.stat(history)) !== null) {
      yield { id: deriveSourceId(AGENT_ID, history), path: history, kind: 'jsonl', sessionHint: null }
    }
  } catch {
    /* an unreadable history index must not hide the session files we did find */
  }
}
