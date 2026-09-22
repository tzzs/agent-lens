/**
 * End-to-end over a throwaway host: detect → discover → parse → normalize, plus the
 * §七 event census the mapping table promises and the §一 layout decisions that say where
 * the store is and which tables are not sources.
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { validateEvent } from '@agentlens/event-model'
import { zcodeAdapter } from '../src/index.ts'
import { buildHost, COMPACTING_SESSION, FIXTURE_MESSAGES, FIXTURE_SESSIONS, type BuiltHost } from '../fixtures/build-host.ts'
import { SOURCE_TABLES, hostCtx, scanAll, scanSource } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost({ subdir: 'cli/db' })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

describe('zcode adapter · detect + discover (§5.1)', () => {
  it('finds the store at cli/db/db.sqlite and reports the engine version', async () => {
    await withHost(async (host) => {
      const detection = await zcodeAdapter.detect(hostCtx(host.dir))
      expect(detection.present).toBe(true)
      expect(detection.reason).toBeNull()
      expect(detection.dataRoot).toBe(host.dir)
      // §七: `schema_migration.app_version` is the engine line; this store has no such table
      // seeded, so `session.version` is the fallback that answers.
      expect(detection.agentVersion).toBe('0.16.5')
    })
  })

  it('yields exactly five sqlite sources, one per collected table', async () => {
    await withHost(async (host) => {
      const seen: string[] = []
      const ids = new Set<string>()
      for await (const spec of zcodeAdapter.discover(hostCtx(host.dir))) {
        seen.push(`${spec.kind}:${spec.sqliteTable}`)
        ids.add(spec.id)
        expect(spec.path).toBe(host.dbPath)
        expect(spec.sessionHint).toBeNull()
      }
      expect(seen).toEqual(SOURCE_TABLES.map((t) => `sqlite:${t}`))
      // The id salts the table, so five sources over one file stay five distinct rows.
      expect(ids.size).toBe(5)
    })
  })

  it('does not advertise the rollup tables (§三)', async () => {
    await withHost(async (host) => {
      const tables: string[] = []
      for await (const spec of zcodeAdapter.discover(hostCtx(host.dir))) tables.push(spec.sqliteTable ?? '')
      for (const ignored of ['turn_usage', 'session_target']) expect(tables).not.toContain(ignored)
    })
  })

  it('reports absence when the store is not there', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    const dir = host.dir
    await host.close()
    const detection = await zcodeAdapter.detect(hostCtx(`${dir}/missing`))
    expect(detection.present).toBe(false)
    expect(detection.reason).toContain('no database')
  })

  it('honours ZCODE_HOME when no data root is seeded', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      // `ctx.dataRoot ?? env.ZCODE_HOME ?? ~/.zcode`: a caller that seeds a root which does
      // not hold the store must not make the agent look absent.
      const ctx = hostCtx(null, { ZCODE_HOME: host.dir })
      const detection = await zcodeAdapter.detect(ctx)
      expect(detection.present).toBe(true)
      expect(detection.dataRoot).toBe(host.dir)
      let sources = 0
      for await (const spec of zcodeAdapter.discover(ctx)) {
        sources++
        expect(spec.path).toBe(host.dbPath)
      }
      expect(sources).toBe(5)
    } finally {
      await host.close()
    }
  })
})

describe('zcode adapter · the §七 mapping census', () => {
  it('maps every row of every source into events that pass schema validation', async () => {
    await withHost(async (host) => {
      const { events, byTable } = await scanAll(host.dbPath)
      for (const e of events) expect(validateEvent(e)).toEqual([])
      expect([...byTable.keys()]).toEqual([...SOURCE_TABLES])
      // One undecodable `part.data` blob is a reported failure, never a dropped row (§5.2).
      const failures = (await scanSource(host.dbPath, 'part')).failures
      expect(failures).toBe(1)
    })
  })

  /**
   * Every figure is the §七 row count of the fixture. The two cycle sessions exist to prove
   * the root walk terminates, and they do have `parent_id`, so they are counted:
   *  - `session` 6 rows → 6 `session.start`, 3 `subagent.start` (child + both cycle rows,
   *    each having a parent), 1 `session.end` (the one `time_archived` row), 1
   *    `context.compact` (the one `time_compacting` row — §17 item 5's "does this agent even
   *    have compaction", answered as an event so the capability dimensions can see it);
   *  - `message` 10 rows → 1 `message.user` (the only `real_user` prompt), 3
   *    `message.assistant`, 1 `error`, 6 `unknown` (four injected kinds + an unseen kind + a
   *    row with no `semantics` at all);
   *  - `part` 20 readable rows → 1 `generation.start`, 5 `tool.start`, 2 `mcp.invoke`,
   *    1 `skill.invoke`, 1 `subagent.start` (the `Agent` call), 4 content events
   *    (3 assistant + 1 user), 6 `unknown` (2 `step-finish` duplicates, the injected text
   *    part, `timeline`, `file`, an unseen type);
   *  - `model_usage` 6 rows → 6 `generation.end`, the only usage carriers;
   *  - `tool_usage` 8 rows → 8 `tool.end`.
   */
  it('produces exactly the event types the mapping table names', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      const byType = new Map<string, number>()
      for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
      expect(Object.fromEntries([...byType.entries()].sort())).toEqual({
        error: 1,
        'context.compact': 1,
        'generation.end': 6,
        'generation.start': 1,
        'message.assistant': 6,
        'message.user': 2,
        'mcp.invoke': 2,
        'session.end': 1,
        'session.start': 6,
        'skill.invoke': 1,
        'subagent.start': 4,
        'tool.end': 8,
        'tool.start': 5,
        unknown: 12,
      })
    })
  })

  it('states compaction as an event, not as a field buried in one row', async () => {
    await withHost(async (host) => {
      const { byTable } = await scanAll(host.dbPath)
      const sessions = byTable.get('session') ?? []
      const compacts = sessions.filter((e) => e.type === 'context.compact')
      // One seeded row, one event; the other five sessions state no compaction at all, and a
      // NULL column must never become a fabricated marker.
      expect(compacts).toHaveLength(1)
      const [compact] = compacts
      expect(compact?.metadata).toMatchObject({ source: 'session.time_compacting' })
      expect(compact?.usage).toBeNull()
      expect(compact?.requestId).toBeNull()
      const seeded = FIXTURE_SESSIONS.find((s) => s.timeCompacting !== null && s.timeCompacting !== undefined)
      // The instant is the store's own, copied verbatim — not a scan-clock guess (§5.2).
      expect(compact?.timestamp).toBe(seeded?.timeCompacting ?? null)
      expect(seeded?.id).toBe(COMPACTING_SESSION)
      // The fact is no longer duplicated inside `session.start`'s metadata.
      expect(sessions.find((e) => e.type === 'session.start')?.metadata).not.toHaveProperty('compacting_at')
    })
  })

  it('counts user turns by semantics, not by role: the §五 2.12× inflation does not happen', async () => {
    await withHost(async (host) => {
      const { byTable } = await scanAll(host.dbPath)
      const messages = byTable.get('message') ?? []
      const parts = byTable.get('part') ?? []
      // The fixture seeds 6 `role='user'` message rows and exactly 1 real prompt, the same
      // 89-of-189 shape §五 measured; a role mapping would report 6 user turns from
      // `message` and 7 once the injected rows' `text` parts are counted too.
      const seededUserRoles = FIXTURE_MESSAGES.filter((m) => m.data.role === 'user').length
      expect(seededUserRoles).toBe(6)
      expect(messages.filter((e) => e.type === 'message.user')).toHaveLength(1)
      expect(parts.filter((e) => e.type === 'message.user')).toHaveLength(1)
      expect(messages.filter((e) => e.subtype === 'todo_reminder').map((e) => e.type)).toEqual(['unknown'])
      expect(parts.filter((e) => e.subtype === 'todo_reminder').map((e) => e.type)).toEqual(['unknown'])
    })
  })

  it('keeps usage on exactly one event type across all five sources', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      const withUsage = events.filter((e) => e.usage)
      expect(withUsage).toHaveLength(6)
      expect(new Set(withUsage.map((e) => e.type))).toEqual(new Set<AgentEvent['type']>(['generation.end']))
      expect(new Set(withUsage.map((e) => e.sourceId))).toEqual(new Set([events.find((e) => e.metadata?.table === 'model_usage')?.sourceId]))
    })
  })
})

describe('zcode adapter · capabilities (§5.1)', () => {
  it('reports no catalog when the plugin surfaces are absent', async () => {
    await withHost(async (host) => {
      expect(await zcodeAdapter.capabilities?.(hostCtx(host.dir))).toEqual([])
    })
  })
})
