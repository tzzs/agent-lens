/**
 * §5.1 `normalize` snapshot regressions — the only cheap defence against upstream
 * format drift (§5.3). Each projection line is what the unified event says happened;
 * `id`/`sessionId`/`projectId` are reduced to prefixes so the snapshot is readable and
 * still catches an identity change.
 */
import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { validateEvent, type AgentEvent } from '@agentlens/event-model'
import { RECORD_TYPES, UNATTRIBUTED_PROJECT_ID } from '../src/normalize.ts'
import { FIXTURES_DIR, SCENARIOS, eventsOf, matchSnapshot } from './helpers.ts'

interface Projection {
  seq: number
  id: string
  type: string
  subtype: string | null
  hostId: string
  session: string
  project: string
  requestId: string | null
  capability: string | null
  usage: Record<string, number> | null
  usageSource: string
  costSource: string | null
  status: string
  parent: string | null
  model: string | null
  payload: string | null
  rawInMetadata: boolean
}

function project(e: AgentEvent, byEventId: Map<string, number>): Projection {
  const parentSeq = e.parentEventId ? byEventId.get(e.parentEventId) : undefined
  // The fixture ctx resolves projects through a readable stub; a real one is a hash and is
  // only compared by prefix, since a change of identity is what the snapshot must catch.
  const project = String(e.projectId)
  return {
    seq: e.rawSeq,
    id: e.id.slice(0, 8),
    type: e.type,
    subtype: e.subtype ?? null,
    hostId: e.hostId,
    session: e.sessionId.slice(0, 8),
    project:
      e.projectId === UNATTRIBUTED_PROJECT_ID
        ? 'unattributed'
        : project.startsWith('project:')
          ? project.slice('project:'.length)
          : project.slice(0, 8),
    requestId: e.requestId ?? null,
    capability: e.capability
      ? `${e.capability.type}:${e.capability.name}:${e.capability.provider ?? ''}`
      : null,
    usage: e.usage ? { ...e.usage } : null,
    usageSource: e.usageSource,
    costSource: e.costSource ?? null,
    status: e.status,
    parent: e.parentEventId ? (parentSeq === undefined ? 'unknown-id' : `seq:${parentSeq}`) : null,
    model: e.model ? `${e.model.provider}/${e.model.name}` : null,
    payload: e.payload ? `${e.payload.kind}:${e.payload.text.length}` : null,
    // `undefined` never survives the sink's JSON, so only a real payload counts as raw.
    rawInMetadata: e.metadata?.raw !== undefined,
  }
}

function projectAll(events: AgentEvent[]): Projection[] {
  const byEventId = new Map<string, number>()
  for (const e of events) if (!byEventId.has(e.id)) byEventId.set(e.id, e.rawSeq)
  return events.map((e) => project(e, byEventId))
}

