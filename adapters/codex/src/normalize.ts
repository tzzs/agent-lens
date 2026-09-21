/**
 * §5.1 `normalize` — the Codex rollout record → unified event mapping.
 *
 * Every rule here is traceable to docs/research/codex.md. Codex is the adapter that
 * falsifies the Claude-shaped abstraction, so the divergences are explicit:
 *  - §18 row 2: usage has three granularities; only `last_token_usage`/`usage` may become
 *    `AgentEvent.usage`, cumulative siblings go to metadata for display only.
 *  - §18 row 4: `input_tokens` already INCLUDES `cached_input_tokens` (opposite of Claude).
 *  - §18 row 3: file = thread, `session_id` spans files, so both ids are always set.
 *  - §18 row 6: `originator` is the host axis.
 *  - §18 row 5: no hook concept at all (measured 0) — `hook.fire` is never produced here.
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  deriveSessionId,
  deriveSessionIdFromSource,
  eventTimestamp,
  SCHEMA_VERSION,
  timestampGuess,
  TIMESTAMP_GUESS_KEY,
  UNATTRIBUTED_PROJECT_ID,
  type AgentEvent,
  type CapabilityRef,
  type EventType,
  type ModelRef,
  type NormalizeCtx,
  type NormalizeResult,
  type ParseFailure,
  type PayloadDraft,
  type RawRecord,
  type TimestampOrigin,
  type Usage,
  type UsageSource,
} from '@agentlens/event-model'
import {
  AGENT_ID,
  PARSE_ERROR_KEY,
  arr,
  asRecord,
  blocksOf,
  blocksText,
  bool,
  cumulativeSnapshot,
  innerTypeOf,
  isPlaceholderModel,
  isPlaceholderResponseId,
  modelRef,
  num,
  payloadOf,
  pickPerCall,
  redact,
  resolveHost,
  safeStringify,
  str,
  timestampMs,
  toolText,
  truncate,
  typeName,
  type UnknownRecord,
  type UsageRow,
} from './record.ts'
import { threadHintFromPath } from './paths.ts'
import { ScanState, stateFor, type ThreadContext } from './state.ts'

/** §4.1 rule 5, shared convention with the other adapters. */
export { UNATTRIBUTED_PROJECT_ID }

/** §5.3 whitelist: the 8 top-level envelope types in codex.md §2.1. */
export const CODEX_ENVELOPE_TYPES: readonly string[] = [
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'token_usage_record',
  'compacted',
  'world_state',
  'inter_agent_communication_metadata',
]

/** codex.md §3.2: these tool calls ARE the subagent lifecycle, not ordinary tools. */
const SUBAGENT_SPAWN_TOOLS = new Set(['spawn_agent'])
const SUBAGENT_CLOSE_TOOLS = new Set(['close_agent', 'interrupt_agent'])

interface EventInit {
  type: EventType
  discriminator: string
  subtype?: string | null
  capability?: CapabilityRef | null
  usage?: Usage | null
  usageSource?: UsageSource
  model?: ModelRef | null
  durationMs?: number | null
  status?: AgentEvent['status']
  errorFingerprint?: string | null
  payload?: PayloadDraft | null
  metadata?: Record<string, unknown> | null
  requestId?: string | null
  parentEventId?: string | null
}

interface Scope {
  rec: UnknownRecord
  payload: UnknownRecord
  ctx: NormalizeCtx
  state: ScanState
  thread: ThreadContext
  hostId: string
  threadId: string | null
  /** How the thread id was obtained: its own record, the thread file, or a hint. */
  threadIdSource: 'record' | 'state' | 'filename-hint' | 'absent'
  sessionId: string
  nativeSessionId: string | null
  projectId: string
  projectSource: 'cwd' | 'thread-cwd' | 'unattributed'
  requestId: string | null
  timestamp: number
  /** §5.2: whether that timestamp is the record's own time or something standing in for it. */
  timestampOrigin: TimestampOrigin
  rawSeq: number
  rawOffset: number
  model: ModelRef | null
  /** The model string as Codex wrote it, kept for placeholder triage (§一 风险 5). */
  rawModelName: string | null
  subagentThread: boolean
  diagnostics: string[]
  upstreamType: string | null
  innerType: string | null
}

