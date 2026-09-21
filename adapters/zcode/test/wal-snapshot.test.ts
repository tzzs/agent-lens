/**
 * §18 row 7, end to end: the running ZCode app keeps `cli/db/db.sqlite` in WAL mode, so
 * nothing here may attach to it — yet the adapter must still be able to read it. The bridge
 * is the collector's snapshot copy (`packages/collector/src/sqlite-snapshot.ts`), which
 * reaches `parse` as `ParseCtx.storePath`. This is the proof that the bridge carries real
 * events while the app's own directory stays byte-identical, and that a missing bridge is
 * recorded rather than swallowed.
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  journalModeOf,
  scanSource,
  snapshotPathFor,
  type EventSink,
  type SavedSourceState,
  type SourceCommit,
} from '@agentlens/collector'
import type { AgentEvent, ParseFailure } from '@agentlens/event-model'
import { zcodeAdapter } from '../src/index.ts'
import { TABLE_MODEL_USAGE, TABLE_TOOL_USAGE } from '../src/record.ts'
import { buildHost } from '../fixtures/build-host.ts'
import { FIXED_NOW, sourceFor } from './helpers.ts'

class RecordingSink implements EventSink {
  events: AgentEvent[] = []
  failures = 0
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
    agentId: 'zcode',
    hostId: 'zcode',
    resolveProject: () => 'project:fixture',
    now: () => FIXED_NOW,
    ...(snapshotDir ? { snapshotDir } : {}),
  }
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

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
  it('produces usage events, leaves the app directory byte-identical, and stays incremental', async () => {
    const host = await buildHost({ subdir: 'cli/db', wal: true, retainWriter: true })
    const snapDir = await mkdtemp(join(tmpdir(), 'zcode-snap-'))
    try {
      const source = sourceFor(host.dbPath, TABLE_MODEL_USAGE)
      const beforeStamps = await stamps(host.dbPath)
      const beforeListing = await listing(host.root)

      const sink = new RecordingSink()
      const first = await scanSource(zcodeAdapter, source, scanCtx(sink, snapDir))
      const copy = snapshotPathFor(host.dbPath, snapDir)

      // Real usage rows came through the copy, with §四's subtraction applied.
      expect(first.events).toBe(6)
      expect(sink.events.length).toBe(6)
      expect(first.failures).toBe(0)
      const withCache = sink.events.find((e) => (e.usage?.cacheReadTokens ?? 0) > 0)
      expect(withCache?.usage?.inputTokens).toBe(4_031)
      expect((withCache?.usage?.inputTokens ?? 0) + (withCache?.usage?.cacheReadTokens ?? 0)).toBe(30_527)

      // The copy is an ordinary rollback store: that is what lets the adapter keep refusing
      // to attach to the real one.
      expect(journalModeOf(copy)).toBe('rollback')
      expect(first.nextOffset).toBeGreaterThan(0)

      expect(await stamps(host.dbPath)).toEqual(beforeStamps)
      expect(await listing(host.root)).toEqual(beforeListing)

      // A second scan resumes from the committed rowid, and an unchanged store is not
      // re-copied — so the snapshot file itself must keep its inode.
      const copyInode = (await stat(copy)).ino
      sink.events = []
      const second = await scanSource(zcodeAdapter, source, scanCtx(sink, snapDir))
      expect(second.events).toBe(0)
      expect(sink.events).toEqual([])
      expect(second.nextOffset).toBe(first.nextOffset)
      expect((await stat(copy)).ino).toBe(copyInode)
    } finally {
      await host.close()
      await rm(snapDir, { recursive: true, force: true })
    }
  })

  it('the tool ledger comes through the same bridge', async () => {
    const host = await buildHost({ subdir: 'cli/db', wal: true, retainWriter: true })
    const snapDir = await mkdtemp(join(tmpdir(), 'zcode-snap-'))
    try {
      const source = sourceFor(host.dbPath, TABLE_TOOL_USAGE)
      const sink = new RecordingSink()
      const result = await scanSource(zcodeAdapter, source, scanCtx(sink, snapDir))
      expect(result.events).toBe(8)
      expect(sink.events.every((e) => e.type === 'tool.end')).toBe(true)
      expect(sink.events.find((e) => e.metadata?.tool === 'mcp__plugin_mimosa_mimosa__security_scan_start')?.capability).toEqual({
        type: 'mcp',
        name: 'security_scan_start',
        provider: 'plugin_mimosa_mimosa',
      })
    } finally {
      await host.close()
      await rm(snapDir, { recursive: true, force: true })
    }
  })

  it('without a snapshot directory the store stays a visible refusal, not a silent zero', async () => {
    const host = await buildHost({ subdir: 'cli/db', wal: true, retainWriter: true })
    try {
      const source = sourceFor(host.dbPath, TABLE_MODEL_USAGE)
      const beforeListing = await listing(host.root)
      const sink = new RecordingSink()
      const result = await scanSource(zcodeAdapter, source, scanCtx(sink))
      expect(result.events).toBe(0)
      expect(result.refusal).toMatch(/WAL mode/)
      expect(sink.commits.at(-1)?.status).toBe('error')
      expect(sink.commits.at(-1)?.lastError).toMatch(/WAL/)
      expect(await listing(host.root)).toEqual(beforeListing)
    } finally {
      await host.close()
    }
  })
})
