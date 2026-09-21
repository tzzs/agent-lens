/**
 * Fixture → event snapshots (§5.3 drift protection) plus the model-conformance
 * assertions. The projection deliberately shows the usage numbers, the thread/session
 * split and whether a cumulative snapshot leaked into `usage`, because those are the
 * three ways this adapter could silently produce a wrong number.
 */
import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { isParseFailure, validateEvent, type AgentEvent, type NormalizeResult } from '@agentlens/event-model'
import { codexAdapter, UNATTRIBUTED_PROJECT_ID } from '../src/index.ts'
import { ctxFor, FIXTURES_DIR, matchSnapshot, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

export const SCENARIOS = [
  'per-call-and-cumulative.jsonl',
  'cached-heavy-call.jsonl',
  'subagent-thread.jsonl',
  'hosts.jsonl',
  'compacted.jsonl',
  'error-records.jsonl',
  'tool-call.jsonl',
  'dynamic-tool-call.jsonl',
  'unknown-record-type.jsonl',
  'placeholder-usage.jsonl',
  'message-turns.jsonl',
  'parent-thread.jsonl',
  'child-thread.jsonl',
]

interface Projection {
  seq: number
  id: string
  type: string
  subtype: string | null
  hostId: string
  threadId: string | null
  session: string
  requestId: string | null
  capability: string | null
  usage: Record<string, number> | null
  usageSource: string
  durationMs: number | null
  status: string
  parentEventId: string | null
  model: string | null
  project: string
  payload: string | null
  subagentThread: boolean
  cumulativeInUsage: boolean
  rawInMetadata: boolean
}

function project(e: AgentEvent): Projection {
  const cumulative = e.metadata?.cumulative_usage as Record<string, unknown> | undefined
  return {
    seq: e.rawSeq,
    id: e.id.slice(0, 16),
    type: e.type,
    subtype: e.subtype ?? null,
    hostId: e.hostId,
    threadId: e.threadId ?? null,
    session: e.sessionId.slice(0, 12),
    requestId: e.requestId ?? null,
    capability: e.capability ? `${e.capability.type}:${e.capability.name}:${e.capability.provider ?? ''}` : null,
    usage: e.usage ? { ...e.usage } : null,
    usageSource: e.usageSource,
    durationMs: e.durationMs ?? null,
    status: e.status,
    parentEventId: e.parentEventId ? `set:${e.parentEventId.slice(0, 8)}` : null,
    model: e.model?.name ?? null,
    project: e.projectId === UNATTRIBUTED_PROJECT_ID ? 'unattributed' : e.projectId,
    payload: e.payload ? `${e.payload.kind}:${e.payload.text.length}` : null,
    subagentThread: e.metadata?.subagentThread === true,
    // A cumulative number must exist in metadata and NEVER inside `usage`.
    cumulativeInUsage: Boolean(
      e.usage && cumulative && JSON.stringify(e.usage) === JSON.stringify(cumulative),
    ),
    rawInMetadata: Boolean(e.metadata && 'raw' in e.metadata),
  }
}

export async function eventsOf(name: string, sessionHint: string | null = null): Promise<AgentEvent[]> {
  const ctx = ctxFor(name, sessionHint)
  resetStateFor(ctx)
  const events: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result: NormalizeResult = await codexAdapter.normalize(record, ctx)
    if (isParseFailure(result)) {
      if (name !== 'parse-failure.jsonl') throw new Error(`${name}: unexpected failure ${result.failure.reason}`)
      continue
    }
    events.push(...result.events)
  }
  return events
}

describe('codex normalize snapshots', () => {
  it('fixtures directory contains every declared scenario', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
    for (const scenario of SCENARIOS) expect(files).toContain(scenario)
  })

  for (const name of SCENARIOS) {
    it(`${name} → stable event stream`, async () => {
      const projected = (await eventsOf(name)).map(project)
      await matchSnapshot(`${name.replace(/\.jsonl$/, '')}.json`, projected)
      expect(projected.length).toBeGreaterThan(0)
    })
  }
})

