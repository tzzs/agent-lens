import { describe, expect, it } from 'vitest'
import {
  canonicalRepoRoot,
  loadMergeRules,
  parseProjectsToml,
  projectIdForCwd,
  type ProjectFs,
} from '../src/project.ts'
import { deriveProjectId } from '../src/ids.ts'

type Entry = { kind: 'dir' } | { kind: 'file'; content: string }

function makeFs(entries: Record<string, Entry>): ProjectFs {
  return {
    isDirectory: (p) => entries[p]?.kind === 'dir',
    isFile: (p) => entries[p]?.kind === 'file',
    readFile: (p) => (entries[p]?.kind === 'file' ? entries[p]!.content : null),
    exists: (p) => p in entries,
  }
}

const dir = { kind: 'dir' } as const
const gitFile = (target: string): Entry => ({ kind: 'file', content: `gitdir: ${target}\n` })

describe('canonicalRepoRoot — step 1: git common-dir', () => {
  it('resolves a linked worktree onto the main checkout', () => {
    const fs = makeFs({
      '/main': dir,
      '/main/.git': dir,
      '/wt/feature-x': dir,
      '/wt/feature-x/.git': gitFile('/main/.git/worktrees/feature-x'),
    })
    expect(canonicalRepoRoot('/wt/feature-x', { fs, rules: [] })).toBe('/main')
  })

  it('resolves a subdirectory of a worktree to the same main root', () => {
    const fs = makeFs({
      '/main': dir,
      '/main/.git': dir,
      '/wt/feature-x/.git': gitFile('/main/.git/worktrees/feature-x'),
    })
    expect(canonicalRepoRoot('/wt/feature-x/packages/app', { fs, rules: [] })).toBe('/main')
  })

  it('strips nested worktree suffixes at any depth', () => {
    const fs = makeFs({
      '/main': dir,
      '/main/.git': dir,
      '/wt/inner/.git': gitFile('/main/.git/worktrees/outer/worktrees/inner'),
    })
    expect(canonicalRepoRoot('/wt/inner', { fs, rules: [] })).toBe('/main')
  })

  it('maps a plain subdirectory of a repo to the repo root', () => {
    const fs = makeFs({ '/repo': dir, '/repo/.git': dir })
    expect(canonicalRepoRoot('/repo/packages/app/src', { fs, rules: [] })).toBe('/repo')
  })

  it('keeps the worktree dir as root when .git is an unparseable pointer-less file', () => {
    const fs = makeFs({ '/weird/.git': { kind: 'file', content: '' } })
    expect(canonicalRepoRoot('/weird', { fs, rules: [] })).toBe('/weird')
  })
})

describe('canonicalRepoRoot — step 2: path rules', () => {
  it('truncates /.claude/worktrees/<x> and any deeper subdirectory', () => {
    const fs = makeFs({ '/repo': dir, '/repo/.git': dir })
    expect(canonicalRepoRoot('/repo/.claude/worktrees/feat/packages/src', { fs, rules: [] })).toBe('/repo')
  })

  it('falls back to the truncated parent when no git metadata is visible', () => {
    const fs = makeFs({})
    expect(canonicalRepoRoot('/home/u/.codex/worktrees/task-1/checkout', { fs, rules: [] })).toBe('/home/u/.codex')
  })
})

describe('canonicalRepoRoot — step 3: merge table', () => {
  it('lets an exact-prefix rule override the resolved root (Orca shape)', () => {
    const fs = makeFs({})
    const rules = parseProjectsToml(`
[[project]]
path = "/Users/t/orca-workspaces/myrepo-alpha"
canonical = "myrepo"
`)
    expect(
      canonicalRepoRoot('/Users/t/orca-workspaces/myrepo-alpha/apps/cli', { fs, rules }),
    ).toBe('myrepo')
  })

  it('lets a regex rule match where steps 1–2 cannot', () => {
    const rules = parseProjectsToml(`
[[project]]
pattern = "^/Volumes/checkouts/(repo-[a-z]+)-"
canonical = "repo-main"
`)
    expect(canonicalRepoRoot('/Volumes/checkouts/repo-x-feature-2', { fs: makeFs({}), rules })).toBe('repo-main')
  })

  it('prefers the longest matching path prefix and respects segment boundaries', () => {
    const rules = parseProjectsToml(`
[[project]]
path = "/main"
canonical = "broad"
[[project]]
path = "/main/nested"
canonical = "specific"
`)
    const fs = makeFs({})
    expect(canonicalRepoRoot('/main/nested/pkg', { fs, rules })).toBe('specific')
    expect(canonicalRepoRoot('/mainother', { fs, rules })).toBeNull()
  })

  it('loads rules from ~/.agentlens/projects.toml when none are passed in', () => {
    const fs = makeFs({
      '/home/u/.agentlens/projects.toml': {
        kind: 'file',
        content: '[[project]]\npath = "/side/x"\ncanonical = "x"\n',
      },
    })
    expect(canonicalRepoRoot('/side/x', { fs, homedir: '/home/u' })).toBe('x')
    expect(loadMergeRules(fs, '/home/u')).toEqual([{ path: '/side/x', canonical: 'x' }])
  })

  it('runs after steps 1–2 so it can override a git-resolved root', () => {
    const fs = makeFs({ '/clone2': dir, '/clone2/.git': dir })
    const rules = parseProjectsToml('[[project]]\npath = "/clone2"\ncanonical = "/origin"\n')
    expect(canonicalRepoRoot('/clone2', { fs, rules })).toBe('/origin')
  })
})

describe('parseProjectsToml', () => {
  it('skips comments, unknown keys, invalid lines and rules that can never match', () => {
    const rules = parseProjectsToml(`
# comment
key = "ignored"
[[merge]]
path = "/a"
[[merge]]
path = "/b"
canonical = "b"
note = "unknown key"
[[merge]]
pattern = "([bad("
canonical = "c"
`)
    expect(rules).toEqual([{ canonical: 'b', path: '/b' }])
  })
})

describe('projectIdForCwd', () => {
  it('hashes the canonical root', () => {
    const fs = makeFs({ '/main': dir, '/main/.git': dir, '/wt/f/.git': gitFile('/main/.git/worktrees/f') })
    expect(projectIdForCwd('/wt/f', { fs, rules: [] })).toBe(deriveProjectId('/main'))
  })

  it('never yields a null project: falls back to the normalized cwd', () => {
    expect(projectIdForCwd('/not/a/repo/x/', { fs: makeFs({}), rules: [] })).toBe(deriveProjectId('/not/a/repo/x'))
    const viaHome = projectIdForCwd('~/whatever', { fs: makeFs({}), rules: [], homedir: '/home/u' })
    expect(viaHome).toBe(deriveProjectId('/home/u/whatever'))
  })
})
