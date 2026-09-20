/**
 * `scan` (§9) — the ONLY CLI path that writes events; every read command goes
 * through the cube so numbers cannot drift between commands.
 */
import { basename } from 'node:path'
import { projectIdForCwd, type AgentAdapter, type SourceSpec } from '@agentlens/event-model'
import { scanSource, type EventSink, type SavedSourceState, type SourceCommit } from '@agentlens/collector'
import { insertEvents, recordParseFailure, updateSourceProgress, type SourceProgress } from '@agentlens/storage'
import type { DatabaseSync } from 'node:sqlite'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { makeHostCtx } from '../context.ts'
import { getAdapters } from '../adapters.ts'
import { table } from '../render.ts'

export interface ScanOutcome {
  adaptersFound: number
  sourcesScanned: number
  events: number
  failures: number
  notDetected: string[]
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

export async function runScan(
  db: DatabaseSync,
  flags: FlagView,
  ctx: Ctx,
  onSource?: (agentId: string, source: SourceSpec, events: number, failures: number, action: string) => void,
): Promise<ScanOutcome> {
  const only = flags.list('agent')
  const contentEnabled = !flags.bool('no-content')
  const adapters = await getAdapters()
  const outcome: ScanOutcome = { adaptersFound: 0, sourcesScanned: 0, events: 0, failures: 0, notDetected: [] }
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
    for await (const source of adapter.discover(makeHostCtx(ctx, detected.dataRoot ?? null))) {
      const saved = savedState(db, source.id)
      const result = await scanSource(adapter, source, {
        sink: makeSink(db, source, adapter.id, contentEnabled),
        saved,
        agentId: adapter.id,
        hostId: adapter.id,
        resolveProject: (cwd) => (cwd ? projectIdForCwd(cwd) : null),
        now: ctx.now,
      })
      outcome.sourcesScanned++
      outcome.events += result.events
      outcome.failures += result.failures
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
  return 0
}
