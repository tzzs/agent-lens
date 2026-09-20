/**
 * AgentLens unified event model — single source of truth (docs/plan-v2.md §3, §4, §5.1).
 *
 * The metric layer (`AgentEvent`) is always collected; message/tool content lives in
 * the separate, TTL-bound content layer (`PayloadDraft`).
 */

export const SCHEMA_VERSION = 1

/** Frozen enum (§3.3). Extend via `subtype`, never by adding columns. */
export type EventType =
  | 'session.start'
  | 'session.end'
  | 'message.user'
  | 'message.assistant'
  | 'tool.start'
  | 'tool.end'
  | 'tool.result'
  | 'generation.start'
  | 'generation.end'
  | 'skill.invoke'
  | 'mcp.invoke'
  | 'plugin.invoke'
  | 'connector.invoke'
  | 'command.execute'
  | 'subagent.start'
  | 'subagent.end'
  | 'hook.fire'
  | 'context.compact'
  | 'error'
  /** §5.3 drift protection: unrecognized upstream records land here, never throw. */
  | 'unknown'

export const EVENT_TYPES: readonly EventType[] = [
  'session.start',
  'session.end',
  'message.user',
  'message.assistant',
  'tool.start',
  'tool.end',
  'tool.result',
  'generation.start',
  'generation.end',
  'skill.invoke',
  'mcp.invoke',
  'plugin.invoke',
  'connector.invoke',
  'command.execute',
  'subagent.start',
  'subagent.end',
  'hook.fire',
  'context.compact',
  'error',
  'unknown',
]

export type CapabilityType =
  | 'tool'
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'connector'
  | 'command'
  | 'subagent'
  | 'hook'

export const CAPABILITY_TYPES: readonly CapabilityType[] = [
  'tool',
  'skill',
  'mcp',
  'plugin',
  'connector',
  'command',
  'subagent',
  'hook',
]

export type UsageSource = 'reported' | 'estimated' | 'missing'
export type EventStatus = 'ok' | 'error' | 'unknown'

/** Raw token counts. Cost is never stored here — it is derived (§8). */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface ModelRef {
  provider: string
  name: string
  tier?: string | null
}

export interface CapabilityRef {
  type: CapabilityType
  name: string
  /** MCP server name / `PreToolUse:Bash` / skill source, e.g. 'userSettings'. */
  provider?: string | null
}

/** Content layer draft (§3.2). Only persisted when content capture is enabled. */
export interface PayloadDraft {
  kind: 'user_message' | 'assistant_message' | 'tool_input' | 'tool_output' | 'reasoning'
  role?: string | null
  text: string
}

export interface AgentEvent {
  /** Deterministic fingerprint (§4.1); makes replay idempotent (§4.2). */
  id: string
  schemaVersion: number
  agentId: string
  /** §1.5: same log store can carry multiple hosts (claude-code CLI vs Claude Desktop). */
  hostId: string
  sourceId: string
  sessionId: string
  projectId: string
  parentEventId?: string | null
  /** Token dedupe key (§3.1 invariant). NULL falls back to per-event accounting. */
  requestId?: string | null
  /** ms epoch, as reported by the source. */
  timestamp: number
  ingestedAt?: number
  type: EventType
  subtype?: string | null
  model?: ModelRef | null
  usage?: Usage | null
  usageSource: UsageSource
  capability?: CapabilityRef | null
  durationMs?: number | null
  status: EventStatus
  errorFingerprint?: string | null
  /** Line / record ordinal within the source. */
  rawSeq: number
  /** Byte offset of the record's first byte within the source. */
  rawOffset: number
  payload?: PayloadDraft | null
  /** Serialized as JSON at rest. */
  metadata?: Record<string, unknown> | null
}

/** §5.2 rule 1: an adapter never fails silently. */
export interface ParseFailure {
  reason: string
  /** Raw source text, truncated for storage. */
  rawLine: string
  offset: number
  rawSeq?: number
  /** Upstream record type that could not be mapped. */
  upstreamType?: string | null
}

export type NormalizeResult = { events: AgentEvent[] } | { failure: ParseFailure }

export function isParseFailure(r: NormalizeResult): r is { failure: ParseFailure } {
  return 'failure' in r
}
