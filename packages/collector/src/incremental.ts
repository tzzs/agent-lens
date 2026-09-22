/**
 * Scheduler-side incremental state (§4.3): the `sources` row comparison that
 * decides skip/append/rotated, and the chunked read wrapper. The line-framing
 * reader itself lives in `@agentlens/event-model` (§5.4 — it is adapter
 * contract framing, and adapters may depend on event-model only); its names are
 * re-exported here so the collector surface stays unchanged.
 */
import { stat } from 'node:fs/promises'
import { readIncremental, type JsonlChunkMeta, type LineItem, type ReadIncrementalOptions } from '@agentlens/event-model'

export {
  isOversizedLine,
  parseLine,
  readIncremental,
  type JsonlChunkMeta,
  type JsonlLine,
  type LineItem,
  type OversizedLine,
  type ParseLineResult,
  type ReadIncrementalOptions,
} from '@agentlens/event-model'

export interface SourceStat {
  inode: number
  size: number
  mtimeMs: number
}

/** The persisted `sources` row fields the incremental decision needs. */
export interface SavedSourcePosition {
  inode: number
  size: number
  mtimeMs: number
  lastOffset: number
}

export type RescanDecision = 'skip' | 'append' | 'rotated'

export interface JsonlChunk extends JsonlChunkMeta {
  lines: LineItem[]
}

export async function statSource(path: string): Promise<SourceStat | null> {
  try {
    const s = await stat(path)
    return { inode: s.ino, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/**
 * §4.3 rotation/truncation: `size < lastOffset` or a changed inode means the
 * old bytes are gone — the caller marks the row `rotated`, keeps history, and
 * starts a fresh source row. Same `(inode, size)` and mtime ⇒ nothing happened.
 * `saved = { inode: 0, lastOffset: 0 }` is the never-scanned sentinel ⇒ append.
 */
export function needsRescan(statted: SourceStat, saved: SavedSourcePosition): RescanDecision {
  if (saved.lastOffset === 0 && saved.inode === 0) return 'append'
  if (statted.inode !== saved.inode || statted.size < saved.lastOffset) return 'rotated'
  if (statted.size === saved.lastOffset && statted.mtimeMs === saved.mtimeMs) return 'skip'
  return 'append'
}

export async function readJsonlChunk(
  path: string,
  fromOffset: number,
  opts: ReadIncrementalOptions = {},
): Promise<JsonlChunk> {
  const lines: LineItem[] = []
  const it = readIncremental(path, fromOffset, opts)
  while (true) {
    const r = await it.next()
    if (r.done) return { lines, ...r.value }
    lines.push(r.value)
  }
}
