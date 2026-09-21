/**
 * §5.1 `normalize` — OpenCode row → unified events. Rules trace to
 * docs/research/qoder-opencode.md §2 and to the read-only re-probe of this
 * machine's `opencode.db` (session 10 / message 531 / part 2,242).
 *
 * The three measurement-forced decisions:
 *  - §18 row 1 — OpenCode states real cost, so `cost_reported`/`cost_source='reported'`
 *    is first-class and the price table must not invent a competing number;
 *  - §18 row 4 — `tokens.cache.read/write` is a third cache dialect and `input`
 *    excludes cached tokens, so the copy is field-to-field and `tokens.total` is ignored;
 *  - §18 row 3 — `session.id` is a native ULID and `parent_id` is the subagent chain,
 *    so `session_id` is the (root) product grain and `thread_id` the native session.
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  deriveSessionId,
  SCHEMA_VERSION,
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
  type Usage,
} from '@agentlens/event-model'
import {
  AGENT_ID,
  HOST_ID,
  asRecord,
  costOf,
  durationOf,
  mcpOf,
  modelRefOf,
  ms,
  num,
  redact,
  str,
  tableOf,
  tokensOf,
  truncate,
  jsonPayload,
  type TokenDraft,
  type UnknownRecord,
} from './record.ts'
import { PARSE_ERROR_KEY } from '@agentlens/collector'
import { TABLE_MESSAGE, TABLE_PART, TABLE_SESSION } from './record.ts'

/** §4.1 rule 5: an unattributable cwd is reported, never guessed. */
export { UNATTRIBUTED_PROJECT_ID }

/**
 * §3.2 / §6: these parts carry whole file or page bodies (measured tools:
 * read 60, edit 5, write 1, bash 31, glob 23, grep 16, task 3 in the probe
 * sample). Their text stays out of the content layer; only sizes/keys are kept.
 */
const FILE_BODY_INPUT_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'patch', 'notebook_edit'])
const FILE_BODY_OUTPUT_TOOLS = new Set(['read', 'webfetch'])

/** Kinds recognised inside `part.data.type`; anything else is counted as drift (§5.3). */
export const KNOWN_PART_TYPES: readonly string[] = [
  'step-start',
  'step-finish',
  'tool',
  'text',
  'reasoning',
  'patch',
]

interface Scope {
  ctx: NormalizeCtx
  table: string
  row: UnknownRecord
  data: UnknownRecord | null
  rowid: number
  nativeId: string | null
  timestamp: number
  sessionId: string
  threadId: string | null
  parentSessionId: string | null
  subagentThread: boolean
  projectId: string
  model: ModelRef | null
  /** True when the collector's single-column SQLite path dropped the join columns. */
  partialRow: boolean
  diagnostics: string[]
}

export async function normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
  const value = asRecord(record.value)
  if (value === null) return failure(record, 'not-a-json-object', JSON.stringify(record.value) ?? '', null)
  const marker = str(value[PARSE_ERROR_KEY])
  if (marker !== null) return failure(record, marker, str(value.rawLine) ?? '', null)

  const scope = buildScope(record, ctx, value)
  let events: AgentEvent[]
  switch (scope.table) {
    case TABLE_SESSION:
      events = fromSession(scope)
      break
    case TABLE_MESSAGE:
      events = fromMessage(scope)
      break
    case TABLE_PART:
      events = fromPart(scope)
      break
    default:
      events = [fromUnknown(scope, `table:${scope.table}`, false)]
  }
  if (events.length === 0) events = [fromUnknown(scope, `${scope.table}:no-mappable-fields`, true)]
  return { events }
}