export async function normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
  const rec = asRecord(record.value)
  if (rec === null) {
    return failure(record, 'not-a-json-object', safeStringify(record.value), null)
  }
  const parseError = str(rec[PARSE_ERROR_KEY])
  if (parseError !== null) {
    return failure(record, parseError, str(rec.rawLine) ?? '', null)
  }

  const state = stateFor(ctx.source.id)
  state.observes(record.seq)
  const payload = payloadOf(rec)
  const upstreamType = typeName(rec.type)
  if (upstreamType === 'session_meta') state.noteSessionMeta(payload)
  else if (upstreamType === 'turn_context') state.noteTurnContext(payload)

  const s = buildScope(record, ctx, state, rec, payload, upstreamType)
  const events = dispatch(s)
  if (events.length === 0) {
    // §5.2 rule 1: suppression stays visible — a placeholder usage row degrades to a
    // counted diagnostic instead of vanishing.
    events.push(fromUnknown(s, s.upstreamType ?? 'none', true, { suppressed: 'no-emittable-event' }))
  }
  return { events }
}

function failure(record: RawRecord, reason: string, rawLine: string, upstreamType: string | null): NormalizeResult {
  const f: ParseFailure = {
    reason,
    rawLine: truncate(rawLine),
    offset: record.offset,
    rawSeq: record.seq,
    upstreamType,
  }
  return { failure: f }
}

/**
 * §18 row 3: `threadId` is the collection/dedupe grain (one file) while `sessionId` is the
 * product grain and spans files (280 distinct sessions across 379 threads), so a subagent
 * thread lands in the SAME session but a DIFFERENT thread.
 */
function buildScope(
  record: RawRecord,
  ctx: NormalizeCtx,
  state: ScanState,
  rec: UnknownRecord,
  payload: UnknownRecord,
  upstreamType: string | null,
): Scope {
  const thread = state.threadCtx()
  const ownOriginator = payload.originator === undefined ? thread.originator : payload.originator
  const { hostId, diagnostic } = resolveHost(ownOriginator)
  const diagnostics = diagnostic ? [diagnostic] : []

  const ownThreadId = upstreamType === 'session_meta' ? str(payload.id) : null
  const hint = ctx.source.sessionHint ?? threadHintFromPath(ctx.source.path)
  const threadId = ownThreadId ?? thread.threadId ?? hint
  const threadIdSource: Scope['threadIdSource'] = ownThreadId
    ? 'record'
    : thread.threadId
      ? 'state'
      : hint
        ? 'filename-hint'
        : 'absent'

  const nativeSessionId = upstreamType === 'session_meta' ? str(payload.session_id) : thread.nativeSessionId
  const sessionId = nativeSessionId
    ? deriveSessionId(AGENT_ID, nativeSessionId)
    : deriveSessionIdFromSource(ctx.source.id, threadId ?? `seq-${record.seq}`)

  const ownCwd = str(payload.cwd) ?? str(asRecord(payload.git)?.root)
  const cwd = ownCwd ?? thread.cwd
  const resolved = ctx.resolveProject(cwd)

  const modelName = str(payload.model) ?? thread.model
  const model = modelRef(thread.modelProvider, modelName)
  const responseId = str(payload.response_id)
  const requestId = responseId && !isPlaceholderResponseId(responseId) ? responseId : null
  const stamp = eventTimestamp(record, timestampMs(rec, payload), ctx.now())

  return {
    rec,
    payload,
    ctx,
    state,
    thread,
    hostId,
    threadId,
    threadIdSource,
    sessionId,
    nativeSessionId,
    projectId: resolved ?? UNATTRIBUTED_PROJECT_ID,
    projectSource: resolved ? (ownCwd ? 'cwd' : 'thread-cwd') : 'unattributed',
    requestId,
    timestamp: stamp.timestamp,
    timestampOrigin: stamp.origin,
    rawSeq: record.seq,
    rawOffset: record.offset,
    model,
    rawModelName: modelName,
    subagentThread: thread.threadSource === 'subagent',
    diagnostics,
    upstreamType,
    innerType: innerTypeOf(rec),
  }
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const metadata: Record<string, unknown> = { ...(init.metadata ?? {}) }
  // §5.2: an invented timestamp must not pose as a fact — `--since` counts these rows either way.
  const guess = timestampGuess(s.timestampOrigin)
  if (guess !== null) metadata[TIMESTAMP_GUESS_KEY] = guess
  // §18 row 3: the query layer filters on this exact marker (dedupe.isSubagentThreadEvent),
  // so every event of a subagent thread — not only its start — has to carry it.
  if (s.subagentThread) metadata.subagentThread = true
  if (s.threadId !== null) metadata.thread_id = s.threadId
  if (s.threadIdSource !== 'record' && s.threadIdSource !== 'state') {
    metadata.thread_id_source = s.threadIdSource
  }
  if (s.nativeSessionId === null) metadata.session_id_synthetic = true
  if (s.diagnostics.length > 0) metadata.host_diagnostics = s.diagnostics.slice()
  if (s.projectSource === 'unattributed') metadata.project_unattributed = true
  const type = init.type
  return {
    id: deriveEventId({
      sourceId: s.ctx.source.id,
      rawSeq: s.rawSeq,
      type,
      timestamp: s.timestamp,
      discriminator: init.discriminator,
    }),
    schemaVersion: SCHEMA_VERSION,
    agentId: AGENT_ID,
    hostId: s.hostId,
    sourceId: s.ctx.source.id,
    sessionId: s.sessionId,
    threadId: s.threadId,
    projectId: s.projectId,
    parentEventId: init.parentEventId ?? null,
    requestId: init.requestId ?? null,
    timestamp: s.timestamp,
    ingestedAt: s.ctx.now(),
    type,
    subtype: init.subtype ?? null,
    model: init.model ?? s.model ?? null,
    usage,
    usageSource: init.usageSource ?? (usage ? 'reported' : 'missing'),
    capability: init.capability ?? null,
    durationMs: init.durationMs ?? null,
    status: init.status ?? 'ok',
    errorFingerprint: init.errorFingerprint ?? null,
    rawSeq: s.rawSeq,
    rawOffset: s.rawOffset,
    payload: init.payload ?? null,
    metadata,
  }
}

