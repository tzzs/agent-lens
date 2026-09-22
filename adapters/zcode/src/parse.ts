/**
 * §5.1 `parse` — row framing for a ZCode source: a SQLite table, or one whole
 * `cli/agents/…/agent_…/metadata.json` document (§八·5a).
 *
 * Three things differ from the JSONL path other adapters take and all three are deliberate:
 *  - `from.offset` / `nextOffset` carry a **rowid high-water mark**, not a byte position
 *    (§4.3: byte offsets are meaningless inside a b-tree), and `seq === offset === rowid`;
 *  - the SELECT joins the relational keys a row does not carry (`part` needs its message's
 *    role/model/provider/variant, every table needs its session's parent/directory/version),
 *    because without them a part row has no session, no role and no thread, and a
 *    `model_usage` row has no project and cannot say whether it is a subagent;
 *  - the store opened is `ctx.storePath ?? source.path`. `source.path` is the app's own
 *    file, which §18 row 7 keeps refusing; when the collector copied a WAL store and folded
 *    it, `storePath` is that rollback-mode copy in our directory.
 *
 * The agents document is the exception on all three counts, and `agents.ts` owns why: it is
 * pretty-printed JSON (no line to frame), it joins nothing (its keys are the document), and
 * it is read straight from `source.path` because reading a file is not opening a database.
 */
import { PARSE_ERROR_KEY, truncate } from '@agentlens/event-model'
import type { DatabaseSync } from 'node:sqlite'
import type { ByteOffset, ParseCtx, ParseTail, RecordStream, SourceSpec } from '@agentlens/event-model'
import { isAgentsMetadataSource, parseAgentsSource } from './agents.ts'
import {
  ms,
  parseJson,
  str,
  TABLE_MESSAGE,
  TABLE_MODEL_USAGE,
  TABLE_PART,
  TABLE_SESSION,
  TABLE_TOOL_USAGE,
  type UnknownRecord,
  type ZcodeTable,
} from './record.ts'
import { openReadOnly } from './safety.ts'

/** Session columns every table needs but none of them store. */
const SESSION_JOIN = [
  's.id AS __session_id',
  's.project_id AS __session_project_id',
  's.parent_id AS __session_parent_id',
  's.directory AS __session_directory',
  's.path AS __session_path',
  's.version AS __session_version',
  's.task_type AS __session_task_type',
  's.title_source AS __session_title_source',
  's.permission AS __session_permission',
].join(', ')

/** `message.data` semantics live inside JSON; reading them here keeps `normalize` IO-free. */
const MESSAGE_SEMANTICS = [
  `json_extract(%.data, '$.role') AS __message_role`,
  `json_extract(%.data, '$.semantics.kind') AS __message_kind`,
  `json_extract(%.data, '$.semantics.origin') AS __message_origin`,
]

function semanticsOf(alias: string): string {
  return MESSAGE_SEMANTICS.map((c) => c.replace('%', alias)).join(', ')
}

function selectFor(table: ZcodeTable): string {
  switch (table) {
    case TABLE_SESSION:
      // `s.*` already carries every joined column; the aliases exist so one scope builder
      // can read all five tables the same way.
      return `SELECT s.rowid AS __rowid, s.*, ${SESSION_JOIN} FROM "session" s WHERE s.rowid > ? ORDER BY s.rowid ASC`
    case TABLE_MESSAGE:
      return (
        `SELECT m.rowid AS __rowid, m.*, ${semanticsOf('m')}, ${SESSION_JOIN} ` +
        `FROM "message" m LEFT JOIN session s ON s.id = m.session_id ` +
        `WHERE m.rowid > ? ORDER BY m.rowid ASC`
      )
    case TABLE_PART:
      return (
        `SELECT p.rowid AS __rowid, p.*, ${semanticsOf('m')}, ` +
        `json_extract(m.data, '$.modelID') AS __message_model_id, ` +
        `json_extract(m.data, '$.providerID') AS __message_provider_id, ` +
        `json_extract(m.data, '$.variant') AS __message_variant, ${SESSION_JOIN} ` +
        `FROM "part" p LEFT JOIN "message" m ON m.id = p.message_id ` +
        `LEFT JOIN session s ON s.id = COALESCE(NULLIF(p.session_id, ''), m.session_id) ` +
        `WHERE p.rowid > ? ORDER BY p.rowid ASC`
      )
    case TABLE_MODEL_USAGE:
      return (
        `SELECT u.rowid AS __rowid, u.*, ${SESSION_JOIN} FROM "model_usage" u ` +
        `LEFT JOIN session s ON s.id = u.session_id WHERE u.rowid > ? ORDER BY u.rowid ASC`
      )
    case TABLE_TOOL_USAGE:
      return (
        `SELECT t.rowid AS __rowid, t.*, ${SESSION_JOIN} FROM "tool_usage" t ` +
        `LEFT JOIN session s ON s.id = t.session_id WHERE t.rowid > ? ORDER BY t.rowid ASC`
      )
    default:
      throw new Error(`zcode: unknown sqlite table ${JSON.stringify(table)}`)
  }
}

