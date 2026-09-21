/**
 * §5.1 `normalize` — Pi local-trace record → unified event mapping.
 *
 * Every rule is traceable to docs/research/pi.md §二–§四 (the measured census: 6 files /
 * 358 records under `~/.pi/agent/sessions`). Where the census names a key but
 * not its vocabulary or nesting, the mapping stays tolerant and writes what it decided
 * into `metadata`, so an upstream change becomes visible drift instead of a quiet 0.
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  eventTimestamp,
  UNATTRIBUTED_PROJECT_ID,
  resolveSessionId,
  projectIdForCwd,
  SCHEMA_VERSION,
  timestampGuess,
  TIMESTAMP_GUESS_KEY,
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
} from '@agentlens/event-model'
import {
  AGENT_ID,
  HOST_PI,
  MEASURED_TRACE_VERSION,
  PARSE_ERROR_KEY,
  apiOf,
  asRecord,
  callPartIdOf,
  callPartNameOf,
  contentParts,
  costOf,
  cwdOf,
  errorMessageOf,
  isErrorOf,
  mapStopReason,
  messageOf,
  modelRefOf,
  parentIdOf,
  partText,
  recordIdOf,
  redact,
  responseIdOf,
  roleOf,
  safeStringify,
  sessionIdOf,
  stopReasonOf,
  str,
  timestampMs,
  toolCallIdOf,
  toolNameOf,
  toolText,
  traceVersionOf,
  truncate,
  typeName,
  usageOf,
  type CostDraft,
  type UnknownRecord,
  type UsageDraft,
} from './record.ts'
import { ScanState, stateFor } from './state.ts'

/**
 * §4.1 rule 5: only the `session` header carries a `cwd` (pi.md §二.1), and a file
 * without one is unattributable — the sink keeps the session's already-known project
 * rather than the adapter guessing one.
 */
export { UNATTRIBUTED_PROJECT_ID }

/**
 * §5.3 record-type whitelist: exactly the four types the measured census counted
 * (message 339 / model_change 7 / session 6 / thinking_level_change 6). Anything else
 * is a counted `unknown`. `model_change` and `thinking_level_change` carry product value
 * but have no first-class enum slot, so they are kept as `unknown` + `subtype` rather
 * than dropped.
 */
export const RECORD_TYPES: readonly string[] = [
  'session',
  'message',
  'model_change',
  'thinking_level_change',
]

interface EventInit {
  type: EventType
  discriminator: string
  subtype?: string | null
  capability?: CapabilityRef | null
  usage?: Usage | null
  usageSource?: AgentEvent['usageSource']
  model?: ModelRef | null
  durationMs?: number | null
  status?: AgentEvent['status']
  errorFingerprint?: string | null
  requestId?: string | null
  parentEventId?: string | null
  costReported?: number | null
  payload?: PayloadDraft | null
  metadata?: Record<string, unknown> | null
}

interface Scope {
  rec: UnknownRecord
  ctx: NormalizeCtx
  state: ScanState
  upstreamType: string | null
  sessionKey: string | null
  sessionId: string
  projectId: string
  projectSource: 'cwd' | 'session' | 'unattributed'
  timestamp: number
  /** §5.2: whether that timestamp is the record's own time or something standing in for it. */
  timestampOrigin: TimestampOrigin
  rawSeq: number
  rawOffset: number
  diagnostics: string[]
}

export async function normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
  try {
    const marker = asRecord(record.value)
    if (marker === null) {
      return failure(record, 'not-a-json-object', safeStringify(record.value), null)
    }
    const parseError = str(marker[PARSE_ERROR_KEY])
    if (parseError !== null) {
      return failure(record, parseError, str(marker.rawLine) ?? '', null)
    }
    const state = stateFor(ctx.source.id)
    state.observes(record.seq)
    const scope = buildScope(record, ctx, state)
    const events = dispatch(scope)
    if (events.length === 0) {
      // §5.2 rule 1: nothing may vanish without a count.
      return {
        events: [
          fromUnknown(scope, scope.upstreamType ?? 'unknown', false, {
            reason: 'record produced no event',
          }),
        ],
      }
    }
    return { events }
  } catch (err) {
    // §5.2 rule 1 is a hard guarantee, so even a hostile record shape — a getter that
    // throws, a prototype that lies — reports itself as a failure instead of rejecting.
    return failure(record, `normalize-internal: ${String(err)}`, safeStringify(record.value), null)
  }
}

