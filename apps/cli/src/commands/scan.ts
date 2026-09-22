/**
 * `scan` (§9) — the ONLY CLI path that writes events; every read command goes
 * through the cube so numbers cannot drift between commands.
 */
import { basename, dirname, join } from 'node:path'
import { deriveProjectId, projectRootForCwd, type AgentAdapter, type SourceSpec } from '@agentlens/event-model'
import { scanSource, type EventSink, type SavedSourceState, type SourceCommit } from '@agentlens/collector'
import {
  deriveSessionProjects,
  deriveSessionTitles,
  insertEvents,
  recordParseFailure,
  resolveSubagentParents,
  setAgentAggregations,
  updateSourceProgress,
  upsertProject,
  type SourceProgress,
} from '@agentlens/storage'
import type { DatabaseSync } from 'node:sqlite'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { makeHostCtx, redactHome } from '../context.ts'
import { adapterAggregations, getAdapters } from '../adapters.ts'
import { table } from '../render.ts'
import { repairProjectRoots } from './projects.ts'

export interface ScanOutcome {
  adaptersFound: number
  sourcesScanned: number
  events: number
  failures: number
  notDetected: string[]
  /**
   * Stores the scan walked away from rather than opened — §18 row 7's WAL rule. They are
   * neither `failures` (nothing failed to parse) nor silent (§5.2), so they ride along
   * separately for `scan`, `watch` and `--serve` to report.
   */
  refusals: SourceRefusal[]
  /**
   * Project rows that had no `canonical_root` and were repaired once this scan ended
   * (§4.1, `commands/projects.ts`). Optional because synthetic outcomes (rendering
   * tests) never touch a database; `runScan` always fills it.
   */
  projectsRepaired?: number
  /**
   * Side-chain rows whose parent this scan resolved across sources (§4.4 row 8,
   * `subagent-parent-links.ts`). Optional because synthetic outcomes (rendering tests)
   * never touch a database; `runScan` always fills it.
   */
  subagentsLinked?: number
  /** Of those, how many the spawn's own id proved versus the nearest-preceding-call guess (§5.2). */
  subagentsProven?: number
  subagentsGuessed?: number
  /** Chains left untouched because re-storing the row would have moved an unrelated column. */
  subagentLinksRefused?: number
  /** Sessions whose title was derived from the store's own title records (§10). */
  sessionsTitled?: number
  /** Sessions lifted out of the unattributed bucket by the project their own events name (§4.1). */
  sessionsAttributed?: number
}

export interface SourceRefusal {
  agentId: string
  path: string
  reason: string
}

function savedState(db: DatabaseSync, sourceId: string): SavedSourceState {
  const row = db.prepare(
    'SELECT last_offset, inode, size, mtime_ms, parser_version, rows_ingested FROM sources WHERE id = ?',
  ).get(sourceId) as Record<string, unknown> | undefined
  return {
    lastOffset: Number(row?.last_offset ?? 0),
    inode: Number(row?.inode ?? 0),
    size: Number(row?.size ?? 0),
    mtimeMs: Number(row?.mtime_ms ?? 0),
    parserVersion: Number(row?.parser_version ?? 0),
    linesConsumed: Number(row?.rows_ingested ?? 0),
    seen: row !== undefined,
  }
}

function makeSink(db: DatabaseSync, source: SourceSpec, agentId: string, contentEnabled: boolean): EventSink {
  return {
    writeEvents: (events) => {
      insertEvents(db, events, { contentEnabled })
    },
    writeParseFailure: (f) => {
      recordParseFailure(db, { ...f, sourceId: source.id, agentId, path: f.path })
    },
    commitSource: (p: SourceCommit) => {
      const prev = db.prepare('SELECT rows_ingested FROM sources WHERE id = ?').get(p.id) as { rows_ingested: number | null } | undefined
      const progress: SourceProgress = {
        id: p.id,
        agentId,
        path: p.path,
        kind: source.kind,
        inode: p.inode,
        size: p.size,
        mtimeMs: p.mtimeMs,
        lastOffset: p.lastOffset,
        parserVersion: p.parserVersion,
        sessionIdHint: source.sessionHint ?? null,
        sqliteTable: p.sqliteTable ?? null,
        status: p.status,
        rowsIngested: (prev?.rows_ingested ?? 0) + p.rowsIngested,
        scanStartedAt: p.scanStartedAt,
        scanFinishedAt: p.scanFinishedAt,
        lastError: p.lastError,
      }
      updateSourceProgress(db, progress)
    },
  }
}