function usageFrom(row: UsageRow | null): Usage | null {
  if (!row) return null
  return { ...row.usage }
}

// ---------------------------------------------------------------- dispatch (§5.3 whitelist)

function dispatch(s: Scope): AgentEvent[] {
  switch (s.upstreamType) {
    case 'session_meta':
      return [fromSessionMeta(s)]
    case 'turn_context':
      return [fromTurnContext(s)]
    case 'response_item':
      return fromResponseItem(s)
    case 'event_msg':
      return fromEventMsg(s)
    case 'token_usage_record':
      return fromTokenUsageRecord(s)
    case 'compacted':
      return [fromCompacted(s)]
    case 'world_state':
      return [fromWorldState(s)]
    case 'inter_agent_communication_metadata':
      return [
        fromKnownWithoutSlot(s, 'inter_agent_communication_metadata', {
          fields: Object.keys(s.payload).sort(),
        }),
      ]
    default:
      return [fromUnknown(s, s.upstreamType, false)]
  }
}

// ---------------------------------------------------------------- session_meta / turn_context

/**
 * codex.md §3.1/§3.2: a thread's own `session_meta` is its beginning; when the thread IS a
 * subagent thread the record is both the session-scoped start marker and the observable
 * evidence of that sub-chain (the spawning `spawn_agent` call lives in another file, so
 * `parent_event_id` stays NULL and `metadata.parent_thread_id` carries the link instead).
 */
