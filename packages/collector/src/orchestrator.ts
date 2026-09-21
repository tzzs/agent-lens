/**
 * Source scan orchestration (docs/plan-v2.md §4.2/§4.3/§5.3).
 *
 * The orchestrator knows nothing about storage: it feeds an `EventSink`. Framing
 * (bytes → `RawRecord`s) is the adapter's `parse` (§5.1), never this module's.
 * Crash-safety rule §4.2: `commitSource` — the only thing that advances
 * `last_offset` — runs after the whole batch was written; any throw before it
 * leaves the offset behind so the next scan replays the batch (writes are
 * idempotent via deterministic event ids).
 */
import type {
  AgentAdapter,
  AgentEvent,
  NormalizeCtx,
  ParseCtx,
  ParseFailure,
  ParseTail,
  RecordStream,
  SourceSpec,
} from '@agentlens/event-model'
import { isParseFailure } from '@agentlens/event-model'
import { needsRescan, statSource } from './incremental.ts'
import { isParseErrorRecord, PARSE_ERROR_KEY } from './parse-jsonl.ts'
import { WalModeRefusedError, journalModeOf } from './sqlite-source.ts'

export interface SourceCommit {
  id: string
  path: string
  lastOffset: number
  inode: number
  size: number
  mtimeMs: number
  parserVersion: number
  /** Lines/rows consumed by this batch; the sink keeps a running total (it seeds `firstSeq` on the next scan). */
  rowsIngested: number
  scanStartedAt: number
  scanFinishedAt: number
  /**
   * `'rotated'` means this commit's `(inode, lastOffset)` describe the NEW
   * file at `path`: the sink should archive the previous row state and start
   * fresh from here, keeping historical events (§4.3).
   */
  status: 'active' | 'rotated' | 'error' | 'gone'
  lastError: string | null
}

export interface EventSink {
  writeEvents(events: readonly AgentEvent[]): void
  writeParseFailure(f: ParseFailure & { path: string }): void
  commitSource(p: SourceCommit): void
}

/** Persisted `sources` row state the scan needs to resume. */
export interface SavedSourceState {
  lastOffset: number
  inode: number
  size: number
  mtimeMs: number
  parserVersion: number
  /** Complete lines consumed so far; `firstSeq` for the next scan is this + 1. */
  linesConsumed: number
}

export interface ScanCtx {
  sink: EventSink
  saved: SavedSourceState
  agentId: string
  hostId: string
  resolveProject(cwd: string | null | undefined): string | null
  now(): number
  signal?: AbortSignal
  maxLineBytes?: number
}

export interface ScanResult {
  action: 'skip' | 'append' | 'rotated' | 'gone' | 'version-drift'
  linesConsumed: number
  events: number
  failures: number
  nextOffset: number
  nextSeq: number
  /**
   * Set when the source was left alone on purpose rather than read — today only
   * §18 row 7's WAL refusal. `action` stays `'skip'`, and the reason is recorded
   * on the source row so `agl status` and `doctor` can show it later (§5.2).
   */
  refusal?: string
}

/** §5.3: parser_version mismatch ⇒ full rescan from 0, safe only because writes are idempotent (§4.2). */
export function rescanSourceOnVersionDrift(
  adapter: Pick<AgentAdapter, 'parserVersion'>,
  savedParserVersion: number,
): boolean {
  return adapter.parserVersion !== savedParserVersion
}

