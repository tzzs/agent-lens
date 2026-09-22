/**
 * §5.1 `normalize` — WorkBuddy local-trace record → unified event mapping.
 *
 * Every rule is traceable to docs/research/workbuddy.md §四 (the measured census: 2 files
 * / 52 records under `~/.workbuddy/projects/*.jsonl`). Where the census names a key but
 * not its vocabulary or nesting, the mapping stays tolerant and writes what it decided
 * into `metadata`, so an upstream change becomes visible drift instead of a quiet 0.
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  deriveSessionId,
  deriveSessionIdFromSource,
  eventTimestamp,
  projectIdForCwd,
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
} from '@agentlens/event-model'
import {
  AGENT_ID,
  CODEBUDDY_LOCAL_MARKER,
  PARSE_ERROR_KEY,
  asRecord,
  bool,
  callIdOf,
  cwdOf,
  mapStatus,
  modelRefOf,
  nameOf,
  nativeRequestIdOf,
  parentIdOf,
  redact,
  resolveHost,
  roleOf,
  safeStringify,
  sessionIdOf,
  str,
  textOf,
  timestampMs,
  toolText,
  truncate,
  typeName,
  usageOf,
  type UnknownRecord,
  type UsageDraft,
} from './record.ts'
import { ScanState, stateFor } from './state.ts'

/**
 * §4.1 rule 5: `cwd` is not on every record (2 of 52 measured carry neither `cwd` nor
 * `sessionId`), and an unattributable record is reported as such — the sink keeps the
 * session's already-known project rather than the adapter guessing one.
 */
export { UNATTRIBUTED_PROJECT_ID }

/**
 * §5.3 record-type whitelist: exactly the six types the measured census counted
 * (function_call 15 / function_call_result 15 / reasoning 12 / message 6 /
 * file-history-snapshot 2 / ai-title 2). Anything else is a counted `unknown`.
 * Two of those six (`ai-title`, `file-history-snapshot`) carry product value but have no
 * first-class enum slot, so they are kept as `unknown` + `subtype` rather than dropped.
 */
export const RECORD_TYPES: readonly string[] = [
  'function_call',
  'function_call_result',
  'reasoning',
  'message',
  'ai-title',
  'file-history-snapshot',
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
  payload?: PayloadDraft | null
  metadata?: Record<string, unknown> | null
  requestId?: string | null
  parentEventId?: string | null
}

interface Scope {
  rec: UnknownRecord
  ctx: NormalizeCtx
  state: ScanState
  hostId: string
  upstreamType: string | null
  nativeSession: string | null
  sessionId: string
  projectId: string
  projectSource: 'cwd' | 'session' | 'unattributed'
  requestId: string | null
  timestamp: number
  /** §5.2: whether that timestamp is the record's own time or something standing in for it. */
  timestampOrigin: TimestampOrigin
  rawSeq: number
  rawOffset: number
  model: ModelRef | null
  usage: UsageDraft | null
  usageSite: string | null
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
  const { hostId, marker, diagnostics } = resolveHost(rec)
  const native = sessionIdOf(rec)
  state.noteNativeSession(native)
  // §4.1: native id first; a sessionless record inherits the session its trace is
  // writing (append-per-session); only a file with no native id anywhere falls back to
  // the source-derived key.
  const sessionKey = native ?? state.nativeSession() ?? ctx.sessionHint ?? null
  const recId = str(rec.id)
  const sessionId = sessionKey
    ? deriveSessionId(AGENT_ID, sessionKey)
    : deriveSessionIdFromSource(ctx.source.id, recId ?? `seq-${record.seq}`)

  const usage = usageOf(rec)
  const cwd = cwdOf(rec)
  const stamp = eventTimestamp(record, timestampMs(rec), ctx.now())
  const diagnosticsOut = [...diagnostics]
  if (marker === false) diagnosticsOut.push('codebuddy-local-marker-false')
  if (sessionKey === null) diagnosticsOut.push('session-id-inferred-from-record')

