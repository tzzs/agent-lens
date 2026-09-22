/**
 * §18 row 7, end to end: a running OpenCode keeps its store in WAL mode, so nothing
 * here may attach to it — yet the adapter must still be able to read it. The bridge is
 * the collector's snapshot copy (`sqlite-snapshot.ts`), which reaches `parse` as
 * `ParseCtx.storePath`. This is the proof that the bridge carries real events while the
 * app's own directory stays byte-identical.
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  journalModeOf,
  snapshotPathFor,
  scanSource,
  type EventSink,
  type SavedSourceState,
  type SourceCommit,
} from '@agentlens/collector'
import type { AgentEvent, ParseFailure } from '@agentlens/event-model'
import { openCodeAdapter } from '../src/index.ts'
import { buildHost } from '../fixtures/build-host.ts'
import { FIXED_NOW, sourceFor } from './helpers.ts'

class RecordingSink implements EventSink {
  events: AgentEvent[] = []
  failures: number = 0
  commits: SourceCommit[] = []
  persisted: SavedSourceState = { lastOffset: 0, inode: 0, size: 0, mtimeMs: 0, parserVersion: 1, linesConsumed: 0 }

  writeEvents(events: readonly AgentEvent[]): void {
    this.events.push(...events)
  }
  writeParseFailure(failure: ParseFailure & { path: string }): void {
    this.failures += 1
    void failure
  }
  commitSource(commit: SourceCommit): void {
    this.commits.push(commit)
    // Mutated in place: a ScanCtx holds this object, so a rescan must see the new offset.
    Object.assign(this.persisted, {
      lastOffset: commit.lastOffset,
      inode: commit.inode,
      size: commit.size,
      mtimeMs: commit.mtimeMs,
      parserVersion: commit.parserVersion,
      linesConsumed: this.persisted.linesConsumed + commit.rowsIngested,
    })
  }
}

function scanCtx(sink: RecordingSink, snapshotDir?: string) {
  return {
    sink,
    saved: sink.persisted,
    agentId: 'opencode',
    hostId: 'opencode',
    resolveProject: () => 'project:fixture',
    now: () => FIXED_NOW,
    ...(snapshotDir ? { snapshotDir } : {}),
  }
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

/** size + mtime + inode of the store and both sidecars: any write of ours shows up here. */
async function stamps(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const s = await stat(p)
      out[p.slice(path.length)] = `${s.size}|${s.mtimeMs}|${s.ino}`
    } catch {
      out[p.slice(path.length)] = 'absent'
    }
  }
  return out
}

describe('a live WAL store read through the collector snapshot (§18 row 7)', () => {
  it('produces events, leaves the app directory byte-identical, and stays incremental', async () => {
    const host = await buildHost({ wal: true, retainWriter: true })
    const snapDir = await mkdtemp(join(tmpdir(), 'opencode-snap-'))
    try {
      const source = sourceFor(host.dbPath, 'part')
      const beforeStamps = await stamps(host.dbPath)
      const beforeListing = await listing(host.root)

      const sink = new RecordingSink()
      const first = await scanSource(openCodeAdapter, source, scanCtx(sink, snapDir))
      const copy = snapshotPathFor(host.dbPath, snapDir)

      expect(first.events).toBeGreaterThan(0)
      expect(sink.events.length).toBe(first.events)
      expect(first.failures).toBe(0)
      // The copy is an ordinary rollback store: that is what lets the adapter keep
      // refusing to attach to the real one.
      expect(journalModeOf(copy)).toBe('rollback')
      expect(first.nextOffset).toBeGreaterThan(0)

      expect(await stamps(host.dbPath)).toEqual(beforeStamps)
      expect(await listing(host.root)).toEqual(beforeListing)

      // A second scan resumes from the committed rowid, and an unchanged store is not
      // re-copied — so the snapshot file itself must keep its inode.
      const copyInode = (await stat(copy)).ino
      sink.events = []
      const second = await scanSource(openCodeAdapter, source, scanCtx(sink, snapDir))
      expect(second.events).toBe(0)
      expect(sink.events).toEqual([])
      expect(second.nextOffset).toBe(first.nextOffset)
      expect((await stat(copy)).ino).toBe(copyInode)
    } finally {
      await host.close()
      await rm(snapDir, { recursive: true, force: true })
    }
  })

  it('without a snapshot directory the store stays a visible refusal, not a silent zero', async () => {
    const host = await buildHost({ wal: true, retainWriter: true })
    try {
      const source = sourceFor(host.dbPath, 'part')
      const beforeListing = await listing(host.root)
      const sink = new RecordingSink()
      const result = await scanSource(openCodeAdapter, source, scanCtx(sink))
      expect(result.events).toBe(0)
      expect(result.refusal).toMatch(/WAL mode/)
      expect(sink.commits.at(-1)?.status).toBe('error')
      expect(await listing(host.root)).toEqual(beforeListing)
    } finally {
      await host.close()
    }
  })
})
