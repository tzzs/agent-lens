/**
 * §3.4 — OTel GenAI semantic-convention alignment. One direction only
 * (export), so the Langfuse/Phoenix bridge (§12) stays a pure mapping and
 * never becomes a second model.
 */
import type { AgentEvent, EventType } from './types.ts'

export interface OtelFieldMapping {
  /** Dot-separated AgentEvent field path, e.g. 'usage.inputTokens'. */
  source: string
  attribute: string
}

export interface OtelAttributeMap {
  /** Event type -> gen_ai.operation.name; unmapped types get no operation attribute. */
  operationByType: Partial<Record<EventType, string>>
  attributes: readonly OtelFieldMapping[]
}

export const OTEL_ATTRIBUTE_MAP: OtelAttributeMap = {
  operationByType: {
    'generation.start': 'chat',
    'generation.end': 'chat',
    'tool.start': 'execute_tool',
    'tool.end': 'execute_tool',
    'tool.result': 'execute_tool',
    'subagent.start': 'invoke_agent',
    'subagent.end': 'invoke_agent',
    'skill.invoke': 'invoke_agent',
  },
  attributes: [
    { source: 'model.provider', attribute: 'gen_ai.provider.name' },
    { source: 'model.name', attribute: 'gen_ai.request.model' },
    { source: 'model.name', attribute: 'gen_ai.response.model' },
    { source: 'usage.inputTokens', attribute: 'gen_ai.usage.input_tokens' },
    { source: 'usage.outputTokens', attribute: 'gen_ai.usage.output_tokens' },
    { source: 'usage.cacheReadTokens', attribute: 'gen_ai.usage.cache_read.input_tokens' },
    { source: 'usage.cacheWriteTokens', attribute: 'gen_ai.usage.cache_creation.input_tokens' },
    // §18 row 1: the OTel GenAI registry has no cost attribute at all (the `gen_ai.usage.cost`
    // seen in the wild is Traceloop/OpenLLMetry, unregistered), so cost stays in our own
    // namespace rather than claiming a semconv alignment it does not have.
    { source: 'costReported', attribute: 'agentlens.cost_reported' },
    { source: 'costSource', attribute: 'agentlens.cost_source' },
    { source: 'hostId', attribute: 'agentlens.host_id' },
    { source: 'capability.type', attribute: 'agentlens.capability.type' },
    { source: 'capability.name', attribute: 'agentlens.capability.name' },
    { source: 'capability.provider', attribute: 'agentlens.capability.provider' },
    { source: 'requestId', attribute: 'agentlens.request_id' },
    // §18 row 3: thread is the source-grain key (a Codex file is one thread) while session_id
    // is the product-grain one, so `gen_ai.conversation.id` — which names a conversation —
    // would be the wrong home for it.
    { source: 'threadId', attribute: 'agentlens.thread_id' },
    { source: 'sourceId', attribute: 'agentlens.source_id' },
    { source: 'rawSeq', attribute: 'agentlens.raw_seq' },
    { source: 'projectId', attribute: 'agentlens.project_id' },
  ],
}

type AttributeValue = string | number | boolean

function readField(event: AgentEvent, dotted: string): AttributeValue | null {
  let cur: unknown = event
  for (const segment of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[segment]
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? cur : null
}

export function toOtelAttributes(e: AgentEvent): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = { 'agentlens.event.type': e.type }
  const operation = OTEL_ATTRIBUTE_MAP.operationByType[e.type]
  if (operation) attrs['gen_ai.operation.name'] = operation
  for (const mapping of OTEL_ATTRIBUTE_MAP.attributes) {
    const value = readField(e, mapping.source)
    if (value !== null) attrs[mapping.attribute] = value
  }
  return attrs
}

/** OTel span-name convention: "{operation} {model|tool name}", else the raw event type. */
export function otelSpanName(e: AgentEvent): string {
  const operation = OTEL_ATTRIBUTE_MAP.operationByType[e.type]
  if (!operation) return e.type
  const subject = operation === 'chat' ? (e.model?.name ?? '') : (e.capability?.name ?? '')
  return subject ? `${operation} ${subject}` : operation
}