  return {
    rec,
    ctx,
    state,
    hostId,
    upstreamType: typeName(rec.type),
    nativeSession: native,
    sessionId,
    ...projectFor(ctx, state, sessionId, cwd, diagnosticsOut),
    requestId:
      nativeRequestIdOf(rec) ??
      (recId ? `req#${sessionKey ?? ctx.source.id}/${recId}` : null),
    timestamp: stamp.timestamp,
    timestampOrigin: stamp.origin,
    rawSeq: record.seq,
    rawOffset: record.offset,
    model: modelRefOf(rec),
    usage: usage?.draft ?? null,
    usageSite: usage?.site ?? null,
    diagnostics: diagnosticsOut,
  }
}

/** §4.1: project comes from `cwd` only — never from the DB's unverified `project_id` (§三). */
function projectFor(
  ctx: NormalizeCtx,
  state: ScanState,
  sessionId: string,
  cwd: string | null,
  diagnostics: string[],
): { projectId: string; projectSource: Scope['projectSource'] } {
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
  const semantic = semanticEvents(s)
  // One record id is recorded per record so a later `parentId` can resolve to this event.
  const recId = str(s.rec.id)
  if (recId) s.state.noteRecord(recId, semantic[0]!.id)
  return [...semantic, ...usageEvents(s)]
}