/** The ms-epoch column per table; usage tables name their start column differently. */
function timeColumnsFor(table: ZcodeTable): string[] {
  switch (table) {
    case TABLE_MODEL_USAGE:
    case TABLE_TOOL_USAGE:
      return ['started_at', 'completed_at', 'time_created']
    default:
      return ['time_created', 'time_updated']
  }
}

/**
 * `session.parent_id` chains subagent sessions (measured: 10 roots + 28 children), so one
 * product session owns one thread tree. The walk carries a `seen` set because the chain is
 * application-maintained, not schema-enforced: a cycle would otherwise spin forever.
 */
function loadSessionRoots(db: DatabaseSync): Map<string, string> {
  const parents = new Map<string, string | null>()
  try {
    for (const row of db.prepare(`SELECT id, parent_id FROM "session"`).all()) {
      const id = typeof row.id === 'string' ? row.id : null
      if (id) parents.set(id, typeof row.parent_id === 'string' ? row.parent_id : null)
    }
  } catch {
    // A store without a readable session table gives every row its own root; that is a
    // visible degradation (metadata.diagnostics), never a guess.
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
  // §八·5a: one pretty-printed document, so there is no line to resume into — `agents.ts`
  // reads it whole and says why the offered `from.offset` must be ignored rather than honoured.
  if (isAgentsMetadataSource(source)) return yield* parseAgentsSource(source, ctx)
  const table = (source.sqliteTable ?? '') as ZcodeTable
  // A WAL store reaches us as a rollback-mode copy in our own directory (§18 row 7);
  // `source.path` is the app's file, which this guard must keep refusing.
  const handle = await openReadOnly(ctx.storePath ?? source.path)
  const startRowid = Number.isFinite(from.offset) ? Math.max(0, Math.floor(from.offset)) : 0
  let lastRowid = startRowid
  try {
    const roots = loadSessionRoots(handle.db)
    const statement = handle.db.prepare(selectFor(table))
    const timeColumns = timeColumnsFor(table)
    for (const rawRow of statement.iterate(startRowid) as Iterable<UnknownRecord>) {
      if (ctx.signal?.aborted) return { nextOffset: lastRowid, nextSeq: lastRowid }
      const row = { ...rawRow }
      const rowid = Number(row.__rowid ?? row.rowid ?? 0)
      if (rowid > lastRowid) lastRowid = rowid
      const { data, raw } = dataOf(row)
      if (raw !== null && data === null) {
        // §5.2 rule 1: an undecodable `data` blob is reported, not dropped.
        yield {
          seq: rowid,
          offset: rowid,
          occurredAt: Date.now(),
          occurredAtOrigin: 'ingest-clock',
          value: {
            [PARSE_ERROR_KEY]: `json-parse: undecodable ${table}.data`,
            rawLine: truncate(raw),
          },
        }
        continue
      }
      const nativeSession =
        str(row.__session_id) ??
        (table === TABLE_SESSION ? str(row.id) : str(row.session_id)) ??
        null
      const value: UnknownRecord = {
        ...row,
        data: data ?? null,
        __table: table,
        __rowid: rowid,
        __root_session_id: nativeSession ? (roots.get(nativeSession) ?? nativeSession) : null,
      }
      // §5.2: a row that states no time has nothing per-row to read — the store's file mtime
      // belongs to whichever row was written last — so only the scan clock can stand in.
      let occurredAt: number | null = null
      for (const column of timeColumns) {
        occurredAt = ms(row[column])
        if (occurredAt !== null) break
      }
      yield {
        seq: rowid,
        offset: rowid,
        occurredAt: occurredAt ?? Date.now(),
        occurredAtOrigin: occurredAt === null ? 'ingest-clock' : 'record',
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
