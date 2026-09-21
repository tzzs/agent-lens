/**
 * §5.1 `discover` — the safely readable half of WorkBuddy's store: one JSONL source per
 * local execution trace under `~/.workbuddy/projects/*.jsonl`, deterministically ordered
 * so `source_id` enumeration and the fixture tests are stable (§4.2).
 *
 * Deliberately absent: a `kind: 'sqlite'` source for `workbuddy.db`. The collector
 * frames such sources through this adapter's own `parse` (§5.1), and this adapter's
 * `parse` would have to open the store with `node:sqlite` — and a read-only open of
 * this WAL store is what created `-wal`/`-shm` in the user's data directory (§二,
 * §18 row 7). Advertising a source whose framing is the side effect is the hole, so
 * the database is reported as a refusal by `sqlite.ts` instead, and `detect()` carries
 * that into doctor. See the note in index.ts on where the guard properly belongs.
 */
import { walkForFiles } from '@agentlens/collector'
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
    return // an unreadable store discovers nothing; detect() reports why
  }
  paths.sort()
  for (const path of paths) {
    yield {
      id: deriveSourceId(AGENT_ID, path),
      path,
      kind: 'jsonl',
      // §4.1: unlike Claude Code (measured one-file-one-session) the WorkBuddy census
      // never relates a file to its sessions, so the file name must not be hinted as a
      // session id; 50 of 52 records carry a native `sessionId` and the rest inherit it.
      sessionHint: null,
    }
  }
}
