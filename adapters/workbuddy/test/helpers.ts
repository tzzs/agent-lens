/**
 * Shared test scaffolding. A fixture tree stands in for `~/.workbuddy`, and every
 * `NormalizeCtx` is built with a fixed clock and a machine-independent source id, so the
 * committed snapshots in `fixtures/expected` stay stable.
 *
 * Nothing here ever touches the real data root: the fixture databases are synthetic
 * files with a hand-written SQLite header, so the WAL guard is exercised without a live
 * store being anywhere near it.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { deepStrictEqual } from 'node:assert'
import { Buffer } from 'node:buffer'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveSourceId,
  isParseFailure,
  recordOccurredAt,
  type AgentEvent,
  type HostContext,
  type NormalizeCtx,
  type NormalizeResult,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { workbuddyAdapter } from '../src/index.ts'
import { forgetState } from '../src/state.ts'
import { PARSE_ERROR_KEY } from '../src/record.ts'

/** Every trace scenario, in snapshot order. */
export const SCENARIOS = [
  'tool-trace.jsonl',
  'shared-usage.jsonl',
  'no-session-trace.jsonl',
  'unknown-record-type.jsonl',
  'error-result.jsonl',
  'timestamp-forms.jsonl',
] as const

/** Runs one fixture through `normalize` with a fresh scan state; failures are a test error. */
export async function eventsOf(name: string, sessionHint: string | null = null): Promise<AgentEvent[]> {
  const ctx = ctxFor(name, sessionHint)
  resetStateFor(ctx)
  const events: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result: NormalizeResult = await workbuddyAdapter.normalize(record, ctx)
    if (isParseFailure(result)) {
      if (name !== 'parse-failure.jsonl') {
        throw new Error(`${name}: unexpected failure ${result.failure.reason}`)
      }
      continue
    }
    events.push(...result.events)
  }
  return events
}

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
export const HOST_DIR = join(FIXTURES_DIR, 'host')
export const EXPECTED_DIR = join(FIXTURES_DIR, 'expected')

export const FIXED_NOW = 1_760_000_000_000

export async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), 'utf8')
}

/** Byte offsets accumulate exactly like the incremental reader's (§4.3). */
export function recordsFromJsonl(text: string): RawRecord[] {
  const out: RawRecord[] = []
  let offset = 0
  let seq = 1
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (line.trim() !== '') {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (err) {
        value = { [PARSE_ERROR_KEY]: `json-parse: ${String(err)}`, rawLine: line }
      }
      // Mirrors parseJsonlRecords (§5.1): the record's own time when it states one, and an
      // explicitly guessed stand-in otherwise — a string-only helper cannot stat a file mtime.
      const own = recordOccurredAt(value)
      out.push({
        seq,
        offset,
        occurredAt: own ?? FIXED_NOW,
        occurredAtOrigin: own === null ? 'ingest-clock' : 'record',
        value,
      })
    }
    offset += lineBytes
    seq++
  }
  return out
}

export function ctxFor(name: string, sessionHint: string | null = null): NormalizeCtx {
  const path = `/fixture/${name}`
  const source: SourceSpec = {
    id: deriveSourceId('workbuddy', path),
    path,
    kind: 'jsonl',
    sessionHint,
  }
  return {
    source,
    agentId: 'workbuddy',
    hostId: 'workbuddy',
    sessionHint,
    resolveProject: (cwd) => (cwd ? `project:${basename(cwd)}` : null),
    now: () => FIXED_NOW,
  }
}

export function hostCtx(overrides: Partial<HostContext> = {}): HostContext {
  const dataRoot = overrides.dataRoot ?? HOST_DIR
  const homedir = overrides.homedir ?? dataRoot
  return {
    dataRoot,
    homedir,
    env: {},
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
    ...overrides,
  }
}

/** Snapshot comparison; UPDATE_SNAPSHOTS=1 regenerates fixtures/expected. */
export async function matchSnapshot(launcher: string, actual: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
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
  if (expected === null) {
    throw new Error(`missing snapshot ${expectedPath} — run UPDATE_SNAPSHOTS=1 to create it`)
  }
  deepStrictEqual(JSON.parse(expected), JSON.parse(serialized))
}

export function resetStateFor(...ctxs: NormalizeCtx[]): void {
  for (const c of ctxs) forgetState(c.source.id)
}
