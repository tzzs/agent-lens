import { describe, expect, it } from 'vitest'
import {
  deriveSessionId,
  deriveSessionIdFromSource,
  deriveSessionIdFromTimeBucket,
  isParseFailure,
  type AgentEvent,
  type RawRecord,
} from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { ctxFor, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

async function eventsOf(name: string): Promise<AgentEvent[]> {
  const ctx = ctxFor(name)
  resetStateFor(ctx)
  const out: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result = await claudeCodeAdapter.normalize(record, ctx)
    if (!isParseFailure(result)) out.push(...result.events)
  }
  return out
}

/**
 * §1.5 rule 2: one store carries two hosts (measured 94.6% Desktop / 5.4% CLI).
 * Without this split "how much did I spend in Claude Code" is wrong by 31x.
 */
describe('host_id from entrypoint', () => {
  it('cli → claude-code, claude-desktop → claude-desktop', async () => {
    const cli = await eventsOf('cli-host.jsonl')
    const desktop = await eventsOf('desktop-host.jsonl')
    expect(new Set(cli.map((e) => e.hostId))).toEqual(new Set(['claude-code']))
    expect(new Set(desktop.map((e) => e.hostId))).toEqual(new Set(['claude-desktop']))
  })

  it('the same store splits into two hostIds record by record', async () => {
    const shared = await eventsOf('entrypoint-drift.jsonl')
    const byHost = new Map<string, number>()
    for (const e of shared) byHost.set(e.hostId, (byHost.get(e.hostId) ?? 0) + 1)
    expect([...byHost.keys()].sort()).toEqual(['claude-code', 'claude-desktop'])
    // absent entrypoint → CLI, but the ambiguity is reported rather than hidden
    const absent = shared.filter((e) => (e.metadata?.host_diagnostics as string[] | undefined)?.includes('entrypoint-absent'))
    expect(absent.length).toBeGreaterThan(0)
    expect(new Set(absent.map((e) => e.hostId))).toEqual(new Set(['claude-code']))
    const unknown = shared.filter((e) =>
      (e.metadata?.host_diagnostics as string[] | undefined)?.some((d) => d.startsWith('entrypoint-unknown')),
    )
    expect(unknown.length).toBeGreaterThan(0)
    expect(new Set(unknown.map((e) => e.hostId))).toEqual(new Set(['claude-desktop']))
  })

  it('hostId is a first-class field, not smuggled metadata', async () => {
    const desktop = await eventsOf('desktop-host.jsonl')
    for (const e of desktop) {
      expect(e.hostId).toBe('claude-desktop')
      expect(e.metadata?.entrypoint).toBeUndefined()
    }
  })
})