function buildScope(record: RawRecord, ctx: NormalizeCtx, value: UnknownRecord): Scope {
  const table = str(value.__table) ?? tableOf(ctx.source.sqliteTable)
  const hasColumns = value.__rowid !== undefined || value.data !== undefined || value.session_id !== undefined
  const data = asRecord(value.data) ?? (hasColumns ? null : value)
  const rowid = num(value.__rowid ?? value.rowid) ?? record.seq
  const diagnostics: string[] = []

  const ownSession =
    str(value.__session_id) ??
    (table === TABLE_SESSION ? str(value.id) : str(value.session_id)) ??
    str(value.__root_session_id)
  const rootSession = str(value.__root_session_id) ?? ownSession
  if (rootSession === null) diagnostics.push('session_unresolved')
  const sessionId = deriveSessionId(AGENT_ID, rootSession ?? ctx.sessionHint ?? `row:${table}/${rowid}`)

  const directory = str(value.__session_directory) ?? str(value.directory)
  const resolved = ctx.resolveProject(directory)
  if (resolved === null) diagnostics.push('project_unattributed')

  const messageData = table === TABLE_MESSAGE ? data : null
  const model = modelRefOf(value.__session_model ?? value.model, messageData ?? (table === TABLE_PART ? partialMessage(value) : null))
  if (!hasColumns) diagnostics.push('partial_row')
  const parentSessionId = str(value.__session_parent_id) ?? (table === TABLE_SESSION ? str(value.parent_id) : null)

  return {
    ctx,
    table,
    row: value,
    data,
    rowid,
    nativeId: str(value.id),
    timestamp: ms(value.time_created) ?? ms(value.time_updated) ?? (record.occurredAt > 0 ? record.occurredAt : ctx.now()),
    sessionId,
    threadId: ownSession,
    parentSessionId,
    subagentThread: parentSessionId !== null,
    projectId: resolved ?? UNATTRIBUTED_PROJECT_ID,
    model,
    partialRow: !hasColumns,
    diagnostics,
  }
}

/** Part rows carry no model of their own; the joined message columns stand in. */
function partialMessage(value: UnknownRecord): UnknownRecord | null {
  if (value.__message_model_id === undefined) return null
  return { modelID: value.__message_model_id, providerID: value.__message_provider_id, variant: value.__message_variant }
}

interface EventInit {
  type: EventType
  discriminator: string
  subtype?: string | null
  capability?: CapabilityRef | null
  usage?: Usage | null
  costReported?: number | null
  costSource?: AgentEvent['costSource']
  model?: ModelRef | null
  durationMs?: number | null
  status?: AgentEvent['status']
  errorFingerprint?: string | null
  payload?: PayloadDraft | null
  metadata?: Record<string, unknown> | null
  requestId?: string | null
  parentEventId?: string | null
  timestamp?: number | null
  threadId?: string | null
  subagentThread?: boolean
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const costReported = init.costReported ?? null
  const metadata: Record<string, unknown> = {
    table: s.table,
    rowid: s.rowid,
    ...(init.metadata ?? {}),
  }
  if (s.diagnostics.length > 0) metadata.diagnostics = s.diagnostics.slice()
  // §18 row 2/3: a child session's whole event stream belongs to a subagent thread,
  // so the marker is inherited from the scope instead of being set per event.
  if (init.subagentThread ?? s.subagentThread) metadata.subagentThread = true
  const timestamp = init.timestamp ?? s.timestamp
  return {
    id: deriveEventId({
      sourceId: s.ctx.source.id,
      rawSeq: s.rowid,
      type: init.type,
      timestamp,
      // The discriminator names table+rowid so two sources of the same file can never collide.
      discriminator: `${s.table}:${s.rowid}:${init.discriminator}`,
    }),
    schemaVersion: SCHEMA_VERSION,
    agentId: AGENT_ID,
    hostId: HOST_ID,
    sourceId: s.ctx.source.id,
    sessionId: s.sessionId,
    projectId: s.projectId,
    parentEventId: init.parentEventId ?? null,
    requestId: init.requestId ?? null,
    threadId: init.threadId === undefined ? s.threadId : init.threadId,
    timestamp,
    ingestedAt: s.ctx.now(),
    type: init.type,
    subtype: init.subtype ?? null,
    model: init.model === undefined ? s.model : init.model,
    usage,
    usageSource: usage ? 'reported' : 'missing',
    costReported,
    // WHY not 'computed': §18 row 1 — the number OpenCode writes is adopted as-is,
    // and a row with no reported cost stays `none` so the price table can be asked
    // for an estimate instead of us silently mixing the two truths.
    costSource: costReported !== null ? 'reported' : (init.costSource ?? 'none'),
    credits: null,
    capability: init.capability ?? null,
    durationMs: init.durationMs ?? null,
    status: init.status ?? 'ok',
    errorFingerprint: init.errorFingerprint ?? null,
    rawSeq: s.rowid,
    rawOffset: s.rowid,
    payload: init.payload ?? null,
    metadata,
  }
}

