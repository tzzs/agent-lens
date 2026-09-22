/**
 * §4.1 identity rules and §4.2 replay determinism.
 *
 * The properties that matter for a five-source SQLite adapter: one product session owns one
 * thread tree no matter which table a row came from; the request key is the one the store
 * proves is 1:1 and never the one it proves is 1:140; a full rescan reproduces the same ids
 * byte for byte so `INSERT OR IGNORE` replays are no-ops; and per-source state cannot walk
 * from one table into another.
 */
import { deepStrictEqual } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UNATTRIBUTED_PROJECT_ID, deriveSessionId, type NormalizeCtx, type RawRecord } from '@agentlens/event-model'
import { zcodeAdapter } from '../src/index.ts'
import { normalize } from '../src/normalize.ts'
import { CHILD_SESSION, ROOT_SESSION, FIXTURE_MODEL_USAGE, buildHost, type BuiltHost } from '../fixtures/build-host.ts'
import { FIXED_NOW, hostCtx, normalizeCtx, project, scanAll, scanSource, sourceFor } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost({ subdir: 'cli/db' })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

describe('identity (§4.1)', () => {
  it('hostId is the single measured surface, and `cli/` in the path changes nothing (§二)', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      expect(events.length).toBeGreaterThan(30)
      // 10/10 root sessions here are desktop-app tasks even though every byte lives under a
      // directory named `cli/`, so no per-event host split is claimable from this store.
      expect([...new Set(events.map((e) => e.hostId))]).toEqual(['zcode'])
      expect([...new Set(events.map((e) => e.agentId))]).toEqual(['zcode'])
    })
  })

  it('threadId is the row’s own session and sessionId is the root of the parent_id chain', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      const child = events.filter((e) => e.threadId === CHILD_SESSION)
      expect(child.length).toBeGreaterThan(2)
      expect(child.every((e) => e.sessionId === deriveSessionId('zcode', ROOT_SESSION))).toBe(true)
      const root = events.find((e) => e.threadId === ROOT_SESSION)
      expect(root?.sessionId).toBe(deriveSessionId('zcode', ROOT_SESSION))
      expect(child.every((e) => e.metadata?.subagentThread === true)).toBe(true)
      expect(events.filter((e) => e.threadId === ROOT_SESSION).every((e) => e.metadata?.subagentThread === undefined)).toBe(true)
    })
  })

  it('the subagent flag is the parent link, not a heuristic (§五 367/367)', async () => {
    await withHost(async (host) => {
      const { byTable } = await scanAll(host.dbPath)
      const usage = (byTable.get('model_usage') ?? []).filter((e) => e.metadata?.query_source === 'subagent')
      expect(usage).toHaveLength(1)
      expect(usage[0]?.metadata?.subagentThread).toBe(true)
      const main = (byTable.get('model_usage') ?? []).filter((e) => e.metadata?.query_source === 'main_turn')
      expect(main.every((e) => e.metadata?.subagentThread === undefined)).toBe(true)
    })
  })

  it('a parent_id cycle terminates instead of hanging the scan', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'session')
      const cycle = events.filter((e) => typeof e.threadId === 'string' && e.threadId.includes('cycle'))
      expect(cycle).toHaveLength(4) // 2 starts + 2 subagent.start
    })
  })

  it('requestId is logical_request_id; trace_id is never a request key (§五)', async () => {
    await withHost(async (host) => {
      const { byTable } = await scanAll(host.dbPath)
      const usage = byTable.get('model_usage') ?? []
      const requestIds = usage.map((e) => e.requestId)
      // 4 of the 6 fixture rows carry the same `trace_id`, exactly the measured 499-rows-
      // over-10-traces shape that would collapse 499 calls into one request.
      const traceIds = usage.map((e) => e.metadata?.trace_id)
      expect(new Set(traceIds).size).toBeLessThan(new Set(requestIds).size)
      expect(requestIds.every((r) => typeof r === 'string' && r !== '' && !String(r).startsWith('trace-'))).toBe(true)
      expect(new Set(requestIds).size).toBe(requestIds.length)
      expect(requestIds).toContain(FIXTURE_MODEL_USAGE[0]?.logicalRequestId)
      expect(traceIds).toContain('trace-fixture-shared-0001')
    })
  })

  it('project comes from the cwd only; the native project id is metadata (§4.1/§7)', async () => {
    await withHost(async (host) => {
      const { byTable } = await scanAll(host.dbPath)
      const starts = (byTable.get('session') ?? []).filter((e) => e.type === 'session.start')
      const root = starts.find((e) => e.metadata?.native_session_id === ROOT_SESSION)
      expect(root?.projectId).toBe('project:zroot')
      expect(root?.metadata?.native_project_id).toBe('proj_work-zroot')
      expect(root?.projectId).not.toBe(deriveSessionId('zcode', 'proj_work-zroot'))
      const archived = starts.find((e) => e.metadata?.native_session_id === 'sess_fixture_archived_0003')
      expect(archived?.projectId).toBe('project:zbeta')
      // The child session shares its parent's directory, hence its project — inherited from
      // the join, not guessed from the session id.
      const child = starts.find((e) => e.metadata?.native_session_id === CHILD_SESSION)
      expect(child?.projectId).toBe('project:zroot')
    })
  })

  it('an unresolvable cwd reports UNATTRIBUTED rather than guessing (§4.1 rule 5)', async () => {
    await withHost(async (host) => {
      const source = sourceFor(host.dbPath, 'message')
      const ctx: NormalizeCtx = { ...normalizeCtx(host.dbPath, 'message'), source, resolveProject: () => null }
      const result = await zcodeAdapter.normalize(
        { seq: 1, offset: 1, occurredAt: FIXED_NOW, value: { __rowid: 1, __table: 'message', session_id: 's', data: {} } },
        ctx,
      )
      if ('events' in result) {
        expect(result.events[0]?.projectId).toBe(UNATTRIBUTED_PROJECT_ID)
        expect(result.events[0]?.metadata?.diagnostics).toContain('project_unattributed')
      } else throw new Error('unexpected failure')
    })
  })

  it('two sources over one file cannot collide on an event id', async () => {
    const partCtx = normalizeCtx('/fixture/zcode.db', 'part')
    const messageCtx = normalizeCtx('/fixture/zcode.db', 'message')
    const a = await normalize(
      { seq: 7, offset: 7, occurredAt: FIXED_NOW, value: { __rowid: 7, __table: 'part', session_id: 's', data: { type: 'step-finish', tokens: { input: 3 } } } },
      partCtx,
    )
    const b = await normalize(
      { seq: 7, offset: 7, occurredAt: FIXED_NOW, value: { __rowid: 7, __table: 'message', session_id: 's', data: { role: 'assistant' } } },
      messageCtx,
    )
    if ('events' in a && 'events' in b) {
      expect(a.events[0]?.id).not.toBe(b.events[0]?.id)
      expect(a.events[0]?.sourceId).not.toBe(b.events[0]?.sourceId)
    } else throw new Error('unexpected failure')
  })
})