function fromSessionMeta(s: Scope): AgentEvent {
  const isSubagent = s.thread.threadSource === 'subagent'
  const capability: CapabilityRef | null = isSubagent
    ? { type: 'subagent', name: s.thread.agentRole ?? 'subagent', provider: 'thread_source' }
    : null
  return event(s, {
    type: isSubagent ? 'subagent.start' : 'session.start',
    subtype: isSubagent ? 'thread_source:subagent' : 'session_meta',
    discriminator: `session-meta:${s.threadId ?? s.rawSeq}`,
    capability,
    status: 'ok',
    requestId: null,
    usage: null,
    usageSource: 'missing',
    metadata: {
      mapped: true,
      native_session_id: s.nativeSessionId,
      thread_source: s.thread.threadSource,
      parent_thread_id: s.thread.parentThreadId,
      forked_from_id: s.thread.forkedFromId,
      agent_role: s.thread.agentRole,
      cli_version: s.thread.cliVersion,
      model_provider: s.thread.modelProvider,
      originator: s.payload.originator ?? null,
      source: s.payload.source ?? null,
      history_mode: s.payload.history_mode ?? null,
      dynamic_tools: [...s.thread.dynamicTools.entries()].map(([name, ns]) => ({ name, namespace: ns })),
      // `base_instructions` is the full system prompt: counted, never stored (§3.2).
      base_instructions_chars: str(s.payload.base_instructions)?.length ?? 0,
      git_present: asRecord(s.payload.git) !== null,
      subagent_history_start_ordinal: num(s.payload.subagent_history_start_ordinal),
    },
  })
}

/**
 * `turn_context` (3,913) restates the model/settings for the following turns. There is no
 * enum slot for "turn configuration", and it is NOT one model call, so mapping it to
 * `generation.start` would fabricate thousands of generations: it lands as a counted
 * `unknown` while its model becomes the thread's current model.
 */
function fromTurnContext(s: Scope): AgentEvent {
  return event(s, {
    type: 'unknown',
    subtype: 'turn_context',
    discriminator: 'turn_context',
    requestId: null,
    usage: null,
    usageSource: 'missing',
    model: s.model,
    metadata: {
      mapped: true,
      reason: 'turn configuration has no first-class event type (§3.3)',
      turn_id: str(s.payload.turn_id),
      effort: s.payload.effort ?? s.payload.reasoning_effort ?? null,
      approval_policy: s.payload.approval_policy ?? null,
      sandbox_mode: s.payload.sandbox_mode ?? null,
      summary: str(s.payload.summary),
      fields: Object.keys(s.payload).sort(),
    },
  })
}

// ---------------------------------------------------------------- response_item

function fromResponseItem(s: Scope): AgentEvent[] {
  const kind = s.innerType ?? 'none'
  switch (kind) {
    case 'message':
      return [fromMessage(s)]
    case 'agent_message':
      return [fromAgentMessage(s)]
    case 'function_call':
    case 'custom_tool_call':
      return [fromToolCall(s, kind)]
    case 'function_call_output':
    case 'custom_tool_call_output':
      return [fromToolResult(s, kind)]
    case 'reasoning':
      return [fromReasoning(s)]
    case 'web_search_call':
      return [fromToolCall(s, kind)]
    case 'image_generation_call':
      return [fromToolCall(s, kind)]
    case 'tool_search_call':
      // codex.md §3.2: dynamic-tool discovery is Codex's route to external capability, the
      // replacement for Claude's `mcp__` prefix.
      return [
        event(s, {
          type: 'mcp.invoke',
          subtype: 'tool_search_call',
          discriminator: 'mcp:tool_search',
          capability: { type: 'mcp', name: 'tool_search', provider: 'dynamic_tools' },
          requestId: null,
          payload: { kind: 'tool_input', role: 'assistant', text: truncate(toolText(s.payload.query ?? s.payload.input ?? s.payload), 4096) },
        }),
      ]
    case 'tool_search_output':
      return [fromToolResult(s, kind, { type: 'mcp', name: 'tool_search', provider: 'dynamic_tools' })]
    case 'compaction':
      return [
        event(s, {
          type: 'context.compact',
          subtype: 'response_item:compaction',
          discriminator: 'compaction',
          requestId: null,
          usage: null,
          usageSource: 'missing',
          metadata: {
            mapped: true,
            included_wrapped_items: arr(s.payload.item).length || null,
            fields: Object.keys(s.payload).sort(),
          },
        }),
      ]
    default:
      return [fromUnknown(s, `response_item:${kind}`, false)]
  }
}

