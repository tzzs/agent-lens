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

/** §18: OpenCode and WorkBuddy log cost natively; a computed cost must never masquerade as one. */
export type CostSource = 'reported' | 'computed' | 'none'

/**
 * §18: how one agent's records must be folded into per-request totals. Only Claude Code and
 * its fork Qoder duplicate usage across content blocks; Codex instead ships cumulative
 * usage alongside per-call usage, and folding the wrong field overstates tokens ~1971x.
 */
export type AggregationMode = 'request_max' | 'per_record_sum' | 'last_call_sum'

export interface AggregationPolicy {
  mode: AggregationMode
  /** Codex thread files are mostly subagents; ccusage reconciliation excludes them from totals. */
  subagentsIncluded: boolean
}

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

/**
 * §5.2: where an event's timestamp came from. Only `record` is a time the source itself
 * stated; the other two stand in for it, and a stand-in has to travel with a label.
 *
 * `file-mtime` is kept distinct from `ingest-clock` because they are guesses of different
 * size: a session file's last write really does bound the lines inside it (a file untouched
 * for a year cannot hold today's activity), while the ingest clock is the instant of the scan
 * — the §19 failure, where 2,158 year-old lines shared the second `agl scan` ran.
 */
export type TimestampOrigin = 'record' | 'file-mtime' | 'ingest-clock'

/** Metadata key carrying the guess; absent means the timestamp is a fact (§5.2). */
export const TIMESTAMP_GUESS_KEY = 'timestampGuess'

/** The `timestampGuess` metadata value, or `null` when the source stated the time itself. */
export function timestampGuess(origin: TimestampOrigin): Exclude<TimestampOrigin, 'record'> | null {
  return origin === 'record' ? null : origin
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
  /** §18: source-grain thread. Codex files are threads and one session spans many of them. */
  threadId?: string | null
  /** ms epoch; where the source stated none, `metadata.timestampGuess` says what stood in (§5.2). */
  timestamp: number
  ingestedAt?: number
  type: EventType
  subtype?: string | null
  model?: ModelRef | null
  usage?: Usage | null
  usageSource: UsageSource
  /** §18 row 1: cost as reported by the agent itself, when its logs carry one. */
  costReported?: number | null
  costSource?: CostSource
  /** §18: plan credits burned (Qoder); NULL where the agent has no credit economy. */
  credits?: number | null
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
