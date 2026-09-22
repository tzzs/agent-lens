/**
 * `watch` (§9): run the `scan` summary once, then stay resident and print one
 * line per new batch. The scanning itself is entirely `runScan`'s / `scanSource`'s
 * (§4.2) — this file only drives the watcher scheduler and renders its batches,
 * so `watch` and `scan` can never disagree about what a byte of history costs.
 */
import { basename } from 'node:path'
import { type AgentAdapter, type SourceSpec } from '@agentlens/event-model'
import {
  createWatcher,
  scanSource,
  DEFAULT_DISCOVER_INTERVAL_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  type EventSink,
  type SavedSourcePosition,
  type SavedSourceState,
  type SourceCommit,
  type WatchBatch,
  type WatchTarget,
  type Watcher,
} from '@agentlens/collector'
import {
  carriesTitleEvidence,
  deriveSessionProjects,
  deriveSessionTitles,
  insertEvents,
  recordParseFailure,
  updateSourceProgress,
  type SourceProgress,
} from '@agentlens/storage'
import type { DatabaseSync } from 'node:sqlite'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { makeHostCtx } from '../context.ts'
import { getAdapters } from '../adapters.ts'
import { formatCount, formatTime } from '../render.ts'
import { cmdScan, contentWanted, makeProjectResolver, recordProjectRoots } from './scan.ts'

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

function positionOf(s: SavedSourceState): SavedSourcePosition {
  return { inode: s.inode, size: s.size, mtimeMs: s.mtimeMs, lastOffset: s.lastOffset }
}

/**
 * The two session-level projections (§4.1 attribution, §10 titles) had no writer in the watch
 * loop: `runScan` runs them at its end, and `watch` calls `runScan` once for the opening summary
 * and never again — so a title record or a cwd arriving on the next appended line stayed
 * unprojected for the life of the process, which is the whole life of the dashboard.
 *
 * They are flagged rather than simply called per source because both read the whole store, not
 * this batch: a tick that touched ten files must project once, and the title pass is a full scan
 * of `events` (measured 1.16s over 400k rows) that only a landed title record can justify.
 */
interface PendingProjections {
  titles: boolean
  projects: boolean
}

/** Run whatever this batch earned, then clear for the next one. */
function drainProjections(db: DatabaseSync, pending: PendingProjections): { titled: number; attributed: number } {
  const { titles, projects } = pending
  pending.titles = false
  pending.projects = false
  return {
    titled: titles ? deriveSessionTitles(db).updated : 0,
    attributed: projects ? deriveSessionProjects(db).upgraded : 0,
  }
}

function makeSink(
  db: DatabaseSync,
  source: SourceSpec,
  agentId: string,
  contentEnabled: boolean,
  pending: PendingProjections,
  onCommit: (p: SourceCommit) => void,
): EventSink {
  return {
    writeEvents: (events) => {
      // Flagged off the batch the sink actually holds, before any of it can throw: an attributed
      // row landing is what makes a latched session repairable, and a title row is the only thing
      // that can make the full-store title scan worth running.
      if (events.length > 0) {
        pending.projects = true
        if (!pending.titles) pending.titles = events.some(carriesTitleEvidence)
      }
      insertEvents(db, events, { contentEnabled })
    },
    writeParseFailure: (f) => {
      recordParseFailure(db, { ...f, sourceId: source.id, agentId, path: f.path })
    },
    commitSource: (p: SourceCommit) => {
      const prev = db.prepare('SELECT rows_ingested FROM sources WHERE id = ?').get(p.id) as
        { rows_ingested: number | null } | undefined
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
      onCommit(p)
    },
  }
}

function makeTarget(db: DatabaseSync, ctx: Ctx, adapter: AgentAdapter, source: SourceSpec, contentEnabled: boolean, pending: PendingProjections): WatchTarget {
  const projects = makeProjectResolver(ctx.homedir)
  const target: WatchTarget = {
    id: source.id,
    agentId: adapter.id,
    adapter,
    source,
    saved: positionOf(savedState(db, source.id)),
    scan: async () => {
      const state = savedState(db, source.id)
      const result = await scanSource(adapter, source, {
        sink: makeSink(db, source, adapter.id, contentEnabled, pending, (p) => {
          // §4.2: only a committed batch advances the in-memory resume position.
          target.saved = { inode: p.inode, size: p.size, mtimeMs: p.mtimeMs, lastOffset: p.lastOffset }
        }),
        saved: state,
        agentId: adapter.id,
        hostId: adapter.id,
        resolveProject: projects.resolveProject,
        now: ctx.now,
        snapshotDir: ctx.snapshotDir,
      })
      recordProjectRoots(db, projects.roots)
      return result
    },
  }
  return target
}