function usageFrom(d: TokenDraft): Usage | null {
  if (!d.present) return null
  return {
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens,
    reasoningTokens: d.reasoningTokens,
  }
}

// ------------------------------------------------------------------- session

function fromSession(s: Scope): AgentEvent[] {
  const out: AgentEvent[] = []
  const native = s.nativeId
  out.push(
    event(s, {
      type: 'session.start',
      discriminator: 'session-start',
      subtype: native ? null : 'session-without-id',
      // §18 row 1: the rollup is kept for reconciliation only — the billable
      // numbers ride the per-step `generation.end` rows, so writing them twice
      // would count every call twice.
      metadata: {
        native_session_id: native,
        parent_session_id: s.parentSessionId,
        agent: str(s.row.agent),
        version: str(s.row.version),
        directory_present: str(s.row.directory) !== null,
        has_title: str(s.row.title) !== null && str(s.row.title) !== '',
        rollup: {
          cost: num(s.row.cost),
          tokens_input: num(s.row.tokens_input),
          tokens_output: num(s.row.tokens_output),
          tokens_reasoning: num(s.row.tokens_reasoning),
          tokens_cache_read: num(s.row.tokens_cache_read),
          tokens_cache_write: num(s.row.tokens_cache_write),
        },
      },
      subagentThread: s.subagentThread,
    }),
  )

  if (s.subagentThread) {
    out.push(
      event(s, {
        type: 'subagent.start',
        discriminator: 'subagent-start',
        capability: { type: 'subagent', name: str(s.row.agent) ?? 'subagent', provider: 'session.parent_id' },
        metadata: { parent_session_id: s.parentSessionId, native_session_id: native },
        subagentThread: true,
      }),
    )
  }

  const compactAt = ms(s.row.time_compacting)
  if (compactAt !== null) {
    out.push(
      event(s, {
        // §18 row 5: OpenCode expresses compaction only as a session timestamp, so this
        // is a derived marker with no token delta — enough to explain a cost jump, not a
        // Claude-style compact_boundary record.
        type: 'context.compact',
        discriminator: 'context-compact',
        timestamp: compactAt,
        metadata: { source: 'session.time_compacting' },
        subagentThread: s.subagentThread,
      }),
    )
  }

  const archivedAt = ms(s.row.time_archived)
  if (archivedAt !== null) {
    out.push(
      event(s, {
        type: 'session.end',
        discriminator: 'session-end',
        timestamp: archivedAt,
        metadata: { source: 'session.time_archived' },
        subagentThread: s.subagentThread,
      }),
    )
  }
  return out
}

// ------------------------------------------------------------------- message

function fromMessage(s: Scope): AgentEvent[] {
  const data = s.data
  const role = str(data?.role) ?? str(s.row.__message_role)
  const out: AgentEvent[] = []

  if (data?.error !== undefined && data.error !== null) {
    const err = asRecord(data.error)
    out.push(
      event(s, {
        type: 'error',
        discriminator: 'message-error',
        subtype: str(err?.name) ?? str(err?.type) ?? 'message-error',
        status: 'error',
        errorFingerprint: deriveErrorFingerprint(
          str(err?.name) ?? str(asRecord(err?.data)?.message) ?? 'opencode message error',
        ),
        metadata: { error_keys: err ? Object.keys(err).sort() : [], raw: redact(data.error) },
      }),
    )
  }

  if (role === 'user') {
    out.push(
      event(s, {
        type: 'message.user',
        discriminator: 'user-turn',
        subtype: 'turn',
        // A user turn has no model: `session.model` describes the assistant side, and
        // inheriting it would attribute generation to the human. Only an explicit
        // per-message override counts.
        model: modelRefOf(null, data),
        metadata: {
          native_message_id: s.nativeId,
          // `message.data.parentID` chains a turn to the message it answers; the event
          // model has no column for it, so it travels as metadata.
          parent_message_id: str(data?.parentID),
          agent: str(data?.agent) ?? str(s.row.__session_agent),
          mode: str(data?.mode),
          // The prompt text is a `text` part in the other table, never on this row.
          text_in_parts: true,
        },
      }),
    )
    return out
  }

  if (role === 'assistant') {
    const tokens = tokensOf(data)
    out.push(
      event(s, {
        type: 'message.assistant',
        discriminator: 'assistant-turn',
        subtype: tokens.present ? 'assistant-rollup' : 'assistant-without-usage',
        // Per-step `generation.end` rows own the usage/cost of this message; the
        // message-level totals are recorded as metadata for reconciliation only.
        metadata: {
          native_message_id: s.nativeId,
          parent_message_id: str(data?.parentID),
          finish: str(data?.finish),
          agent: str(data?.agent),
          rollup: tokens.present ? { cost: costOf(data), tokens: asRecord(data?.tokens) } : null,
        },
      }),
    )
    return out
  }

  return [fromUnknown(s, role === null ? 'message-without-role' : `message-role:${role}`, false)]
}

