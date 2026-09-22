/**
 * §5.1 `normalize` behaviour beyond the snapshots: the whitelist is closed, the
 * capability surface stays honest, and the parent/usage invariants the fold rests on
 * hold on every scenario.
 */
import { describe, expect, it } from 'vitest'
import {
  isParseFailure,
  projectIdForCwd,
  type AgentEvent,
  type EventType,
} from '@agentlens/event-model'
import { piAdapter } from '../src/index.ts'
import { RECORD_TYPES, UNATTRIBUTED_PROJECT_ID } from '../src/normalize.ts'
import {
  NO_HEADER_HINT,
  SCENARIOS,
  ctxFor,
  eventsOf,
  matchSnapshot,
  readFixture,
  recordsFromJsonl,
  resetStateFor,
} from './helpers.ts'

describe('snapshots', () => {
  it.each([
    ['session-trace.jsonl', null],
    ['shared-usage.jsonl', null],
    ['no-header-trace.jsonl', NO_HEADER_HINT],
    ['unknown-record-type.jsonl', null],
    ['error-result.jsonl', null],
    ['timestamp-forms.jsonl', NO_HEADER_HINT],
  ])('%s normalizes to the committed event set', async (name, hint) => {
    await matchSnapshot(`${name}.json`, await eventsOf(name, hint as string | null))
  })
})

describe('record-type whitelist (§5.3)', () => {
  it('is exactly the four census types', () => {
    expect(RECORD_TYPES).toEqual(['session', 'message', 'model_change', 'thinking_level_change'])
  })

  it('produces no event type the schema does not know', async () => {
    const known: EventType[] = [
      'session.start',
      'message.user',
      'message.assistant',
      'tool.start',
      'tool.result',
      'generation.end',
      'unknown',
    ]
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        expect(known, `${name} emitted ${e.type}`).toContain(e.type)
      }
    }
  })
})

describe('session-trace mapping', () => {
  const name = 'session-trace.jsonl'

  it('opens with a session.start carrying the header facts', async () => {
    const events = await eventsOf(name)
    const start = events.find((e) => e.type === 'session.start')!
    expect(start.rawSeq).toBe(1)
    expect(start.subtype).toBeNull()
    expect(start.metadata?.cwd).toBe('/work/alpha')
    expect(start.metadata?.upstream_version).toBe(3)
    expect(start.metadata?.session_scoped).toBe(true)
  })

  it('config records land as counted unknowns, kept not dropped', async () => {
    const events = await eventsOf(name)
    const unknowns = events.filter((e) => e.type === 'unknown')
    expect(unknowns.map((e) => e.subtype)).toEqual(['model_change'])
    expect(unknowns[0]!.metadata?.mapped).toBe(true)
    expect(unknowns[0]!.metadata?.session_scoped).toBe(true)
    expect(unknowns[0]!.metadata?.value).toEqual({ model: 'claude-sonnet-4-5' })
  })

  it('pairs tool.start and tool.result through the callId', async () => {
    const events = await eventsOf(name)
    const start = events.find((e) => e.type === 'tool.start')!
    const result = events.find((e) => e.type === 'tool.result')!
    expect(start.capability).toEqual({ type: 'tool', name: 'read', provider: null })
    expect(start.metadata?.call_id).toBe('call-01')
    expect(start.payload?.kind).toBe('tool_input')
    expect(result.capability).toEqual({ type: 'tool', name: 'read', provider: null })
    expect(result.parentEventId).toBe(start.id)
    expect(result.status).toBe('ok')
    expect(result.metadata?.unlinked_result).toBeUndefined()
  })

  it('reasoning rides an assistant event under the primary message', async () => {
    const events = await eventsOf(name)
    const primary = events.find((e) => e.rawSeq === 4 && e.type === 'message.assistant' && e.subtype === 'toolUse')!
    const reasoning = events.find((e) => e.subtype === 'reasoning')!
    expect(reasoning.type).toBe('message.assistant')
    expect(reasoning.payload?.kind).toBe('reasoning')
    expect(reasoning.parentEventId).toBe(primary.id)
    expect(reasoning.capability).toBeNull()
  })

  it('ten records-worth of semantics: exactly the fan-out the census predicts', async () => {
    const events = await eventsOf(name)
    expect(events.map((e) => `${e.rawSeq}:${e.type}`)).toEqual([
      '1:session.start',
      '2:unknown',
      '3:message.user',
      '4:message.assistant',
      '4:message.assistant',
      '4:tool.start',
      '4:generation.end',
      '5:tool.result',
      '6:message.assistant',
      '6:generation.end',
    ])
  })
})

