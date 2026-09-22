/**
 * §4.1 attribution repair for existing databases: a legacy project row is a bare
 * digest, and the ONLY thing that may turn it back into a path is a candidate that
 * reproduces that digest — never a guess. These tests pin acceptance (raw + folded
 * evidence, metadata-persisted cwds), refusal (no evidence, unattributed), the §4.2
 * convergence rule (run twice, second run writes nothing), and that `upsertProject`'s
 * COALESCE arm keeps a user-set display name.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { deriveProjectId, UNATTRIBUTED_PROJECT_ID, type AgentEvent } from '@agentlens/event-model'
import { insertEvents, upsertProject } from '../src/write.ts'
import { migrate } from '../src/migrate.ts'
import { backfillProjectRoots, projectsWithoutRoots } from '../src/project-backfill.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-backfill-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A fake repo: `.git` (directory) makes `projectRootForCwd` fold nested cwds onto it. */
const repo = join(tmp, 'my-repo')
mkdirSync(join(repo, '.git', 'objects'), { recursive: true })
const nested = join(repo, 'packages', 'cli')
mkdirSync(nested, { recursive: true })

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(join(tmp, `b-${Math.random().toString(36).slice(2)}.db`))
  migrate(db)
  return db
}

/** A legacy row: the event carries only the digest, and the projects row has no root. */
function legacyRow(db: DatabaseSync, projectId: string, i = 1): void {
  const ev: AgentEvent = {
    schemaVersion: 1,
    id: `e-${i}`,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-legacy',
    sessionId: 'sess-legacy',
    projectId,
    timestamp: Date.UTC(2026, 8, 1),
    type: 'message.user',
    usageSource: 'missing',
    status: 'ok',
    rawSeq: i,
    rawOffset: i,
    usage: null,
  }
  insertEvents(db, [ev])
}

const rootOf = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT canonical_root, display_name FROM projects WHERE id = ?').get(id) as {
    canonical_root: string | null
    display_name: string | null
  }

describe('backfillProjectRoots (§4.1 repair)', () => {
  it('labels a digest row from a nested cwd through the §4.1 fold', () => {
    const db = freshDb()
    const id = deriveProjectId(repo)
    legacyRow(db, id)
    expect(projectsWithoutRoots(db)).toContain(id)

    const stats = backfillProjectRoots(db, { extraCandidates: [nested] })
    expect(stats.repaired).toEqual([id])
    expect(stats.remaining).toBe(0)
    expect(rootOf(db, id)).toMatchObject({ canonical_root: repo })
    db.close()
  })

  it('takes evidence from cwd strings already persisted in event metadata', () => {
    const db = freshDb()
    const id = deriveProjectId(repo)
    legacyRow(db, id)
    // A pi-style `$.cwd` and a claude-history-style `$.project_hint`, both ingested under
    // other project ids — the digest check is what binds them to this row.
    insertEvents(
      db,
      [
        {
          schemaVersion: 1,
          id: 'meta-1',
          agentId: 'pi',
          hostId: 'pi',
          sourceId: 'src-meta',
          sessionId: 'sess-meta',
          projectId: deriveProjectId('elsewhere'),
          timestamp: Date.UTC(2026, 8, 2),
          type: 'session.start',
          usageSource: 'missing',
          status: 'ok',
          rawSeq: 1,
          rawOffset: 1,
          usage: null,
          metadata: { cwd: nested },
        },
        {
          schemaVersion: 1,
          id: 'meta-2',
          agentId: 'claude-code',
          hostId: 'claude-code',
          sourceId: 'src-history',
          sessionId: 'sess-meta',
          projectId: UNATTRIBUTED_PROJECT_ID,
          timestamp: Date.UTC(2026, 8, 3),
          type: 'session.start',
          usageSource: 'missing',
          status: 'ok',
          rawSeq: 1,
          rawOffset: 1,
          usage: null,
          metadata: { project_hint: '/nowhere/else' },
        },
      ],
      { contentEnabled: false },
    )

    expect(backfillProjectRoots(db).repaired).toEqual([id])
    expect(rootOf(db, id)).toMatchObject({ canonical_root: repo })
    db.close()
  })

  it('never invents a root: without matching evidence the row stays a digest', () => {
    const db = freshDb()
    const id = deriveProjectId(repo)
    legacyRow(db, id)
    const stats = backfillProjectRoots(db, {
      extraCandidates: [join(tmp, 'not-the-repo'), repo.replace(/repo$/, 'rEpO'), ''],
    })
    expect(stats).toMatchObject({ inspected: 1, repaired: [], remaining: 1 })
    expect(rootOf(db, id)).toEqual({ canonical_root: null, display_name: null })
    db.close()
  })

  it('keeps the unattributed bucket unlabelled even when the literal string is offered', () => {
    const db = freshDb()
    legacyRow(db, UNATTRIBUTED_PROJECT_ID)
    const stats = backfillProjectRoots(db, { extraCandidates: ['unattributed'] })
    expect(stats.inspected).toBe(0)
    expect(rootOf(db, UNATTRIBUTED_PROJECT_ID)).toEqual({ canonical_root: null, display_name: null })
    db.close()
  })

  it('is idempotent and convergent: a second run sees nothing and changes nothing (§4.2)', () => {
    const db = freshDb()
    const id = deriveProjectId(repo)
    legacyRow(db, id)
    upsertProject(db, { id, displayName: 'Keeper' })

    const first = backfillProjectRoots(db, { extraCandidates: [nested, repo] })
    expect(first.repaired).toEqual([id])
    const after = rootOf(db, id)

    const second = backfillProjectRoots(db, { extraCandidates: [nested, repo] })
    expect(second).toMatchObject({ inspected: 0, repaired: [], remaining: 0 })
    expect(rootOf(db, id)).toEqual(after)
    // COALESCE in upsertProject: the repair added a root and kept the human-set name.
    expect(after).toEqual({ canonical_root: repo, display_name: 'Keeper' })
    db.close()
  })

  it('is per-row: evidence for one digest does not touch rows without evidence', () => {
    const db = freshDb()
    const known = deriveProjectId(repo)
    const unknown = deriveProjectId(join(tmp, 'ghost'))
    legacyRow(db, known, 1)
    legacyRow(db, unknown, 2)
    const stats = backfillProjectRoots(db, { extraCandidates: [repo] })
    expect(stats.repaired).toEqual([known])
    expect(stats.remaining).toBe(1)
    expect(rootOf(db, unknown).canonical_root).toBeNull()
    db.close()
  })
})