/** Enumerate every watched agent's current files; the watcher adopts the ones it has not seen (§4.3). */
async function buildTargets(
  db: DatabaseSync,
  flags: FlagView,
  ctx: Ctx,
  adapters: AgentAdapter[],
  pending: PendingProjections,
): Promise<WatchTarget[]> {
  const only = flags.list('agent')
  const contentEnabled = contentWanted(flags)
  const known = new Set<string>()
  const targets: WatchTarget[] = []

  for (const adapter of adapters) {
    if (only.length > 0 && !only.includes(adapter.id)) continue
    let detected: Awaited<ReturnType<AgentAdapter['detect']>>
    try {
      detected = await adapter.detect(makeHostCtx(ctx))
    } catch (err) {
      ctx.err(`! ${adapter.id}: detection failed: ${(err as Error).message}`)
      continue
    }
    if (!detected.present) continue
    const dataRoot = detected.dataRoot ?? null
    for await (const source of adapter.discover(makeHostCtx(ctx, dataRoot))) {
      if (known.has(source.id)) continue
      known.add(source.id)
      targets.push(makeTarget(db, ctx, adapter, source, contentEnabled, pending))
    }
    const first = targets.find((t) => t.agentId === adapter.id)
    if (first) {
      first.discover = async function* (): AsyncIterable<WatchTarget> {
        for await (const source of adapter.discover(makeHostCtx(ctx, dataRoot))) {
          if (known.has(source.id)) continue
          known.add(source.id)
          yield makeTarget(db, ctx, adapter, source, contentEnabled, pending)
        }
      }
    }
  }
  return targets
}

/** §9 one-line-per-batch rendering. */
export function renderBatch(batch: WatchBatch, ctx: Ctx): void {
  for (const f of batch.failed) {
    ctx.err(
      `! ${formatTime(f.atMs)} ${f.agentId} ${basename(f.path)}: ${f.error} (attempt ${f.consecutive}${f.quarantined ? ', paused' : ''})`,
    )
  }
  for (const id of batch.vanished) {
    ctx.out(`· ${formatTime(batch.atMs)} source gone (history kept): ${basename(id)}`)
  }
  for (const s of batch.scanned) {
    if (s.events === 0 && s.linesConsumed === 0 && s.failures === 0) continue
    ctx.out(
      `+ ${formatTime(batch.atMs)} ${s.agentId} ${basename(s.path)} · ${s.action} · ` +
        `${formatCount(s.events)} events · ${formatCount(s.failures)} failures`,
    )
  }
  if (batch.discovered.length > 0) {
    ctx.out(`→ ${formatTime(batch.atMs)} discovered ${batch.discovered.length} new source(s)`)
  }
}

export interface WatchRun {
  /** Resolves with the process exit code once the watcher is shut down. */
  done: Promise<number>
  watcher: Watcher
  targetCount: number
}

/**
 * Run the `scan` summary, then start the resident watcher. `adapters` and
 * `registerShutdown` are injectable so the e2e test can drive start/stop
 * without real SIGINT or process timers; production uses `getAdapters` +
 * SIGINT/SIGTERM (§9).
 */
export async function runWatch(
  db: DatabaseSync,
  flags: FlagView,
  ctx: Ctx,
  deps: {
    adapters?: AgentAdapter[]
    registerShutdown?: (stop: () => void) => () => void
    printInitialSummary?: boolean
  } = {},
): Promise<WatchRun> {
  if (deps.printInitialSummary !== false) await cmdScan(db, flags, ctx)

  const adapters = deps.adapters ?? await getAdapters()
  if (adapters.length === 0) {
    ctx.out('! watch: no adapters installed — nothing to watch.')
    const noop = createWatcher({ targets: [], useFsWatch: false, discoverIntervalMs: 0 })
    return { done: Promise.resolve(0), watcher: noop, targetCount: 0 }
  }

  const pending: PendingProjections = { titles: false, projects: false }
  const targets = await buildTargets(db, flags, ctx, adapters, pending)
  const intervalMs = flags.num('interval') ?? DEFAULT_WATCH_INTERVAL_MS
  const watcher = createWatcher({
    targets,
    intervalMs,
    discoverIntervalMs: DEFAULT_DISCOVER_INTERVAL_MS,
    useFsWatch: true,
    onBatch: (b) => {
      renderBatch(b, ctx)
      const { titled, attributed } = drainProjections(db, pending)
      if (titled > 0 || attributed > 0) {
        ctx.out(
          `~ ${formatTime(b.atMs)} sessions projected · ${formatCount(titled)} titled · ${formatCount(attributed)} attributed`,
        )
      }
    },
    onLoopError: (err) => ctx.err(`! watch: ${err.message}`),
  })
  ctx.out(`watching ${targets.length} source(s) every ${Math.round(intervalMs / 1000)}s — Ctrl-C to stop`)

  const done = new Promise<number>((resolve) => {
    let shuttingDown = false
    const stop = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      teardown()
      watcher.stop()
      ctx.out('stopped')
      resolve(0)
    }
    const teardown = deps.registerShutdown
      ? deps.registerShutdown(stop)
      : registerSignalShutdown(stop)
    watcher.start()
  })
  return { done, watcher, targetCount: targets.length }
}

function registerSignalShutdown(stop: () => void): () => void {
  const onSig = (): void => stop()
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)
  return () => {
    process.off('SIGINT', onSig)
    process.off('SIGTERM', onSig)
  }
}

export async function cmdWatch(db: DatabaseSync, flags: FlagView, ctx: Ctx): Promise<number> {
  const { done } = await runWatch(db, flags, ctx)
  return done
}
