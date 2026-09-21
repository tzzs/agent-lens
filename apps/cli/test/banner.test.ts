/**
 * §14: the first screen has to lead with what the numbers cannot say. Two things
 * were measured on the real host and are easy to miss — upstream retention leaves a
 * project directory in place after its session files are gone, and one agent's total
 * can be almost entirely produced by a single machine. Both are pinned here so a
 * quiet-looking overview can never be mistaken for a complete one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, updateSourceProgress } from '@agentlens/storage'
import { bannerWarnings } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-banner-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const ctx = { now: () => Date.UTC(2026, 8, 21), homedir: tmp } as Ctx

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(join(tmp, `b-${Math.random().toString(36).slice(2)}.db`))
  migrate(db)
  return db
}

function ev(hostId: string, i: number): AgentEvent {
  return {
    schemaVersion: 1,
    id: `e-${hostId}-${i}`,
    agentId: 'claude-code',
    hostId,
    sourceId: 'src-banner',
    sessionId: `sess-${i}`,
    projectId: 'proj-banner',
    timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: i,
    rawOffset: i,
    usage: null,
  }
}

describe('bannerWarnings (§14 first screen)', () => {
  it('says nothing when the host is clean', () => {
    const db = freshDb()
    insertEvents(db, [ev('claude-code', 1), ev('claude-code', 2)])
    expect(bannerWarnings(db, ctx)).toEqual([])
    db.close()
  })

  it('reports a source dir that survives its own session files', () => {
    const db = freshDb()
    updateSourceProgress(db, {
      id: 'src-retained',
      agentId: 'claude-code',
      path: join(tmp, 'deleted-session.jsonl'),
      kind: 'jsonl',
      inode: 1,
      size: 0,
      mtimeMs: 0,
      lastOffset: 0,
      parserVersion: 1,
      sessionIdHint: null,
      status: 'active',
      lastError: null,
      scanStartedAt: 0,
      scanFinishedAt: 0,
      rowsIngested: 0,
    })
    const lines = bannerWarnings(db, ctx)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/upstream retention/)
    // Home is redacted: the banner is printed on a shared terminal (§12).
    expect(lines[0]).not.toContain(tmp)
    db.close()
  })

  it('calls out an agent total that one host produced almost alone', () => {
    const db = freshDb()
    insertEvents(db, [...Array(19).keys()].map((i) => ev('desk-laptop', i)).concat(ev('build-server', 99)))
    const lines = bannerWarnings(db, ctx)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('95.0%')
    expect(lines[0]).toContain('claude-code')
    expect(lines[0]).toContain('desk-laptop')
    expect(lines[0]).toContain('build-server')
    db.close()
  })

  it('stays quiet for a small or evenly split corpus', () => {
    const even = freshDb()
    insertEvents(even, [ev('desk-laptop', 1), ev('desk-laptop', 2), ev('build-server', 3), ev('build-server', 4)])
    expect(bannerWarnings(even, ctx)).toEqual([])
    const small = freshDb()
    insertEvents(small, [...Array(8).keys()].map((i) => ev('desk-laptop', i)).concat(ev('build-server', 99)))
    expect(bannerWarnings(small, ctx)).toEqual([])
    even.close()
    small.close()
  })
})