describe('workbuddy normalize snapshots', () => {
  it('the fixtures directory contains every declared scenario', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
    for (const scenario of SCENARIOS) expect(files).toContain(scenario)
  })

  for (const name of SCENARIOS) {
    it(`${name} → stable event stream`, async () => {
      const projected = projectAll(await eventsOf(name))
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
        expect(seen.has(e.id), `duplicate event id across ${name}`).toBe(false)
        seen.add(e.id)
      }
    }
  })

  it('the record-type whitelist is the six measured types and nothing else is assumed (§5.3)', async () => {
    expect(RECORD_TYPES).toEqual([
      'function_call',
      'function_call_result',
      'reasoning',
      'message',
      'ai-title',
      'file-history-snapshot',
    ])
    const events = await eventsOf('tool-trace.jsonl')
    // The pair of non-traceable types is kept as subtype, not dropped (§5.3 "product value").
    expect(events.filter((e) => e.type === 'unknown').map((e) => e.subtype)).toEqual([
      'ai-title',
      'file-history-snapshot',
    ])
    for (const e of events.filter((e) => e.type === 'unknown')) {
      expect(e.metadata?.mapped).toBe(true)
      expect(e.metadata?.session_scoped).toBe(true)
    }
  })

  it('an unmapped record type keeps its raw JSON in metadata (§5.3)', async () => {
    const events = await eventsOf('unknown-record-type.jsonl')
    expect(events).toHaveLength(4)
    for (const e of events) expect(e.type).toBe('unknown')
    expect(events.map((e) => e.subtype)).toEqual(['tool-progress', '42', null, null])
    expect(JSON.stringify(events[0]?.metadata?.raw)).toContain('record type WorkBuddy added')
    expect(events[0]?.metadata?.mapped).toBe(false)
    expect(events[2]?.metadata?.upstream_type).toBeNull()
  })

  it('only the tool capability exists in this source: no mcp/hook/skill/subagent is invented', async () => {
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        if (!e.capability) continue
        expect(e.capability.type, `${name} invented capability ${e.capability.type}`).toBe('tool')
      }
      const types = new Set((await eventsOf(name)).map((e) => e.type))
      for (const invented of ['mcp.invoke', 'hook.fire', 'skill.invoke', 'subagent.start', 'subagent.end', 'context.compact', 'plugin.invoke', 'connector.invoke', 'command.execute']) {
        expect(types.has(invented as AgentEvent['type']), `${name} invented ${invented}`).toBe(false)
      }
    }
  })

  it('function_call → tool.start and function_call_result → tool.result, linked by callId', async () => {
    const events = await eventsOf('tool-trace.jsonl')
    const call = events.find((e) => e.type === 'tool.start')
    const result = events.find((e) => e.type === 'tool.result')
    expect(call?.capability).toEqual({ type: 'tool', name: 'read_file', provider: null })
    expect(result?.capability).toEqual({ type: 'tool', name: 'read_file', provider: null })
    expect(result?.parentEventId).toBe(call?.id)
    expect(result?.status).toBe('ok')
    expect(result?.payload?.kind).toBe('tool_output')
    expect(call?.payload?.kind).toBe('tool_input')
    // The result row that never saw its call is still counted, and says so.
    const errored = await eventsOf('error-result.jsonl')
    const orphan = errored.find((e) => e.type === 'tool.result' && e.rawSeq === 3)
    expect(orphan?.status).toBe('unknown')
    expect(orphan?.metadata?.unlinked_result).toBe(true)
    expect(orphan?.capability).toEqual({ type: 'tool', name: 'web_fetch', provider: null })
    const failed = errored.find((e) => e.type === 'tool.result' && e.rawSeq === 2)
    expect(failed?.status).toBe('error')
    expect(failed?.errorFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(failed?.parentEventId).toBe(errored.find((e) => e.type === 'tool.start')?.id)
  })

  it('a snapshot record is kept as an event but its file bodies are not copied (§3.2)', async () => {
    const events = await eventsOf('tool-trace.jsonl')
    const snapshot = events.find((e) => e.subtype === 'file-history-snapshot')
    expect(snapshot?.type).toBe('unknown')
    expect(snapshot?.payload).toBeNull()
    const meta = JSON.stringify(snapshot?.metadata)
    expect(meta).not.toContain('deliberately long')
    expect(snapshot?.metadata?.snapshot).toEqual({
      shape: 'object',
      entries: 1,
      fields: ['src/retry.ts'],
    })
    expect(snapshot?.metadata?.is_snapshot_update).toBe(true)
    const title = events.find((e) => e.subtype === 'ai-title')
    expect(title?.metadata?.value).toEqual({ title: 'Rename retry helper' })
  })

  it('reasoning rides an assistant message with a reasoning payload and no capability', async () => {
    const events = await eventsOf('tool-trace.jsonl')
    const reasoning = events.find((e) => e.subtype === 'reasoning')
    expect(reasoning?.type).toBe('message.assistant')
    expect(reasoning?.capability).toBeNull()
    expect(reasoning?.payload?.kind).toBe('reasoning')
    expect(reasoning?.usageSource).toBe('missing')
  })
})
