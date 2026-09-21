/**
 * Adapter contract (docs/plan-v2.md §5.1). Adapters are pure translators: they never
 * open the database, never price a model, and never mutate a source file (§5.2).
 */
import type { AggregationPolicy, NormalizeResult, TimestampOrigin } from './types.ts'

export interface HostContext {
  /**
   * Absolute path to THIS agent's data root, e.g. `~/.claude`. `null` until `detect` has
   * resolved it: a caller that seeds this with the home directory makes every adapter look
   * for `<home>/projects` and report "not installed" on a machine that has the agent.
   */
  dataRoot: string | null
  homedir: string
  env: NodeJS.ProcessEnv
  /** Restricted to reads; adapters must not create or modify anything here. */
  readFile(path: string): Promise<string>
  readDir(path: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; inode: number } | null>
}

export interface Detection {
  present: boolean
  /** Upstream product version, used for drift reporting (§5.3). */
  agentVersion?: string | null
  dataRoot?: string | null
  reason?: string | null
}

export type SourceKind = 'jsonl' | 'sqlite' | 'ndir'

export interface SourceSpec {
  id: string
  path: string
  kind: SourceKind
  sessionHint?: string | null
  /** For `sqlite` sources: table + rowid high-water-mark replace byte offsets (§4.3). */
  sqliteTable?: string | null
}

export interface ByteOffset {
  /** Byte position to resume from; a trailing partial line is never consumed (§4.3). */
  offset: number
  /**
   * Absolute ordinal of the first record to emit (defaults to 1). WHY: `raw_seq`
   * participates in the deterministic event id fingerprint, so a resumed scan
   * must continue numbering or replays collide.
   */
  firstSeq?: number
}

export interface RawRecord {
  /** Ordinal within the source (line number, or rowid). */
  seq: number
  /** Byte offset of this record's first byte. */
  offset: number
  /** ms epoch from the record when parseable, else the source's own time (see `occurredAtOrigin`). */
  occurredAt: number
  /**
   * §5.2: what `occurredAt` actually is when the record stated no time of its own. Absent means
   * the record's own time — the pre-§19 reading of `occurredAt`, which every parser here keeps.
   */
  occurredAtOrigin?: TimestampOrigin
  value: unknown
}

/**
 * §5.2: the one way an adapter may settle on an event timestamp — the record's own time first,
 * then whatever the parser read off the source, and the scan clock only as the last resort and
 * always labelled. `recordTime` is what the adapter's own rule found (null: it found nothing).
 */
export function eventTimestamp(
  record: RawRecord,
  recordTime: number | null,
  now: number,
): { timestamp: number; origin: TimestampOrigin } {
  if (recordTime !== null && recordTime > 0) return { timestamp: recordTime, origin: 'record' }
  if (record.occurredAt > 0) {
    return { timestamp: record.occurredAt, origin: record.occurredAtOrigin ?? 'record' }
  }
  return { timestamp: now, origin: 'ingest-clock' }
}

export interface ParseCtx {
  source: SourceSpec
  agentId: string
  hostId: string
  /** Set when the adapter needs the parent record's identity (subagent trees). */
  sessionHint?: string | null
  signal?: AbortSignal
  /** Lines longer than this are reported as an unparseable marker instead of buffered (§4.3). */
  maxLineBytes?: number
  /**
   * Where to read a `kind:'sqlite'` source's store from; differs from `source.path`
   * when the collector copied a WAL store out of a directory neither we nor the app
   * should be disturbed by. Adapters that open the store themselves MUST read from
   * `storePath` when set, and MUST NOT create or modify any file at that path beyond
   * what SQLite needs.
   */
  storePath?: string
}

/**
 * Where a `parse` stream left off, carried on the generator's completion value.
 * WHY: only the reader knows how many trailing bytes belong to an unterminated
 * line, so the position travels on the completion value rather than in the
 * yielded records.
 */
export interface ParseTail {
  /** Byte offset of the last COMPLETELY consumed line boundary: the safe place to resume (§4.3). */
  nextOffset: number
  /** Ordinal the next record will get. */
  nextSeq: number
}

export type RecordStream = AsyncGenerator<RawRecord, ParseTail>

export interface NormalizeCtx extends ParseCtx {
  /** Canonical project id for the record's cwd; resolved by the collector (§4.1). */
  resolveProject(cwd: string | null | undefined): string | null
  now(): number
}

export interface CapabilityCatalog {
  type: 'skill' | 'mcp' | 'plugin' | 'connector' | 'hook' | 'subagent'
  name: string
  provider?: string | null
  /** Static catalog ⇒ "installed but never used" view (§5.1). */
  source: string
}

export interface AgentAdapter {
  readonly id: string
  readonly displayName: string
  /** Bump when parsing rules change; a mismatch triggers a full rescan of that source (§5.3). */
  readonly parserVersion: number
  /**
   * How this agent's usage must be folded before summing (§18 row 2). Required rather than
   * defaulted: an adapter that stays silent gets `request_max`, which is exactly the rule
   * that doubles Codex-style cumulative logs — the mistake has to be impossible to make.
   */
  readonly aggregation: AggregationPolicy
  detect(ctx: HostContext): Promise<Detection>
  discover(ctx: HostContext): AsyncIterable<SourceSpec>
  /** The single framing entry point (§5.1): bytes → `RawRecord`s, ending in a `ParseTail`. */
  parse(source: SourceSpec, from: ByteOffset, ctx: ParseCtx): RecordStream
  normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult>
  capabilities?(ctx: HostContext): Promise<CapabilityCatalog[]>
}
