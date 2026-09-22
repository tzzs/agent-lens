/**
 * §八·5a — the sixth source: `cli/agents/<parentSessionId>/agent_<agentId>/metadata.json`.
 *
 * This file tree, not the SQLite store, is where ZCode writes the foreign key that says which
 * `Agent` call opened a subagent session. Measured on this machine (28 files, 5 parent
 * sessions): 28/28 `childSessionId` values name a `session` row, and 28/28 `parentToolUseId`
 * values name both a `tool_usage.tool_call_id` and a `part.data.callID`, against exactly 28
 * `Agent` callIDs in `part`. A bijection, so the link is a fact and no time heuristic is
 * wanted (§五's last bullet).
 *
 * Two shapes here are unlike every other source in this adapter, and both are framing rather
 * than policy:
 *
 *  - **the document is one record, read whole.** `metadata.json` is pretty-printed JSON, so
 *    there is no line to frame and `kind:'jsonl'` is a container the collector accepts
 *    (`scanSource` throws on anything but `sqlite`/`jsonl`, and `ndir` has no implementation).
 *    `parse` therefore ignores `from.offset` entirely — see its comment for why an append
 *    resume into a rewritten document would otherwise read from mid-file.
 *  - **the parent is the directory name.** `spawnDirOf` reads it from the path, and the
 *    document's own `parentSessionId` agrees with the containing directory on 28/28 files,
 *    which is what makes the disagreement a diagnostic rather than a decision.
 *
 * The privacy rule (§八·5a) is enforced by the field allowlist below: the same document also
 * carries `prompt` (the entire subagent prompt — 4.8 KB on the sample read) and
 * `profileSnapshot.systemPrompt` (the entire agent system prompt). Neither is ever copied out
 * of this module, so no mapping branch can echo one by accident. The row-kind label the
 * records carry is `TABLE_AGENT_METADATA` (record.ts) — `discover` must not put a
 * `sqliteTable` on a file source, or the collector takes the rowid framing path (§4.3).
 */
/**
 * The `__table` / `metadata.table` name for this source is `TABLE_AGENT_METADATA`
 * (record.ts); `discover` cannot put a `sqliteTable` on a file source without the collector
 * taking the rowid path (§4.3).
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  PARSE_ERROR_KEY,
  deriveSourceId,
  walkForFiles,
  type HostContext,
  type ParseCtx,
  type ParseTail,
  type RawRecord,
  type RecordStream,
  type SourceSpec,
} from '@agentlens/event-model'
import { AGENT_SPAWN_DIR_PREFIX, AGENTS_METADATA_FILE, agentsDirOf } from './paths.ts'
import { AGENT_ID, TABLE_AGENT_METADATA, asRecord, iso, str, type UnknownRecord } from './record.ts'

/**
 * Keys copied into the record's `data`, and the ONLY ones. The two privacy keys (§八·5a) are
 * absent from this list on purpose: `prompt`, `profileSnapshot`, `description` (the task line
 * the operator typed) and the three `*File` keys (absolute paths on the user's disk) never
 * become part of a `RawRecord`, so they cannot reach `payload` or `metadata` even truncated.
 * The only other key read anywhere is `cwd`/`workspaceRoot`, and `readAgentsDocument` feeds
 * that to §4.1's project resolver without putting it in `data`.
 */
const MAPPED_KEYS: readonly string[] = [
  'agentId',
  'childSessionId',
  'parentSessionId',
  'parentToolUseId',
  'status',
  'createdAt',
  'completedAt',
  'totalTokens',
  'totalDurationMs',
  'totalToolUseCount',
  'usage',
]

export function isAgentsMetadataSource(source: SourceSpec): boolean {
  return basename(source.path) === AGENTS_METADATA_FILE && !source.sqliteTable
}

/** `<agentsRoot>/<parentSessionId>/agent_<agentId>/metadata.json`; anything else names no parent. */
export function spawnDirOf(filePath: string): string | null {
  const agentDir = dirname(filePath)
  const sessionDir = dirname(agentDir)
  if (!basename(agentDir).startsWith(AGENT_SPAWN_DIR_PREFIX)) return null
  const dir = basename(sessionDir)
  // `basename` of a root-ish path can come back '' or '/' — neither is a session id.
  return dir === '' || dir === '/' || dir === sessionDir ? null : dir
}

/** One `SourceSpec` per run document, sorted, so a rescan enumerates the same ids in the same order. */
export async function* discoverAgentsSources(ctx: HostContext): AsyncIterable<SourceSpec> {
  const root = agentsDirOf(ctx)
  const paths: string[] = []
  // `walkForFiles` skips a directory it cannot read and never follows a symlink; an absent
  // root simply yields nothing, which is the honest answer for a ZCode that never spawned.
  for await (const path of walkForFiles(root, { pattern: AGENTS_METADATA_FILE })) paths.push(path)
  paths.sort()
  for (const path of paths) {
    yield {
      id: deriveSourceId(AGENT_ID, path),
      path,
      // §5.1's accepted kind for "one document, no line framing": the collector's `ndir` has no
      // implementation, and any other kind makes `scanSource` throw.
      kind: 'jsonl',
      // Each document names its own child session, so no hint is needed.
      sessionHint: null,
    }
  }
}