function fromMessage(s: Scope): AgentEvent {
  const role = str(s.payload.role) ?? 'unknown'
  const text = blocksText(s.payload)
  if (role !== 'user' && role !== 'assistant') {
    // `developer`/`system` turns are injected instructions, not user turns: counting them
    // as `message.user` would inflate the Session page's turn count.
    return fromKnownWithoutSlot(s, `response_item:message:${role}`, {
      text_chars: text?.length ?? 0,
      // Instruction bodies are content-layer material and default to not stored (§3.2).
      fields: Object.keys(s.payload).sort(),
    })
  }
  return event(s, {
    type: role === 'assistant' ? 'message.assistant' : 'message.user',
    subtype: null,
    discriminator: `message:${role}`,
    requestId: null,
    usage: null,
    usageSource: 'missing',
    payload: text
      ? {
          kind: role === 'assistant' ? 'assistant_message' : 'user_message',
          role,
          text: truncate(text, 64 * 1024),
        }
      : null,
    metadata: {
      mapped: true,
      content_types: blocksOf(s.payload).map((b) => str(b.type) ?? '?'),
      block_count: blocksOf(s.payload).length,
    },
  })
}

/** `agent_message` (423) is a message FROM another agent thread (§3.2). */
function fromAgentMessage(s: Scope): AgentEvent {
  const text = blocksText(s.payload)
  return event(s, {
    type: 'message.assistant',
    subtype: 'agent_message',
    discriminator: 'agent_message',
    capability: { type: 'subagent', name: str(s.payload.author) ?? s.thread.agentRole ?? 'agent', provider: 'inter_agent' },
    requestId: null,
    usage: null,
    usageSource: 'missing',
    payload: text ? { kind: 'assistant_message', role: 'assistant', text: truncate(text, 64 * 1024) } : null,
    metadata: { mapped: true, fields: Object.keys(s.payload).sort(), text_chars: text?.length ?? 0 },
  })
}

/**
 * Codex has no `mcp__<server>__<tool>` naming at all (codex.md §3.2, exact prefix match = 0).
 * Its "external capability" arrives through `session_meta.dynamic_tools` namespaces, so the
 * namespace is resolved against the thread context instead of a string pattern.
 */
function classifyTool(name: string, s: Scope): { type: EventType; capability: CapabilityRef } {
  const namespace = s.thread.dynamicTools.get(name)
  if (namespace !== undefined) {
    return {
      type: 'mcp.invoke',
      capability: { type: 'mcp', name, provider: namespace ?? 'dynamic_tools' },
    }
  }
  const sep = firstNamespaceSeparator(name)
  if (sep !== null) {
    return { type: 'mcp.invoke', capability: { type: 'mcp', name: name.slice(sep + 1), provider: name.slice(0, sep) } }
  }
  if (SUBAGENT_SPAWN_TOOLS.has(name)) {
    return { type: 'subagent.start', capability: { type: 'subagent', name: 'spawn_agent', provider: name } }
  }
  if (SUBAGENT_CLOSE_TOOLS.has(name)) {
    return { type: 'subagent.end', capability: { type: 'subagent', name: str(s.payload.agent) ?? name, provider: name } }
  }
  return { type: 'tool.start', capability: { type: 'tool', name, provider: null } }
}

function firstNamespaceSeparator(name: string): number | null {
  const dots = name.indexOf('.')
  const colons = name.indexOf(':')
  if (dots < 0 && colons < 0) return null
  if (dots < 0) return colons
  if (colons < 0) return dots
  return Math.min(dots, colons)
}

function fromToolCall(s: Scope, kind: string): AgentEvent {
  // Hosted calls (`web_search_call`, `image_generation_call`) carry no `name`: the record
  // kind IS the tool name, so the capability stays attributable instead of landing on 'unknown'.
  const name = str(s.payload.name) ?? kind
  const callId = str(s.payload.call_id)
  const classified = classifyTool(name, s)
  const args = s.payload.arguments ?? s.payload.input
  const payload: PayloadDraft | null =
    args === undefined || args === null ? null : { kind: 'tool_input', role: 'assistant', text: truncate(toolText(args), 4096) }
  const toolEvent = event(s, {
    type: classified.type,
    subtype: kind === 'custom_tool_call' ? `custom_tool_call:${name}` : kind,
    discriminator: `tool:${callId ?? name}:${kind}`,
    capability: classified.capability,
    requestId: null,
    usage: null,
    usageSource: 'missing',
    payload,
    status: 'ok',
    metadata: { mapped: true, call_id: callId, tool_name: name, transport: kind },
  })
  s.state.noteToolCall(callId, { eventId: toolEvent.id, capability: classified.capability, type: classified.type })
  return toolEvent
}

