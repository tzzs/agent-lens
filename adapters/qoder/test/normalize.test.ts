/**
 * Fixture-level normalize behaviour + committed snapshot regressions (§5.3),
 * with explicit assertions on the rules the Qoder measurement forced:
 * credits-are-not-dollars, tool_result-is-not-a-user-turn, request_max folding.
 */
import { describe, expect, it } from 'vitest'
import { dedupeByRequestId, deriveSourceId, type AgentEvent } from '@agentlens/event-model'
import { forgetState } from '../src/state.ts'
import { normalize } from '../src/normalize.ts'
import { ctxFor, matchSnapshot, normalizeFixture, readFixture, recordsFromJsonl } from './helpers.ts'

async function events(name: string, hint: string | null = null): Promise<AgentEvent[]> {
  const r = await normalizeFixture(name, hint)
  return r.results.flatMap((x): AgentEvent[] => ('events' in x ? (x.events as AgentEvent[]) : []))
}

describe('snapshot fixtures', () => {
  for (const name of [
    'assistant-credits.jsonl',
    'tool-result-user.jsonl',
    'user-turn.jsonl',
    'mcp-tool.jsonl',
    'hook-attachment.jsonl',
    'compact-boundary.jsonl',
    'unknown-record-type.jsonl',
    'parse-failure.jsonl',
    'synthetic-model.jsonl',
    'zero-usage-credits.jsonl',
    'sidechain.jsonl',
    'host-metadata-types.jsonl',
  ]) {
    it(`normalizes ${name} to the committed snapshot`, async () => {
      const actual = await normalizeFixture(name)
      await matchSnapshot(name.replace(/\.jsonl$/, '.json'), actual)
    })
  }
})

describe('credits vs dollars (§18 rows 1–2)', () => {
  it('a usage-bearing record with credits but no currency yields credits set and costReported null', async () => {
    const evs = await events('assistant-credits.jsonl')
    const gen = evs.find((e) => e.type === 'generation.end')!
    expect(gen.credits).toBeCloseTo(0.42)
    expect(gen.costReported ?? null).toBeNull()
    expect(gen.costSource ?? null).toBeNull()
    expect(gen.metadata?.qoder_original_credits).toBe(0.42)
    expect(gen.metadata?.qoder_billable).toBe(true)
    expect(gen.metadata?.qoder_context_usage_ratio).toBe(0.21345)
    expect(gen.metadata?.qoder_billing).toMatchObject({ service_tier: 'standard', speed: 'standard' })
    expect(gen.usageSource).toBe('reported')
  })

  it('never maps a credit number onto the cost columns', async () => {
    for (const file of ['assistant-credits.jsonl', 'zero-usage-credits.jsonl', 'sidechain.jsonl']) {
      for (const e of await events(file)) {
        if (e.credits != null) {
          expect(e.costReported ?? null).toBeNull()
          expect(e.costSource ?? null).toBeNull()
        }
      }
    }
  })
})

describe('input excludes cache (dialect assertion, §18 row 4)', () => {
  it('cache fields map to cacheRead/cacheWrite and input stays separate', async () => {
    const gen = (await events('assistant-credits.jsonl')).find((e) => e.type === 'generation.end')!
    expect(gen.usage).toEqual({
      inputTokens: 21000,
      outputTokens: 340,
      cacheReadTokens: 180000,
      cacheWriteTokens: 512,
      reasoningTokens: 0,
    })
    // If input ever INCLUDED cached tokens, folding input+cacheRead would double-count.
    expect(gen.usage!.inputTokens).toBeLessThan(gen.usage!.cacheReadTokens)
  })
})

