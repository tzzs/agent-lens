/**
 * §4.1 — three-step project canonicalization.
 *
 * Measured reality: 8 of 25 frequent cwd values were git worktrees, so plain
 * `git rev-parse --show-toplevel` splits one repo into N projects; and a
 * third-party tool (Orca) creates `~/orca-workspaces/<repo>-<name>` directories
 * no fixed rule can detect. Hence three steps, applied in order:
 *  1. git common-dir resolution — a worktree's `.git` file holds
 *     `gitdir: <common>/worktrees/<name>`; stripping the worktree suffix and
 *     taking the parent of the common dir collapses worktrees onto main.
 *  2. path-rule fallback — truncate known worktree path shapes.
 *  3. merge table from ~/.agentlens/projects.toml — user overrides for the
 *     residue steps 1–2 cannot see (Orca, multi-checkout copies).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { deriveProjectId } from './ids.ts'

export interface ProjectFs {
  isDirectory(p: string): boolean
  isFile(p: string): boolean
  readFile(p: string): string | null
  exists(p: string): boolean
}

const realProjectFs: ProjectFs = {
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  isFile: (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  exists: (p) => existsSync(p),
}

export interface MergeRule {
  /** Absolute path prefix, matched on segment boundaries. */
  path?: string
  /** Regex alternative to `path`. */
  pattern?: RegExp
  canonical: string
}

export interface CanonicalizeOptions {
  fs?: ProjectFs
  rules?: MergeRule[]
  homedir?: string
}

export function projectsConfigPath(home: string): string {
  return join(home, '.agentlens', 'projects.toml')
}

/*
Accepted `projects.toml` subset (one array-of-tables entry per merge rule):

  [[project]]                      any [[name]] header starts a rule
  path    = "/abs/prefix"          segment-boundary prefix match, or
  pattern = "^/abs/(repo)-"        regex match (first matching rule wins)
  canonical = "myrepo"             required; project name or path

Comments, blank lines, unknown keys and unparseable lines are skipped.
*/
export function parseProjectsToml(text: string): MergeRule[] {
  const rules: MergeRule[] = []
  let current: { path?: string; pattern?: string; canonical?: string } | null = null

  const flush = (): void => {
    const c = current
    current = null
    if (!c || !c.canonical) return
    const rule: MergeRule = { canonical: c.canonical }
    if (c.path) rule.path = trimTrailingSlash(c.path)
    if (c.pattern) {
      try {
        rule.pattern = new RegExp(c.pattern)
      } catch {
        /* invalid regex: keep the path rule if any */
      }
    }
    if (rule.path !== undefined || rule.pattern !== undefined) rules.push(rule)
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[[')) {
      flush()
      current = {}
      continue
    }
    if (line.startsWith('[')) {
      flush()
      continue
    }
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (!m) continue
    const key = m[1]
    const value = (m[2] ?? '').replace(/\\(["\\])/g, '$1')
    if (!current || (key !== 'path' && key !== 'pattern' && key !== 'canonical')) continue
    current[key] = value
  }
  flush()
  return rules
}

export function loadMergeRules(fs: ProjectFs = realProjectFs, home?: string): MergeRule[] {
  const text = fs.readFile(projectsConfigPath(home ?? homedir()))
  return text ? parseProjectsToml(text) : []
}

function trimTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

function normalizePath(p: string, home: string): string | null {
  if (!p) return null
  let abs = p
  if (abs === '~') abs = home
  else if (abs.startsWith('~/')) abs = join(home, abs.slice(2))
  if (!isAbsolute(abs)) return null
  return trimTrailingSlash(resolve(abs))
}

function parseGitdirPointer(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    const m = /^gitdir:\s*(.+)$/i.exec(l)
    return m?.[1] ? m[1].trim() : l
  }
  return null
}

/** `/main/.git/worktrees/feat` (any depth) → `/main`; plain `.git` → its parent. */
function repoRootFromGitdir(gitdirPath: string, worktreeRoot: string): string {
  const m = /^(.*?)\/worktrees\/[^/]/.exec(gitdirPath)
  if (m?.[1]) return dirname(m[1])
  if (basename(gitdirPath) === '.git') return dirname(gitdirPath)
  return worktreeRoot
}

function followGitdir(content: string, dotGitParent: string): string | null {
  const target = parseGitdirPointer(content)
  if (!target) return null
  const abs = isAbsolute(target) ? target : resolve(join(dotGitParent, target))
  const normalized = normalizePath(abs, '') ?? abs
  return repoRootFromGitdir(normalized, dotGitParent)
}

function resolveGitRoot(start: string, fs: ProjectFs): string | null {
  let dir = start
  for (;;) {
    const dotGit = join(dir, '.git')
    if (fs.isFile(dotGit)) {
      const content = fs.readFile(dotGit)
      const root = content ? followGitdir(content, dir) : null
      return root ?? dir
    }
    if (fs.isDirectory(dotGit)) {
      // A .git *directory* carrying a gitdir: marker is a worktree admin dir, not a main repo.
      const marker = fs.readFile(join(dotGit, 'gitdir'))
      const root = marker ? followGitdir(marker, dir) : null
      return root ?? dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function truncateAtWorktreeMarker(p: string): string | null {
  for (const marker of ['/.claude/worktrees/', '/worktrees/']) {
    const i = p.indexOf(marker)
    if (i > 0) return p.slice(0, i)
  }
  return null
}

function matchesPrefix(target: string, prefix: string): boolean {
  return target === prefix || target.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

function applyMergeRules(target: string, rules: readonly MergeRule[]): string | null {
  let bestPathRule: MergeRule | null = null
  let firstRegexRule: MergeRule | null = null
  for (const rule of rules) {
    if (rule.path !== undefined && matchesPrefix(target, rule.path)) {
      if (!bestPathRule || rule.path.length > (bestPathRule.path?.length ?? 0)) bestPathRule = rule
    } else if (rule.pattern !== undefined && rule.pattern.test(target)) {
      if (!firstRegexRule) firstRegexRule = rule
    }
  }
  return bestPathRule?.canonical ?? firstRegexRule?.canonical ?? null
}

/** Returns the canonical repository root (or merge-table name), or null if the cwd cannot be attributed to any project. */
export function canonicalRepoRoot(cwd: string, opts: CanonicalizeOptions = {}): string | null {
  const fs = opts.fs ?? realProjectFs
  const home = opts.homedir ?? homedir()
  const normalized = normalizePath(cwd, home)
  if (!normalized) return null

  const rules = opts.rules ?? loadMergeRules(fs, home)

  const gitRoot = resolveGitRoot(normalized, fs)
  const worktreeCut = truncateAtWorktreeMarker(normalized)
  const step12 =
    gitRoot ?? (worktreeCut ? (resolveGitRoot(worktreeCut, fs) ?? worktreeCut) : null)

  for (const candidate of step12 ? [step12, normalized] : [normalized]) {
    const canonical = applyMergeRules(candidate, rules)
    if (canonical) return canonical
  }
  return step12
}

/** Never returns a null project: unresolvable cwds fall back to the normalized path. */
export function projectIdForCwd(cwd: string, opts: CanonicalizeOptions = {}): string {
  const canonical = canonicalRepoRoot(cwd, opts)
  if (canonical) return deriveProjectId(canonical)
  const normalized = normalizePath(cwd, opts.homedir ?? homedir()) ?? cwd
  return deriveProjectId(normalized)
}