function fromToolResult(s: Scope, kind: string, fallbackCapability?: CapabilityRef): AgentEvent {
  const callId = str(s.payload.call_id)
  const ref = s.state.toolCall(callId)
  const output = s.payload.output ?? s.payload.result ?? s.payload.error
  const errorText = str(s.payload.error)
  const isError = bool(s.payload.is_error) || bool(s.payload.error) || s.payload.success === false
  const text = output === undefined || output === null ? null : toolText(output)
  return event(s, {
    type: 'tool.result',
    subtype: kind,
    discriminator: `tool-result:${callId ?? kind}:${s.rawSeq}`,
    // §3.1: the result inherits the call's capability, so tool counts stay honest even
    // when the pairing record was cut off by a resumed scan.
    capability: ref?.capability ?? fallbackCapability ?? null,
    parentEventId: ref?.eventId ?? null,
    requestId: null,
    usage: null,
    usageSource: 'missing',
    status: isError ? 'error' : 'ok',
    errorFingerprint: isError ? deriveErrorFingerprint(truncate(errorText ?? text ?? kind, 512)) : null,
    payload: text ? { kind: 'tool_output', role: 'user', text: truncate(text, 64 * 1024) } : null,
    metadata: { mapped: true, call_id: callId, linked_call: ref?.eventId != null, output_chars: text?.length ?? 0 },
  })
}

/**
 * `reasoning` (17,696) has no event type — §3.3 froze none for it, even though the content
 * layer DOES have a `reasoning` kind. Counted as `unknown` so the volume stays visible.
 */
function fromReasoning(s: Scope): AgentEvent {
  const text = blocksText(s.payload)
  return event(s, {
    type: 'unknown',
    subtype: 'response_item:reasoning',
    discriminator: 'reasoning',
    requestId: null,
    usage: null,
    usageSource: 'missing',
    payload: text ? { kind: 'reasoning', role: 'assistant', text: truncate(text, 64 * 1024) } : null,
    metadata: {
      mapped: true,
      reason: 'reasoning items have no first-class event type (§3.3)',
      summary_count: arr(s.payload.summary_content ?? s.payload.summary).length || null,
      text_chars: text?.length ?? 0,
    },
  })
}

// ---------------------------------------------------------------- event_msg

function fromEventMsg(s: Scope): AgentEvent[] {
  const kind = s.innerType ?? 'none'
  switch (kind) {
    case 'token_count':
      return fromTokenCount(s)
    case 'turn_aborted':
      return [fromAbort(s)]
    case 'error':
    case 'api_error':
      return [fromError(s, kind)]
    case 'task_started': {
      const turnId = str(s.payload.turn_id)
      s.state.noteTurnStarted(turnId, s.timestamp)
      return [fromKnownWithoutSlot(s, 'task_started', { turn_id: turnId })]
    }
    case 'task_complete': {
      const turnId = str(s.payload.turn_id)
      const started = s.state.turnStartedAt(turnId)
      return [
        fromKnownWithoutSlot(
          s,
          'task_complete',
          {
            turn_id: turnId,
            duration_ms: started === null ? null : Math.max(0, s.timestamp - started),
          },
          started === null ? null : Math.max(0, s.timestamp - started),
        ),
      ]
    }
    case 'thread_goal_updated':
      return [fromKnownWithoutSlot(s, 'thread_goal_updated', { goal_fields: Object.keys(s.payload).sort() })]
    case 'thread_settings_applied':
      return [fromKnownWithoutSlot(s, 'thread_settings_applied', { fields: Object.keys(s.payload).sort() })]
    case 'item_completed': {
      const item = asRecord(s.payload.item)
      return [fromKnownWithoutSlot(s, `item_completed:${str(item?.type) ?? 'none'}`, { fields: Object.keys(s.payload).sort() })]
    }
    default:
      return [fromUnknown(s, `event_msg:${kind}`, false)]
  }
}

/** The old format: `event_msg.token_count.payload.info` carries per-call AND cumulative. */
function fromTokenCount(s: Scope): AgentEvent[] {
  const container = asRecord(s.payload.info) ?? s.payload
  return usageEvents(s, container, 'token_count', null)
}