describe('request_max fold (§18 row 2)', () => {
  it('duplicated usage across blocks of one request folds to one copy', async () => {
    const evs = await events('assistant-credits.jsonl')
    const gen = evs.find((e) => e.type === 'generation.end')!
    // Simulate future fork drift: the same usage repeated across 3 blocks of one request.
    const duplicated: AgentEvent[] = [gen, { ...gen, id: `${gen.id}-b2` }, { ...gen, id: `${gen.id}-b3` }]
    const groups = dedupeByRequestId(duplicated)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.usage).toEqual(gen.usage)
    expect(groups[0]!.eventIds).toHaveLength(3)
  })

  it('requestId comes from the native request_id and is never fabricated', async () => {
    const evs = await events('assistant-credits.jsonl')
    const gen = evs.find((e) => e.type === 'generation.end')!
    expect(gen.requestId).toBe('b0d468a4-0000-4000-8000-000000000001')
    const toolStarts = evs.filter((e) => e.type === 'tool.start')
    expect(toolStarts.every((e) => e.requestId === gen.requestId)).toBe(true)
    const userEvs = await events('tool-result-user.jsonl')
    expect(userEvs.filter((e) => e.type === 'tool.result').every((e) => e.requestId === null)).toBe(true)
  })
})

describe('tool_result vs message.user (§3.3)', () => {
  it('maps tool_result-carrying user records to tool.result and text records to message.user', async () => {
    const evs = await events('tool-result-user.jsonl')
    const toolResults = evs.filter((e) => e.type === 'tool.result')
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]!.capability).toMatchObject({ type: 'tool', name: 'Bash' })
    expect(toolResults[0]!.parentEventId).not.toBeNull()
    expect(toolResults[1]!.status).toBe('error')
    expect(toolResults[1]!.capability).toBeNull() // unlinked tool_use_id: attributed nothing
    expect(evs.filter((e) => e.type === 'message.user')).toHaveLength(0)

    const turns = await events('user-turn.jsonl')
    expect(turns.map((e) => e.type)).toEqual(['message.user', 'message.user'])
    expect(turns[1]!.subtype).toBe('with-image')
  })
})

describe('assistant blocks', () => {
  it('emits tool.start children with distinct ids from one record', async () => {
    const evs = await events('assistant-credits.jsonl')
    const tools = evs.filter((e) => e.type === 'tool.start')
    expect(tools.map((t) => t.capability?.name)).toEqual(['Bash', 'Read'])
    expect(new Set(tools.map((t) => t.id)).size).toBe(2)
    expect(tools.every((t) => t.parentEventId === evs.find((e) => e.type === 'generation.end')!.id)).toBe(true)
  })

  it('maps mcp__ tools to mcp.invoke with the server as provider', async () => {
    const evs = await events('mcp-tool.jsonl')
    const mcp = evs.find((e) => e.type === 'mcp.invoke')!
    expect(mcp.capability).toEqual({ type: 'mcp', name: 'search_tools', provider: 'qoder_market' })
    expect(mcp.status).toBe('ok')
  })
})

describe('hooks and compaction (probe: 77 hook refs, 44 compaction refs)', () => {
  it('hook_* attachment becomes hook.fire linked to the hooked tool call', async () => {
    const evs = await events('hook-attachment.jsonl')
    const hook = evs.find((e) => e.type === 'hook.fire' && e.subtype === 'hook_post')!
    expect(hook.capability).toMatchObject({ type: 'hook', name: 'PostToolUse:Edit', provider: 'PostToolUse' })
    expect(hook.durationMs).toBe(137)
    expect(hook.status).toBe('ok')
    const edit = evs.find((e) => e.type === 'tool.start')!
    expect(hook.parentEventId).toBe(edit.id)
  })

  it('system subtypes map: compact_boundary → context.compact, api_error → error, others → counted unknown', async () => {
    const evs = await events('compact-boundary.jsonl')
    expect(evs.map((e) => `${e.type}:${e.subtype}`)).toEqual([
      'context.compact:compact_boundary',
      'error:api_error',
      'unknown:system:quantum_mode_changed',
    ])
    expect(evs[1]!.errorFingerprint).toBeTruthy()
    expect((evs[2]!.metadata as Record<string, unknown>).raw).toBeTruthy()
  })
})

