import { describe, expect, it } from 'vitest'
import { OTEL_ATTRIBUTE_MAP, otelSpanName, toOtelAttributes } from '../src/otel-map.ts'
import { makeEvent, usage } from './helpers.ts'

describe('toOtelAttributes', () => {
  it('maps generation.end with usage to the documented gen_ai.* names', () => {
    const e = makeEvent({
      type: 'generation.end',
      requestId: 'req-42',
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      usage: usage({
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 8000,
        cacheWriteTokens: 15,
      }),
    })
    const attrs = toOtelAttributes(e)
    expect(attrs).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.response.model': 'claude-sonnet-4-5',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 340,
      'gen_ai.usage.cache_read.input_tokens': 8000,
      'gen_ai.usage.cache_creation.input_tokens': 15,
      'agentlens.event.type': 'generation.end',
      'agentlens.request_id': 'req-42',
      'agentlens.host_id': 'claude-code',
      'agentlens.source_id': e.sourceId,
      'agentlens.raw_seq': e.rawSeq,
      'agentlens.project_id': e.projectId,
    })
  })

  it('maps tool events to execute_tool with the capability triple', () => {
    const attrs = toOtelAttributes(
      makeEvent({
        type: 'tool.end',
        capability: { type: 'mcp', name: 'search', provider: 'brave' },
      }),
    )
    expect(attrs['gen_ai.operation.name']).toBe('execute_tool')
    expect(attrs['agentlens.capability.type']).toBe('mcp')
    expect(attrs['agentlens.capability.name']).toBe('search')
    expect(attrs['agentlens.capability.provider']).toBe('brave')
  })

  it('omits absent optional fields and unmapped operation names', () => {
    const attrs = toOtelAttributes(makeEvent({ type: 'session.start', usage: null, model: null, requestId: null }))
    expect('gen_ai.operation.name' in attrs).toBe(false)
    expect('gen_ai.usage.input_tokens' in attrs).toBe(false)
    expect('agentlens.request_id' in attrs).toBe(false)
    expect(attrs['agentlens.event.type']).toBe('session.start')
  })

  it('gives unknown event types only the agentlens.event.type marker plus agentlens.* ids', () => {
    const attrs = toOtelAttributes(makeEvent({ type: 'unknown', usage: null, model: null }))
    expect('gen_ai.operation.name' in attrs).toBe(false)
    expect('gen_ai.provider.name' in attrs).toBe(false)
    expect(Object.keys(attrs).every((k) => k.startsWith('agentlens.'))).toBe(true)
  })

  // §18 fields the unified model carries and the export contract used to drop.
  it('exports thread_id and the reported-cost pair instead of losing them', () => {
    const attrs = toOtelAttributes(
      makeEvent({ type: 'generation.end', threadId: 'thread-7', costReported: 0.125, costSource: 'reported' }),
    )
    expect(attrs['agentlens.thread_id']).toBe('thread-7')
    expect(attrs['agentlens.cost_reported']).toBe(0.125)
    expect(attrs['agentlens.cost_source']).toBe('reported')
  })

  it('keeps a zero cost rather than treating it as absent', () => {
    const attrs = toOtelAttributes(makeEvent({ costReported: 0, costSource: 'none' }))
    expect(attrs['agentlens.cost_reported']).toBe(0)
    expect(attrs['agentlens.cost_source']).toBe('none')
  })

  it('omits the cost and thread keys when the source carries neither', () => {
    const attrs = toOtelAttributes(makeEvent({ threadId: null, costReported: null, costSource: undefined }))
    expect('agentlens.thread_id' in attrs).toBe(false)
    expect('agentlens.cost_reported' in attrs).toBe(false)
    expect('agentlens.cost_source' in attrs).toBe(false)
  })

  // §12: outside tools parse these names, so a rename is a break. Adding a key is allowed —
  // this list is the whole emitted surface, frozen.
  it('emits exactly the frozen attribute-name set for a fully populated event', () => {
    const attrs = toOtelAttributes(
      makeEvent({
        type: 'generation.end',
        requestId: 'req-42',
        threadId: 'thread-7',
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        capability: { type: 'tool', name: 'Bash', provider: 'builtin' },
        usage: usage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
        costReported: 0.125,
        costSource: 'computed',
      }),
    )
    expect(Object.keys(attrs).sort()).toEqual([
      'agentlens.capability.name',
      'agentlens.capability.provider',
      'agentlens.capability.type',
      'agentlens.cost_reported',
      'agentlens.cost_source',
      'agentlens.event.type',
      'agentlens.host_id',
      'agentlens.project_id',
      'agentlens.raw_seq',
      'agentlens.request_id',
      'agentlens.source_id',
      'agentlens.thread_id',
      'gen_ai.operation.name',
      'gen_ai.provider.name',
      'gen_ai.request.model',
      'gen_ai.response.model',
      'gen_ai.usage.cache_creation.input_tokens',
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
    ])
  })
})

describe('otelSpanName', () => {
  it('follows the "{operation} {subject}" convention', () => {
    expect(
      otelSpanName(makeEvent({ type: 'generation.end', model: { provider: 'anthropic', name: 'glm-4.7' } })),
    ).toBe('chat glm-4.7')
    expect(
      otelSpanName(makeEvent({ type: 'subagent.start', capability: { type: 'subagent', name: 'researcher' } })),
    ).toBe('invoke_agent researcher')
    expect(otelSpanName(makeEvent({ type: 'skill.invoke', capability: { type: 'skill', name: 'tdd' } }))).toBe(
      'invoke_agent tdd',
    )
    expect(otelSpanName(makeEvent({ type: 'unknown' }))).toBe('unknown')
  })
})

describe('OTEL_ATTRIBUTE_MAP', () => {
  it('is a declarative table of dot-paths to attribute names', () => {
    expect(OTEL_ATTRIBUTE_MAP.operationByType['tool.result']).toBe('execute_tool')
    expect(OTEL_ATTRIBUTE_MAP.attributes).toContainEqual({
      source: 'usage.inputTokens',
      attribute: 'gen_ai.usage.input_tokens',
    })
    expect(OTEL_ATTRIBUTE_MAP.attributes).toEqual(
      expect.arrayContaining([
        { source: 'threadId', attribute: 'agentlens.thread_id' },
        { source: 'costReported', attribute: 'agentlens.cost_reported' },
        { source: 'costSource', attribute: 'agentlens.cost_source' },
      ]),
    )
  })
})