export async function scanSource(
  adapter: AgentAdapter,
  source: SourceSpec,
  ctx: ScanCtx,
): Promise<ScanResult> {
  const startedAt = ctx.now()
  const drift = rescanSourceOnVersionDrift(adapter, ctx.saved.parserVersion)
  if (drift && source.kind !== 'sqlite' && (await statSource(source.path)) === null) {
    return commitGone(adapter, source, ctx, startedAt)
  }
  if (source.kind === 'sqlite') return scanSqliteSource(adapter, source, ctx, startedAt, drift)
  if (source.kind !== 'jsonl') {
    throw new Error(`scanSource: unsupported source kind ${JSON.stringify(source.kind)}`)
  }

  const statted = await statSource(source.path)
  if (statted === null) return commitGone(adapter, source, ctx, startedAt)

  const decision = needsRescan(statted, ctx.saved)
  if (decision === 'skip' && !drift) {
    return { action: 'skip', linesConsumed: 0, events: 0, failures: 0, nextOffset: ctx.saved.lastOffset, nextSeq: ctx.saved.linesConsumed + 1 }
  }
  const fullRescan = decision === 'rotated' || drift
  const fromOffset = fullRescan ? 0 : ctx.saved.lastOffset
  const firstSeq = fullRescan ? 1 : ctx.saved.linesConsumed + 1

  const normalizeCtx = buildNormalizeCtx(ctx, source)

  // §5.1: framing is the adapter's job — `parse` is the only entry point for source → records.
  const stream = adapter.parse(source, { offset: fromOffset, firstSeq }, buildParseCtx(ctx, source))
  const batch = await consumeRecords(stream, adapter, source, ctx, normalizeCtx)
  const { tail, events } = batch

  if (events.length > 0) ctx.sink.writeEvents(events)
  // Only now may the offset move forward (§4.2).
  ctx.sink.commitSource({
    id: source.id,
    path: source.path,
    lastOffset: tail.nextOffset,
    inode: statted.inode,
    size: statted.size,
    mtimeMs: statted.mtimeMs,
    parserVersion: adapter.parserVersion,
    rowsIngested: batch.linesConsumed,
    scanStartedAt: startedAt,
    scanFinishedAt: ctx.now(),
    status: decision === 'rotated' ? 'rotated' : 'active',
    lastError: null,
  })
  return {
    action: drift && decision !== 'rotated' ? 'version-drift' : decision,
    linesConsumed: batch.linesConsumed,
    events: events.length,
    failures: batch.failures,
    nextOffset: tail.nextOffset,
    nextSeq: tail.nextSeq,
  }
}

/**
 * The single record-consuming loop behind both source kinds, so they cannot drift:
 * parse-error markers and `normalize` failures go to the sink as `ParseFailure`s
 * (§5.2 rule 1), everything else becomes events that wait for one batched
 * `writeEvents` before `commitSource` (§4.2).
 */
async function consumeRecords(
  stream: RecordStream,
  adapter: AgentAdapter,
  source: SourceSpec,
  ctx: ScanCtx,
  normalizeCtx: NormalizeCtx,
): Promise<{ tail: ParseTail; linesConsumed: number; events: AgentEvent[]; failures: number }> {
  const events: AgentEvent[] = []
  let linesConsumed = 0
  let failures = 0
  while (true) {
    const r = await stream.next()
    if (r.done) return { tail: r.value, linesConsumed, events, failures }
    if (ctx.signal?.aborted) throw new Error(`scanSource: aborted at offset ${r.value.offset}`)
    const record = r.value
    linesConsumed++
    if (isParseErrorRecord(record.value)) {
      failures++
      ctx.sink.writeParseFailure({
        reason: record.value[PARSE_ERROR_KEY],
        rawLine: record.value.rawLine,
        offset: record.offset,
        rawSeq: record.seq,
        path: source.path,
      })
      continue
    }
    const result = await adapter.normalize(record, normalizeCtx)
    if (isParseFailure(result)) {
      failures++
      ctx.sink.writeParseFailure({ ...result.failure, path: source.path })
    } else {
      events.push(...result.events)
    }
  }
}