/** The new format (codex.md §一): per-call `usage` + `turn_token_usage` + `thread_token_usage`. */
function fromTokenUsageRecord(s: Scope): AgentEvent[] {
  return usageEvents(s, s.payload, 'token_usage_record', str(s.payload.response_id))
}

/**
 * §18 row 2 (the ~1971x risk) lives here: ONLY the per-call object may become `usage`.
 * The cumulative objects are copied into `metadata.cumulative_usage` so the UI can show
 * "thread so far" without the aggregation layer ever folding them.
 */
function usageEvents(s: Scope, container: UnknownRecord, subtype: string, responseId: string | null): AgentEvent[] {
  const perCall = pickPerCall(container)
  const cumulative = cumulativeSnapshot(container)
  const contextWindow = num(container.model_context_window) ?? s.thread.contextWindow
  if (contextWindow !== null) s.state.noteContextWindow(contextWindow)
  const base: Record<string, unknown> = {
    mapped: true,
    usage_granularity: perCall ? 'per_call' : 'absent',
    per_call_field: perCall?.field ?? null,
    cumulative_usage: cumulative,
    // Emitted usage fields are the DE-CACHED view (§18 row 4); keep what Codex reported.
    reported_input_tokens: perCall?.row.reportedInputTokens ?? null,
    cached_input_tokens: perCall?.row.cachedInputTokens ?? null,
    cache_write_input_tokens: perCall?.row.cacheWriteInputTokens ?? null,
    reported_total_tokens: perCall?.row.reportedTotalTokens ?? null,
    reasoning_overlap: perCall?.row.reasoningOverlap ?? null,
    model_context_window: contextWindow,
  }

  if (perCall === null) {
    return [
      event(s, {
        type: 'generation.end',
        subtype,
        discriminator: `usage:${subtype}:${s.rawSeq}`,
        requestId: null,
        usage: null,
        usageSource: 'missing',
        status: 'unknown',
        metadata: { ...base, reason: 'no per-call usage object', fields: Object.keys(container).sort() },
      }),
    ]
  }

  const placeholderId = isPlaceholderResponseId(responseId)
  // codex.md §一 风险 5: 224 all-zero `token_count` rows + 12 `r1`/`resp_1` placeholders.
  // Billing them would add a ghost call to each thread, so they are counted diagnostics.
  if (perCall.row.isZero || (placeholderId && usageIsTiny(perCall.row))) {
    return [
      event(s, {
        type: 'error',
        subtype: 'placeholder-usage',
        discriminator: `placeholder:${subtype}:${s.rawSeq}`,
        requestId: null,
        usage: null,
        usageSource: 'missing',
        status: 'error',
        errorFingerprint: deriveErrorFingerprint('codex placeholder usage record'),
        metadata: {
          ...base,
          reason: placeholderId ? `response_id=${responseId}` : 'all per-call token fields are zero',
        },
      }),
    ]
  }

  if (s.rawModelName !== null && isPlaceholderModel(s.rawModelName)) {
    // A real call with an unattributable model: keep the tokens, drop the model, flag it.
    return [
      event(s, {
        type: 'generation.end',
        subtype,
        discriminator: `usage:${subtype}:${s.rawSeq}`,
        requestId: s.requestId,
        usage: usageFrom(perCall.row),
        usageSource: 'reported',
        model: null,
        status: 'ok',
        metadata: { ...base, model_placeholder: s.rawModelName ?? '<absent>' },
      }),
    ]
  }

  return [
    event(s, {
      type: 'generation.end',
      subtype,
      discriminator: `usage:${subtype}:${s.rawSeq}`,
      // §18 row 1: Codex never repeats usage across records, so `requestId` is only set
      // where the source genuinely carries one (`response_id`, new format only) — the row
      // is its own group otherwise, which is exactly right for `last_call_sum`.
      requestId: s.requestId,
      usage: usageFrom(perCall.row),
      usageSource: 'reported',
      status: 'ok',
      metadata: base,
    }),
  ]
}

function usageIsTiny(row: UsageRow): boolean {
  const u = row.usage
  return (
    u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens <= 4 &&
    row.reportedInputTokens <= 1 &&
    row.usage.outputTokens <= 1
  )
}