interface FramedDocument {
  record: RawRecord
  tail: ParseTail
}

/**
 * Read the document whole and frame it as exactly one record.
 *
 * `from.offset` is ignored, deliberately: the resume the collector offers for a rewritten
 * document is an APPEND from the old byte size, and a JSON document has no line boundary there
 * — parsing from mid-file would fail on a file that is perfectly readable. Re-emitting the same
 * deterministic id instead is safe (§4.2): `insertEvents`' §5.3 repair upsert re-derives the
 * columns that changed, and both `seq` and the discriminator are constants of this source, so
 * the replay differs only where the document itself changed. Hence `nextOffset` is the size of
 * the bytes actually consumed and the document's ordinal is always 1.
 */
export async function readAgentsDocument(path: string, now: number): Promise<FramedDocument> {
  const buffer = await readFile(path)
  const size = buffer.byteLength
  let doc: UnknownRecord | null = null
  try {
    doc = asRecord(JSON.parse(buffer.toString('utf8')) as unknown)
  } catch {
    doc = null
  }
  if (doc === null) {
    // §5.2 rule 1: undecodable is a counted failure, never a dropped row. `rawLine` stays a
    // note rather than the bytes: this is the one document shape in the adapter that carries a
    // whole prompt (§八·5a), an undecodable document cannot be field-filtered before echoing,
    // and the path + offset + ordinal already say where to look — the same privacy-over-evidence
    // call §六 makes for `cli/rollout/`.
    return {
      record: {
        seq: 1,
        offset: size,
        occurredAt: now,
        occurredAtOrigin: 'ingest-clock',
        value: {
          [PARSE_ERROR_KEY]: `json-parse: undecodable ${TABLE_AGENT_METADATA} document (${String(size)}B)`,
          rawLine: '(body withheld: agents metadata documents carry the full subagent prompt)',
        },
      },
      tail: { nextOffset: size, nextSeq: 2 },
    }
  }

  const value: UnknownRecord = {
    __table: TABLE_AGENT_METADATA,
    // One document per source, so the ordinal is a constant and the event id is keyed by
    // `source_id` (the file path) instead.
    __rowid: 1,
    data: pick(doc),
    // The child session: its own rows live in this bucket's thread tree (§18 row 3), and its
    // `subagent.start` carries the same `native_session_id`.
    __session_id: str(doc.childSessionId),
    // The root, read off the directory. This is what puts the closing row in the SAME session
    // bucket as the chain it closes: nesting is one level here (measured 28/28 spawn dirs are
    // `sess_…` roots and no `sess_subagent_agent_…` child is ever a dir name), and the file
    // tree is the only evidence this source may read — the store's `parent_id` walk belongs to
    // another source and this one cannot query it (§5.2).
    __root_session_id: spawnDirOf(path),
    __session_parent_id: spawnDirOf(path),
    // `cwd` === `workspaceRoot` on 28/28, so either names the project; §4.1 still canonicalizes.
    __session_directory: str(doc.cwd) ?? str(doc.workspaceRoot),
  }

  const stated = iso(doc.completedAt) ?? iso(doc.createdAt)
  let mtime: number | null = null
  if (stated === null) {
    // 0/28 measured, so this is the guard rather than the path: the file's own clock is the
    // best remaining answer, and the scan clock only if even that is unreachable.
    mtime = await stat(path)
      .then((s) => (s.mtimeMs > 0 ? Math.round(s.mtimeMs) : null))
      .catch(() => null)
  }
  const timestamp = stated ?? mtime ?? now
  return {
    record: {
      seq: 1,
      offset: size,
      occurredAt: timestamp,
      occurredAtOrigin: stated !== null ? 'record' : mtime !== null ? 'file-mtime' : 'ingest-clock',
      value,
    },
    tail: { nextOffset: size, nextSeq: 2 },
  }
}

/** The allowlisted subset of a parsed document, with `usage` left as the raw sub-object. */
function pick(doc: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {}
  for (const key of MAPPED_KEYS) if (doc[key] !== undefined) out[key] = doc[key]
  return out
}

/** Framing for one document, as the generator `parse` delegates to. */
export async function* parseAgentsSource(source: SourceSpec, ctx: ParseCtx): RecordStream {
  if (ctx.signal?.aborted) {
    // Nothing was consumed, so the byte high-water must not move (§4.2).
    return { nextOffset: 0, nextSeq: 1 }
  }
  const { record, tail } = await readAgentsDocument(source.path, Date.now())
  yield record
  return tail
}
