/**
 * §7: a project id is a digest of its canonical root, so the row `insertEvents` mints
 * carries no label — until the collector records the root beside it. These tests pin the
 * two behaviours a user actually sees: `--project my-repo` resolves, and the tables print
 * a name rather than a hash.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { projectIdForCwd, type AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, upsertProject } from '@agentlens/storage'
import { makeProjectResolver, recordProjectRoots } from '../src/commands/scan.ts'
import { resolveProjectIds } from '../src/context.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-projects-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Two cwds inside one repository resolve to the repo root, which is the whole point of the digest. */
const repo = join(tmp, 'my-repo')
mkdirSync(join(repo, '.git', 'objects'), { recursive: true })
mkdirSync(join(repo, 'packages', 'cli'), { recursive: true })

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(join(tmp, `p-${Math.random().toString(36).slice(2)}.db`))
  migrate(db)
  return db
}

function eventAt(projectId: string, i: number): AgentEvent {
  return {
    schemaVersion: 1,
    id: `e-${i}`,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-projects',
    sessionId: 'sess-1',
    projectId,
    timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: i,
    rawOffset: i,
    usage: null,
  }
}

function root(db: DatabaseSync, id: string): Record<string, unknown> {
  return db.prepare('SELECT canonical_root, display_name FROM projects WHERE id = ?').get(id) as Record<string, unknown>
}

describe('project labels (§7)', () => {
  it('resolves a cwd to the same id insertEvents would mint, and remembers the root that made it', () => {
    const db = freshDb()
    const projects = makeProjectResolver()
    const fromRepoDir = projects.resolveProject(repo)
    const fromNestedDir = projects.resolveProject(join(repo, 'packages', 'cli'))
    expect(projects.resolveProject(null)).toBeNull()
    expect(projects.resolveProject(undefined)).toBeNull()

    expect(fromNestedDir).toBe(fromRepoDir)
    expect(fromRepoDir).toBe(projectIdForCwd(repo))
    expect(projects.roots.size).toBe(1)

    insertEvents(db, [eventAt(fromRepoDir ?? '', 1)])
    // Before the collector records anything, the event's project is an anonymous hash.
    expect(root(db, fromRepoDir ?? '')).toEqual({ canonical_root: null, display_name: null })

    recordProjectRoots(db, projects.roots)
    expect(projects.roots.size).toBe(0)
    expect(root(db, fromRepoDir ?? '')).toMatchObject({ canonical_root: repo })
    db.close()
  })

  it('makes the root searchable by basename, which is what §9 prints', () => {
    const db = freshDb()
    const messages: string[] = []
    const ctx = { homedir: tmp, err: (m: string) => messages.push(m) } as Ctx
    const projects = makeProjectResolver()
    const id = projects.resolveProject(join(repo, 'packages', 'cli')) ?? ''
    insertEvents(db, [eventAt(id, 1)])

    // Without the recorded root there is nothing to match a human name against, so the
    // word is passed through as if it were an id — which returns no rows.
    expect(resolveProjectIds(db, ctx, ['my-repo'])).toEqual(['my-repo'])
    recordProjectRoots(db, projects.roots)
    expect(resolveProjectIds(db, ctx, ['my-repo'])).toEqual([id])
    expect(resolveProjectIds(db, ctx, [repo])).toEqual([id])
    expect(messages).toEqual([])
    db.close()
  })

  it('keeps a name the user set, and needs no repository to label a cwd', () => {
    const db = freshDb()
    const plain = join(tmp, 'plain-dir')
    mkdirSync(plain, { recursive: true })
    const projects = makeProjectResolver()
    const id = projects.resolveProject(plain) ?? ''
    upsertProject(db, { id, displayName: 'Scratch' })
    recordProjectRoots(db, projects.roots)

    // Not a repository, so the fallback is the path itself — still a basename a human reads.
    expect(root(db, id)).toEqual({ canonical_root: plain, display_name: 'Scratch' })
    db.close()
  })
})
