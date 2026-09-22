import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  deriveEventId,
  deriveProjectId,
  deriveSessionId,
  deriveSourceId,
  SCHEMA_VERSION,
  type AgentEvent,
  type EventType,
} from '@agentlens/event-model'
import { dumpTable } from '../src/query-shape.ts'

export const FIXTURE = {
  agentId: 'fake-agent',
  hostId: 'fake-agent',
  path: '/tmp/fake/logs/a.jsonl',
  repoRoot: '/repo/alpha',
  nativeSession: 'sess-111',
}

export const SOURCE_ID = deriveSourceId(FIXTURE.agentId, FIXTURE.path)
export const PROJECT_ID = deriveProjectId(FIXTURE.repoRoot)
export const SESSION_ID = deriveSessionId(FIXTURE.agentId, FIXTURE.nativeSession)

let seq = 0
export function makeEvent(overrides: Partial<AgentEvent> & { type?: EventType } = {}): AgentEvent {
  const rawSeq = overrides.rawSeq ?? ++seq
  const timestamp = overrides.timestamp ?? 1_750_000_000_000 + rawSeq * 1000
  const id =
    overrides.id ??
    deriveEventId({
      sourceId: SOURCE_ID,
      rawSeq,
      type: overrides.type ?? 'message.user',
      timestamp,
      discriminator: overrides.subtype ?? overrides.type ?? '',
    })
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    agentId: FIXTURE.agentId,
    hostId: FIXTURE.hostId,
    sourceId: SOURCE_ID,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    timestamp,
    ingestedAt: 1_750_000_100_000,
    type: overrides.type ?? 'message.user',
    usageSource: 'reported',
    status: 'ok',
    rawSeq,
    rawOffset: rawSeq * 128,
    ...overrides,
  }
}

export const SNAPSHOT_TABLES = [
  'schema_migrations',
  'agents',
  'projects',
  'models',
  'sources',
  'sessions',
  'events',
  // §19's materialised stage 1 rides along, so every existing idempotency assertion in this
  // directory is also asserting that a replay leaves the derived table byte-identical.
  'requests',
  'requests_state',
  'payloads',
  'parse_errors',
  'machine',
] as const

/** Byte-comparable snapshot of the whole DB state (§15 M0 acceptance ①). */
export function snapshot(db: DatabaseSync): string {
  const dump: Record<string, unknown> = {}
  for (const table of SNAPSHOT_TABLES) {
    dump[table] = table === 'schema_migrations'
      ? dumpTable(db, table).map(({ _rowid: _r, ...rest }) => rest)
      : dumpTable(db, table)
  }
  // applied_at carries Date.now(); exclude volatile fields so replays compare honestly.
  return JSON.stringify(dump, (_key, value) => {
    if (_key === 'applied_at' || _key === 'last_error_seen') return 'ANY'
    return value instanceof Uint8Array ? `b64:${Buffer.from(value).toString('base64')}` : value
  })
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agentlens-storage-'))
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