// ---------------------------------------------------------------------- part

function fromPart(s: Scope): AgentEvent[] {
  const data = s.data
  const kind = str(data?.type)
  switch (kind) {
    case 'step-start':
      return [
        event(s, {
          type: 'generation.start',
          discriminator: 'step-start',
          requestId: stepRequestId(s),
          metadata: { message_id: str(s.row.message_id), snapshot: str(data?.snapshot) !== null },
        }),
      ]
    case 'step-finish':
      return [
        event(s, {
          type: 'generation.end',
          discriminator: 'step-finish',
          usage: usageFrom(tokensOf(data)),
          costReported: costOf(data),
          requestId: stepRequestId(s),
          status: str(data?.error) !== null ? 'error' : 'ok',
          metadata: {
            message_id: str(s.row.message_id),
            finish_reason: str(data?.reason),
            tokens_total_reported: num(asRecord(data?.tokens)?.total),
          },
        }),
      ]
    case 'tool':
      return fromTool(s)
    case 'text':
      return [fromTextPart(s, 'text', 'assistant_message')]
    case 'reasoning':
      return [fromTextPart(s, 'reasoning', 'reasoning')]
    case 'patch':
      return [
        fromUnknown(s, 'part-patch', true, {
          reason: 'file-snapshot-content-excluded-from-content-layer',
          files: Array.isArray(data?.files) ? (data?.files as unknown[]).length : null,
          hash_present: str(data?.hash) !== null,
        }),
      ]
    default:
      return [fromUnknown(s, `part-type:${kind ?? 'absent'}`, false)]
  }
}

/**
 * One OpenCode step is one API call, so its request id is unique by construction:
 * the fold under `request_max` and `per_record_sum` therefore agree, which keeps
 * the adapter safe under the conservative default aggregation policy (§18 row 2).
 */
function stepRequestId(s: Scope): string {
  const message = str(s.row.message_id)
  return message ? `${message}/${s.nativeId ?? `rowid:${s.rowid}`}` : `${s.table}/${s.rowid}`
}

function fromTextPart(s: Scope, kind: string, payloadKind: 'assistant_message' | 'reasoning'): AgentEvent {
  const role = str(s.row.__message_role)
  const text = str(s.data?.text)
  if (role === null) {
    // Without the joined role a text part cannot be attributed to a turn; guessing
    // 'assistant' would silently inflate assistant counts (§3.3).
    return fromUnknown(s, `part-type:${kind}`, true, { reason: 'role-unresolved', text_chars: text?.length ?? 0 })
  }
  const isUser = role === 'user'
  if (kind === 'reasoning' && isUser) return fromUnknown(s, 'reasoning-on-user-message', true)
  return event(s, {
    type: isUser ? 'message.user' : 'message.assistant',
    discriminator: isUser ? 'part-text-user' : 'part-text-assistant',
    subtype: isUser ? 'part-text' : kind === 'reasoning' ? 'reasoning' : 'part-text',
    // The turn itself is anchored on the `message` row; this event carries content.
    // Same rule as the user turn: no inherited session model.
    model: isUser ? modelRefOf(null, partialMessage(s.row)) : undefined,
    metadata: { content_only: true, message_id: str(s.row.message_id), part_id: s.nativeId },
    payload: text === null || text === '' ? null : { kind: isUser ? 'user_message' : payloadKind, role, text: truncate(text) },
  })
}

