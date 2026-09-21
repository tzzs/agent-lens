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
import { projectIdForCwd, UNATTRIBUTED_PROJECT_ID, type AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase, upsertProject } from '@agentlens/storage'
import { makeProjectResolver, recordProjectRoots } from '../src/commands/scan.ts'
import { resolveProjectIds } from '../src/context.ts'
import { runCli } from '../src/index.ts'
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

  it('labels the records no cwd can be attributed to, without inventing a root', () => {
    const db = freshDb()
    const messages: string[] = []
    const ctx = { homedir: tmp, err: (m: string) => messages.push(m) } as Ctx
    // 21% of the real claude-code corpus: reported as unattributed (§5.2), so it has no path
    // to label and would otherwise print as a 64-hex digest on the first screen.
    insertEvents(db, [eventAt(UNATTRIBUTED_PROJECT_ID, 1)])
    expect(root(db, UNATTRIBUTED_PROJECT_ID)).toEqual({ canonical_root: null, display_name: null })
    expect(resolveProjectIds(db, ctx, ['unattributed'])).toEqual([UNATTRIBUTED_PROJECT_ID])
    expect(messages).toEqual([])
    db.close()
  })
})

/**
 * The measured drift: `agl projects` printed `picko` while `agl sessions` printed
 * `d42d99c330` for the very same digest — because the list rendered `sessions.project_id`
 * itself instead of going through the cube's label. §14 forbids the two screens disagreeing,
 * and §7 forbids a second renderer, so both must land on `event-model/projectLabel`.
 */
describe('agl sessions / session print the label, not the digest (§14)', () => {
  const repoProjectId = projectIdForCwd(repo)

  function seeded(name: string, projectId: string): string {
    const path = join(tmp, `${name}.db`)
    const db = openDatabase(path)
    migrate(db)
    const projects = makeProjectResolver()
    const id = projectId === repoProjectId ? (projects.resolveProject(join(repo, 'packages', 'cli')) ?? '') : projectId
    insertEvents(db, [eventAt(id, 1), eventAt(id, 2)])
    if (projectId === repoProjectId) recordProjectRoots(db, projects.roots)
    db.close()
    return path
  }

  async function run(db: string, ...argv: string[]): Promise<string> {
    const lines: string[] = []
    const ctx: Ctx = {
      argv: [...argv, '--db', db],
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      homedir: tmp,
      env: {},
      now: () => Date.UTC(2026, 8, 21),
    }
    expect(await runCli(ctx)).toBe(0)
    return lines.join('\n')
  }

  it('shows the same word projects does, and that word is what --project accepts back', async () => {
    const path = seeded('sessions-labelled', repoProjectId)
    const projects = await run(path, 'projects')
    const sessions = await run(path, 'sessions')
    const detail = await run(path, 'session', 'sess-1')

    expect(projects).toContain('my-repo') // the baseline this command had to match
    expect(sessions).toContain('my-repo')
    expect(detail).toContain('project=my-repo')
    for (const screen of [sessions, detail]) {
      expect(screen).not.toContain(repoProjectId.slice(0, 10))
      expect(screen).not.toContain(repoProjectId)
    }

    // Round trip: the label on screen is a filter the same command understands (§9).
    const filtered = await run(path, 'sessions', '--project', 'my-repo')
    expect(filtered).toContain('my-repo')
    expect(filtered).toContain('1 of 1 sessions')
  })

  it('spells out the unattributed bucket instead of printing its digest', async () => {
    const sessions = await run(seeded('sessions-unattributed', UNATTRIBUTED_PROJECT_ID), 'sessions')
    expect(sessions).toContain('unattributed')
    expect(sessions).not.toContain(UNATTRIBUTED_PROJECT_ID.slice(0, 10))
  })

  it('keeps a digest that has nothing to shorten it from readable, never a 64-char column', async () => {
    const unknown = 'f'.repeat(64)
    const sessions = await run(seeded('sessions-unlabelled', unknown), 'sessions')
    expect(sessions).toContain(unknown.slice(0, 10))
    expect(sessions).not.toContain(unknown)
  })
})