/**
 * A project id is a digest, and `insertEvents` can only mint the row from the event —
 * so without this the whole product would label projects by hash. The collector is the
 * one place that has seen the cwd, so it hands the canonical root to `projects` here.
 */
export function makeProjectResolver(homedir?: string): {
  resolveProject(cwd: string | null | undefined): string | null
  roots: Map<string, string>
} {
  const roots = new Map<string, string>()
  const opts = homedir ? { homedir } : {}
  return {
    roots,
    resolveProject(cwd) {
      if (!cwd) return null
      // One canonicalization per cwd: the id and the label must come off the same root.
      const root = projectRootForCwd(cwd, opts)
      const id = deriveProjectId(root)
      roots.set(id, root)
      return id
    },
  }
}

export function recordProjectRoots(db: DatabaseSync, roots: Map<string, string>): void {
  for (const [id, root] of roots) upsertProject(db, { id, canonicalRoot: root })
  roots.clear()
}

/**
 * §6's risk table: the content layer copies private message/tool text into this
 * database, so it is off by default and a run opts in with `--content`.
 * `--no-content` is the plan's global switch and outranks it.
 */
export function contentWanted(flags: FlagView): boolean {
  return flags.bool('content') && !flags.bool('no-content')
}

export async function runScan(
  db: DatabaseSync,
  flags: FlagView,
  ctx: Ctx,
  onSource?: (agentId: string, source: SourceSpec, events: number, failures: number, action: string) => void,
): Promise<ScanOutcome> {
  const only = flags.list('agent')
  const contentEnabled = contentWanted(flags)
  const adapters = await getAdapters()
  const outcome: ScanOutcome = { adaptersFound: 0, sourcesScanned: 0, events: 0, failures: 0, notDetected: [], refusals: [] }
  const projects = makeProjectResolver(ctx.homedir)
  for (const adapter of adapters) {
    if (only.length > 0 && !only.includes(adapter.id)) continue
    const hostCtx = makeHostCtx(ctx)
    let detected: Awaited<ReturnType<AgentAdapter['detect']>>
    try {
      detected = await adapter.detect(hostCtx)
    } catch (err) {
      ctx.err(`! ${adapter.id}: detection failed: ${(err as Error).message}`)
      continue
    }
    if (!detected.present) {
      outcome.notDetected.push(adapter.id)
      continue
    }
    outcome.adaptersFound++
    // Recorded before that adapter's first row lands, so the stored fold rule covers every
    // row it writes even if the scan dies half-way (§18 row 2).
    setAgentAggregations(db, adapterAggregations([adapter]))
    for await (const source of adapter.discover(makeHostCtx(ctx, detected.dataRoot ?? null))) {
      const saved = savedState(db, source.id)
      const result = await scanSource(adapter, source, {
        sink: makeSink(db, source, adapter.id, contentEnabled),
        saved,
        agentId: adapter.id,
        hostId: adapter.id,
        resolveProject: projects.resolveProject,
        now: ctx.now,
        snapshotDir: ctx.snapshotDir,
      })
      // After every source rather than at the end: the ids are already durably referenced
      // by the events, and a scan that dies mid-run must not leave them unlabelled.
      recordProjectRoots(db, projects.roots)
      outcome.sourcesScanned++
      outcome.events += result.events
      outcome.failures += result.failures
      if (result.refusal) outcome.refusals.push({ agentId: adapter.id, path: source.path, reason: result.refusal })
      onSource?.(adapter.id, source, result.events, result.failures, result.action)
    }
  }
  // §4.1 attribution repair for rows that predate project naming: `skip`ped sources
  // never re-ingest, so their project rows are given the root back from the evidence
  // still in the store (persisted cwds, decodable `sources.path`). Idempotent, and a
  // no-op once every row has a root.
  outcome.projectsRepaired = repairProjectRoots(db, { homedir: ctx.homedir }).repaired.length
  // §4.4 row 8 one layer up from the adapter: a side chain's transcript is its own file, so the
  // spawn that started it lives in another source and the adapter's per-source ledger cannot see
  // it. The candidate pool here is the rows already in the store, which is also why the answer
  // cannot depend on which file the scan reached first (§4.2).
  const links = resolveSubagentParents(db)
  const relinked = links.rows.filter((r) => r.changes)
  outcome.subagentsLinked = links.rewritten
  outcome.subagentsProven = relinked.filter((r) => r.evidence === 'foreign-key').length
  outcome.subagentsGuessed = relinked.filter((r) => r.evidence === 'heuristic').length
  outcome.subagentLinksRefused = links.refused.length
  // §10: the session list is the product's first screen, and the title records are already in
  // the store (`custom-title` / `ai-title` rows) — this only projects them onto the session.
  outcome.sessionsTitled = deriveSessionTitles(db).updated
  // §4.1 one layer up on the same screen: a session whose first record carried no cwd was latched
  // into the unattributed bucket by the seed, and the rows behind it could never correct it. The
  // evidence is in the event rows already; this reads the session's own project back from them.
  outcome.sessionsAttributed = deriveSessionProjects(db).upgraded
  return outcome
}

