/**
 * Shared test scaffolding: every case runs against a throwaway host database built by
 * `fixtures/build-host.ts`, with a fixed clock and a path-free source id so the committed
 * snapshots in `fixtures/expected/` stay stable.
 */
import { deepStrictEqual } from 'node:assert'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveSourceId,
  type AgentEvent,
  type HostContext,
  type NormalizeCtx,
  type ParseTail,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { zcodeAdapter } from '../src/index.ts'
import { AGENT_ID } from '../src/record.ts'

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
export const EXPECTED_DIR = join(FIXTURES_DIR, 'expected')
export const FIXED_NOW = 1_760_000_500_000

/** The five collected tables, in the order `discover` yields them. */
export const SOURCE_TABLES = ['session', 'message', 'part', 'model_usage', 'tool_usage'] as const

export function hostCtx(dataRoot: string | null, env: NodeJS.ProcessEnv = {}): HostContext {
  return {
    dataRoot,
    homedir: dataRoot ?? '/nonexistent-home',
    env,
    async readFile(path) {
      return readFile(path, 'utf8')
    },
    async readDir(path) {
      return readdir(path)
    },
    async stat(path) {
      try {
        const s = await stat(path)
        return { size: s.size, mtimeMs: s.mtimeMs, inode: s.ino }
      } catch {
        return null
      }
    },
  }
}

export function sourceFor(dbPath: string, table: string): SourceSpec {
  return {
    id: deriveSourceId(AGENT_ID, `${dbPath}#${table}`),
    path: dbPath,
    kind: 'sqlite',
    sqliteTable: table,
    sessionHint: null,
  }
}

/**
 * Snapshots pin event ids and ids are derived from the source id — so the fixture's random
 * `mkdtemp` path must not leak into them. `SNAPSHOT_DB_PATH` stands in for the path while
 * the rows are still read from the throwaway file.
 */
export const SNAPSHOT_DB_PATH = '/agentlens-zcode-fixture/cli/db/db.sqlite'

export function snapshotSourceFor(table: string, realPath: string): SourceSpec {
  return {
    id: deriveSourceId(AGENT_ID, `${SNAPSHOT_DB_PATH}#${table}`),
    path: realPath,
    kind: 'sqlite',
    sqliteTable: table,
    sessionHint: null,
  }
}

export function ctxFor(source: SourceSpec, sessionHint: string | null = null, storePath?: string): NormalizeCtx {
  return {
    source,
    agentId: AGENT_ID,
    hostId: AGENT_ID,
    sessionHint,
    storePath: storePath ?? source.path,
    resolveProject: (cwd) => (cwd ? `project:${cwd.split('/').pop() ?? cwd}` : null),
    now: () => FIXED_NOW,
  }
}

export function normalizeCtx(dbPath: string, table: string, sessionHint: string | null = null): NormalizeCtx {
  return ctxFor(sourceFor(dbPath, table), sessionHint)
}

export interface ScannedSource {
  records: RawRecord[]
  tail: ParseTail
  events: AgentEvent[]
  failures: number
}

/** detect-free end-to-end run of one source: parse → normalize, mirroring `scanSqliteSource`. */
export async function scanSource(
  dbPath: string,
  table: string,
  fromRowid = 0,
  options: { stableIds?: boolean; storePath?: string } = {},
): Promise<ScannedSource> {
  const source = options.stableIds ? snapshotSourceFor(table, dbPath) : sourceFor(dbPath, table)
  const ctx = ctxFor(source, null, options.storePath)
  const records: RawRecord[] = []
  const stream = zcodeAdapter.parse(source, { offset: fromRowid }, ctx)
  while (true) {
    const next = await stream.next()
    if (next.done) {
      const events: AgentEvent[] = []
      let failures = 0
      for (const record of records) {
        const result = await zcodeAdapter.normalize(record, ctx)
        if ('failure' in result) failures++
        else events.push(...result.events)
      }
      return { records, tail: next.value, events, failures }
    }
    records.push(next.value)
  }
}

/** All five sources in discovery order — the shape one collector pass produces. */
export async function scanAll(
  dbPath: string,
  options: { stableIds?: boolean } = {},
): Promise<{ events: AgentEvent[]; failures: number; byTable: Map<string, AgentEvent[]> }> {
  const events: AgentEvent[] = []
  const byTable = new Map<string, AgentEvent[]>()
  let failures = 0
  for (const table of SOURCE_TABLES) {
    const scanned = await scanSource(dbPath, table, 0, options)
    byTable.set(table, scanned.events)
    events.push(...scanned.events)
    failures += scanned.failures
  }
  return { events, failures, byTable }
}

/** Snapshot comparison; UPDATE_SNAPSHOTS=1 regenerates `fixtures/expected`. */
export async function matchSnapshot(launcher: string, actual: unknown): Promise<void> {
  const expectedPath = join(EXPECTED_DIR, launcher)
  const serialized = `${JSON.stringify(actual, null, 2)}\n`
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    await mkdir(EXPECTED_DIR, { recursive: true })
    await writeFile(expectedPath, serialized, 'utf8')
    return
  }
  let expected: string | null = null
  try {
    expected = await readFile(expectedPath, 'utf8')
  } catch {
    expected = null
  }
  if (expected === null) throw new Error(`missing snapshot ${expectedPath} — run UPDATE_SNAPSHOTS=1 to create it`)
  deepStrictEqual(JSON.parse(expected), JSON.parse(serialized))
}

/** Stable, comparable projection of an event list (ids first so ordering is deterministic). */
export function project(events: AgentEvent[]): unknown[] {
  return events
    .map((e) => ({
      id: e.id,
      type: e.type,
      subtype: e.subtype ?? null,
      sessionId: e.sessionId,
      threadId: e.threadId ?? null,
      projectId: e.projectId,
      hostId: e.hostId,
      timestamp: e.timestamp,
      rawSeq: e.rawSeq,
      rawOffset: e.rawOffset,
      requestId: e.requestId ?? null,
      parentEventId: e.parentEventId ?? null,
      usage: e.usage ?? null,
      usageSource: e.usageSource,
      costReported: e.costReported ?? null,
      costSource: e.costSource ?? null,
      capability: e.capability ?? null,
      durationMs: e.durationMs ?? null,
      status: e.status,
      model: e.model ?? null,
      payloadKind: e.payload?.kind ?? null,
      payloadChars: e.payload ? e.payload.text.length : 0,
      metadata: e.metadata ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