function fromAbort(s: Scope): AgentEvent {
  const message = str(s.payload.reason) ?? str(s.payload.message) ?? 'turn_aborted'
  return event(s, {
    type: 'error',
    subtype: 'turn_aborted',
    discriminator: 'turn_aborted',
    requestId: null,
    usage: null,
    usageSource: 'missing',
    status: 'error',
    errorFingerprint: deriveErrorFingerprint(message),
    metadata: { mapped: true, turn_id: str(s.payload.turn_id), message: truncate(message, 512) },
  })
}

function fromError(s: Scope, kind: string): AgentEvent {
  const message = str(s.payload.message) ?? str(s.payload.error) ?? blocksText(s.payload) ?? kind
  return event(s, {
    type: 'error',
    subtype: kind,
    discriminator: `error:${kind}:${s.rawSeq}`,
    requestId: null,
    usage: null,
    usageSource: 'missing',
    status: 'error',
    errorFingerprint: deriveErrorFingerprint(message),
    metadata: { mapped: true, message: truncate(message, 512), fields: Object.keys(s.payload).sort() },
  })
}

// ---------------------------------------------------------------- compacted / world_state

/** codex.md §3.2: 222 `compacted` records — `context.compact` has a real source per agent. */
function fromCompacted(s: Scope): AgentEvent {
  const history = arr(s.payload.replacement_history)
  const historyChars = history.reduce((sum, h) => sum + safeStringify(h).length, 0)
  return event(s, {
    type: 'context.compact',
    subtype: 'compacted',
    discriminator: 'compacted',
    requestId: null,
    usage: null,
    usageSource: 'missing',
    durationMs: num(s.payload.duration_ms),
    metadata: {
      mapped: true,
      // The replacement history IS a prompt snapshot: counted, never stored (§3.2).
      replacement_history_entries: history.length,
      replacement_history_chars: historyChars,
      trigger: str(s.payload.trigger) ?? str(s.payload.cause),
      window: num(s.payload.model_context_window),
    },
  })
}

/** `world_state` (189) carries AGENTS.md project instructions + env + timezone. */
function fromWorldState(s: Scope): AgentEvent {
  const agentsMd = str(s.payload.agents_md) ?? str(asRecord(s.payload.agents_md)?.content)
  return fromKnownWithoutSlot(s, 'world_state', {
    fields: Object.keys(s.payload).sort(),
    // Project instructions are content-layer: measured, stored nowhere (§3.2).
    agents_md_chars: agentsMd?.length ?? 0,
    timezone: str(s.payload.timezone) ?? str(s.payload.local_timezone),
  })
}

// ---------------------------------------------------------------- known / unknown

/** Known-by-name upstream records with no first-class enum slot: counted, mapped, raw kept. */
function fromKnownWithoutSlot(s: Scope, subtype: string, extra?: Record<string, unknown>, durationMs?: number | null): AgentEvent {
  return event(s, {
    type: 'unknown',
    subtype,
    discriminator: `known:${subtype}:${s.rawSeq}`,
    requestId: null,
    usage: null,
    usageSource: 'missing',
    durationMs: durationMs ?? null,
    metadata: { mapped: true, upstream_type: subtype, ...(extra ?? {}) },
  })
}

/** §5.3: anything outside the dispatch table is a counted `unknown` carrying its raw JSON. */
function fromUnknown(s: Scope, upstreamType: string | null, mapped: boolean, extra?: Record<string, unknown>): AgentEvent {
  const key = upstreamType ?? 'none'
  const ordinal = s.state.noteUnknown(key)
  return event(s, {
    type: 'unknown',
    subtype: key,
    discriminator: `unknown:${key}:${s.rawSeq}`,
    requestId: null,
    usage: null,
    usageSource: 'missing',
    status: 'unknown',
    metadata: {
      mapped,
      upstream_type: key,
      // Counted per source: "silently dropped" is what §5.2 rule 1 forbids.
      unknown_ordinals: { [key]: ordinal },
      unknown_totals_in_source: s.state.unknownTotals(),
      ...(extra ?? {}),
      raw: mapped ? undefined : redact(s.rec),
    },
  })
}