function semanticEvents(s: Scope): AgentEvent[] {
  switch (s.upstreamType) {
    case 'function_call':
      return [fromFunctionCall(s)]
    case 'function_call_result':
      return [fromFunctionCallResult(s)]
    case 'reasoning':
      return [fromReasoning(s)]
    case 'message':
      return fromMessage(s)
    case 'ai-title':
      return [fromAiTitle(s)]
    case 'file-history-snapshot':
      return [fromFileHistorySnapshot(s)]
    default:
      break
  }
  return [fromUnknown(s, s.upstreamType, false)]
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const metadata: Record<string, unknown> = { ...(init.metadata ?? {}) }
  // §5.2: an invented timestamp must not pose as a fact — `--since` counts these rows either way.
  const guess = timestampGuess(s.timestampOrigin)
  if (guess !== null) metadata[TIMESTAMP_GUESS_KEY] = guess
  if (s.diagnostics.length > 0) metadata.diagnostics = s.diagnostics.slice()
  const marker = s.rec[CODEBUDDY_LOCAL_MARKER]
  if (typeof marker === 'boolean') metadata.codebuddy_local = marker
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
    hostId: s.hostId,
    sourceId: s.ctx.source.id,
    sessionId: s.sessionId,
    projectId: s.projectId,
    parentEventId: init.parentEventId ?? null,
    requestId: init.requestId ?? null,
    timestamp: s.timestamp,
    ingestedAt: s.ctx.now(),
    type: init.type,
    subtype: init.subtype ?? null,
    model: init.model ?? s.model ?? null,
    usage,
    usageSource: init.usageSource ?? (usage ? 'reported' : 'missing'),
    // §18 row 1: WorkBuddy's DB is reported to carry cost, but it is unreadable (§二),
    // and the trace has no cost field — so the honest answer is 'none', never 'reported'.
    costReported: null,
    costSource: 'none',
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

/**
 * The adapter's invariant, asserted by test: usage never rides the record's own semantic
 * event, it rides a dedicated `generation.end`. That keeps "which row carries the tokens"
 * answerable with one predicate and makes the `request_max` fold exact — if a
 * `function_call_result` echoes the usage of the response that produced it, both rows
 * share a `request_id` and MAX collapses them; if they are distinct requests their native
 * ids differ and nothing is lost.
 */
function usageEvents(s: Scope): AgentEvent[] {
  const d = s.usage
  if (!d) return []
  return [
    event(s, {
      type: 'generation.end',
      subtype: `usage:${s.upstreamType ?? 'unknown'}`,
      discriminator: `generation:${s.rawSeq}`,
      usage: usageFromDraft(d),
      usageSource: 'reported',
      requestId: s.requestId,
      model: s.model,
      metadata: {
        mapped: true,
        usage_site: s.usageSite,
        reported_fields: [...d.reportedFields].sort(),
        unmapped_fields: [...d.unmappedFields].sort(),
        // §四: the trace has no cache-write and no reasoning counter. The frozen `Usage`
        // shape (§3.1) requires both fields, so they carry 0 and this pair of flags is
        // what distinguishes "measured zero" from "not reported" for pricing and doctor.
        cache_write_tokens_absent: !d.reportedFields.includes('cache_creation_input_tokens'),
        reasoning_tokens_absent: true,
        // §18 row 4: an explicit statement of the input/cache relationship. Codex's
        // `input_tokens` already contains the cached tokens; the Anthropic-style naming
        // WorkBuddy uses does not, so the two buckets are summed independently.
        input_includes_cache_read: false,
        provider_request_id: nativeRequestIdOf(s.rec),
      },
    }),
  ]
}

/** A record's `parentId` names another record's `id`; an unresolved link stays NULL, never guessed. */
function recordParentEventId(s: Scope): string | null {
  const parentId = parentIdOf(s.rec)
  if (!parentId) return null
  return s.state.recordEvent(parentId) ?? null
}

// ---------------------------------------------------------------- function_call

/**
 * §四: `function_call` is the tool invocation (`name` + `arguments`), so it maps to
 * `tool.start` with a `tool` capability. There is no measured evidence of MCP / hook /
 * skill / subagent markers in WorkBuddy traces, so none is invented: every call is a
 * plain tool until a source says otherwise (§5.3).
 */
function fromFunctionCall(s: Scope): AgentEvent {
  const callId = callIdOf(s.rec)
  const name = nameOf(s.rec) ?? 'unknown'
  const capability: CapabilityRef = { type: 'tool', name, provider: null }
  const rawArgs = s.rec.arguments
  const payload: PayloadDraft | null =
    rawArgs === undefined || rawArgs === null ? null : { kind: 'tool_input', role: 'assistant', text: toolText(rawArgs) }
  const ev = event(s, {
    type: 'tool.start',
    discriminator: `tool:${callId ?? name}:${s.rawSeq}`,
    capability,
    parentEventId: recordParentEventId(s),
    status: s.rec.status === undefined ? 'ok' : mapStatus(s.rec.status),
    payload,
    metadata: {
      mapped: true,
      call_id: callId,
      record_id: str(s.rec.id),
      parent_id: parentIdOf(s.rec),
      status_raw: str(s.rec.status),
      argument_keys: argumentKeys(rawArgs),
    },
  })
  s.state.noteToolCall(callId, { eventId: ev.id, capability, name })
  return ev
}

function argumentKeys(rawArgs: unknown): string[] | null {
  const rec = asRecord(rawArgs)
  return rec ? Object.keys(rec).sort() : null
}

// ---------------------------------------------------------------- function_call_result

/**
 * `function_call_result` answers the `function_call` with the same `callId`, which is the
 * only foreign key the census shows: it supplies the capability and `parent_event_id`, and
 * a result that never saw its call still lands as a counted `tool.result` marked unlinked.
 */
function fromFunctionCallResult(s: Scope): AgentEvent {
  const callId = callIdOf(s.rec)
  const ref = s.state.toolCall(callId)
  const name = ref?.name ?? nameOf(s.rec)
  const capability: CapabilityRef | null = ref?.capability ?? (name ? { type: 'tool', name, provider: null } : null)
  const status = mapStatus(s.rec.status)
  const output = textOf(s.rec.output, s.rec.rawContent, s.rec.content)
  return event(s, {
    type: 'tool.result',
    discriminator: `tool-result:${callId ?? name ?? s.rawSeq}`,
    capability,
    parentEventId: ref?.eventId ?? recordParentEventId(s),
    status,
    errorFingerprint:
      status === 'error'
        ? deriveErrorFingerprint(truncate(output ?? `function_call_result:${name ?? 'unknown'}`, 512))
        : null,
    payload: output ? { kind: 'tool_output', role: 'user', text: truncate(output, 64 * 1024) } : null,
    metadata: {
      mapped: true,
      call_id: callId,
      parent_id: parentIdOf(s.rec),
      status_raw: str(s.rec.status),
      unlinked_result: ref ? undefined : true,
      output_chars: output?.length ?? 0,
    },
  })
}

// ---------------------------------------------------------------- reasoning

/**
 * §3.3 has no reasoning event type and the payload layer does (§3.2 kind `reasoning`),
 * so a reasoning record rides an assistant message with no capability — it is model
 * output, not an agent-side action, and counting it as a capability would inflate the
 * Capability page.
 */
function fromReasoning(s: Scope): AgentEvent {
  const text = textOf(s.rec.content, s.rec.rawContent)
  return event(s, {
    type: 'message.assistant',
    subtype: 'reasoning',
    discriminator: `reasoning:${s.rawSeq}`,
    capability: null,
    payload: text ? { kind: 'reasoning', role: 'assistant', text: truncate(text, 64 * 1024) } : null,
    metadata: { mapped: true, parent_id: parentIdOf(s.rec), content_chars: text?.length ?? 0 },
  })
}

// ---------------------------------------------------------------- message

function fromMessage(s: Scope): AgentEvent[] {
  const role = roleOf(s.rec)
  const text = textOf(s.rec.content, s.rec.rawContent)
  const base = {
    subtype: null as string | null,
    discriminator: `message:${role ?? 'absent'}:${s.rawSeq}`,
    parentEventId: recordParentEventId(s),
    metadata: {
      mapped: true,
      role_raw: role,
      parent_id: parentIdOf(s.rec),
      content_chars: text?.length ?? 0,
    },
  }
  if (role === 'user') {
    return [
      event(s, {
        ...base,
        type: 'message.user',
        payload: text ? { kind: 'user_message', role: 'user', text: truncate(text, 64 * 1024) } : null,
      }),
    ]
  }
  if (role === 'assistant') {
    return [
      event(s, {
        ...base,
        type: 'message.assistant',
        payload: text ? { kind: 'assistant_message', role: 'assistant', text: truncate(text, 64 * 1024) } : null,
      }),
    ]
  }
  // An unknown `role` vocabulary is drift (§5.3), not a user turn: guessing the role would
  // move tokens between the Session page's turn counts.
  return [fromUnknown(s, `message:role:${role ?? 'absent'}`, true, { reason: 'unmapped message role' })]
}

// ---------------------------------------------------------------- product-valued metadata

/** The census shows `aiTitle`; session titles are exactly the "keep as subtype" case (§5.3). */
function fromAiTitle(s: Scope): AgentEvent {
  const title = str(s.rec.aiTitle) ?? str(s.rec.title)
  return event(s, {
    type: 'unknown',
    subtype: 'ai-title',
    discriminator: `metadata:ai-title:${s.rawSeq}`,
    metadata: {
      mapped: true,
      session_scoped: true,
      upstream_type: 'ai-title',
      value: title === null ? { present: false } : { title: truncate(title, 512) },
      raw: title === null ? redact(s.rec) : undefined,
    },
  })
}

/**
 * `file-history-snapshot` marks a checkpoint (and `isSnapshotUpdate` its revision). The
 * snapshot body is whole-file content, so §3.2's disk rule wins: keep the event, keep the
 * shape of the snapshot, copy none of its text.
 */
function fromFileHistorySnapshot(s: Scope): AgentEvent {
  return event(s, {
    type: 'unknown',
    subtype: 'file-history-snapshot',
    discriminator: `metadata:file-history-snapshot:${s.rawSeq}`,
    metadata: {
      mapped: true,
      session_scoped: true,
      upstream_type: 'file-history-snapshot',
      is_snapshot_update: bool(s.rec.isSnapshotUpdate) || null,
      snapshot: snapshotSummary(s.rec.snapshot),
    },
  })
}

function snapshotSummary(value: unknown): Record<string, unknown> {
  if (value === undefined) return { shape: 'absent' }
  if (typeof value === 'string') return { shape: 'string', chars: value.length }
  if (Array.isArray(value)) return { shape: 'array', entries: value.length }
  const rec = asRecord(value)
  if (!rec) return { shape: typeof value }
  const fields = Object.keys(rec).sort()
  return { shape: 'object', entries: fields.length, fields }
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