describe('diagnostics: synthetic + zero-usage (§4.4 row 6)', () => {
  it('<synthetic> yields one error event, no usage, no requestId', async () => {
    const evs = await events('synthetic-model.jsonl')
    expect(evs).toHaveLength(1)
    expect(evs[0]!.type).toBe('error')
    expect(evs[0]!.subtype).toBe('synthetic-placeholder')
    expect(evs[0]!.usage).toBeNull()
    expect(evs[0]!.usageSource).toBe('missing')
    expect(evs[0]!.requestId).toBeNull()
    expect(evs[0]!.credits).toBe(0) // real credit field (0), still not a cost
    expect(evs[0]!.costReported ?? null).toBeNull()
  })

  it('a zero-token billing row keeps credits but reports no usage', async () => {
    const evs = await events('zero-usage-credits.jsonl')
    expect(evs).toHaveLength(1)
    const e = evs[0]!
    expect(e.type).toBe('generation.end')
    expect(e.subtype).toBe('zero-usage')
    expect(e.usage).toBeNull()
    expect(e.usageSource).toBe('missing')
    expect(e.credits).toBeCloseTo(0.0823075)
    expect(e.status).toBe('error')
  })
})

describe('sidechains', () => {
  it('uses the native parent_tool_use_id FK for subagent.start/end linkage', async () => {
    const evs = await events('sidechain.jsonl')
    const agentCall = evs.find((e) => e.subtype === 'Agent:spawn')!
    const start = evs.find((e) => e.type === 'subagent.start')!
    const end = evs.find((e) => e.type === 'subagent.end')!
    expect(start.parentEventId).toBe(agentCall.id)
    expect(end.parentEventId).toBe(agentCall.id)
    expect(start.metadata?.parent_link).toBe('native-fk')
    // one start per agentId
    expect(evs.filter((e) => e.type === 'subagent.start')).toHaveLength(1)
  })
})

describe('unknown types are counted, never dropped (§5.2 rule 1)', () => {
  it('an unmapped record type lands in unknown with the raw JSON in metadata, no throw', async () => {
    const evs = await events('unknown-record-type.jsonl')
    expect(evs).toHaveLength(2)
    expect(evs[0]!.type).toBe('unknown')
    expect(evs[0]!.subtype).toBe('telemetry-beacon-v9')
    expect((evs[0]!.metadata as Record<string, unknown>).raw).toMatchObject({ type: 'telemetry-beacon-v9' })
    expect(evs[1]!.subtype).toBe(null)
    expect(evs[1]!.metadata).toMatchObject({ upstream_type: null })
  })

  it('host bookkeeping types (active-leaf etc.) are whitelisted unknowns', async () => {
    const evs = await events('host-metadata-types.jsonl')
    expect(evs.every((e) => e.type === 'unknown')).toBe(true)
    expect(evs.map((e) => e.subtype)).toEqual([
      'active-leaf',
      'runtime-config',
      'last-prompt',
      'workspace-directories',
      'worktree-state',
      'file-history-snapshot',
    ])
    // the prompt body is redacted, its length is not lost (§3.2 disk rule)
    const last = evs[2]!
    const raw = (last.metadata as Record<string, Record<string, unknown> | undefined>).raw
    expect(String(raw?.prompt)).toContain('(omitted')
  })
})

describe('malformed input', () => {
  it('an unparseable line yields a ParseFailure with reason/rawLine/offset, not a throw', async () => {
    const ctx = ctxFor('parse-failure.jsonl')
    forgetState(ctx.source.id)
    const records = recordsFromJsonl(await readFixture('parse-failure.jsonl'))
    const results = []
    for (const r of records) results.push(await normalize(r, ctx))
    expect('events' in results[0]!).toBe(true)
    const bad = records[1]!
    const failure = (results[1] as { failure?: unknown }).failure
    expect(failure).toBeTruthy()
    const f = (results[1] as { failure: { reason: string; rawLine: string; offset: number } }).failure
    expect(f.reason).toMatch(/^json-parse/)
    expect(f.rawLine).toContain('"broken"')
    expect(f.offset).toBe(bad.offset)
    expect(f.offset).toBeGreaterThan(0)
  })
})
