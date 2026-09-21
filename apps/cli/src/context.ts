/**
 * Shared CLI execution context: every command handler takes (db, flags, words, ctx)
 * and writes ONLY through ctx.out / ctx.err, so tests can capture stdout without
 * spawning a process.
 */
import { accessSync, constants, readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { HostContext } from '@agentlens/event-model'
import type { FlagView } from './args.ts'
import type { ServeHandle } from './serve.ts'
import { loadAgentAggregations } from '@agentlens/storage'
import type { BillingMode, QueryFilter, QueryDeps } from './types.ts'
import { loadBillingModes, loadPricing } from './pricing-store.ts'

export interface Ctx {
  argv: string[]
  out: (line: string) => void
  err: (line: string) => void
  homedir: string
  env: NodeJS.ProcessEnv
  now: () => number
  /**
   * Where a WAL-mode third-party store is copied to before anything reads it
   * (§18 row 7, `sqlite-snapshot.ts`). Unset ⇒ such stores stay refused.
   */
  snapshotDir?: string
  /**
   * `--serve` plug point (§14). Tests inject a stub so the suite never binds a socket
   * or launches a browser; the real implementation lives in `serve.ts`.
   */
  serve?: (db: DatabaseSync, dbPath: string, flags: FlagView, ctx: Ctx, deps: QueryDeps) => Promise<ServeHandle>
}

export function defaultCtx(argv: string[]): Ctx {
  return {
    argv,
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
    homedir: osHomedir(),
    env: process.env,
    now: Date.now,
  }
}

/** Error/output must never leak the real home directory (§ privacy posture of the whole tool). */
export function redactHome(text: string, home: string): string {
  if (!home) return text
  return text.split(home).join('~')
}

/** Display a path as `~/...` so §11-style lines stay recognisable without leaking it. */
export function displayPath(path: string, home: string): string {
  if (home && path.startsWith(home)) return '~' + path.slice(home.length)
  // Outside home: only show the tail — absolute user paths must not be printed.
  return join3('...', basename(dirname(path)), basename(path))
}
function join3(a: string, b: string, c: string): string {
  return [a, b, c].filter(Boolean).join('/')
}

export function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** HostContext (§5.1) backed by real fs, read-only. */
export function makeHostCtx(ctx: Ctx, dataRoot?: string | null): HostContext {
  return {
    dataRoot: dataRoot ?? null,
    homedir: ctx.homedir,
    env: ctx.env,
    async readFile(path: string): Promise<string> {
      return readFileSync(path, 'utf8')
    },
    async readDir(path: string): Promise<string[]> {
      const { readdirSync } = await import('node:fs')
      return readdirSync(path)
    },
    async stat(path: string) {
      const { statSync } = await import('node:fs')
      try {
        const st = statSync(path)
        return { size: st.size, mtimeMs: st.mtimeMs, inode: st.ino }
      } catch {
        return null
      }
    },
  }
}

export function queryDeps(db: DatabaseSync, dbPath: string, ctx: Ctx): QueryDeps {
  const { table } = loadPricing(dbPath)
  const modes = loadBillingModes(dbPath)
  return {
    priceResolver: (provider, model, occurredAt) => table.lookup(provider, model, occurredAt),
    billingModeFor: (agentId): BillingMode => modes[agentId] ?? 'api',
    // §18 row 2: read the fold rule back from the rows' own agents, so a query never has to
    // know which adapter version wrote them.
    aggregation: loadAgentAggregations(db),
  }
}

/** Filters arrive as names or ids; resolve names -> ids via the entity tables so the
 *  cube keeps seeing only opaque ids (and everything stays parameterised anyway). */
function rows(db: DatabaseSync, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  return (params.length ? stmt.all(...(params as never[])) : stmt.all()).map((r) => ({ ...r })) as Record<string, unknown>[]
}

function resolveValues(
  db: DatabaseSync,
  requested: string[],
  select: string,
  candidates: (r: Record<string, unknown>) => (string | null | undefined)[],
  fallbackIdOk: boolean,
  label: string,
  warn: (msg: string) => void,
): string[] {
  if (requested.length === 0) return []
  const all = rows(db, select)
  const out: string[] = []
  for (const want0 of requested) {
    const want = want0.toLowerCase()
    const hit = all.find((r) =>
      candidates(r).some((c) => c !== null && c !== undefined && String(c).toLowerCase() === want),
    )
    if (hit) {
      out.push(String(hit['id'] ?? hit['name'] ?? ''))
      continue
    }
    if (fallbackIdOk) {
      out.push(want0) // already an opaque id (hash): pass through
      continue
    }
    warn(`${label}: no match for ${JSON.stringify(want0)}, matching literally`)
    out.push(want0)
  }
  return out
}

export function resolveAgentIds(db: DatabaseSync, ctx: Ctx, values: string[]): string[] {
  return resolveValues(
    db,
    values,
    'SELECT id, display_name FROM agents',
    (r) => [String(r.id), r.display_name ? String(r.display_name) : null],
    true,
    'agent',
    (m) => ctx.err(`! ${m}`),
  )
}

export function resolveProjectIds(db: DatabaseSync, ctx: Ctx, values: string[]): string[] {
  return resolveValues(
    db,
    values,
    'SELECT id, display_name, canonical_root FROM projects',
    (r) => {
      const root = r.canonical_root ? String(r.canonical_root) : null
      return [String(r.id), r.display_name ? String(r.display_name) : null, root, root ? basename(root) : null]
    },
    true,
    'project',
    (m) => ctx.err(`! ${m}`),
  )
}

export function resolveModelNames(values: string[]): string[] {
  return values
}

/** Assemble the §7 filter from parsed flags; names resolved to ids for agent/project. */
export function buildFilter(
  db: DatabaseSync,
  ctx: Ctx,
  f: {
    since?: string
    until?: string
    agent: string[]
    host: string[]
    project: string[]
    session: string[]
    model: string[]
    provider: string[]
    status: string[]
    type: string[]
  },
): QueryFilter {
  const filter: QueryFilter = {}
  if (f.since !== undefined) filter.since = f.since
  if (f.until !== undefined) filter.until = f.until
  const agent = resolveAgentIds(db, ctx, f.agent)
  if (agent.length) filter.agent = agent
  if (f.host.length) filter.host = f.host
  const project = resolveProjectIds(db, ctx, f.project)
  if (project.length) filter.project = project
  if (f.session.length) filter.session = f.session
  if (f.model.length) filter.model = resolveModelNames(f.model)
  if (f.provider.length) filter.provider = f.provider
  if (f.status.length) filter.status = f.status
  if (f.type.length) filter.type = f.type
  return filter
}
