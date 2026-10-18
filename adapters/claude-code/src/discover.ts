/**
 * §5.1 `discover` — one JSONL source per session file, plus the coverage-recovery
 * history index (§4.4 row 4: sessions whose file was deleted upstream are still
 * known here). Sorted output so `source_id` enumeration and fixture tests are stable.
 *
 * §5.3: every root from `rootsOf` is walked, not just the canonical one. A model-switching
 * setup (`~/.claude-deepseek`) is real usage that no gateway can see, so dropping it would
 * understate the machine's activity. Source ids stay path-derived, so the two roots can never
 * collide; session ids come from the records' own `sessionId`, so a session that moved between
 * stores stays one session.
 */
import { basename, join } from 'node:path'
import { walkForFiles } from '@agentlens/event-model'
import { deriveSourceId, type HostContext, type SourceSpec } from '@agentlens/event-model'
import { AGENT_ID } from './record.ts'
import { historyFileOf, projectsDirOf, rootsOf } from './paths.ts'

export const HISTORY_SOURCE_FILE = 'history.jsonl'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  const roots = await rootsOf(ctx)
  const paths: string[] = []
  for (const root of roots) {
    for await (const path of walkForFiles(projectsDirOf(ctx, root), { pattern: '*.jsonl' })) {
      paths.push(path)
    }
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

  const histories = roots.map((root) => historyFileOf(ctx, root))
  histories.sort()
  for (const history of histories) {
    try {
      if ((await ctx.stat(history)) !== null) {
        yield { id: deriveSourceId(AGENT_ID, history), path: history, kind: 'jsonl', sessionHint: null }
      }
    } catch {
      /* an unreadable history index must not hide the session files we did find */
    }
  }
}