export async function cmdScan(db: DatabaseSync, flags: FlagView, ctx: Ctx): Promise<number> {
  const adapters = await getAdapters()
  if (adapters.length === 0) {
    ctx.out(`${'!'} no adapters installed — nothing to scan.`)
    ctx.out("  adapters ship as @agentlens/adapter-* packages; ingested history stays queryable.")
    return 0
  }
  const rows: (string | number)[][] = []
  const outcome = await runScan(db, flags, ctx, (agentId, source, events, failures, action) => {
    if (action === 'skip') return
    rows.push([agentId, basename(source.path), action, events, failures])
  })
  if (rows.length > 0) {
    ctx.out(table(['agent', 'source', 'action', 'events', 'failures'], rows, ['left', 'left', 'left', 'right', 'right']))
  } else {
    ctx.out('✓ up to date — no new rows since last scan')
  }
  ctx.out(`${outcome.sourcesScanned} sources scanned · ${outcome.events} events ingested · ${outcome.failures} parse failures`)
  if (outcome.projectsRepaired) {
    ctx.out(`+ ${outcome.projectsRepaired} existing project ${outcome.projectsRepaired === 1 ? 'row' : 'rows'} attributed to a directory (§4.1)`)
  }
  if (outcome.subagentsLinked) {
    // The two evidence kinds are named because they are not equally trustworthy, and a chain
    // placed under the wrong spawn is worse than one left open (§4.4 row 8).
    ctx.out(
      `+ ${outcome.subagentsLinked} side-chain ${outcome.subagentsLinked === 1 ? 'row' : 'rows'} linked to its spawn (§4.4 row 8: ` +
        `${outcome.subagentsProven ?? 0} by the spawn's own id, ${outcome.subagentsGuessed ?? 0} by the nearest preceding call)`,
    )
  }
  if (outcome.sessionsTitled) {
    ctx.out(`+ ${outcome.sessionsTitled} session ${outcome.sessionsTitled === 1 ? 'row' : 'rows'} titled from the title records its own logs carry (§10)`)
  }
  if (outcome.sessionsAttributed) {
    ctx.out(
      `+ ${outcome.sessionsAttributed} session ${outcome.sessionsAttributed === 1 ? 'row' : 'rows'} lifted out of "unattributed" by the cwd ` +
        'its own later records carry — the first line of the transcript had none (§4.1)',
    )
  }
  if (outcome.subagentLinksRefused) {
    ctx.out(
      `! ${outcome.subagentLinksRefused} chain${outcome.subagentLinksRefused === 1 ? '' : 's'} left as-is: rewriting the stored row would have ` +
        'moved a column this pass does not own (§5.2)',
    )
  }
  for (const line of refusalLines(outcome, ctx)) ctx.out(line)
  return 0
}

/** §18 row 7: WAL stores are read through a copy that lives in our own data directory. */
export function snapshotsDirFor(dbPath: string): string {
  return join(dirname(dbPath), 'snapshots')
}

/** §18 row 7 stores left alone on purpose, spelled out rather than folded into "failures". */
export function refusalLines(outcome: ScanOutcome, ctx: { homedir: string }): string[] {
  // One store usually backs several sources (OpenCode: 3 tables in one db), and the stored
  // error repeats the path the line already names — both would just multiply identical text.
  const bySource = new Map<string, { agentId: string; path: string; reason: string; count: number }>()
  for (const r of outcome.refusals) {
    const key = `${r.agentId}\u0000${r.path}\u0000${r.reason}`
    const seen = bySource.get(key)
    if (seen) seen.count += 1
    else bySource.set(key, { agentId: r.agentId, path: r.path, reason: r.reason.replace(/^refusing to open "[^"]*": /, ''), count: 1 })
  }
  return [...bySource.values()].map(
    (r) =>
      `! ${r.agentId} ${redactHome(r.path, ctx.homedir)} not read${r.count > 1 ? ` (${r.count} sources)` : ''}: ${redactHome(r.reason, ctx.homedir)}`,
  )
}
