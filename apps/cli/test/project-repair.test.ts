/**
 * §4.1 attribution repair, CLI side: existing project rows that only carry a digest
 * are given their root back WITHOUT re-ingesting any source. Evidence is the encoded
 * directory inside the persisted `sources.path`, walked against the real filesystem
 * and accepted only when it reproduces the row's digest. These tests pin the decode
 * (hidden dirs, deleted worktree leaves, `-`/`.` ambiguity), the repair over a seeded
 * legacy store, idempotence (§4.2), and the honest no-evidence outcome. All paths are
 * synthetic temp dirs (§6 privacy).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { deriveProjectId, projectRootForCwd, type AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate } from '@agentlens/storage'
import { decodeEncodedDir, repairProjectRoots } from '../src/commands/projects.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-repair-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const encode = (p: string) => p.replace(/[/.-]/g, '-')

describe('decodeEncodedDir (filesystem-walked decode)', () => {
  /** A virtual filesystem: enough to pin the walk without touching anything real. */
  const tree: Record<string, string[]> = {
    '/': ['Users'],
    '/Users': ['tanzz'],
    '/Users/tanzz': ['.qoder', 'workspaces'],
    '/Users/tanzz/.qoder': ['projects'],
    '/Users/tanzz/workspaces': ['demo-repo', 'ambig'],
    '/Users/tanzz/workspaces/demo-repo': ['.claude'],
    '/Users/tanzz/workspaces/demo-repo/.claude': ['worktrees'],
    '/Users/tanzz/workspaces/demo-repo/.claude/worktrees': [], // the branch dir was deleted upstream
    '/Users/tanzz/workspaces/ambig': ['a-b', 'a.b'],
  }
  const listDir = (dir: string) => tree[dir] ?? []

  it('walks an encoded absolute path past a hidden directory', () => {
    const found = decodeEncodedDir(encode('/Users/tanzz/.qoder/projects'), listDir)
    expect(found).toContain('/Users/tanzz/.qoder/projects')
  })

  it('yields the surviving prefixes of a deleted worktree leaf', () => {
    const enc = encode('/Users/tanzz/workspaces/demo-repo/.claude/worktrees/feat-gone')
    const found = decodeEncodedDir(enc, listDir)
    expect(found).toContain('/Users/tanzz/workspaces/demo-repo')
    expect(found).toContain('/Users/tanzz/workspaces/demo-repo/.claude/worktrees')
    expect(found).not.toContain('/Users/tanzz/workspaces/demo-repo/.claude/worktrees/feat-gone')
  })

  it('branches on `-` vs `.` ambiguity instead of picking one', () => {
    const found = decodeEncodedDir(encode('/Users/tanzz/workspaces/ambig/a.b'), listDir)
    expect(found).toContain('/Users/tanzz/workspaces/ambig/a.b')
    expect(found).toContain('/Users/tanzz/workspaces/ambig/a-b')
  })

  it('leaves plain segments and names with no filesystem shape alone', () => {
    expect(decodeEncodedDir('projects', listDir)).toEqual([])
    expect(decodeEncodedDir('rollout-2026-06-17', listDir)).toEqual([])
  })
})

describe('repairProjectRoots after a legacy scan (§4.1)', () => {
  const home = join(tmp, 'home')
  const repo = join(home, 'workspaces', 'demo-repo')
  // The worktree dir itself is deliberately absent — the digest names the folded root.
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
  const goneWorktreeCwd = join(repo, '.claude', 'worktrees', 'feat-gone')

  function seed(): DatabaseSync {
    const db = new DatabaseSync(join(tmp, `r-${Math.random().toString(36).slice(2)}.db`))
    migrate(db)
    const ev: AgentEvent = {
      schemaVersion: 1,
      id: 'e-legacy',
      agentId: 'claude-code',
      hostId: 'claude-code',
      sourceId: 'src-legacy',
      sessionId: 'sess-legacy',
      projectId: deriveProjectId(projectRootForCwd(goneWorktreeCwd)),
      timestamp: Date.UTC(2026, 8, 1),
      type: 'message.user',
      usageSource: 'missing',
      status: 'ok',
      rawSeq: 1,
      rawOffset: 0,
      usage: null,
    }
    insertEvents(db, [ev])
    // The legacy row: created by ingest, never attributed — and a `sources` row whose
    // encoded directory is the only surviving trace of the cwd.
    db.prepare(
      "UPDATE sources SET path = ?, kind = 'jsonl' WHERE id = 'src-legacy'",
    ).run(join(home, '.claude', 'projects', encode(goneWorktreeCwd), 'sess.jsonl'))
    return db
  }

  const rootOf = (db: DatabaseSync, id: string) =>
    (db.prepare('SELECT canonical_root FROM projects WHERE id = ?').get(id) as { canonical_root: string | null })
      .canonical_root

  it('gives the digest row its folded root back from the encoded source path', () => {
    const db = seed()
    const id = String((db.prepare('SELECT id FROM projects').get() as { id: string }).id)
    expect(rootOf(db, id)).toBeNull()

    const stats = repairProjectRoots(db, { homedir: home })
    expect(stats.repaired).toEqual([id])
    expect(rootOf(db, id)).toBe(repo)
    db.close()
  })

  it('is a no-op on the second run (§4.2 convergence)', () => {
    const db = seed()
    const first = repairProjectRoots(db, { homedir: home })
    expect(first.repaired).toHaveLength(1)
    const id = first.repaired[0]!
    const second = repairProjectRoots(db, { homedir: home })
    expect(second).toMatchObject({ inspected: 0, repaired: [], remaining: 0 })
    expect(rootOf(db, id)).toBe(repo)
    db.close()
  })

  it('leaves a row with no filesystem evidence as an honest digest', () => {
    const db = new DatabaseSync(join(tmp, `ghost-${Math.random().toString(36).slice(2)}.db`))
    migrate(db)
    const ghost = join(home, 'workspaces', 'no-such-repo')
    const ev: AgentEvent = {
      schemaVersion: 1,
      id: 'e-ghost',
      agentId: 'claude-code',
      hostId: 'claude-code',
      sourceId: 'src-ghost',
      sessionId: 'sess-ghost',
      projectId: deriveProjectId(ghost),
      timestamp: Date.UTC(2026, 8, 1),
      type: 'message.user',
      usageSource: 'missing',
      status: 'ok',
      rawSeq: 1,
      rawOffset: 0,
      usage: null,
    }
    insertEvents(db, [ev])
    db.prepare("UPDATE sources SET path = ? WHERE id = 'src-ghost'").run(join(home, '.claude', 'projects', encode(ghost), 's.jsonl'))

    const stats = repairProjectRoots(db, { homedir: home })
    expect(stats.repaired).toEqual([])
    expect(rootOf(db, ev.projectId!)).toBeNull()
    db.close()
  })
})
