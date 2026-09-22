/**
 * §4.1 attribution, session layer: a session row parked in the unattributed bucket while its own
 * events name the project. Two halves, one bug — the batch seed must not let a no-cwd record win
 * (`insertEvents`), and rows already latched have to be re-derived from the store
 * (`deriveSessionProjects`). These pin both, plus the three limits that keep the repair
 * trustworthy: it only leaves the unknown bucket, it never re-homes an attributed session, and it
 * invents nothing when there is no evidence.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { UNATTRIBUTED_PROJECT_ID, type AgentEvent } from '@agentlens/event-model'
import { deriveSessionProjects, insertEvents, migrate, openDatabase } from '../src/index.ts'

const T0 = 1_700_000_000_000

function ev(id: string, sessionId: string, projectId: string | null, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'qoder',
    hostId: 'qoder',
    sourceId: 'src-a',
    sessionId,
    projectId,
    timestamp: T0,
    ingestedAt: T0,
    type: 'message.assistant',
    usageSource: 'missing',
    status: 'ok',
    rawSeq: Number(id.replace(/\D/g, '')) || 1,
    rawOffset: 0,
  } as unknown as AgentEvent
}

function seeded(events: AgentEvent[]): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, events, { contentEnabled: false })
  return db
}

const projectOf = (db: DatabaseSync, sessionId: string): string | null =>
  (db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null }).project_id

/** The first qoder/claude-code record is bookkeeping with no cwd, so it lands in the bucket. */
const NO_CWD = UNATTRIBUTED_PROJECT_ID

describe('insertEvents session seed (the latch)', () => {
  it('does not let a no-cwd record win the seed against a cwd record in the same batch', () => {
    const db = seeded([
      ev('e1', 'sess-a', NO_CWD),
      ev('e2', 'sess-a', 'proj-real'),
      ev('e3', 'sess-a', 'proj-real'),
    ])
    expect(projectOf(db, 'sess-a')).toBe('proj-real')
    db.close()
  })

  it('keeps a real project once named, whatever arrives after it', () => {
    const db = seeded([ev('e1', 'sess-b', 'proj-real'), ev('e2', 'sess-b', NO_CWD)])
    expect(projectOf(db, 'sess-b')).toBe('proj-real')
    db.close()
  })

  it('still reports a session whose every record lacked a cwd', () => {
    const db = seeded([ev('e1', 'sess-c', NO_CWD), ev('e2', 'sess-c', NO_CWD)])
    expect(projectOf(db, 'sess-c')).toBe(NO_CWD)
    db.close()
  })

  it('leaves the repair nothing to do when the seed already settled it', () => {
    const db = seeded([ev('q1', 'sess-q', NO_CWD), ev('q2', 'sess-q', 'proj-real')])
    expect(deriveSessionProjects(db)).toEqual({ stuck: 0, upgraded: 0 })
    expect(projectOf(db, 'sess-q')).toBe('proj-real')
    db.close()
  })
})

describe('deriveSessionProjects (§4.1, the repair)', () => {
  it('lifts a latched session onto the project its own events name', () => {
    // The reported shape: one unattributed first row, then the transcript proper.
    const db = openDatabase(':memory:')
    migrate(db)
    insertEvents(db, [ev('r1', 'sess-latched', NO_CWD)], { contentEnabled: false })
    expect(projectOf(db, 'sess-latched')).toBe(NO_CWD)
    insertEvents(db, [ev('r2', 'sess-latched', 'proj-agent-lens'), ev('r3', 'sess-latched', 'proj-agent-lens')], { contentEnabled: false })

    const stats = deriveSessionProjects(db)
    expect(stats).toEqual({ stuck: 1, upgraded: 1 })
    expect(projectOf(db, 'sess-latched')).toBe('proj-agent-lens')
    db.close()
  })

  it('takes the majority project, not the first one it happens to see', () => {
    const db = seeded([
      ev('m1', 'sess-m', NO_CWD),
      ev('m2', 'sess-m', 'proj-a'),
      ev('m3', 'sess-m', 'proj-b'),
      ev('m4', 'sess-m', 'proj-b'),
      ev('m5', 'sess-m', 'proj-b'),
    ])
    // The seed already settled it; prove the derivation agrees from a latched start.
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(UNATTRIBUTED_PROJECT_ID, 'sess-m')
    expect(deriveSessionProjects(db).upgraded).toBe(1)
    expect(projectOf(db, 'sess-m')).toBe('proj-b')
    db.close()
  })

  it('breaks a tie on the digest so two runs cannot disagree', () => {
    const db = seeded([ev('t1', 'sess-t', NO_CWD), ev('t2', 'sess-t', 'proj-z'), ev('t3', 'sess-t', 'proj-a')])
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(UNATTRIBUTED_PROJECT_ID, 'sess-t')
    deriveSessionProjects(db)
    expect(projectOf(db, 'sess-t')).toBe('proj-a')
    db.close()
  })

  it('leaves an attributed session alone even when its events mostly name elsewhere', () => {
    const db = seeded([
      ev('k1', 'sess-keep', 'proj-first'),
      ev('k2', 'sess-keep', 'proj-other'),
      ev('k3', 'sess-keep', 'proj-other'),
    ])
    expect(deriveSessionProjects(db)).toEqual({ stuck: 0, upgraded: 0 })
    expect(projectOf(db, 'sess-keep')).toBe('proj-first')
    db.close()
  })

  it('keeps the bucket honest when no record ever carried a cwd', () => {
    const db = seeded([ev('n1', 'sess-none', NO_CWD), ev('n2', 'sess-none', NO_CWD)])
    expect(deriveSessionProjects(db)).toEqual({ stuck: 0, upgraded: 0 })
    expect(projectOf(db, 'sess-none')).toBe(NO_CWD)
    db.close()
  })

  it('is a no-op the second time, so a replay converges (§4.2)', () => {
    const db = seeded([ev('c1', 'sess-conv', NO_CWD), ev('c2', 'sess-conv', 'proj-x')])
    // The seed settles a fresh batch; force the latch the pre-fix store is full of to watch the
    // repair run once and then hold.
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(UNATTRIBUTED_PROJECT_ID, 'sess-conv')
    expect(deriveSessionProjects(db).upgraded).toBe(1)
    expect(deriveSessionProjects(db)).toEqual({ stuck: 0, upgraded: 0 })
    expect(projectOf(db, 'sess-conv')).toBe('proj-x')
    db.close()
  })

  it('repairs a session that no batch will ever touch again', () => {
    // A latched row from before the seed fix, with its evidence already stored: a scan that
    // ingests nothing new still has to be able to settle it.
    const db = seeded([ev('o1', 'sess-old', NO_CWD), ev('o2', 'sess-old', 'proj-old')])
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(UNATTRIBUTED_PROJECT_ID, 'sess-old')
    expect(deriveSessionProjects(db).upgraded).toBe(1)
    expect(projectOf(db, 'sess-old')).toBe('proj-old')
    db.close()
  })
})