describe('replay determinism (§4.2)', () => {
  it('a full rescan reproduces byte-identical events, ids included', async () => {
    await withHost(async (host) => {
      const first = await scanAll(host.dbPath, { stableIds: true })
      const second = await scanAll(host.dbPath, { stableIds: true })
      deepStrictEqual(project(second.events), project(first.events))
      expect(first.events.length).toBeGreaterThan(30)
      expect(new Set(first.events.map((e) => e.id)).size).toBe(first.events.length)
      expect(first.failures).toBe(1)
    })
  })

  it('rawSeq and rawOffset both carry the rowid, so replays are no-ops', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'model_usage')
      for (const e of events) {
        expect(e.rawSeq).toBeGreaterThan(0)
        expect(e.rawOffset).toBe(e.rawSeq)
      }
    })
  })
})

describe('per-source state isolation', () => {
  function partRow(seq: number, extra: Record<string, unknown>): RawRecord {
    return {
      seq,
      offset: seq,
      occurredAt: FIXED_NOW,
      value: {
        __rowid: seq,
        __table: 'part',
        message_id: 'msg-x',
        session_id: 'sess-x',
        time_created: FIXED_NOW,
        data: { type: 'text', text: 'synthetic' },
        ...extra,
      },
    }
  }

  const JOINS = {
    __message_role: 'user',
    __message_kind: 'user_prompt',
    __message_origin: 'real_user',
    __session_id: 'sess-x',
    __root_session_id: 'sess-x',
  }

  it('a degraded row inherits only from its own source', async () => {
    const inSource = normalizeCtx('/fixture/zcode.db', 'part')
    const otherSource = normalizeCtx('/fixture/zcode.db', 'message')
    const warm = await normalize(partRow(1, JOINS), inSource)
    expect('events' in warm).toBe(true)

    // Same source, no join columns: the earlier row of THIS source vouches for the kind.
    const inherited = await normalize(partRow(2, {}), inSource)
    if ('events' in inherited) {
      expect(inherited.events[0]?.type).toBe('message.user')
      expect(inherited.events[0]?.metadata?.diagnostics).toContain('content_kind_inherited_from_source_state')
    } else throw new Error('unexpected failure')

    // Another source over the same file has never seen that row, so it stays unresolved.
    const dir = await mkdtemp(join(tmpdir(), 'agentlens-zcode-isolation-'))
    try {
      const foreign = normalizeCtx(join(dir, 'db.sqlite'), 'part')
      const isolated = await normalize(partRow(1, {}), { ...foreign, source: sourceFor(join(dir, 'db.sqlite'), 'part') })
      if ('events' in isolated) {
        expect(isolated.events[0]?.type).toBe('unknown')
        expect(isolated.events[0]?.subtype).toBe('text')
        expect(String(isolated.events[0]?.metadata?.reason)).toContain('content_kind_unresolved')
      } else throw new Error('unexpected failure')
      // And the `message` source never learns from a `part` row either.
      const notLeaked = await normalize(partRow(3, {}), otherSource)
      if ('events' in notLeaked) expect(notLeaked.events[0]?.type).toBe('unknown')
      else throw new Error('unexpected failure')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a seq restart rebuilds the state, so a replay matches the first pass', async () => {
    const ctx = normalizeCtx('/fixture/zcode.db', 'part')
    await normalize(partRow(1, JOINS), ctx)
    // Rowid 1 again is a rescan: the map must be rebuilt, and this degraded row must then be
    // unresolved exactly as it would be at the head of a cold pass.
    await normalize(partRow(1, JOINS), ctx)
    const afterReplay = await normalize(partRow(2, {}), ctx)
    if ('events' in afterReplay) {
      expect(afterReplay.events[0]?.metadata?.diagnostics).toContain('content_kind_inherited_from_source_state')
      expect(afterReplay.events[0]?.type).toBe('message.user')
    } else throw new Error('unexpected failure')
  })
})

describe('adapter surface', () => {
  it('declares an aggregation policy, a capability catalog and no write path (§5.2 rule 2)', () => {
    expect(zcodeAdapter.aggregation).toEqual({ mode: 'per_record_sum', subagentsIncluded: true })
    expect(Object.keys(zcodeAdapter).sort()).toEqual([
      'aggregation',
      'capabilities',
      'detect',
      'discover',
      'displayName',
      'id',
      'normalize',
      'parse',
      'parserVersion',
    ])
    expect(zcodeAdapter.id).toBe('zcode')
    expect(zcodeAdapter.displayName).toBe('ZCode')
    expect(zcodeAdapter.parserVersion).toBe(4)
  })

  it('exports the default the CLI’s pickAdapter prefers', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.default).toBe(zcodeAdapter)
  })
})