describe('normalize contract', () => {
  it('every emitted event satisfies the event-model schema with a unique id', async () => {
    const seen = new Set<string>()
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        expect(validateEvent(e), `${name}: ${validateEvent(e).join('; ')}`).toEqual([])
        expect(e.agentId).toBe('codex')
        expect(e.threadId, `${name}: every Codex event carries its thread`).toBeTruthy()
        expect(seen.has(e.id), `duplicate event id across ${name}`).toBe(false)
        seen.add(e.id)
      }
    }
  })

  it('cumulative usage never lands in the usage columns, only in metadata (§18 row 2)', async () => {
    for (const name of SCENARIOS) {
      for (const e of (await eventsOf(name)).map(project)) {
        expect(e.cumulativeInUsage, `${name} seq ${e.seq}`).toBe(false)
      }
    }
  })

  it('unknown record types land in type "unknown" with the raw JSON in metadata (§5.3)', async () => {
    const events = await eventsOf('unknown-record-type.jsonl')
    const drift = events.find((e) => e.subtype === 'quantum_flux_sample')
    expect(drift?.type).toBe('unknown')
    expect(drift?.metadata?.mapped).toBe(false)
    expect(JSON.stringify(drift?.metadata?.raw)).toContain('deadbeef')
    // counted, not dropped: the second sample of the same type is a second event
    expect(events.filter((e) => e.subtype === 'quantum_flux_sample')).toHaveLength(2)
    expect(drift?.metadata?.unknown_totals_in_source).toEqual({ quantum_flux_sample: 1 })
    const last = events.filter((e) => e.subtype === 'quantum_flux_sample')[1]
    expect((last?.metadata?.unknown_totals_in_source as Record<string, number>).quantum_flux_sample).toBe(2)
    // an inner type Codex has never emitted (not in codex.md's event_msg census) is drift:
    // counted as unknown with mapped:false, and the raw JSON kept for triage
    const driftInner = events.find((e) => e.subtype === 'event_msg:agent_frozen')
    expect(driftInner?.type).toBe('unknown')
    expect(driftInner?.metadata?.mapped).toBe(false)
    expect(JSON.stringify(driftInner?.metadata?.raw)).toContain('synthetic')
    const interAgent = events.find((e) => e.subtype === 'inter_agent_communication_metadata')
    expect(interAgent?.type).toBe('unknown')
    expect(interAgent?.metadata?.mapped).toBe(true)
    // a redacted body: the raw prompt text never reaches metadata verbatim
    expect(JSON.stringify(events.find((e) => e.subtype === 'response_item:holographic_memory_dump')?.metadata)).not.toContain(
      'must be redacted in metadata',
    )
  })

  it('never stores a system prompt, compressed history or AGENTS.md body (§3.2)', async () => {
    for (const name of ['compacted.jsonl', 'per-call-and-cumulative.jsonl', 'subagent-thread.jsonl']) {
      for (const e of await eventsOf(name)) {
        const raw = JSON.stringify(e.metadata ?? {})
        expect(raw, name).not.toContain('Synthetic system prompt body')
        expect(raw, name).not.toContain('Synthetic compressed history')
        expect(raw, name).not.toContain('Synthetic AGENTS.md')
        expect(raw.length).toBeLessThan(8192)
      }
    }
    const compacted = (await eventsOf('compacted.jsonl')).find((e) => e.type === 'context.compact')
    expect(compacted?.subtype).toBe('compacted')
    expect(compacted?.metadata?.replacement_history_entries).toBe(2)
    expect(compacted?.metadata?.replacement_history_chars).toBeGreaterThan(0)
    expect((await eventsOf('compacted.jsonl')).filter((e) => e.type === 'context.compact')).toHaveLength(2)
    const worldState = (await eventsOf('compacted.jsonl')).find((e) => e.subtype === 'world_state')
    expect(worldState?.metadata?.agents_md_chars).toBeGreaterThan(0)
    expect(worldState?.metadata?.timezone).toBe('Asia/Shanghai')
  })

  it('turns, tools and results are typed the Codex way (§3.3)', async () => {
    const events = await eventsOf('message-turns.jsonl')
    expect(events.find((e) => e.type === 'message.user')?.payload?.text).toContain('Synthetic user prompt')
    expect(events.find((e) => e.type === 'message.assistant')?.payload?.text).toContain('Synthetic assistant answer')
    // reasoning has no event type in the frozen enum: counted, payload preserved
    const reasoning = events.find((e) => e.subtype === 'response_item:reasoning')
    expect(reasoning?.type).toBe('unknown')
    expect(reasoning?.payload?.kind).toBe('reasoning')
    // a `developer` turn is injected instructions, not a user turn
    const developer = events.find((e) => e.subtype === 'response_item:message:developer')
    expect(developer?.type).toBe('unknown')
    expect(developer?.payload).toBeNull()

    const tools = await eventsOf('tool-call.jsonl')
    expect(tools.filter((e) => e.type === 'tool.start').map((e) => e.capability?.name)).toEqual([
      'exec_command',
      'apply_patch',
      'wait_agent',
      'web_search_call',
    ])
    const result = tools.find((e) => e.subtype === 'function_call_output')
    expect(result?.type).toBe('tool.result')
    expect(result?.parentEventId).toBeTruthy()
    expect(result?.capability?.name).toBe('exec_command')
    expect(tools.find((e) => e.subtype === 'custom_tool_call:apply_patch')?.capability?.name).toBe('apply_patch')
    // subagent lifecycle: spawn/close are thread events, not ordinary tools. The transport
    // stays in `subtype` (`function_call`), the identity in `capability`.
    const spawn = tools.find((e) => e.capability?.name === 'spawn_agent')
    expect(spawn?.type).toBe('subagent.start')
    expect(spawn?.subtype).toBe('function_call')
    const close = tools.find((e) => e.capability?.name === 'close_agent')
    expect(close?.type).toBe('subagent.end')
    expect(close?.subtype).toBe('function_call')
    const orphan = (await eventsOf('error-records.jsonl')).find((e) => e.type === 'tool.result')
    expect(orphan?.parentEventId).toBeNull()
    expect(orphan?.status).toBe('error')
    expect(orphan?.capability).toBeNull()
  })

  it('MCP-ish calls resolve through dynamic_tools namespaces, not an mcp__ prefix (§18 row 5)', async () => {
    const events = await eventsOf('dynamic-tool-call.jsonl')
    const mcp = events.filter((e) => e.type === 'mcp.invoke')
    expect(mcp.map((e) => `${e.capability?.provider}/${e.capability?.name}`)).toEqual([
      'codex_app/read_thread_terminal',
      'plugin_management/install_plugin',
      'dynamic_tools/tool_search',
    ])
    const plain = events.find((e) => e.capability?.name === 'shell_command')
    expect(plain?.type).toBe('tool.start')
    expect(plain?.capability?.type).toBe('tool')
    const result = events.find((e) => e.subtype === 'tool_search_output')
    expect(result?.type).toBe('tool.result')
    expect(result?.capability).toEqual({ type: 'mcp', name: 'tool_search', provider: 'dynamic_tools' })
  })

  it('errors map to type "error" and hook concepts are never invented (§18 row 5)', async () => {
    const events = await eventsOf('error-records.jsonl')
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.map((e) => e.subtype).sort()).toEqual(['error', 'turn_aborted'])
    expect(errors.every((e) => e.status === 'error' && Boolean(e.errorFingerprint) && e.usageSource === 'missing')).toBe(true)
    // codex.md §3.2: 0 hook records exist, so this adapter must never emit one.
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) expect(e.type).not.toBe('hook.fire')
    }
  })

  it('records with no resolvable cwd anywhere stay unattributed (§4.1)', async () => {
    // Replay the thread first so the state is the fixture's own: cwd IS known there.
    const ctx = ctxFor('hosts.jsonl')
    resetStateFor(ctx)
    for (const record of recordsFromJsonl(await readFixture('hosts.jsonl'))) {
      await codexAdapter.normalize(record, ctx)
    }
    const bare = {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt.' }] },
      timestamp: '2026-09-15T13:00:09.000Z',
    }
    const result = await codexAdapter.normalize({ seq: 9, offset: 999, occurredAt: 1, value: bare }, ctx)
    expect(isParseFailure(result)).toBe(false)
    if (isParseFailure(result)) return
    // cwd survives from the thread context, so this one is NOT unattributed…
    expect(result.events[0]?.projectId).toBe('project:hosts')
    expect(result.events[0]?.hostId).toBe('codex-desktop')

    // …but a thread that never stated a cwd is flagged instead of being filed away.
    const blind = ctxFor('hosts.jsonl', null, '/fixture/blind-hosts.jsonl')
    resetStateFor(blind)
    const orphan = await codexAdapter.normalize({ seq: 1, offset: 0, occurredAt: 1, value: bare }, blind)
    expect(isParseFailure(orphan)).toBe(false)
    if (isParseFailure(orphan)) return
    expect(orphan.events[0]?.projectId).toBe(UNATTRIBUTED_PROJECT_ID)
    expect(orphan.events[0]?.metadata?.project_unattributed).toBe(true)
    // no session_meta yet: the host axis degrades to codex-unknown, counted in metadata
    expect(orphan.events[0]?.hostId).toBe('codex-unknown')
    expect(orphan.events[0]?.metadata?.host_diagnostics).toEqual(['originator-absent'])
  })
})
