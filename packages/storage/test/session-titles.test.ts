/**
 * §10: `sessions.title` was a column with no writer, so the session list fell back to
 * "Untitled <agent> session" on a machine whose logs hold 5,338 title records. These tests pin the
 * derivation to the rules that make it trustworthy: a human-set title outranks a generated one,
 * the newest wins inside a kind, the answer is a pure function of stored rows (so §4.2's replay
 * stays a no-op and a title arriving from another source file reads the same), and nothing is
 * invented where there is no evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '@agentlens/event-model'
import { deriveSessionTitles, selectSessionTitle } from '../src/session-titles.ts'
import { insertEvents, migrate, openDatabase } from '../src/index.ts'

const T0 = 1_700_000_000_000

function titleEvent(id: string, sessionId: string, subtype: string, title: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: over.sourceId ?? 'src-a',
    sessionId,
    projectId: 'proj-x',
    timestamp: over.timestamp ?? T0,
    ingestedAt: T0,
    type: 'unknown',
    subtype,
    usageSource: 'missing',
    status: 'ok',
    rawSeq: over.rawSeq ?? 1,
    rawOffset: 0,
    metadata: { mapped: true, session_scoped: true, upstream_type: subtype, value: { title } },
  } as unknown as AgentEvent
}

function seeded(events: AgentEvent[]): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, events, { contentEnabled: false })
  return db
}

const titleOf = (db: DatabaseSync, sessionId: string): string | null =>
  (db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null }).title

describe('selectSessionTitle (precedence, in isolation)', () => {
  it('prefers the human title even when the generated one came later', () => {
    expect(selectSessionTitle([{ session_id: 's', subtype: 'custom-title', title: 'Ship the telemetry' }, { session_id: 's', subtype: 'ai-title', title: 'Work in progress' }])).toBe('Ship the telemetry')
  })

  it('takes the newest of the preferred kind, and trims', () => {
    expect(selectSessionTitle([
      { session_id: 's', subtype: 'custom-title', title: 'first' },
      { session_id: 's', subtype: 'custom-title', title: '  renamed twice  ' },
    ])).toBe('renamed twice')
    expect(selectSessionTitle([])).toBeNull()
  })
})

describe('deriveSessionTitles (§4.2, §10)', () => {
  it('titles a session from its own rows, newest human title winning', () => {
    const db = seeded([
      titleEvent('t1', 'sess-a', 'custom-title', 'first name', { timestamp: T0 + 1 }),
      titleEvent('t2', 'sess-a', 'custom-title', 'renamed', { timestamp: T0 + 5 }),
      titleEvent('t3', 'sess-a', 'ai-title', 'generated name', { timestamp: T0 + 9 }),
      titleEvent('t4', 'sess-b', 'ai-title', 'only generated', { timestamp: T0 + 2 }),
    ])
    const stats = deriveSessionTitles(db)
    expect(titleOf(db, 'sess-a')).toBe('renamed')
    expect(titleOf(db, 'sess-b')).toBe('only generated')
    expect(stats.withEvidence).toBe(2)
    expect(stats.updated).toBe(2)
    db.close()
  })

  it('reads a title that arrived through a different source file of the same session', () => {
    const db = seeded([
      titleEvent('x1', 'sess-multi', 'session.start', '', { sourceId: 'src-main' }),
      titleEvent('x2', 'sess-multi', 'custom-title', 'titled elsewhere', { sourceId: 'src-side', timestamp: T0 + 3 }),
    ])
    deriveSessionTitles(db)
    expect(titleOf(db, 'sess-multi')).toBe('titled elsewhere')
    db.close()
  })

  it('is a no-op the second time, so a replay converges (§4.2)', () => {
    const db = seeded([titleEvent('r1', 'sess-c', 'custom-title', 'stable', { timestamp: T0 + 1 })])
    expect(deriveSessionTitles(db).updated).toBe(1)
    expect(deriveSessionTitles(db).updated).toBe(0)
    expect(titleOf(db, 'sess-c')).toBe('stable')
    db.close()
  })

  it('follows a rename instead of sticking at the first title', () => {
    const db = seeded([titleEvent('n1', 'sess-d', 'custom-title', 'before', { timestamp: T0 + 1 })])
    deriveSessionTitles(db)
    insertEvents(db, [titleEvent('n2', 'sess-d', 'custom-title', 'after', { timestamp: T0 + 8 })], { contentEnabled: false })
    expect(deriveSessionTitles(db).updated).toBe(1)
    expect(titleOf(db, 'sess-d')).toBe('after')
    db.close()
  })

  it('leaves a session with no title evidence at NULL rather than inventing one', () => {
    const db = seeded([titleEvent('e1', 'sess-e', 'custom-title', '   '), titleEvent('e2', 'sess-f', 'mode', 'x')])
    const stats = deriveSessionTitles(db)
    expect(stats.updated).toBe(0)
    expect(titleOf(db, 'sess-e')).toBeNull()
    db.close()
  })

  // No "session row is gone" case: `events.session_id` is a foreign key, so a session cannot
  // vanish while its title rows exist — the delete itself is refused (§6).
})