function failure(
  record: RawRecord,
  reason: string,
  rawLine: string,
  upstreamType: string | null,
): NormalizeResult {
  const f: ParseFailure = {
    reason,
    rawLine: truncate(rawLine),
    offset: record.offset,
    rawSeq: record.seq,
    upstreamType,
  }
  return { failure: f }
}

function buildScope(record: RawRecord, ctx: NormalizeCtx, state: ScanState): Scope {
  const rec = record.value as UnknownRecord
  const upstreamType = typeName(rec.type)
  const diagnostics: string[] = []
  if (upstreamType === 'session') {
    // §二.1: the header is the only record that carries the native session id and the cwd.
    state.noteHeader(sessionIdOf(rec), cwdOf(rec))
  }
  // §4.1: header id first; a headerless file inherits the session its filename names
  // (append-per-session); only a file with neither falls back to the lower tiers.
  const sessionKey = state.headerSession() ?? ctx.sessionHint ?? null
  if (state.headerSession() === null && ctx.sessionHint) diagnostics.push('session-header-absent')
  const recId = recordIdOf(rec)
  const stamp = eventTimestamp(record, timestampMs(rec), ctx.now())
  // §4.1 tier 3: neither a header/hint nor a record id ⇒ join the source's 30-minute
  // bucket; the old per-record key made every such line its own session.
  const sessionId = resolveSessionId({
    agentId: AGENT_ID,
    nativeSessionId: sessionKey,
    sourceId: ctx.source.id,
    recordUuid: recId,
    timestampMs: stamp.timestamp,
  })
  if (sessionKey === null) diagnostics.push('session-id-derived-from-record')

  return {
    rec,
    ctx,
    state,
    upstreamType,
    sessionKey,
    sessionId,
    ...projectFor(ctx, state, sessionId, diagnostics),
    timestamp: stamp.timestamp,
    timestampOrigin: stamp.origin,
    rawSeq: record.seq,
    rawOffset: record.offset,
    diagnostics,
  }
}

/** §4.1: project comes from the header's `cwd` only — never from a path guess. */
function projectFor(
  ctx: NormalizeCtx,
  state: ScanState,
  sessionId: string,
  diagnostics: string[],
): { projectId: string; projectSource: Scope['projectSource'] } {
  const cwd = state.headerCwdPath()
  if (cwd) {
    // The collector normally resolves cwds; falling back to the same event-model rule
    // keeps a direct `normalize()` caller from losing the project entirely.
    const projectId = ctx.resolveProject(cwd) ?? projectIdForCwd(cwd)
    state.noteSessionProject(sessionId, projectId)
    return { projectId, projectSource: 'cwd' }
  }
  const inherited = state.sessionProject(sessionId)
  if (inherited) return { projectId: inherited, projectSource: 'session' }
  diagnostics.push('cwd-absent-unattributed')
  return { projectId: UNATTRIBUTED_PROJECT_ID, projectSource: 'unattributed' }
}

/** Explicit whitelist dispatch (§5.3); everything else is a counted `unknown`. */
function dispatch(s: Scope): AgentEvent[] {
  const events = semanticEvents(s)
  // One record id is recorded per record so a later `parentId` can resolve to this event.
  const recId = recordIdOf(s.rec)
  if (recId && events.length > 0) s.state.noteRecord(recId, events[0]!.id)
  return events
}

