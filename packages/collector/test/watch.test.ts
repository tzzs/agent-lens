import { mkdtemp, appendFile, rm, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  deriveEventId,
  deriveSourceId,
  type AgentAdapter,
  type AgentEvent,
  type HostContext,
  type NormalizeCtx,
  type NormalizeResult,
  type ParseFailure,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { parseJsonlRecords } from '@agentlens/event-model'
import { scanSource, type EventSink, type SavedSourceState, type SourceCommit } from '../src/orchestrator.ts'
import { createWatcher, type WatchTarget, type WatcherOptions } from '../src/watch.ts'

let currentTmp: string | null = null
async function tmp(name: string): Promise<string> {
  if (!currentTmp) currentTmp = await mkdtemp(join(tmpdir(), 'collector-watch-'))
  return join(currentTmp, name)
}
afterEach(async () => {
  if (currentTmp) await rm(currentTmp, { recursive: true, force: true })
  currentTmp = null
})

/** Pure JSONL adapter: one `message.user` event per record; `{"bad":true}` ⇒ ParseFailure. */
function fakeAdapter(id = 'fake'): AgentAdapter {
  return {
    id,
    displayName: 'Fake',
    parserVersion: 1,
    aggregation: { mode: 'per_record_sum', subagentsIncluded: false },
    async detect(): Promise<{ present: boolean }> {
      return { present: true }
    },
    async *discover(): AsyncIterable<SourceSpec> {},
    parse: (source, from, ctx) => parseJsonlRecords(source, from, ctx),
    async normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
      const value = record.value as { bad?: boolean; text?: string }
      if (value?.bad) {
        return {
          failure: { reason: 'unmappable', rawLine: JSON.stringify(value), offset: record.offset, rawSeq: record.seq } satisfies ParseFailure,
        }
      }
      const event: AgentEvent = {
        id: deriveEventId({ sourceId: ctx.source.id, rawSeq: record.seq, type: 'message.user', timestamp: record.occurredAt, discriminator: value.text ?? null }),
        schemaVersion: SCHEMA_VERSION,
        agentId: ctx.agentId,
        hostId: ctx.hostId,
        sourceId: ctx.source.id,
        sessionId: 'session-1',
        projectId: 'proj-1',
        timestamp: record.occurredAt,
        type: 'message.user',
        usageSource: 'missing',
        status: 'ok',
        rawSeq: record.seq,
        rawOffset: record.offset,
        metadata: { text: value.text ?? null },
      }
      return { events: [event] }
    },
  }
}

const rec = (n: number): string => JSON.stringify({ text: `msg-${n}`, timestamp: 1_700_000_000_000 + n })
const body = (...ns: number[]): string => ns.map((n) => rec(n) + '\n').join('')

/** A source the sink is committed to: mirrors the CLI's `makeTarget` (offset advances only after commit, §4.2). */
interface Harness {
  events: AgentEvent[]
  commits: SourceCommit[]
  scanShouldThrow: () => void
  target: WatchTarget
  state: () => SavedSourceState
}

function harness(adapter: AgentAdapter, path: string, opts: { scanThrows?: boolean } = {}): Harness {
  const source: SourceSpec = { id: deriveSourceId(adapter.id, path), path, kind: 'jsonl' }
  const state: SavedSourceState = { lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: adapter.parserVersion, linesConsumed: 0 }
  const events: AgentEvent[] = []
  const commits: SourceCommit[] = []
  const h: Harness = {
    events,
    commits,
    scanShouldThrow: () => {
      opts.scanThrows = true
    },
    target: null as unknown as WatchTarget,
    state: () => state,
  }
  const sink: EventSink = {
    writeEvents: (evs) => events.push(...evs),
    writeParseFailure: () => {},
    commitSource: (p) => {
      commits.push(p)
      Object.assign(state, {
        lastOffset: p.lastOffset,
        inode: p.inode,
        size: p.size,
        mtimeMs: p.mtimeMs,
        parserVersion: p.parserVersion,
        linesConsumed: state.linesConsumed + p.rowsIngested,
      })
      h.target.saved = { inode: p.inode, size: p.size, mtimeMs: p.mtimeMs, lastOffset: p.lastOffset }
    },
  }
  h.target = {
    id: source.id,
    agentId: adapter.id,
    adapter,
    source,
    saved: { inode: 0, size: 0, mtimeMs: 0, lastOffset: 0 },
    scan: async () => {
      if (opts.scanThrows) throw new Error('scan exploded')
      return scanSource(adapter, source, {
        sink,
        saved: state,
        agentId: adapter.id,
        hostId: adapter.id,
        resolveProject: () => 'proj-1',
        now: () => 1_700_000_000_000,
      })
    },
  }
  return h
}

