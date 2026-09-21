/**
 * `scan` (§9) — the ONLY CLI path that writes events; every read command goes
 * through the cube so numbers cannot drift between commands.
 */
import { basename, dirname, join } from 'node:path'
import { projectIdForCwd, projectRootForCwd, type AgentAdapter, type SourceSpec } from '@agentlens/event-model'
import { scanSource, type EventSink, type SavedSourceState, type SourceCommit } from '@agentlens/collector'
import {
  insertEvents,
  recordParseFailure,
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
export function makeProjectResolver(): { resolveProject(cwd: string | null | undefined): string | null } & {
  roots: Map<string, string>
} {
  const roots = new Map<string, string>()
  return {
    roots,
    resolveProject(cwd) {
      if (!cwd) return null
      const id = projectIdForCwd(cwd)
      roots.set(id, projectRootForCwd(cwd))
      return id
    },
  }
}

export function recordProjectRoots(db: DatabaseSync, roots: Map<string, string>): void {
  for (const [id, root] of roots) upsertProject(db, { id, canonicalRoot: root })
  roots.clear()
}

export async function runScan(
  db: DatabaseSync,
  flags: FlagView,
  ctx: Ctx,
  onSource?: (agentId: string, source: SourceSpec, events: number, failures: number, action: string) => void,
): Promise<ScanOutcome> {
  const only = flags.list('agent')
  const contentEnabled = !flags.bool('no-content')
  const adapters = await getAdapters()
  const outcome: ScanOutcome = { adaptersFound: 0, sourcesScanned: 0, events: 0, failures: 0, notDetected: [], refusals: [] }
  const projects = makeProjectResolver()
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