function fromTool(s: Scope): AgentEvent[] {
  const data = s.data
  const state = asRecord(data?.state)
  const rawName = str(data?.tool)
  const callId = str(data?.callID)
  const status = str(state?.status)
  const stateMeta = asRecord(state?.metadata)
  const mcp = mcpOf(rawName, stateMeta)
  const isSubagentTool = rawName === 'task' || rawName === 'Agent'

  const capability: CapabilityRef = mcp
    ? { type: 'mcp', name: mcp.tool, provider: mcp.server }
    : isSubagentTool
      ? {
          type: 'subagent',
          name: str(asRecord(state?.input)?.subagent_type) ?? str(stateMeta?.type) ?? 'subagent',
          provider: 'task',
        }
      : { type: 'tool', name: rawName ?? 'unknown', provider: null }

  const base = {
    capability,
    requestId: null,
    metadata: {
      message_id: str(s.row.message_id),
      call_id: callId,
      tool: rawName,
      status,
      state_title_present: str(state?.title) !== null,
    },
  }

  const inputExcluded = rawName !== null && FILE_BODY_INPUT_TOOLS.has(rawName)
  const inputText = inputExcluded ? null : jsonPayload(state?.input)
  const startEventId = event(s, {
    type: isSubagentTool ? 'subagent.start' : mcp ? 'mcp.invoke' : 'tool.start',
    discriminator: `tool-start:${callId ?? s.rowid}`,
    ...base,
    metadata: {
      ...base.metadata,
      input_chars: typeof state?.input === 'string' ? state.input.length : state?.input ? JSON.stringify(state.input).length : 0,
      input_excluded: inputExcluded,
    },
    payload: inputText === null ? null : { kind: 'tool_input', role: 'assistant', text: inputText },
  })
  const out: AgentEvent[] = [startEventId]

  if (status !== 'completed' && status !== 'error') return out

  const outputExcluded = rawName !== null && FILE_BODY_OUTPUT_TOOLS.has(rawName)
  const outputText = outputExcluded ? null : jsonPayload(state?.output)
  const errorText = str(state?.error) ?? null
  out.push(
    event(s, {
      type: 'tool.result',
      discriminator: `tool-result:${callId ?? s.rowid}`,
      parentEventId: startEventId.id,
      capability,
      durationMs: durationOf(state?.time),
      status: status === 'error' ? 'error' : 'ok',
      errorFingerprint: status === 'error' ? deriveErrorFingerprint(errorText ?? `${rawName ?? 'tool'} error`) : null,
      metadata: {
        ...base.metadata,
        output_chars: typeof state?.output === 'string' ? state.output.length : 0,
        output_excluded: outputExcluded,
        ...(errorText !== null ? { error: truncate(errorText, 500) } : {}),
      },
      payload: outputText === null ? null : { kind: 'tool_output', role: 'tool', text: outputText },
    }),
  )
  return out
}

// ------------------------------------------------------------------- unknown

function fromUnknown(s: Scope, upstreamType: string, mapped: boolean, extra: Record<string, unknown> = {}): AgentEvent {
  return event(s, {
    type: 'unknown',
    discriminator: `unknown:${upstreamType}`,
    subtype: upstreamType,
    // §5.2 rule 1 + §5.3: drift is counted with the raw row attached, never dropped.
    metadata: { upstream_type: upstreamType, mapped, raw: redact(s.data ?? s.row), ...extra },
  })
}

function failure(record: RawRecord, reason: string, rawLine: string, upstreamType: string | null): NormalizeResult {
  const f: ParseFailure = {
    reason,
    rawLine: truncate(rawLine, 16 * 1024),
    offset: record.offset,
    rawSeq: record.seq,
    upstreamType,
  }
  return { failure: f }
}
