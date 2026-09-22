/**
 * Shared test scaffolding: a fixture tree stands in for `~/.qoder`, and every
 * `NormalizeCtx` is built with a fixed clock and a machine-independent source
 * id so the committed snapshots in fixtures/expected stay stable.
 */
import assert from 'node:assert'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveSourceId,
  recordOccurredAt,
  type HostContext,
  type NormalizeCtx,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { normalize } from '../src/normalize.ts'
import { forgetState } from '../src/state.ts'
import { PARSE_ERROR_KEY } from '../src/record.ts'

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
    id: deriveSourceId('qoder', path),
    path,
    kind: 'jsonl',
    sessionHint,
  }
  return {
    source,
    agentId: 'qoder',
    hostId: 'qoder',
    sessionHint,
    resolveProject: (cwd) => (cwd ? `project:${cwd.split('/').pop() ?? cwd}` : null),
    now: () => FIXED_NOW,
  }
}

export function hostCtx(overrides: Partial<HostContext> = {}): HostContext {
  const dataRoot = overrides.dataRoot ?? HOST_DIR
  const homedir = overrides.homedir ?? HOST_DIR
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
  assert.deepStrictEqual(JSON.parse(expected), actual)
}

/** Normalize every record of a fixture; returns a stable shape for snapshots. */
export async function normalizeFixture(name: string, sessionHint: string | null = null) {
  forgetState(deriveSourceId('qoder', `/fixture/${name}`))
  const ctx = ctxFor(name, sessionHint)
  const records = recordsFromJsonl(await readFixture(name))
  const results = []
  for (const record of records) {
    results.push(await normalize(record, ctx))
  }
  return {
    results: results.map((r) =>
      'failure' in r
        ? { failure: r.failure }
        : {
            events: r.events.map((e) => ({
              id: e.id,
              type: e.type,
              subtype: e.subtype ?? null,
              hostId: e.hostId,
              sessionId: e.sessionId,
              threadId: e.threadId ?? null,
              projectId: e.projectId,
              parentEventId: e.parentEventId ?? null,
              requestId: e.requestId ?? null,
              timestamp: e.timestamp,
              model: e.model ?? null,
              usage: e.usage ?? null,
              usageSource: e.usageSource,
              costReported: e.costReported ?? null,
              costSource: e.costSource ?? null,
              credits: e.credits ?? null,
              capability: e.capability ?? null,
              durationMs: e.durationMs ?? null,
              status: e.status,
              errorFingerprint: e.errorFingerprint ?? null,
              rawSeq: e.rawSeq,
              rawOffset: e.rawOffset,
              payload: e.payload ? { ...e.payload, text: `${e.payload.text.length}ch` } : null,
              metadata: e.metadata ?? null,
            })),
          },
    ),
  }
}
