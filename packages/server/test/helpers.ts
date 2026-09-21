/**
 * Shared fixture for the server tests: a migrated DB seeded through the REAL
 * writer (`insertEvents`), so routes are exercised against the rows the
 * collector produces rather than a hand-rolled copy of the schema.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { insertEvents, migrate, openDatabase, upsertProject } from '@agentlens/storage'
import type { AgentEvent } from '@agentlens/event-model'
import type { PriceEntry } from '@agentlens/pricing'
import { createApp, createContext } from '../src/app.ts'
import type { ServerCtx, ServerDeps } from '../src/types.ts'

/** 1 USD per 1M tokens on both sides: cheap to reason about in assertions. */
export const TEST_PRICE: PriceEntry = {
  provider: 'anthropic',
  model: 'test-model',
  inputPerMTok: 1,
  outputPerMTok: 1,
  cacheReadPerMTok: 1,
  cacheWritePerMTok: 1,
  reasoningPerMTok: null,
  effectiveFrom: 0,
  source: 'manual',
}

export function testPriceResolver(provider: string, model: string): PriceEntry | null {
  return provider === 'anthropic' && model === 'test-model' ? { ...TEST_PRICE } : null
}

/** Deterministic factory with readable, stable ids (`e1`, `f2`, …). */
function ev(id: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'cli',
    sourceId: 'src-1',
    sessionId: 'sess-aaaa1111',
    projectId: 'proj-1',
    timestamp: 1_700_000_000_000,
    type: 'message.assistant',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 0,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

/**
 * Covers §1.5 (two hosts on one agent), §3.1 (the same usage repeated under one
 * request id), §10 (a subagent chain through parent_event_id), §11 (hook + tool
 * failures) and §3.2 (a session with no content layer at all).
 */
export function fixtureEvents(): AgentEvent[] {
  return [
    ev('e1', { type: 'session.start', rawSeq: 1, usage: null, usageSource: 'missing' }),
    ev('e2', {
      rawSeq: 2,
      timestamp: 1_700_000_010_000,
      requestId: 'req-1',
      model: { provider: 'anthropic', name: 'test-model' },
      usage: usage(1000, 200),
      durationMs: 5_000,
    }),
    // Same request id, identical usage again: the cube must fold to the MAX, never sum.
    ev('e3', {
      rawSeq: 3,
      timestamp: 1_700_000_011_000,
      requestId: 'req-1',
      model: { provider: 'anthropic', name: 'test-model' },
      usage: usage(1000, 200),
    }),
    ev('e4', {
      type: 'tool.start',
      rawSeq: 4,
      timestamp: 1_700_000_020_000,
      capability: { type: 'tool', name: 'Bash', provider: 'builtin' },
      usage: null,
      usageSource: 'missing',
    }),
    ev('e5', {
      type: 'tool.end',
      rawSeq: 5,
      timestamp: 1_700_000_030_000,
      capability: { type: 'tool', name: 'Bash', provider: 'builtin' },
      parentEventId: 'e4',
      durationMs: 10_000,
      status: 'error',
      errorFingerprint: 'hash-bash-fail',
      usage: null,
      usageSource: 'missing',
    }),
    ev('e6', {
      type: 'subagent.start',
      rawSeq: 6,
      timestamp: 1_700_000_040_000,
      capability: { type: 'subagent', name: 'explore' },
      parentEventId: 'e1',
      usage: null,
      usageSource: 'missing',
    }),
    ev('e7', {
      type: 'hook.fire',
      rawSeq: 7,
      timestamp: 1_700_000_050_000,
      capability: { type: 'hook', name: 'PreToolUse:Bash' },
      status: 'error',
      errorFingerprint: 'hash-hook-timeout',
      usage: null,
      usageSource: 'missing',
    }),
    ev('e8', {
      type: 'context.compact',
      rawSeq: 8,
      timestamp: 1_700_000_060_000,
      usage: null,
      usageSource: 'missing',
      metadata: { trigger: 'auto' },
    }),
    ev('e9', { type: 'session.end', rawSeq: 9, timestamp: 1_700_000_070_000, usage: null, usageSource: 'missing' }),
    // Second session: other host, other project, an UNPRICED model.
    ev('f1', {
      sessionId: 'sess-bbbb2222',
      hostId: 'claude-desktop',
      projectId: 'proj-2',
      sourceId: 'src-2',
      requestId: 'req-2',
      model: { provider: 'anthropic', name: 'unpriced-model' },
      usage: usage(500, 50),
      rawSeq: 1,
      timestamp: 1_700_003_600_000,
    }),
    ev('f2', {
      sessionId: 'sess-bbbb2222',
      hostId: 'claude-desktop',
      projectId: 'proj-2',
      sourceId: 'src-2',
      type: 'tool.start',
      capability: { type: 'mcp', name: 'playwright', provider: 'mcp.json' },
      usage: null,
      usageSource: 'missing',
      rawSeq: 2,
      timestamp: 1_700_003_610_000,
    }),
  ]
}

export interface Seeded {
  db: DatabaseSync
  dir: string
  events: AgentEvent[]
  close(): void
}

export function seedDb(options: { contentEnabled?: boolean } = {}): Seeded {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-server-test-'))
  const db = openDatabase(join(dir, 'test.db'))
  migrate(db)
  const events = fixtureEvents()
  insertEvents(db, events, { contentEnabled: options.contentEnabled ?? false })
  db.prepare("UPDATE agents SET display_name = 'Claude Code' WHERE id = 'claude-code'").run()
  upsertProject(db, { id: 'proj-1', canonicalRoot: join(dir, 'repo-one'), displayName: 'repo-one', source: 'git' })
  upsertProject(db, { id: 'proj-2', canonicalRoot: join(dir, 'repo-two'), displayName: 'repo-two', source: 'git' })
  return {
    db,
    dir,
    events,
    close() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export interface Response_ {
  status: number
  body: any
  text: string
  headers: Headers
}

export interface Harness {
  seeded: Seeded
  ctx: ServerCtx
  app: ReturnType<typeof createApp>
  get(path: string): Promise<Response_>
  post(path: string): Promise<Response_>
  close(): void
}

/** Drives the Hono app through `fetch`; never binds a socket, so tests cannot race a port. */
export function harness(deps: Partial<ServerDeps> = {}, options: { contentEnabled?: boolean } = {}): Harness {
  const seeded = seedDb(options)
  const depsFor = (): ServerDeps => ({
    db: seeded.db,
    now: () => 1_700_000_100_000,
    priceResolver: testPriceResolver,
    homedir: seeded.dir,
    ...deps,
  })
  const ctx = createContext(depsFor())
  const app = createApp(depsFor())
  const call = async (method: 'GET' | 'POST', path: string): Promise<Response_> => {
    const res = await app.request(path, { method })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* non-JSON (SSE frames, static text) stays a string */
    }
    return { status: res.status, body, text, headers: res.headers }
  }
  return {
    seeded,
    ctx,
    app,
    get: (p) => call('GET', p),
    post: (p) => call('POST', p),
    close: () => seeded.close(),
  }
}