/** Watcher with no timers/hints — the test drives `tick()`/`scanOnce()` directly. */
function watcher(targets: WatchTarget[], extra: Omit<WatcherOptions, 'targets'> = {}) {
  return createWatcher({ useFsWatch: false, discoverIntervalMs: 0, now: () => Date.now(), ...extra, targets })
}

describe('watcher.tick — append (§4.3)', () => {
  it('append-only growth triggers exactly one scan and advances the offset by whole lines only', async () => {
    const path = await tmp('a.jsonl')
    await writeFile(path, body(1, 2))
    const h = harness(fakeAdapter(), path)
    const w = watcher([h.target])

    const first = await w.tick()
    expect(first.scanned).toHaveLength(1)
    expect(first.scanned[0]!.events).toBe(2)
    expect(h.state().lastOffset).toBe(Buffer.byteLength(body(1, 2)))

    // A trailing partial line (no `\n`) is read but NOT consumed: 0 new events, offset frozen.
    await writeFile(path, body(1, 2) + '{"text":"partial"')
    const second = await w.tick()
    expect(second.scanned[0]!.events).toBe(0) // partial line left unconsumed
    expect(h.state().lastOffset).toBe(Buffer.byteLength(body(1, 2)))

    // Completing the line picks it up on the next tick, once.
    await writeFile(path, body(1, 2, 3))
    const third = await w.tick()
    expect(third.scanned).toHaveLength(1)
    expect(h.events.map((e) => (e.metadata as { text: string }).text)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(h.state().lastOffset).toBe(Buffer.byteLength(body(1, 2, 3)))

    // An unchanged file yields no scan at all (needsRescan ⇒ skip).
    const fourth = await w.tick()
    expect(fourth.scanned).toHaveLength(0)
    expect(fourth.vanished).toHaveLength(0)
  })

  it('a growing file scanned twice in one loop wakes once per change', async () => {
    const path = await tmp('grow.jsonl')
    await writeFile(path, body(1))
    const h = harness(fakeAdapter(), path)
    let batches = 0
    const w = watcher([h.target], { onBatch: () => batches++ })
    await w.tick()
    await appendFile(path, body(2))
    await w.tick()
    expect(batches).toBe(2)
    expect(h.state().lastOffset).toBe(Buffer.byteLength(body(1, 2)))
  })
})

describe('watcher.tick — rotation/truncation (§4.3)', () => {
  it('truncated file (size < lastOffset) is rescanned from 0 and reported as rotated', async () => {
    const path = await tmp('rot.jsonl')
    await writeFile(path, body(1, 2, 3))
    const h = harness(fakeAdapter(), path)
    const w = watcher([h.target])
    await w.tick()
    const fullOffset = h.state().lastOffset

    await writeFile(path, body(9)) // smaller content
    const r = await w.tick()
    expect(r.scanned[0]!.action).toBe('rotated')
    expect(h.commits.at(-1)!.status).toBe('rotated')
    expect(h.state().lastOffset).toBe(Buffer.byteLength(body(9)))
    expect(h.state().lastOffset).toBeLessThan(fullOffset)
    expect(h.events.at(-1)!.metadata).toEqual({ text: 'msg-9' })
  })

  it('inode change (file replaced) is treated as rotated at the same path', async () => {
    const path = await tmp('inode.jsonl')
    const swap = await tmp('inode.swap')
    await writeFile(path, body(1, 2, 3))
    const h = harness(fakeAdapter(), path)
    const w = watcher([h.target])
    await w.tick()
    const oldInode = h.state().inode

    await writeFile(swap, body(7) + body(8))
    await unlink(path)
    await rename(swap, path) // new inode, same path
    const r = await w.tick()
    expect(r.scanned[0]!.action).toBe('rotated')
    expect(h.state().inode).not.toBe(oldInode)
    expect(h.events.at(-1)!.metadata).toEqual({ text: 'msg-8' })
  })
})

describe('watcher.tick — discovery + vanishing (§4.3)', () => {
  it('a new file appearing in a watched directory is discovered on the next cycle', async () => {
    const a = await tmp('s-a.jsonl')
    await writeFile(a, body(1))
    const adapter = fakeAdapter()
    const ha = harness(adapter, a)
    const w = watcher([ha.target], {
      discoverIntervalMs: 1,
      now: () => Date.now(),
    })
    // Attach an enumerator that lists the directory and yields a target per *.jsonl.
    ha.target.discover = async function* (): AsyncIterable<WatchTarget> {
      const { readdir } = await import('node:fs/promises')
      for (const name of (await readdir(currentTmp!)).filter((n) => n.endsWith('.jsonl')).sort()) {
        const p = join(currentTmp!, name)
        if (p === a) continue // already tracked under ha.target
        const hb = harness(adapter, p)
        hb.target.discover = ha.target.discover
        yield hb.target
      }
    }
    const first = await w.scanOnce()
    expect(first.scanned.map((s) => s.path)).toEqual([a])

    const b = await tmp('s-b.jsonl')
    await writeFile(b, body(2))
    const second = await w.scanOnce() // scanOnce forces a discovery pass
    expect(second.discovered).toContain(deriveSourceId('fake', b))
    expect(second.scanned.some((s) => s.path === b)).toBe(true)
    expect(w.targets).toHaveLength(2)
  })

  it('a source vanishing flips status to gone without erasing history', async () => {
    const path = await tmp('gone.jsonl')
    await writeFile(path, body(1, 2))
    const h = harness(fakeAdapter(), path)
    const w = watcher([h.target])
    await w.tick()
    const ingested = [...h.events]
    const offset = h.state().lastOffset

    await unlink(path)
    const gone = await w.tick()
    expect(gone.vanished).toEqual([h.target.id])
    expect(h.commits.at(-1)!.status).toBe('gone')
    expect(h.state().lastOffset).toBe(offset) // history/offset preserved, not deleted

    // The second tick does not re-commit gone.
    const again = await w.tick()
    expect(again.vanished).toHaveLength(0)
    expect(h.events).toEqual(ingested)
  })
})

describe('watcher.tick — failure isolation (§4.2/§5.2)', () => {
  it('one adapter throwing leaves the other source progressing and does not advance the failing offset', async () => {
    const goodPath = await tmp('good.jsonl')
    const badPath = await tmp('bad.jsonl')
    await writeFile(goodPath, body(1))
    await writeFile(badPath, body(1))
    const good = harness(fakeAdapter('good'), goodPath)
    const bad = harness(fakeAdapter('bad'), badPath, { scanThrows: true })
    const w = watcher([good.target, bad.target], { maxFailures: 3 })

    const first = await w.tick()
    expect(first.scanned.map((s) => s.agentId)).toEqual(['good'])
    expect(first.failed.map((f) => f.agentId)).toEqual(['bad'])
    expect(good.state().lastOffset).toBe(Buffer.byteLength(body(1)))
    expect(bad.state().lastOffset).toBe(0) // failing source never advanced

    // The failing source is retried, then quarantined after maxFailures; good keeps working.
    await appendFile(goodPath, body(2))
    await w.tick()
    await appendFile(goodPath, body(3))
    const last = await w.tick()
    expect(good.state().lastOffset).toBe(Buffer.byteLength(body(1, 2, 3)))
    // bad was quarantined on its 3rd consecutive failure (2 above + this one).
    expect(last.failed.some((f) => f.agentId === 'bad')).toBe(true)
    const afterQuarantine = await w.tick()
    expect(afterQuarantine.failed.some((f) => f.agentId === 'bad')).toBe(false)
  })
})
