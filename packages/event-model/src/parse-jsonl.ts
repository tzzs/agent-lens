/**
 * The reusable default JSONL framing behind `AgentAdapter.parse` (§5.1).
 *
 * Framing means "bytes to records": it delegates the whole offset/line-boundary
 * problem to the incremental reader (§4.3) and never throws — a line that
 * cannot be turned into a record is yielded as a marker record so `normalize`
 * can report it as a `ParseFailure` (§5.2 rule 1). Adapters whose session files
 * are plain JSONL can re-export `parseJsonlRecords` as their `parse`.
 */
import { stat } from 'node:fs/promises'
import type { ByteOffset, ParseCtx, RawRecord, RecordStream, SourceSpec } from './adapter.ts'
import type { TimestampOrigin } from './types.ts'
import { isOversizedLine, parseLine, readIncremental } from './incremental.ts'

/** Set on a record whose line could not be decoded, so normalize can report it (§5.2 rule 1). */
export const PARSE_ERROR_KEY = '__agentlensParseError'

/**
 * Payload of a marker record. One convention across collector and adapters: the
 * reason keeps its `json-parse: …` / `oversized-line: …` prefix so doctor output
 * stays stable, and `rawLine` carries the truncated offending text.
 */
export interface ParseErrorMarker {
  [PARSE_ERROR_KEY]: string
  rawLine: string
}

export function isParseErrorRecord(value: unknown): value is ParseErrorMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[PARSE_ERROR_KEY] === 'string'
  )
}

const RAW_LINE_LIMIT = 16 * 1024

/** Bounded raw text for a `ParseFailure` (§3.2/§6 forbid keeping whole source lines). */
export function truncate(text: string): string {
  return text.length > RAW_LINE_LIMIT ? `${text.slice(0, RAW_LINE_LIMIT)}…` : text
}

const TS_FIELDS = ['timestamp', 'created_at', 'createdAt', 'time', 'ts', 'created'] as const

/** §5.2: the record's own time, or `null` when it states none — the caller then has to say what it substituted. */
export function recordOccurredAt(value: unknown): number | null {
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
  return null
}

/** Best-effort generic timestamp extraction; adapters refine semantics (§5.1 RawRecord.occurredAt). */
export function resolveOccurredAt(value: unknown, fallback: number): number {
  return recordOccurredAt(value) ?? fallback
}

/** A record's `occurredAt` paired with what it is (§5.1). */
interface OccurredAt {
  occurredAt: number
  occurredAtOrigin: TimestampOrigin
}

/**
 * §5.2: an undated line is dated by its own source file's last write, which really does bound
 * it, and only a file that cannot be stat-ed leaves the scan clock. Stat-ed once per parse.
 */
async function sourceStamp(path: string): Promise<OccurredAt> {
  const st = await stat(path).catch(() => null)
  return st
    ? { occurredAt: st.mtimeMs, occurredAtOrigin: 'file-mtime' }
    : { occurredAt: Date.now(), occurredAtOrigin: 'ingest-clock' }
}

/**
 * Streams one `RawRecord` per complete line from `from.offset` to EOF and
 * returns the reader's `ParseTail`, which is the only safe place to resume.
 */
export async function* parseJsonlRecords(
  source: SourceSpec,
  from: ByteOffset,
  ctx: ParseCtx,
): RecordStream {
  const firstSeq = from.firstSeq ?? 1
  const it = readIncremental(source.path, from.offset, {
    firstSeq,
    maxLineBytes: ctx.maxLineBytes,
  })
  let undated: Promise<OccurredAt> | null = null
  const sourceStampOnce = (): Promise<OccurredAt> => (undated ??= sourceStamp(source.path))
  try {
    let produced = 0
    while (true) {
      if (ctx.signal?.aborted) {
        // Stop without claiming progress: the caller resumes where this stream started.
        return { nextOffset: from.offset, nextSeq: firstSeq }
      }
      const next = await it.next()
      if (next.done) return next.value
      const item = next.value
      // The reader numbers every line it emits, oversized markers included.
      const seq = 'seq' in item ? item.seq : firstSeq + produced
      produced++
      if (isOversizedLine(item)) {
        yield markerRecord(
          seq,
          item.offset,
          `oversized-line: ${item.bytes} bytes exceed maxLineBytes`,
          '',
          await sourceStampOnce(),
        )
        continue
      }
      const parsed = parseLine(item)
      if (!parsed.ok) {
        yield markerRecord(
          parsed.seq,
          parsed.offset,
          `json-parse: ${parsed.error}`,
          truncate(parsed.text),
          await sourceStampOnce(),
        )
        continue
      }
      const own = recordOccurredAt(parsed.value)
      const stamp: OccurredAt =
        own !== null ? { occurredAt: own, occurredAtOrigin: 'record' } : await sourceStampOnce()
      yield {
        seq,
        offset: parsed.offset,
        occurredAt: stamp.occurredAt,
        occurredAtOrigin: stamp.occurredAtOrigin,
        value: parsed.value,
      }
    }
  } finally {
    // Guarantees the reader's file handle closes when the consumer stops early.
    await it.return({ nextOffset: from.offset, nextSeq: firstSeq, residualBytes: 0 })
  }
}

function markerRecord(
  seq: number,
  offset: number,
  reason: string,
  rawLine: string,
  stamp: OccurredAt,
): RawRecord {
  const marker: ParseErrorMarker = { [PARSE_ERROR_KEY]: reason, rawLine }
  return { seq, offset, occurredAt: stamp.occurredAt, occurredAtOrigin: stamp.occurredAtOrigin, value: marker }
}
