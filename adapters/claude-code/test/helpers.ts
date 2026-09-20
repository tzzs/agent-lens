/**
 * Shared test scaffolding: a fixture tree stands in for `~/.claude`, and every
 * `NormalizeCtx` is built with a fixed clock and a machine-independent source id
 * so the committed snapshots in fixtures/expected stay stable.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { deepStrictEqual } from 'node:assert'
import { Buffer } from 'node:buffer'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveSourceId,
  type HostContext,
  type NormalizeCtx,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
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
      const ts = (value as { timestamp?: unknown })?.timestamp
      out.push({
        seq,
        offset,
        occurredAt: typeof ts === 'string' ? Date.parse(ts) : typeof ts === 'number' ? ts : FIXED_NOW,
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
    id: deriveSourceId('claude-code', path),
    path,
    kind: 'jsonl',
    sessionHint,
  }
  return {
    source,
    agentId: 'claude-code',
    hostId: 'claude-code',
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