function semanticEvents(s: Scope): AgentEvent[] {
  switch (s.upstreamType) {
    case 'session':
      return [fromSessionHeader(s)]
    case 'message':
      return fromMessage(s)
    case 'model_change':
      return [fromChangeRecord(s, 'model_change', str(s.rec.model))]
    case 'thinking_level_change':
      return [fromChangeRecord(s, 'thinking_level_change', str(s.rec.level))]
    default:
      break
  }
  return [fromUnknown(s, s.upstreamType, false)]
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const costReported = init.costReported ?? null
  const metadata: Record<string, unknown> = { ...(init.metadata ?? {}) }
  // §5.2: an invented timestamp must not pose as a fact — `--since` counts these rows either way.
  const guess = timestampGuess(s.timestampOrigin)
  if (guess !== null) metadata[TIMESTAMP_GUESS_KEY] = guess
  if (s.diagnostics.length > 0) metadata.diagnostics = s.diagnostics.slice()
  if (s.projectSource !== 'cwd') metadata.project_source = s.projectSource
  return {
    id: deriveEventId({
      sourceId: s.ctx.source.id,
      rawSeq: s.rawSeq,
      type: init.type,
      timestamp: s.timestamp,
      discriminator: init.discriminator,
    }),
    schemaVersion: SCHEMA_VERSION,
    agentId: AGENT_ID,
    hostId: HOST_PI,
    sourceId: s.ctx.source.id,
    sessionId: s.sessionId,
    projectId: s.projectId,
    parentEventId: init.parentEventId ?? null,
    requestId: init.requestId ?? null,
    timestamp: s.timestamp,
    ingestedAt: s.ctx.now(),
    type: init.type,
    subtype: init.subtype ?? null,
    model: init.model ?? null,
    usage,
    usageSource: init.usageSource ?? (usage ? 'reported' : 'missing'),
    costReported,
    // §18 row 1: Pi reports cost natively in each assistant `usage.cost` (pi.md §三),
    // so a row carrying it says 'reported'; a row without it says 'none', never 'computed'
    // — the adapter does not own a price table (§5.2).
    costSource: costReported !== null ? 'reported' : 'none',
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

function usageFromDraft(d: UsageDraft): Usage {
  return {
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens,
    reasoningTokens: d.reasoningTokens,
  }
}

// ---------------------------------------------------------------- session header

/**
 * The `session` record opens a trace file (measured: always line 1, one per file) and is
 * the only carrier of the native session id, the cwd and the trace format version, so it
 * maps to `session.start`. A `version` away from the measured 3 is drift (§5.3): the
 * event still lands, flagged.
 */
function fromSessionHeader(s: Scope): AgentEvent {
  const version = traceVersionOf(s.rec)
  return event(s, {
    type: 'session.start',
    subtype: version === MEASURED_TRACE_VERSION ? null : 'version-drift',
    discriminator: `session:${s.rawSeq}`,
    metadata: {
      mapped: true,
      session_scoped: true,
      record_id: recordIdOf(s.rec),
      upstream_version: version,
      measured_version: MEASURED_TRACE_VERSION,
      cwd: cwdOf(s.rec),
      timestamp_raw: str(s.rec.timestamp),
    },
  })
}

// ---------------------------------------------------------------- message records

function fromMessage(s: Scope): AgentEvent[] {
  const msg = messageOf(s.rec)
  if (msg === null) {
    return [fromUnknown(s, 'message:message-absent', true, { reason: 'message record without a message' })]
  }
  const role = roleOf(msg)
  switch (role) {
    case 'user':
      return [fromUser(s, msg)]
    case 'assistant':
      return fromAssistant(s, msg)
    case 'toolResult':
      return [fromToolResult(s, msg)]
    default:
      break
  }
  // An unknown `role` vocabulary is drift (§5.3), not a user turn: guessing the role would
  // move tokens between the Session page's turn counts.
  return [fromUnknown(s, `message:role:${role ?? 'absent'}`, true, { reason: 'unmapped message role' })]
}

function fromUser(s: Scope, msg: UnknownRecord): AgentEvent {
  const text = partText(contentParts(msg), 'text').join('\n')
  return event(s, {
    type: 'message.user',
    discriminator: `message:user:${s.rawSeq}`,
    parentEventId: recordParentEventId(s),
    payload: text ? { kind: 'user_message', role: 'user', text: truncate(text) } : null,
    metadata: { mapped: true, role_raw: 'user', parent_id: parentIdOf(s.rec), content_chars: text.length },
  })
}

/**
 * One assistant record is one API response (pi.md §二.2): it fans out into the visible
 * message, its `thinking` parts as assistant reasoning events, each `toolCall` part as a
 * `tool.start`, and — the adapter's invariant, asserted by test — its usage and native
 * cost as a dedicated `generation.end`. That keeps "which row carries the tokens"
 * answerable with one predicate and makes the `request_max` fold exact.
 */
function fromAssistant(s: Scope, msg: UnknownRecord): AgentEvent[] {
  const model = modelRefOf(msg)
  const reason = stopReasonOf(msg)
  const status = mapStopReason(reason)
  const text = partText(contentParts(msg), 'text').join('\n')
  const errorText = errorMessageOf(msg) ?? (reason ? `stopReason:${reason}` : 'assistant:reason-absent')
  const primary = event(s, {
    type: 'message.assistant',
    subtype: reason,
    discriminator: `message:assistant:${s.rawSeq}`,
    model,
    status,
    errorFingerprint: status === 'error' ? deriveErrorFingerprint(truncate(errorText, 512)) : null,
    parentEventId: recordParentEventId(s),
    payload: text ? { kind: 'assistant_message', role: 'assistant', text: truncate(text) } : null,
    metadata: {
      mapped: true,
      role_raw: 'assistant',
      api: apiOf(msg),
      stop_reason: reason,
      error_message_present: errorMessageOf(msg) !== null,
      record_id: recordIdOf(s.rec),
      parent_id: parentIdOf(s.rec),
      content_chars: text.length,
    },
  })

  const events: AgentEvent[] = [primary]
  for (const thinking of partText(contentParts(msg), 'thinking')) {
    events.push(
      event(s, {
        type: 'message.assistant',
        subtype: 'reasoning',
        discriminator: `reasoning:${s.rawSeq}:${events.length}`,
        parentEventId: primary.id,
        payload: { kind: 'reasoning', role: 'assistant', text: truncate(thinking) },
        metadata: { mapped: true, content_chars: thinking.length },
      }),
    )
  }
  for (const part of contentParts(msg)) {
    if (str(part.type) !== 'toolCall') continue
    const callId = callPartIdOf(part)
    const name = callPartNameOf(part) ?? 'unknown'
    const capability: CapabilityRef = { type: 'tool', name, provider: null }
    const ev = event(s, {
      type: 'tool.start',
      discriminator: `tool:${callId ?? name}:${s.rawSeq}`,
      capability,
      parentEventId: primary.id,
      payload:
        part.arguments === undefined || part.arguments === null
          ? null
          : { kind: 'tool_input', role: 'assistant', text: toolText(part.arguments) },
      metadata: { mapped: true, call_id: callId, argument_keys: argumentKeys(part.arguments) },
    })
    s.state.noteToolCall(callId, { eventId: ev.id, capability, name })
    events.push(ev)
  }

  const usage = usageOf(msg)
  if (usage === null) {
    // §三: every assistant row in the census carries `usage`; a missing one is drift and
    // must be counted, not silently read as zero tokens.
    events.push(
      fromUnknown(s, 'assistant:usage-absent', true, {
        reason: 'assistant message without usage',
        model: model ? `${model.provider}/${model.name}` : null,
      }),
    )
    return events
  }
  const cost = costOf(msg)
  events.push(usageEvent(s, usage, cost, model))
  return events
}

function usageEvent(
  s: Scope,
  d: UsageDraft,
  cost: CostDraft | null,
  model: ReturnType<typeof modelRefOf>,
): AgentEvent {
  const msg = messageOf(s.rec)
  const requestId = msg ? responseIdOf(msg) : null
  return event(s, {
    type: 'generation.end',
    subtype: 'usage:assistant',
    discriminator: `generation:${s.rawSeq}`,
    usage: usageFromDraft(d),
    usageSource: 'reported',
    requestId,
    model,
    costReported: cost?.total ?? null,
    metadata: {
      mapped: true,
      reported_fields: [...d.reportedFields].sort(),
      unmapped_fields: [...d.unmappedFields].sort(),
      // §三: the trace has no reasoning token counter, and `totalTokens` is a derived
      // roll-up (see record.ts usageOf). The frozen `Usage` shape (§3.1) requires both
      // fields, so they carry 0 and this pair of flags distinguishes "measured zero"
      // from "not reported" for pricing and doctor.
      reasoning_tokens_absent: true,
      cache_write_reported: d.reportedFields.includes('cacheWrite'),
      // §18 row 4: explicit statement of the input/cache relationship. Pi's four buckets
      // are DISJOINT (verified: totalTokens == their sum on 160/160 records, pi.md §三),
      // so the Anthropic-style naming holds and the buckets sum independently.
      input_includes_cache_read: false,
      cost_breakdown: cost?.breakdown ?? null,
      provider_request_id: requestId,
    },
  })
}

function argumentKeys(rawArgs: unknown): string[] | null {
  const rec = asRecord(rawArgs)
  return rec ? Object.keys(rec).sort() : null
}

/**
 * `toolResult` answers a `toolCall` through `toolCallId`, the only foreign key the census
 * shows: it supplies the capability and `parent_event_id`, and a result that never saw
 * its call still lands as a counted `tool.result` marked unlinked.
 */
function fromToolResult(s: Scope, msg: UnknownRecord): AgentEvent {
  const callId = toolCallIdOf(msg)
  const ref = s.state.toolCall(callId)
  const name = ref?.name ?? toolNameOf(msg)
  const capability: CapabilityRef | null =
    ref?.capability ?? (name ? { type: 'tool', name, provider: null } : null)
  const isError = isErrorOf(msg)
  const status = isError === null ? 'unknown' : isError ? 'error' : 'ok'
  const output = partText(contentParts(msg), 'text').join('\n')
  const fingerprintSource = output || `toolResult:${name ?? 'unknown'}`
  return event(s, {
    type: 'tool.result',
    discriminator: `tool-result:${callId ?? name ?? s.rawSeq}`,
    capability,
    parentEventId: ref?.eventId ?? recordParentEventId(s),
    status,
    errorFingerprint:
      status === 'error' ? deriveErrorFingerprint(truncate(fingerprintSource, 512)) : null,
    payload: output ? { kind: 'tool_output', role: 'user', text: truncate(output) } : null,
    metadata: {
      mapped: true,
      call_id: callId,
      tool_name_raw: toolNameOf(msg),
      is_error_raw: isError,
      has_details: msg.details !== undefined,
      unlinked_result: ref ? undefined : true,
      output_chars: output.length,
    },
  })
}

// ---------------------------------------------------------------- product-valued metadata

/**
 * `model_change` / `thinking_level_change` are session-scoped configuration statements
 * (pi.md §二.5). No first-class enum slot exists, so they ride `unknown` + `subtype` with
 * the new value kept — exactly the "keep as subtype" case (§5.3).
 */
function fromChangeRecord(s: Scope, label: string, value: string | null): AgentEvent {
  return event(s, {
    type: 'unknown',
    subtype: label,
    discriminator: `metadata:${label}:${s.rawSeq}`,
    metadata: {
      mapped: true,
      session_scoped: true,
      upstream_type: label,
      value: value === null ? { present: false } : { [label === 'model_change' ? 'model' : 'level']: value },
      record_id: recordIdOf(s.rec),
      parent_id: parentIdOf(s.rec),
    },
  })
}

function fromUnknown(
  s: Scope,
  upstreamType: string | null,
  mapped: boolean,
  extra?: Record<string, unknown>,
): AgentEvent {
  return event(s, {
    type: 'unknown',
    subtype: upstreamType,
    discriminator: `unknown:${upstreamType ?? 'none'}:${s.rawSeq}`,
    metadata: {
      mapped,
      upstream_type: upstreamType,
      ...(extra ?? {}),
      // §5.3: unrecognized records keep their raw JSON (bounded by `redact`) so a later
      // schema revision can be written against what is actually on disk.
      raw: mapped ? undefined : redact(s.rec),
    },
  })
}

/** A record's `parentId` names another record's `id`; an unresolved link stays NULL, never guessed. */
function recordParentEventId(s: Scope): string | null {
  const parentId = parentIdOf(s.rec)
  if (!parentId) return null
  return s.state.recordEvent(parentId) ?? null
}
