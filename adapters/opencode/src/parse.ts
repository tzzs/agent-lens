/**
 * §5.1 `parse` — row framing for a SQLite source.
 *
 * Two things differ from the JSONL path and both are deliberate:
 *  - `from.offset` / `nextOffset` carry a **rowid high-water mark**, not a byte
 *    position (§4.3: byte offsets are meaningless inside a b-tree);
 *  - the SELECT joins the relational keys that `data` does not carry
 *    (`part.message_id`, `part.session_id`, `session.parent_id`), because
 *    without them a part row has no session, no role and no thread.
 */
import { PARSE_ERROR_KEY, truncate } from '@agentlens/collector'
import type { DatabaseSync } from 'node:sqlite'
import type { ByteOffset, ParseCtx, ParseTail, RecordStream, SourceSpec } from '@agentlens/event-model'
import { ms, parseJson, TABLE_MESSAGE, TABLE_PART, TABLE_SESSION, type OpenCodeTable, type UnknownRecord } from './record.ts'
import { openReadOnly } from './safety.ts'

function selectFor(table: OpenCodeTable): string {
  const sessionJoin = [
    's.id AS __session_id',
    's.project_id AS __session_project_id',
    's.parent_id AS __session_parent_id',
    's.directory AS __session_directory',
    's.agent AS __session_agent',
    's.model AS __session_model',
    's.version AS __session_version',
  ].join(', ')
  switch (table) {
    case TABLE_SESSION:
      return `SELECT s.rowid AS __rowid, s.* FROM "session" s WHERE s.rowid > ? ORDER BY s.rowid ASC`
    case TABLE_MESSAGE:
      return (
        `SELECT m.rowid AS __rowid, m.*, json_extract(m.data, '$.role') AS __message_role, ` +
        `${sessionJoin} FROM "message" m LEFT JOIN session s ON s.id = m.session_id ` +
        `WHERE m.rowid > ? ORDER BY m.rowid ASC`
      )
    case TABLE_PART:
      return (
        `SELECT p.rowid AS __rowid, p.*, json_extract(m.data, '$.role') AS __message_role, ` +
        `json_extract(m.data, '$.modelID') AS __message_model_id, ` +
        `json_extract(m.data, '$.providerID') AS __message_provider_id, ` +
        `json_extract(m.data, '$.variant') AS __message_variant, ${sessionJoin} ` +
        `FROM "part" p LEFT JOIN "message" m ON m.id = p.message_id ` +
        `LEFT JOIN session s ON s.id = COALESCE(p.session_id, m.session_id) ` +
        `WHERE p.rowid > ? ORDER BY p.rowid ASC`
      )
    default:
      throw new Error(`opencode: unknown sqlite table ${JSON.stringify(table)}`)
  }
}

/** `session.parent_id` chains subagent sessions; resolve to the root so one product session owns one thread tree. */
function loadSessionRoots(db: DatabaseSync): Map<string, string> {
  const parents = new Map<string, string | null>()
  try {
    for (const row of db.prepare(`SELECT id, parent_id FROM "session"`).all()) {
      const id = typeof row.id === 'string' ? row.id : null
      if (id) parents.set(id, typeof row.parent_id === 'string' ? row.parent_id : null)
    }
  } catch {
    // A store without a readable session table gives every row its own root; that is
    // a visible degradation (metadata.thread_unresolved), never a guess.
  }
  const roots = new Map<string, string>()
  for (const id of parents.keys()) {
    let cursor = id
    const seen = new Set<string>([cursor])
    for (;;) {
      const parent = parents.get(cursor) ?? null
      if (parent === null || seen.has(parent)) break
      seen.add(parent)
      cursor = parent
    }
    roots.set(id, cursor)
  }
  return roots
}

function dataOf(row: UnknownRecord): { data: UnknownRecord | null; raw: string | null } {
  const raw = typeof row.data === 'string' ? row.data : null
  if (raw === null) return { data: null, raw: null }
  return { data: parseJson(raw), raw }
}

export async function* parse(source: SourceSpec, from: ByteOffset, ctx: ParseCtx): RecordStream {
  const table = (source.sqliteTable ?? '') as OpenCodeTable
  const handle = await openReadOnly(source.path)
  const startOffset = Number.isFinite(from.offset) ? Math.max(0, Math.floor(from.offset)) : 0
  let lastRowid = startOffset
  try {
    const roots = loadSessionRoots(handle.db)
    const statement = handle.db.prepare(selectFor(table))
    for (const rawRow of statement.iterate(startOffset) as Iterable<UnknownRecord>) {
      if (ctx.signal?.aborted) return { nextOffset: lastRowid, nextSeq: lastRowid }
      const row = { ...rawRow }
      const rowid = Number(row.__rowid ?? row.rowid ?? 0)
      if (rowid > lastRowid) lastRowid = rowid
      const { data, raw } = dataOf(row)
      if (raw !== null && data === null) {
        yield {
          seq: rowid,
          offset: rowid,
          occurredAt: Date.now(),
          value: {
            [PARSE_ERROR_KEY]: `json-parse: undecodable ${table}.data`,
            rawLine: truncate(raw),
          },
        }
        continue
      }
      const nativeSession =
        typeof row.__session_id === 'string'
          ? row.__session_id
          : table === TABLE_SESSION && typeof row.id === 'string'
            ? row.id
            : null
      const value: UnknownRecord = {
        ...row,
        data: data ?? null,
        __table: table,
        __rowid: rowid,
        __root_session_id: nativeSession ? (roots.get(nativeSession) ?? nativeSession) : null,
      }
      yield {
        seq: rowid,
        offset: rowid,
        occurredAt: ms(row.time_created) ?? ms(row.time_updated) ?? Date.now(),
        value,
      }
    }
  } finally {
    handle.db.close()
    await handle.verifyNoSidecars()
  }
  const tail: ParseTail = { nextOffset: lastRowid, nextSeq: lastRowid }
  return tail
}
