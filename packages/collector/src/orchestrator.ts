/**
 * Source scan orchestration (docs/plan-v2.md §4.2/§4.3/§5.3).
 *
 * The orchestrator knows nothing about storage: it feeds an `EventSink`.
 * Crash-safety rule §4.2: `commitSource` — the only thing that advances
 * `last_offset` — runs after the whole batch was written; any throw before it
 * leaves the offset behind so the next scan replays the batch (writes are
 * idempotent via deterministic event ids).
 */
import type {
  AgentAdapter,
  AgentEvent,
  NormalizeCtx,
  ParseFailure,
  RawRecord,
  SourceSpec,
} from '@agentlens/event-model'
import { isParseFailure } from '@agentlens/event-model'
import {
  needsRescan,
  parseLine,
  readIncremental,
  statSource,
  type JsonlChunkMeta,
  type LineItem,
} from './incremental.ts'
import { readSqliteIncremental } from './sqlite-source.ts'

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
  /** Required for `kind: 'sqlite'` sources: which columns carry the rowid and the payload. */
  sqlite?: { rowidColumn: string; column: string }
  maxLineBytes?: number
}

export interface ScanResult {
  action: 'skip' | 'append' | 'rotated' | 'gone' | 'version-drift'
  linesConsumed: number
  events: number
  failures: number
  nextOffset: number
  nextSeq: number
}

const RAW_LINE_LIMIT = 16 * 1024

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
  const events: AgentEvent[] = []
  let linesConsumed = 0
  let failures = 0

  const it = readIncremental(source.path, fromOffset, { firstSeq, maxLineBytes: ctx.maxLineBytes })
  let meta: JsonlChunkMeta
  while (true) {
    const r = await it.next()
    if (r.done) {
      meta = r.value
      break
    }
    if (ctx.signal?.aborted) throw new Error(`scanSource: aborted at offset ${fromOffset}`)
    const item = r.value
    linesConsumed++
    const outcome = await consumeLine(item, adapter, normalizeCtx)
    if (outcome.kind === 'events') {
      events.push(...outcome.events)
    } else {
      failures++
      ctx.sink.writeParseFailure({ ...outcome.failure, path: source.path })
    }
  }

  if (events.length > 0) ctx.sink.writeEvents(events)
  // Only now may the offset move forward (§4.2).
  ctx.sink.commitSource({
    id: source.id,
    path: source.path,
    lastOffset: meta.nextOffset,
    inode: statted.inode,
    size: statted.size,
    mtimeMs: statted.mtimeMs,
    parserVersion: adapter.parserVersion,
    rowsIngested: linesConsumed,
    scanStartedAt: startedAt,
    scanFinishedAt: ctx.now(),
    status: decision === 'rotated' ? 'rotated' : 'active',
    lastError: null,
  })
  return {
    action: drift && decision !== 'rotated' ? 'version-drift' : decision,
    linesConsumed,
    events: events.length,
    failures,
    nextOffset: meta.nextOffset,
    nextSeq: meta.nextSeq,
  }
}

type LineOutcome =
  | { kind: 'events'; events: AgentEvent[] }
  | { kind: 'failure'; failure: ParseFailure }

async function consumeLine(
  item: LineItem,
  adapter: AgentAdapter,
  ctx: NormalizeCtx,
): Promise<LineOutcome> {
  if ('oversized' in item) {
    return {
      kind: 'failure',
      failure: {
        reason: `oversized-line: ${item.bytes} bytes exceed maxLineBytes`,
        rawLine: '',
        offset: item.offset,
      },
    }
  }
  const parsed = parseLine(item)
  if (!parsed.ok) {
    return {
      kind: 'failure',
      failure: {
        reason: `json-parse: ${parsed.error}`,
        rawLine: truncate(parsed.text),
        offset: parsed.offset,
        rawSeq: parsed.seq,
      },
    }
  }
  const record: RawRecord = {
    seq: parsed.seq,
    offset: parsed.offset,
    occurredAt: resolveOccurredAt(parsed.value, ctx.now()),
    value: parsed.value,
  }
  const result = await adapter.normalize(record, ctx)
  if (isParseFailure(result)) return { kind: 'failure', failure: result.failure }
  return { kind: 'events', events: result.events }
}