async function scanSqliteSource(
  adapter: AgentAdapter,
  source: SourceSpec,
  ctx: ScanCtx,
  startedAt: number,
  drift: boolean,
): Promise<ScanResult> {
  if (!source.sqliteTable) {
    throw new Error(`scanSource: sqlite source ${source.id} has no sqliteTable`)
  }
  // §4.3: for sqlite sources `last_offset` is the rowid high-water mark; rotation and
  // inode/size heuristics do not apply, and §5.3 drift restarts the stream from 0.
  const fromRowid = drift ? 0 : ctx.saved.lastOffset
  const firstSeq = drift ? 1 : ctx.saved.linesConsumed + 1
  if (journalModeOf(source.path) === 'wal') {
    // §5.2: a store we will not open is a reported fact, not a dead scan. The offset
    // stays where it was because nothing was read.
    const err = new WalModeRefusedError(source.path)
    const stat = await statSource(source.path)
    ctx.sink.commitSource({
      id: source.id,
      path: source.path,
      lastOffset: fromRowid,
      inode: stat?.inode ?? 0,
      size: stat?.size ?? 0,
      mtimeMs: stat?.mtimeMs ?? 0,
      parserVersion: adapter.parserVersion,
      rowsIngested: 0,
      scanStartedAt: startedAt,
      scanFinishedAt: ctx.now(),
      status: 'error',
      lastError: err.message,
    })
    return {
      action: 'skip',
      linesConsumed: 0,
      events: 0,
      failures: 0,
      nextOffset: fromRowid,
      nextSeq: ctx.saved.linesConsumed + 1,
      refusal: err.message,
    }
  }
  const stat = await statSource(source.path)
  const normalizeCtx = buildNormalizeCtx(ctx, source)
  // §5.1: framing is the adapter's job for row stores too — only its `parse` can
  // produce the joined row shape its `normalize` expects.
  const stream = adapter.parse(source, { offset: fromRowid, firstSeq }, buildParseCtx(ctx, source))
  const batch = await consumeRecords(stream, adapter, source, ctx, normalizeCtx)

  if (batch.events.length > 0) ctx.sink.writeEvents(batch.events)
  // Only now may the high-water mark move forward (§4.2).
  ctx.sink.commitSource({
    id: source.id,
    path: source.path,
    lastOffset: batch.tail.nextOffset,
    inode: stat?.inode ?? 0,
    size: stat?.size ?? 0,
    mtimeMs: stat?.mtimeMs ?? 0,
    parserVersion: adapter.parserVersion,
    rowsIngested: batch.linesConsumed,
    scanStartedAt: startedAt,
    scanFinishedAt: ctx.now(),
    status: 'active',
    lastError: null,
  })
  return {
    action: drift ? 'version-drift' : 'append',
    linesConsumed: batch.linesConsumed,
    events: batch.events.length,
    failures: batch.failures,
    nextOffset: batch.tail.nextOffset,
    nextSeq: batch.tail.nextSeq,
  }
}

function commitGone(
  adapter: AgentAdapter,
  source: SourceSpec,
  ctx: ScanCtx,
  startedAt: number,
): ScanResult {
  const s = ctx.saved
  ctx.sink.commitSource({
    id: source.id,
    path: source.path,
    lastOffset: s.lastOffset,
    inode: s.inode,
    size: s.size,
    mtimeMs: s.mtimeMs,
    parserVersion: adapter.parserVersion,
    rowsIngested: 0,
    scanStartedAt: startedAt,
    scanFinishedAt: ctx.now(),
    status: 'gone',
    lastError: 'source file is missing',
  })
  return { action: 'gone', linesConsumed: 0, events: 0, failures: 0, nextOffset: s.lastOffset, nextSeq: s.linesConsumed + 1 }
}

function buildParseCtx(ctx: ScanCtx, source: SourceSpec): ParseCtx {
  return {
    source,
    agentId: ctx.agentId,
    hostId: ctx.hostId,
    sessionHint: source.sessionHint ?? null,
    signal: ctx.signal,
    maxLineBytes: ctx.maxLineBytes,
  }
}

function buildNormalizeCtx(ctx: ScanCtx, source: SourceSpec): NormalizeCtx {
  return {
    ...buildParseCtx(ctx, source),
    resolveProject: ctx.resolveProject,
    now: ctx.now,
  }
}
