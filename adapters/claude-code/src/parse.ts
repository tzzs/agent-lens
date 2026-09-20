/**
 * Line-delimited JSONL reader for Claude Code session files (§5.1 `parse`).
 *
 * The collector's incremental engine already guarantees whole lines and never
 * consumes a trailing fragment (§4.3); this layer only turns bytes into
 * `RawRecord`s. A malformed line becomes a marker record so `normalize()` can
 * report it as a `ParseFailure` — parsing itself never throws (§5.2 rule 1).
 */
import { readIncremental, isOversizedLine } from '@agentlens/collector'
import type { ByteOffset, ParseCtx, RawRecord, SourceSpec } from '@agentlens/event-model'
import { PARSE_ERROR_KEY, timestampMs, truncate } from './record.ts'

export async function* parse(
  source: SourceSpec,
  from: ByteOffset,
  ctx: ParseCtx,
): AsyncIterable<RawRecord> {
  const it = readIncremental(source.path, from.offset)
  while (true) {
    if (ctx.signal?.aborted) return
    const next = await it.next()
    if (next.done) return
    const item = next.value
    if (isOversizedLine(item)) {
      yield marker(item.offset, 0, `oversized-line: ${item.bytes} bytes exceed maxLineBytes`, '')
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(item.text)
    } catch (err) {
      yield marker(item.offset, item.seq, `json-parse: ${String(err)}`, truncate(item.text))
      continue
    }
    yield {
      seq: item.seq,
      offset: item.offset,
      occurredAt: timestampMs(asObj(value), Date.now()),
      value,
    }
  }
}

function marker(offset: number, seq: number, reason: string, rawLine: string): RawRecord {
  return { seq, offset, occurredAt: Date.now(), value: { [PARSE_ERROR_KEY]: reason, rawLine } }
}

function asObj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