describe('drift and failure reporting', () => {
  it('an unrecognized record keeps raw JSON bounded by redact (§5.3)', async () => {
    const events = await eventsOf('unknown-record-type.jsonl')
    expect(events).toHaveLength(3)
    const branch = events.find((e) => e.subtype === 'branch_summary')!
    expect(branch.metadata?.mapped).toBe(false)
    expect(JSON.stringify(branch.metadata?.raw)).toMatch(/\(\d+ch\)/)
    const system = events.find((e) => e.subtype === 'message:role:system')!
    expect(system.metadata?.mapped).toBe(true)
    expect(system.metadata?.reason).toBe('unmapped message role')
  })

  it('an aborted assistant row reports status, fingerprint and zero usage (§4.4 row 1)', async () => {
    const events = await eventsOf('error-result.jsonl')
    const aborted = events.find((e) => e.subtype === 'aborted')!
    expect(aborted.type).toBe('message.assistant')
    expect(aborted.status).toBe('error')
    expect(aborted.errorFingerprint).toBeTruthy()
    expect(aborted.payload).toBeNull()
    const usageRow = events.find((e) => e.type === 'generation.end')!
    expect(usageRow.requestId).toBeNull()
    expect(usageRow.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
    expect(usageRow.usageSource).toBe('reported')
  })

  it('an orphan tool result still lands, marked unlinked', async () => {
    const events = await eventsOf('error-result.jsonl')
    const orphan = events.find((e) => e.type === 'tool.result')!
    expect(orphan.metadata?.unlinked_result).toBe(true)
    expect(orphan.capability).toEqual({ type: 'tool', name: 'bash', provider: null })
    expect(orphan.status).toBe('error')
    expect(orphan.errorFingerprint).toBeTruthy()
    expect(orphan.parentEventId).toBeNull()
  })
})

describe('projection invariants across all scenarios', () => {
  it('capabilities are only ever plain tools — none invented (§5.3)', async () => {
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        if (e.capability) expect(e.capability.type, `${name} invented ${e.capability.type}`).toBe('tool')
      }
    }
  })

  it('every event is internally consistent', async () => {
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        expect(e.agentId).toBe('pi')
        expect(e.id).toMatch(/^[0-9a-f]/)
        expect(e.schemaVersion).toBeGreaterThan(0)
        if (e.usage) expect(e.usageSource).toBe('reported')
        else expect(e.usageSource).toBe('missing')
        if (e.projectId === UNATTRIBUTED_PROJECT_ID) expect(e.metadata?.project_source).toBe('unattributed')
        else expect(['cwd', 'session']).toContain(String(e.metadata?.project_source ?? 'cwd'))
      }
    }
  })

  it('parent links only ever point at an event from the same source run', async () => {
    for (const name of SCENARIOS) {
      const events: AgentEvent[] = await eventsOf(name)
      const ids = new Set(events.map((e) => e.id))
      for (const e of events) {
        if (typeof e.parentEventId === 'string') expect(ids.has(e.parentEventId), `${name} dangling parent`).toBe(true)
      }
    }
  })
})

describe('context plumbing', () => {
  it('a direct caller without resolveProject still gets a project from the header cwd', async () => {
    // Falling back to the event-model rule keeps a raw `normalize()` caller from losing
    // the project entirely (§4.1), even though the collector normally resolves cwds.
    const ctx = { ...ctxFor('session-trace.jsonl'), resolveProject: () => null }
    resetStateFor(ctx)
    const records = recordsFromJsonl(await readFixture('session-trace.jsonl'))
    const first = await piAdapter.normalize(records[0]!, ctx)
    if (isParseFailure(first)) throw new Error(`unexpected failure ${first.failure.reason}`)
    expect(first.events[0]!.projectId).toBe(projectIdForCwd('/work/alpha'))
  })
})