/** §2.7: 93.2% of user records are tool results; counting them as turns inflates 18x. */
describe('user record split', () => {
  it('tool_result records never become message.user', async () => {
    const all = await eventsOf('user-turn-mix.jsonl')
    const results = all.filter((e) => e.type === 'tool.result')
    const turns = all.filter((e) => e.type === 'message.user')
    expect(results).toHaveLength(6)
    expect(turns).toHaveLength(3)
    expect(results.length / turns.length).toBeGreaterThanOrEqual(2)
    for (const e of results) expect(e.payload?.kind).toBe('tool_output')
    for (const e of turns) expect(e.payload?.kind).toBe('user_message')
  })

  it('a tool result inherits the capability of the call it answers', async () => {
    const all = await eventsOf('user-turn-mix.jsonl')
    const answered = all.find((e) => e.type === 'tool.result' && e.metadata?.tool_use_id === 'tu-ut-1')
    expect(answered?.capability).toEqual({ type: 'tool', name: 'Read', provider: null })
    expect(answered?.parentEventId).toMatch(/^[0-9a-f]{64}$/)
    const errored = all.find((e) => e.type === 'tool.result' && e.metadata?.tool_use_id === 'tu-ut-9')
    expect(errored?.status).toBe('error')
    expect(errored?.errorFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

/** §4.4 row 6: the placeholder would otherwise add one ghost call per session. */
describe('<synthetic> placeholder', () => {
  it('becomes an error diagnostic with zero usage and no requestId', async () => {
    const all = await eventsOf('synthetic-model.jsonl')
    const ghost = all.filter((e) => e.model?.name === '<synthetic>')
    expect(ghost).toHaveLength(1)
    expect(ghost[0]?.type).toBe('error')
    expect(ghost[0]?.status).toBe('error')
    expect(ghost[0]?.usage).toBeNull()
    expect(ghost[0]?.usageSource).toBe('missing')
    expect(ghost[0]?.requestId).toBeNull()
    expect(all.filter((e) => e.type === 'generation.end')).toHaveLength(1)
  })
})

/** §2.5: hooks are the largest capability class and the only duration source. */
describe('hook records', () => {
  it('carry duration, provider and exit-code status, and link to the hooked call', async () => {
    const all = await eventsOf('hook-fire.jsonl')
    const hooks = all.filter((e) => e.type === 'hook.fire')
    expect(hooks).toHaveLength(3)
    const pre = hooks.find((e) => e.capability?.name === 'PreToolUse:Bash')
    expect(pre?.capability).toEqual({ type: 'hook', name: 'PreToolUse:Bash', provider: 'PreToolUse' })
    expect(pre?.durationMs).toBe(1234)
    expect(pre?.status).toBe('ok')
    expect(pre?.parentEventId).toBe(all.find((e) => e.capability?.name === 'Bash')?.id)
    const failed = hooks.find((e) => e.capability?.name === 'PostToolUseFailure:Bash')
    expect(failed?.status).toBe('error')
    expect(failed?.durationMs).toBe(77)
    expect(JSON.stringify(failed?.metadata)).not.toContain('report endpoint unreachable')
  })

  it('stop_hook_summary and turn_duration are counted, not dropped (§3.3)', async () => {
    const all = await eventsOf('stop-hook-summary.jsonl')
    const summary = all.find((e) => e.type === 'hook.fire')
    expect(summary?.subtype).toBe('stop_hook_summary')
    expect(summary?.durationMs).toBe(910)
    const turn = all.find((e) => e.subtype === 'turn_duration')
    expect(turn?.durationMs).toBe(6540)
    expect(turn?.type).toBe('unknown')
    expect(all.find((e) => e.type === 'command.execute')?.capability).toEqual({
      type: 'command',
      name: '/cost',
      provider: 'system',
    })
  })
})

/** §2.3: entry tool renamed Task→Agent across 2.1.x; parent linkage is a heuristic. */
describe('subagents', () => {
  it('Agent chain: start is linked to the entry call, end closes it', async () => {
    const all = await eventsOf('agent-subagent-chain.jsonl')
    const start = all.find((e) => e.type === 'subagent.start')
    const end = all.find((e) => e.type === 'subagent.end')
    const entry = all.find((e) => e.subtype === 'Agent:spawn')
    expect(entry?.capability).toEqual({ type: 'subagent', name: 'general-purpose', provider: 'Agent' })
    expect(start?.parentEventId).toBe(entry?.id)
    expect(start?.capability).toEqual({ type: 'subagent', name: 'general-purpose', provider: 'Agent' })
    expect(all.filter((e) => e.type === 'subagent.start')).toHaveLength(1)
    // §4.4 row 8 / probe-subagent-attribution: the spawn's own result carries the FK,
    // so this link is proved, not guessed.
    expect(end?.parentEventId).toBe(entry?.id)
    expect(end?.metadata?.parent_source).toBe('foreign-key')
    expect(end?.metadata?.parent_heuristic).toBe(false)
  })

  /**
   * docs/research/subagent-attribution.md: nearest-preceding is a *fallback* only.
   * Where the spawn's `tool_result` proves a different call, the proved link wins.
   */
  it('the spawn-result foreign key overrides a contradicting heuristic guess', async () => {
    const all = await eventsOf('agent-subagent-fk-override.jsonl')
    const wrong = all.find((e) => e.type === 'tool.start' && e.metadata?.tool_use_id === 'tu-fk-wrong')
    const trueSpawn = all.find((e) => e.type === 'tool.start' && e.metadata?.tool_use_id === 'tu-fk-true')
    const start = all.find((e) => e.type === 'subagent.start')
    const end = all.find((e) => e.type === 'subagent.end')
    // at start time only the earlier call exists, so the heuristic has to guess
    expect(start?.parentEventId).toBe(wrong?.id)
    expect(start?.metadata?.parent_source).toBe('heuristic')
    // the closing result names tu-fk-true, which is the parent the logs actually prove
    expect(end?.parentEventId).toBe(trueSpawn?.id)
    expect(end?.metadata?.parent_source).toBe('foreign-key')
    expect(end?.metadata?.linked_parent).toBe(trueSpawn?.id)
    expect(end?.capability).toEqual({ type: 'subagent', name: 'general-purpose', provider: 'Agent' })
  })

  /**
   * Deployed shape (probe-subagent-attribution): the chain's own records live in a
   * separate source, so this session file never emits `subagent.start` — but the
   * closing result still names its spawn, so `subagent.end` is attributed exactly.
   */
  it('attributes a chain whose records are in another source, from the closing result', async () => {
    const all = await eventsOf('agent-subagent-fk-separate-source.jsonl')
    const entry = all.find((e) => e.subtype === 'Agent:spawn')
    const end = all.find((e) => e.type === 'subagent.end')
    expect(all.filter((e) => e.type === 'subagent.start')).toHaveLength(0)
    expect(end?.parentEventId).toBe(entry?.id)
    expect(end?.metadata?.parent_source).toBe('foreign-key')
    expect(end?.metadata?.agent_id).toBe('a-sep-chain')
  })

  it('legacy Task entry is accepted and an unmatched chain stays NULL', async () => {
    const all = await eventsOf('legacy-task-entry.jsonl')
    const entry = all.find((e) => e.subtype === 'Task:spawn')
    expect(entry?.capability).toEqual({ type: 'subagent', name: 'claude-code-guide', provider: 'Task' })
    const start = all.find((e) => e.type === 'subagent.start')
    expect(start?.parentEventId).toBe(entry?.id)
    expect(start?.metadata?.parent_matched).toBe(true)
  })

  it('a side chain with no preceding entry call keeps parent_event_id NULL (§4.4 row 8)', async () => {
    const ctx = ctxFor('orphan-sidechain.jsonl')
    resetStateFor(ctx)
    const record = {
      seq: 1,
      offset: 0,
      occurredAt: Date.parse('2026-09-21T12:00:00.000Z'),
      value: {
        type: 'assistant',
        sessionId: 'sess-orphan',
        isSidechain: true,
        agentId: 'a-orphan-0001',
        uuid: 'u-orphan-1',
        timestamp: '2026-09-21T12:00:00.000Z',
        entrypoint: 'cli',
        requestId: 'req-orphan-1',
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'orphaned work' }],
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
        },
      },
    }
    const result = await claudeCodeAdapter.normalize(record, ctx)
    if (isParseFailure(result)) throw new Error('unexpected failure')
    const start = result.events.find((e) => e.type === 'subagent.start')
    expect(start?.parentEventId).toBeNull()
    expect(start?.metadata?.parent_matched).toBe(false)
    // NULL is an outcome doctor can count, not a silent guess (§4.4 row 8)
    expect(start?.metadata?.parent_source).toBe('none')
  })
})

/** §2.6: MCP tools carry their server in the name; plugin servers are namespaced. */
describe('mcp / plugin tools', () => {
  it('mcp__<server>__<tool> splits into name + provider', async () => {
    const all = await eventsOf('mcp-tool.jsonl')
    const mcp = all.find((e) => e.type === 'mcp.invoke')
    expect(mcp?.capability).toEqual({ type: 'mcp', name: 'navigate', provider: 'Claude_Browser' })
    const plugin = all.find((e) => e.type === 'plugin.invoke')
    expect(plugin?.capability).toEqual({
      type: 'plugin',
      name: 'tap',
      provider: 'plugin_build-ios-apps_xcodebuildmcp',
    })
  })
})

const MIN = 60 * 1000
/** A whole 30-minute boundary, so a bucket offset lands exactly where the test says. */
const T0 = Date.UTC(2026, 8, 20, 12, 0)

/**
 * §4.1 tier 3: measured reality is that every deployed Claude Code record carries a
 * `sessionId`, so this tier is the last-resort path — but a source that loses both the
 * session id and the `uuid` must group its records into one bucketed session instead of
 * minting one session per line.
 */
describe('session id from the source + time bucket (§4.1 tier 3)', () => {
  const sourceId = ctxFor('idless.jsonl').source.id

  function record(seq: number, atMs: number, extra: Record<string, unknown> = {}): RawRecord {
    const iso = new Date(atMs).toISOString()
    return {
      seq,
      offset: seq * 128,
      occurredAt: Date.parse(iso),
      value: {
        type: 'assistant',
        timestamp: iso,
        entrypoint: 'cli',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'id-less record' }],
        },
        ...extra,
      },
    }
  }

  async function sessionIdsOf(records: RawRecord[]): Promise<string[]> {
    const ctx = ctxFor('idless.jsonl')
    resetStateFor(ctx)
    const out: string[] = []
    for (const r of records) {
      const result = await claudeCodeAdapter.normalize(r, ctx)
      if (isParseFailure(result)) throw new Error(`seq ${r.seq} failed: ${result.failure.reason}`)
      expect(result.events.length, `seq ${r.seq} produced no event`).toBeGreaterThan(0)
      out.push(result.events[0]!.sessionId)
    }
    return out
  }

  it('records under 30 minutes apart join one session instead of one session per record', async () => {
    const ids = await sessionIdsOf([record(1, T0 + MIN), record(2, T0 + 10 * MIN), record(3, T0 + 29 * MIN)])
    const bucketed = deriveSessionIdFromTimeBucket(sourceId, T0 + MIN)
    expect(ids).toEqual([bucketed, bucketed, bucketed])
  })

  it('a gap over 30 minutes starts a second session', async () => {
    const ids = await sessionIdsOf([record(1, T0 + MIN), record(2, T0 + 46 * MIN)])
    expect(ids).toEqual([
      deriveSessionIdFromTimeBucket(sourceId, T0 + MIN),
      deriveSessionIdFromTimeBucket(sourceId, T0 + 46 * MIN),
    ])
    expect(ids[0]).not.toBe(ids[1])
  })

  it('a native sessionId still wins, and a uuid still names its own session', async () => {
    const ids = await sessionIdsOf([
      record(1, T0 + MIN, { sessionId: 'sess-native' }),
      record(2, T0 + 2 * MIN, { uuid: 'u-idless' }),
    ])
    expect(ids[0]).toBe(deriveSessionId('claude-code', 'sess-native'))
    expect(ids[1]).toBe(deriveSessionIdFromSource(sourceId, 'u-idless'))
  })
})