function scanSqliteSource(
  adapter: AgentAdapter,
  source: SourceSpec,
  ctx: ScanCtx,
  startedAt: number,
  drift: boolean,
): Promise<ScanResult> {
  return (async () => {
    if (!source.sqliteTable) {
      throw new Error(`scanSource: sqlite source ${source.id} has no sqliteTable`)
    }
    const cols = ctx.sqlite ?? { rowidColumn: 'rowid', column: 'value' }
    const fromRowid = drift ? 0 : ctx.saved.lastOffset
    const chunk = readSqliteIncremental(source.path, {
      table: source.sqliteTable,
      rowidColumn: cols.rowidColumn,
      column: cols.column,
      fromRowid,
    })
    const stat = await statSource(source.path)
    const normalizeCtx = buildNormalizeCtx(ctx, source)
    const events: AgentEvent[] = []
    let failures = 0
    for (const row of chunk.rows) {
      if (ctx.signal?.aborted) throw new Error(`scanSource: aborted at rowid ${row.rowid}`)
      let value: unknown
      try {
        value = JSON.parse(row.value)
      } catch (err) {
        failures++
        ctx.sink.writeParseFailure({
          path: source.path,
          reason: `json-parse: ${String(err)}`,
          rawLine: truncate(row.value),
          offset: row.rowid,
          rawSeq: row.rowid,
        })
        continue
      }
      const record: RawRecord = {
        seq: row.rowid,
        offset: row.rowid, // for sqlite sources the "offset" is the rowid
        occurredAt: resolveOccurredAt(value, stat?.mtimeMs ?? ctx.now()),
        value,
      }
      const result = await adapter.normalize(record, normalizeCtx)
      if (isParseFailure(result)) {
        failures++
        ctx.sink.writeParseFailure({ ...result.failure, path: source.path })
      } else {
        events.push(...result.events)
      }
    }
    if (events.length > 0) ctx.sink.writeEvents(events)
    ctx.sink.commitSource({
      id: source.id,
      path: source.path,
      lastOffset: chunk.nextRowid,
      inode: stat?.inode ?? 0,
      size: stat?.size ?? 0,
      mtimeMs: stat?.mtimeMs ?? 0,
      parserVersion: adapter.parserVersion,
      rowsIngested: chunk.rows.length,
      scanStartedAt: startedAt,
      scanFinishedAt: ctx.now(),
      status: 'active',
      lastError: null,
    })
    return {
      action: drift ? 'version-drift' : 'append',
      linesConsumed: chunk.rows.length,
      events: events.length,
      failures,
      nextOffset: chunk.nextRowid,
      nextSeq: chunk.nextRowid,
    }
  })()
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

function buildNormalizeCtx(ctx: ScanCtx, source: SourceSpec): NormalizeCtx {
  return {
    source,
    agentId: ctx.agentId,
    hostId: ctx.hostId,
    sessionHint: source.sessionHint ?? null,
    signal: ctx.signal,
    resolveProject: ctx.resolveProject,
    now: ctx.now,
  }
}

const TS_FIELDS = ['timestamp', 'created_at', 'createdAt', 'time', 'ts', 'created'] as const

/** Best-effort generic timestamp extraction; adapters refine semantics (§5.1 RawRecord.occurredAt). */
function resolveOccurredAt(value: unknown, fallback: number): number {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const field of TS_FIELDS) {
      const v = obj[field]
      if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v
      if (typeof v === 'string') {
        const ms = Date.parse(v)
        if (!Number.isNaN(ms)) return ms
      }
    }
  }
  return fallback
}

function truncate(text: string): string {
  return text.length > RAW_LINE_LIMIT ? `${text.slice(0, RAW_LINE_LIMIT)}…` : text
}
