/**
 * JSONL incremental reader (docs/plan-v2.md §4.3).
 *
 * The invariant everything else trusts: `nextOffset` only ever points at a
 * line boundary produced by a terminating `\n`. A trailing fragment without
 * its newline is left unconsumed, because a concurrent writer may still be
 * appending to that line and re-reading it next scan is cheap, while
 * ingesting half a line would corrupt the count permanently.
 *
 * Home of this module is event-model (§5.4): it is the framing half of the
 * adapter contract — bytes to lines, before any agent-specific semantics —
 * and adapters read their own sources with it. The scheduler-side decision
 * helpers that consume a persisted `sources` row (`statSource`/`needsRescan`)
 * stay in collector.
 */
import { open } from 'node:fs/promises'

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024
const READ_BLOCK_BYTES = 64 * 1024
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/** A complete line: `offset` is the absolute byte position of its first byte, `seq` its ordinal in the file (1-based). */
export interface JsonlLine {
  seq: number
  offset: number
  text: string
}

/** Emitted instead of buffering a complete line that exceeds `maxLineBytes`. */
export interface OversizedLine {
  oversized: true
  offset: number
  bytes: number
}

export type LineItem = JsonlLine | OversizedLine

export function isOversizedLine(item: LineItem): item is OversizedLine {
  return 'oversized' in item
}

/** Completion value of `readIncremental`. */
export interface JsonlChunkMeta {
  /** Byte offset to resume from: the start of the residual fragment, or EOF. */
  nextOffset: number
  /** Seq the next scanned line will receive (continues across chunks). */
  nextSeq: number
  /** Byte length of the trailing fragment that lacked its terminating newline. */
  residualBytes: number
}

export interface ReadIncrementalOptions {
  /** Seq of the first line yielded; pass the prior chunk's `nextSeq` to keep file ordinals stable. */
  firstSeq?: number
  maxLineBytes?: number
}

/**
 * Streams complete lines from `fromOffset` to EOF. The generator's completion
 * value (`JsonlChunkMeta`) carries the safe resume offset; iterate manually or
 * wrap it to obtain one collected chunk.
 */
export async function* readIncremental(
  path: string,
  fromOffset: number,
  opts: ReadIncrementalOptions = {},
): AsyncGenerator<LineItem, JsonlChunkMeta> {
  const firstSeq = opts.firstSeq ?? 1
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  const fh = await open(path, 'r')
  try {
    let pos = fromOffset
    let lineStart = fromOffset
    let fragments: Buffer[] = []
    let oversized = false
    let seq = firstSeq

    while (true) {
      const block = Buffer.allocUnsafe(READ_BLOCK_BYTES)
      const { bytesRead } = await fh.read(block, 0, READ_BLOCK_BYTES, pos)
      if (bytesRead === 0) break
      let lineBegin = 0
      for (let i = 0; i < bytesRead; i++) {
        if (block[i] !== NEWLINE) continue
        const contentBytes = pos + i - lineStart
        if (oversized || contentBytes > maxLineBytes) {
          // Marker instead of text: an oversized line must never be buffered or decoded.
          yield { oversized: true, offset: lineStart, bytes: contentBytes }
        } else {
          fragments.push(block.subarray(lineBegin, i))
          yield { seq, offset: lineStart, text: decodeLine(fragments) }
        }
        seq++
        fragments = []
        oversized = false
        lineStart = pos + i + 1
        lineBegin = i + 1
      }
      if (!oversized) {
        const runningBytes = pos + bytesRead - lineStart
        if (runningBytes > maxLineBytes) {
          oversized = true
          fragments = [] // stop buffering: the line will be reported as a marker
        } else {
          fragments.push(block.subarray(lineBegin, bytesRead))
        }
      }
      pos += bytesRead
    }

    const residualBytes = pos - lineStart
    return { nextOffset: lineStart, nextSeq: seq, residualBytes }
  } finally {
    await fh.close()
  }
}

export type ParseLineResult =
  | { ok: true; seq: number; offset: number; value: unknown }
  | { ok: false; seq: number; offset: number; text: string; error: string }

/** Malformed JSON is data, not an exception: the caller records a ParseFailure (§5.2 rule 1). */
export function parseLine(line: JsonlLine): ParseLineResult {
  try {
    return { ok: true, seq: line.seq, offset: line.offset, value: JSON.parse(line.text) }
  } catch (err) {
    return { ok: false, seq: line.seq, offset: line.offset, text: line.text, error: String(err) }
  }
}

/** Views into per-iteration blocks, so one concat + decode is safe against split multi-byte chars. */
function decodeLine(parts: Buffer[]): string {
  const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
  let text = buf.toString('utf8')
  if (text.length > 0 && text.charCodeAt(text.length - 1) === CARRIAGE_RETURN) {
    // CRLF files are common on Windows-hosted agents; the \r is not line content.
    text = text.slice(0, -1)
  }
  return text
}
