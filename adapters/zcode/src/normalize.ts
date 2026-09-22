/**
 * §5.1 `normalize` — ZCode row (or subagent run document) → unified events, following
 * docs/research/zcode.md §七 and §八·5.
 *
 * The five measurement-forced decisions this file exists to make:
 *  - §三 — the same API call's tokens are stored FIVE times (`model_usage`,
 *    `part.step-finish`, `message.data.tokens`, `turn_usage`, `session_target`). Usage is
 *    read from `model_usage` alone and lands on `generation.end` alone; the other copies
 *    become `metadata.rollup` or an `unknown` row. `part`/`message` rows are UPDATEd in
 *    place under a stable rowid while resume is a rowid high-water mark, so a copy that
 *    lives there would be present or absent depending on scan timing;
 *  - §四 — `input_tokens` already CONTAINS `cache_read_input_tokens` (1395/1395 rows), so
 *    the cached buckets are subtracted rather than copied field to field;
 *  - §五 — `message.data.semantics.kind` dispatches, never `role`: 189 rows say
 *    `role='user'` and only 89 are real prompts, so a role mapping inflates user turns
 *    2.12× (and, measured the same way, would inflate them again through the 100 `text`
 *    parts those injected rows carry);
 *  - §18 row 1 — `cost` columns are uniformly 0 under a coding plan, so the event builder
 *    structurally cannot emit a reported cost;
 *  - §八·5 — the subagent parent link is a two-row contract, not one: the `Agent` call becomes
 *    a `tool.start` under a `subagent` capability (the shape the shared linker's candidate
 *    pool queries) while the chain marker stays the child session's own `subagent.start`, and
 *    the `cli/agents/<parentSession>/agent_<id>/metadata.json` document closes it naming that
 *    call's raw tool-use id.
 *    The same document is §三's fifth usage copy, so its numbers go to `metadata.rollup` only.
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  deriveSessionId,
  eventTimestamp,
  PARSE_ERROR_KEY,
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
  BACKGROUND_QUERY_SOURCES,
  COST_REASON,
  FILE_BODY_INPUT_TOOLS,
  FILE_BODY_OUTPUT_TOOLS,
  HOST_ID,
  INJECTED_SEMANTICS_KINDS,
  SEMANTICS_ASSISTANT_RESPONSE,
  SEMANTICS_USER_PROMPT,
  SKILL_TOOL,
  SUBAGENT_TOOLS,
  TABLE_MESSAGE,
  TABLE_MODEL_USAGE,
  TABLE_PART,
  TABLE_SESSION,
  TABLE_TOOL_USAGE,
  asRecord,
  bodyExcluded,
  bool,
  costCopy,
  iso,
  jsonPayload,
  mcpOf,
  modelRefOf,
  ms,
  num,
  parseJson,
  redact,
  sem,
  str,
  KNOWN_PART_TYPES,
  tableOf,
  truncate,
  usageFromModelUsage,
  type UnknownRecord,
  TABLE_AGENT_METADATA,
} from './record.ts'
import { stateFor } from './state.ts'

/** §4.1 rule 5: an unattributable cwd is reported, never guessed. */
export { UNATTRIBUTED_PROJECT_ID }

interface Scope {
  ctx: NormalizeCtx
  table: string
  row: UnknownRecord
  data: UnknownRecord | null
  rowid: number
  nativeId: string | null
  timestamp: number
  /** §5.2: whether that timestamp is the row's own time or something standing in for it. */
  timestampOrigin: TimestampOrigin
  sessionId: string
  /** §18 row 3: the row's OWN native session id, so a subagent's work stays separable. */
  threadId: string | null
  rootSessionId: string | null
  parentSessionId: string | null
  subagentThread: boolean
  projectId: string
  model: ModelRef | null
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
    case TABLE_MODEL_USAGE:
      events = fromModelUsage(scope)
      break
    case TABLE_TOOL_USAGE:
      events = fromToolUsage(scope)
      break
    case TABLE_AGENT_METADATA:
      events = fromAgentsMetadata(scope)
      break
    default:
      events = [fromUnknown(scope, `table:${scope.table}`, false)]
  }
  if (events.length === 0) events = [fromUnknown(scope, `${scope.table}:no-mappable-fields`, true)]
  return { events }
}

function buildScope(record: RawRecord, ctx: NormalizeCtx, value: UnknownRecord): Scope {
  const table = str(value.__table) ?? tableOf(ctx.source.sqliteTable)
  const hasColumns =
    value.__rowid !== undefined ||
    value.data !== undefined ||
    value.session_id !== undefined ||
    value.rowid !== undefined ||
    value.turn_id !== undefined
  const data = asRecord(value.data) ?? (hasColumns ? null : value)
  const rowid = num(value.__rowid ?? value.rowid) ?? record.seq
  const diagnostics: string[] = []
  const state = stateFor(ctx.source.id)
  state.observes(record.seq)

  const ownSession =
    str(value.__session_id) ?? (table === TABLE_SESSION ? str(value.id) : str(value.session_id)) ?? null
  const rootSession = str(value.__root_session_id) ?? ownSession
  if (rootSession === null) diagnostics.push('session_unresolved')

  const directory = str(value.__session_directory) ?? str(value.directory)
  const path = str(value.__session_path) ?? str(value.path)
  const parentSessionId =
    str(value.__session_parent_id) ?? (table === TABLE_SESSION ? str(value.parent_id) : null)
  const dataKind = str(value.__message_kind) ?? str(sem(data)?.kind)
  const dataOrigin = str(value.__message_origin) ?? str(sem(data)?.origin)

  // The per-source fallback map is fed from every row that states the fact, so a later row
  // of the SAME source delivered without its join columns can still be attributed. It is
  // write-only-per-source by construction: `part` never sees what `message` learned, which
  // is what the isolation test asserts.
  const stateKey = table === TABLE_MESSAGE ? str(value.id) : str(value.message_id)
  if (stateKey !== null && (dataKind !== null || str(value.__message_role) !== null)) {
    state.noteMessage(stateKey, {
      role: str(value.__message_role) ?? str(data?.role),
      kind: dataKind,
      origin: dataOrigin,
      modelId: str(value.__message_model_id) ?? str(data?.modelID),
      providerId: str(value.__message_provider_id) ?? str(data?.providerID),
      variant: str(value.__message_variant) ?? str(data?.variant),
    })
  }
  if (ownSession !== null && rootSession !== null) {
    state.noteSession(ownSession, {
      rootSessionId: rootSession,
      // Only a row whose parent column was actually delivered may teach "this is a root":
      // a frame that never carried `__session_parent_id` says nothing about parentage, and
      // recording NULL from it would quietly unflag a subagent thread.
      parentSessionId:
        (table === TABLE_SESSION ? value.parent_id !== undefined : value.__session_parent_id !== undefined)
          ? parentSessionId
          : null,
      directory: directory,
      version: str(value.__session_version) ?? str(value.version),
    })
  }
  const inherited = ownSession === null ? undefined : state.session(ownSession)

  const resolved = ctx.resolveProject(directory ?? path)
  if (resolved === null) diagnostics.push('project_unattributed')
  if (!hasColumns) diagnostics.push('partial_row')

  const rootForId = rootSession ?? inherited?.rootSessionId ?? ctx.sessionHint
  if (rootSession === null && inherited?.rootSessionId) diagnostics.push('session_inherited_from_source_state')
  const stamp = eventTimestamp(
    record,
    ms(value.time_created) ?? ms(value.started_at) ?? ms(value.time_updated) ?? ms(value.completed_at),
    ctx.now(),
  )

  return {
    ctx,
    table,
    row: value,
    data,
    rowid,
    nativeId: str(value.id),
    timestamp: stamp.timestamp,
    timestampOrigin: stamp.origin,
    sessionId: deriveSessionId(AGENT_ID, rootForId ?? `row:${table}/${rowid}`),
    threadId: ownSession,
    rootSessionId: rootSession,
    // §五 measured `query_source='subagent'` ⟺ `parent_id IS NOT NULL` on 367/367 rows, so
    // the parent link IS the subagent test: no timing heuristic is needed or wanted.
    parentSessionId: parentSessionId ?? inherited?.parentSessionId ?? null,
    subagentThread: (parentSessionId ?? inherited?.parentSessionId) !== null,
    projectId: resolved ?? UNATTRIBUTED_PROJECT_ID,
    model: defaultModelOf(table, data, value),
    diagnostics,
  }
}

function defaultModelOf(table: string, data: UnknownRecord | null, row: UnknownRecord): ModelRef | null {
  switch (table) {
    case TABLE_MODEL_USAGE: {
      // §五: `ModelRef{provider: provider_id, name: model_id, tier: variant}` verbatim.
      const name = str(row.model_id)
      if (name === null) return null
      return { provider: str(row.provider_id) ?? 'unknown', name, tier: str(row.variant) }
    }
    case TABLE_TOOL_USAGE:
      // A tool call is not a model generation; inheriting one would attribute generation.
      return null
    case TABLE_SESSION:
      // `session` carries no model column at all in ZCode's schema, unlike OpenCode's.
      return null
    default:
      return modelRefOf(data, row)
  }
}

interface EventInit {
  type: EventType
  discriminator: string
  subtype?: string | null
  capability?: CapabilityRef | null
  usage?: Usage | null
  model?: ModelRef | null
  durationMs?: number | null
  status?: AgentEvent['status']
  errorFingerprint?: string | null
  payload?: PayloadDraft | null
  metadata?: Record<string, unknown> | null
  requestId?: string | null
  timestamp?: number | null
  threadId?: string | null
  subagentThread?: boolean
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const metadata: Record<string, unknown> = {
    table: s.table,
    rowid: s.rowid,
    ...(init.metadata ?? {}),
  }
  if (s.diagnostics.length > 0) metadata.diagnostics = s.diagnostics.slice()
  if (init.subagentThread ?? s.subagentThread) metadata.subagentThread = true
  const timestamp = init.timestamp ?? s.timestamp
  // §5.2: an event that names its own row time states a fact; one wearing the scope's stamp
  // inherits that stamp's provenance, guessed or not.
  const guess = timestamp === s.timestamp ? timestampGuess(s.timestampOrigin) : null
  if (guess !== null) metadata[TIMESTAMP_GUESS_KEY] = guess
  return {
    id: deriveEventId({
      sourceId: s.ctx.source.id,
      rawSeq: s.rowid,
      type: init.type,
      timestamp,
      // Table + rowid in the discriminator, so two sources over one file can never collide.
      discriminator: `${s.table}:${s.rowid}:${init.discriminator}`,
    }),
    schemaVersion: SCHEMA_VERSION,
    agentId: AGENT_ID,
    hostId: HOST_ID,
    sourceId: s.ctx.source.id,
    sessionId: s.sessionId,
    projectId: s.projectId,
    // WHY always null: the one cross-source link worth making
    // (`tool_usage.tool_call_id` → the `part` row's `tool.start`) crosses a `source_id`
    // boundary, and §5.2 forbids an adapter from querying for it. The Timeline pairs the
    // two on `metadata.call_id` instead — a reported fact rather than a joined guess.
    parentEventId: null,
    requestId: init.requestId ?? null,
    threadId: init.threadId === undefined ? s.threadId : init.threadId,
    timestamp,
    ingestedAt: s.ctx.now(),
    type: init.type,
    subtype: init.subtype ?? null,
    model: init.model === undefined ? s.model : init.model,
    usage,
    usageSource: usage ? 'reported' : 'missing',
    // §18 row 1 + §四: no ZCode row may claim a reported cost — see `COST_REASON`. The
    // builder accepts no cost input at all, so a future call site cannot reintroduce one.
    costReported: null,
    costSource: 'none',
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

function usageOf(d: ReturnType<typeof usageFromModelUsage>): Usage | null {
  if (!d.present) return null
  return {
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens,
    reasoningTokens: d.reasoningTokens,
  }
}

/** §五: `completed` / `error` / `cancelled`, plus an unseen `running`, → the three-valued status. */
function statusOf(value: string | null): AgentEvent['status'] {
  if (value === 'completed') return 'ok'
  if (value === 'error' || value === 'cancelled') return 'error'
  return 'unknown'
}

function errorFingerprintOf(errorType: string | null, errorCode: string | null): string | null {
  if (errorType === null && errorCode === null) return null
  // Fingerprint the CLASS, not the message: §五's five `error_type` values are the stable
  // grouping, while `error_message` carries per-occurrence counts that would split it.
  return deriveErrorFingerprint(`${errorType ?? 'error'}:${errorCode ?? ''}`)
}

// ------------------------------------------------------------------- session

function fromSession(s: Scope): AgentEvent[] {
  const native = s.nativeId
  const permission = parseJson(s.row.permission)
  const out: AgentEvent[] = []
  out.push(
    event(s, {
      type: 'session.start',
      discriminator: 'session-start',
      subtype: native === null ? 'session-without-id' : null,
      metadata: {
        native_session_id: native,
        parent_session_id: s.parentSessionId,
        title_source: str(s.row.__session_title_source) ?? str(s.row.title_source),
        version: str(s.row.__session_version) ?? str(s.row.version),
        // §七's `mode`: `session` has no `mode` column, so the value comes from the
        // `permission` JSON (`{"mode":"yolo"}` on 38/38 rows). The per-request `mode` on
        // `model_usage` is the authoritative copy; this one is the session's default.
        mode: str(permission?.mode),
        task_type: str(s.row.__session_task_type) ?? str(s.row.task_type),
        // §七: the native `project_id` is kept for reconciliation only. §4.1's three-step
        // canonicalization of `directory` stays the authoritative `project_id` column.
        native_project_id: str(s.row.__session_project_id) ?? str(s.row.project_id),
        directory_present: (str(s.row.__session_directory) ?? str(s.row.directory)) !== null,
        has_title: str(s.row.title) !== null && str(s.row.title) !== '',
        rollup: sessionRollup(s.row),
      },
      subagentThread: s.subagentThread,
    }),
  )

  if (s.subagentThread) {
    out.push(
      event(s, {
        type: 'subagent.start',
        discriminator: 'subagent-start',
        // ZCode's `session` table carries no agent name (that is `model_usage.agent`, a
        // per-request column), so a child session's own row can only state that a subagent
        // session exists. The concrete kind (`zcode-Explore`, `zcode-general-purpose`) shows
        // up on its `generation.end` rows.
        capability: { type: 'subagent', name: 'subagent', provider: 'session.parent_id' },
        metadata: { parent_session_id: s.parentSessionId, native_session_id: native },
        subagentThread: true,
      }),
    )
  }

  const compactAt = ms(s.row.time_compacting)
  if (compactAt !== null) {
    // §17 item 5: ZCode states compaction the same way OpenCode does — a session timestamp, so
    // this is a derived marker with no token delta, enough to explain a cost jump downstream.
    // It is an event rather than a metadata field because the capability dimensions and `doctor`
    // count `context.compact`; a field hidden inside one row's metadata reads as "no compaction".
    out.push(
      event(s, {
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
    // §七: 0 archived sessions measured on this machine, so this branch is the only way
    // `session.end` can appear — its absence stays a reported fact rather than being
    // fabricated into an end event.
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

/**
 * `session` has no `cost`/`tokens` rollup columns (contrast OpenCode), so the only numbers
 * here are the diff summaries. §三's session-grain token rollups (copy #5) are
 * `session_target.tokens_used` — not a source, and the other half of that copy, the per-agent
 * `metadata.json` totals, keeps its numbers in `rollup` for the same reason (§八·5a). Nothing
 * in this object can reach `usage`.
 */
function sessionRollup(row: UnknownRecord): Record<string, unknown> {
  return {
    cost: null,
    tokens: null,
    summary_additions: num(row.summary_additions),
    summary_deletions: num(row.summary_deletions),
    summary_files: num(row.summary_files),
  }
}

// ------------------------------------------------------------------- message

function fromMessage(s: Scope): AgentEvent[] {
  const data = s.data
  const kind = str(s.row.__message_kind) ?? str(sem(data)?.kind)
  const origin = str(s.row.__message_origin) ?? str(sem(data)?.origin)
  const out: AgentEvent[] = []

  const err = asRecord(data?.error)
  if (data?.error !== undefined && data.error !== null) {
    // Measured 20/1603: the error rides ON an `assistant_response` row, so the error event
    // and the message event are both emitted — dropping either would lose the failure or
    // lose the turn it belongs to.
    const errData = asRecord(err?.data)
    const attribution = asRecord(errData?.attribution)
    out.push(
      event(s, {
        type: 'error',
        discriminator: 'message-error',
        subtype: str(err?.name) ?? 'message-error',
        status: 'error',
        errorFingerprint: deriveErrorFingerprint(
          str(err?.name) ?? str(errData?.message) ?? 'zcode message error',
        ),
        metadata: {
          error_keys: err ? Object.keys(err).sort() : [],
          error_reason: str(attribution?.reason),
          error_code: str(errData?.code),
          status_code: num(attribution?.statusCode),
          provider_retryable: bool(attribution?.retryable),
          raw: redact(data?.error),
        },
      }),
    )
  }

  const semantics = {
    semantics_kind: kind,
    semantics_origin: origin,
    native_message_id: s.nativeId,
    parent_message_id: str(data?.parentID),
    agent: str(data?.agent),
    mode: str(data?.mode),
  }

  if (kind === SEMANTICS_USER_PROMPT && origin === 'real_user') {
    out.push(
      event(s, {
        type: 'message.user',
        discriminator: 'user-turn',
        subtype: 'turn',
        // A user turn has no model. ZCode's user rows do carry `data.model` — the SELECTION
        // for the turn — so it goes to metadata rather than the model column, which would
        // otherwise read as "this model generated the human's message".
        model: null,
        metadata: {
          ...semantics,
          selected_model: modelRefOf(data, null),
          // The prompt text is a `text` part in the other table, never on this row.
          text_in_parts: true,
        },
      }),
    )
    return out
  }

  if (kind === SEMANTICS_ASSISTANT_RESPONSE) {
    const copy = costCopy(data)
    out.push(
      event(s, {
        type: 'message.assistant',
        discriminator: 'assistant-turn',
        subtype: asRecord(data?.tokens) !== null ? 'assistant-rollup' : 'assistant-without-usage',
        // §三 copy #3: `message.data.tokens` restates the same call. This row's id IS the
        // `logical_request_id` (measured equal on 1385/1385 non-null usage rows), so the
        // turn shares the request key without carrying a second usage object.
        requestId: s.nativeId,
        metadata: {
          ...semantics,
          finish: str(data?.finish),
          rollup: {
            // `cost` is the plan-zero column (§四); `cost_reason` says why it is null.
            cost: copy.reported,
            cost_column_value: copy.value,
            cost_reason: COST_REASON,
            tokens: asRecord(data?.tokens),
          },
        },
      }),
    )
    return out
  }

  if (kind !== null && (INJECTED_SEMANTICS_KINDS as readonly string[]).includes(kind)) {
    // §五/§七: kept as `unknown` + the kind, so the Timeline still shows the injection while
    // turn counts stay clean. Discarding these 100 rows would lose the evidence instead.
    out.push(fromUnknown(s, kind, true, { semantics_origin: origin, ui_visibility: str(sem(data)?.uiVisibility) }))
    return out
  }

  if (kind === SEMANTICS_USER_PROMPT) {
    // A prompt the runtime attributes to itself: reported as drift, never upgraded to a user
    // turn, because `origin='real_user'` is the measured test for "the human typed this".
    return [fromUnknown(s, SEMANTICS_USER_PROMPT, false, { semantics_origin: origin })]
  }

  return [fromUnknown(s, kind ?? 'message-without-semantics', false)]
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
          // Same key as the `generation.end` this step produces (measured: a step's
          // `message_id` IS the `logical_request_id` on 1385/1385 assistant steps), so the
          // request group is well-formed even though only one of its rows carries usage.
          requestId: str(s.row.message_id) ?? s.nativeId,
          metadata: { message_id: str(s.row.message_id), part_id: s.nativeId },
        }),
      ]
    case 'step-finish':
      return [fromStepFinish(s)]
    case 'tool':
      return [fromToolStart(s)]
    case 'text':
      return fromContentPart(s, 'text')
    case 'reasoning':
      return fromContentPart(s, 'reasoning')
    default: {
      // §五 measured 7 kinds, all of them above. Anything else is a shape this adapter has
      // never seen: `fromUnknown` reports both cases, and the flag says which one it is, so
      // §5.3's drift count can tell "known, deliberately unmapped" from "new upstream type".
      const seen = kind !== null && (KNOWN_PART_TYPES as readonly string[]).includes(kind)
      return [fromUnknown(s, kind ?? 'part-type-absent', false, { recognized_part_type: seen })]
    }
  }
}

/**
 * §三 copy #2: `part.step-finish` states the same tokens as its `model_usage` row
 * (`tokens.total`/`input` equal row-for-row on 1355/1355 pairs) and lands on a rowid that is
 * UPDATEd in place at the end of the request. Under a rowid high-water resume that makes it
 * a coin flip, so it becomes an `unknown` with NO usage: the drift stays visible and the
 * double count becomes impossible.
 */
function fromStepFinish(s: Scope): AgentEvent {
  const data = s.data
  const copy = costCopy(data)
  return event(s, {
    type: 'unknown',
    discriminator: 'step-finish-duplicate',
    subtype: 'step-finish',
    requestId: str(s.row.message_id) ?? s.nativeId,
    metadata: {
      upstream_type: 'step-finish',
      mapped: true,
      duplicate_of: 'model_usage',
      reason: 'usage is read from model_usage only (§三); this row restates it on an UPDATEd rowid',
      message_id: str(s.row.message_id),
      part_id: s.nativeId,
      finish_reason: str(data?.reason),
      rollup: { cost: copy.reported, cost_column_value: copy.value, tokens: asRecord(data?.tokens) },
      raw: redact(data),
    },
  })
}

/** ZCode's capability vocabulary, from the measured tool-name dialect (§五). */
function capabilityOf(toolName: string | null, input: UnknownRecord | null): CapabilityRef {
  const mcp = mcpOf(toolName)
  if (mcp !== null) return { type: 'mcp', name: mcp.tool, provider: mcp.server }
  if (toolName !== null && SUBAGENT_TOOLS.has(toolName.toLowerCase())) {
    return { type: 'subagent', name: str(input?.subagent_type) ?? 'subagent', provider: toolName }
  }
  if (toolName !== null && toolName.toLowerCase() === SKILL_TOOL.toLowerCase()) {
    return { type: 'skill', name: str(input?.skill) ?? 'skill', provider: toolName }
  }
  return { type: 'tool', name: toolName ?? 'unknown', provider: null }
}

/**
 * `part.tool` gives the START only. The outcome comes from `tool_usage`, because part rows
 * are UPDATEd in place (measured 1,800 completed / 51 error at rest, from `pending`) and a
 * rowid already scanned is never re-read — so an outcome taken from this table would be
 * missing from every incremental scan that arrived before the call finished.
 */
function fromToolStart(s: Scope): AgentEvent {
  const data = s.data
  const state = asRecord(data?.state)
  const rawName = str(data?.tool)
  const callId = str(data?.callID)
  const capability = capabilityOf(rawName, asRecord(state?.input))
  const inputExcluded = bodyExcluded(FILE_BODY_INPUT_TOOLS, rawName)
  const outputExcluded = bodyExcluded(FILE_BODY_OUTPUT_TOOLS, rawName)
  const inputText = inputExcluded ? null : jsonPayload(state?.input)
  const output = str(state?.output)
  return event(s, {
    // §八·5b: the spawn is a `tool.start` under a `subagent` capability, NOT a
    // `subagent.start`. The shared parent-link pass resolves `subagent.start` rows against a
    // candidate pool queried as `type = 'tool.start' AND capability_type = 'subagent'` —
    // exactly how claude-code's spawn rows are shaped — so naming this row anything else keeps
    // the pool empty and the chain's parent NULL even though the foreign key is on disk.
    // `metadata.call_id` below is the key that pass binds its proof to. The chain marker stays
    // the child session's own `subagent.start` from the `session` source, so the Timeline
    // still sees a subagent beginning; it just no longer competes with the spawn for the same
    // event type. `mcp__*` and `Skill` keep their own mappings.
    type: capability.type === 'mcp' ? 'mcp.invoke' : capability.type === 'skill' ? 'skill.invoke' : 'tool.start',
    discriminator: `tool-start:${callId ?? s.rowid}`,
    capability,
    metadata: {
      message_id: str(s.row.message_id),
      part_id: s.nativeId,
      call_id: callId,
      tool: rawName,
      // The status this row happens to hold right now is evidence about scan timing, not
      // about the call; `tool_usage.status` is the authoritative outcome.
      observed_state_status: str(state?.status),
      input_chars: sizeOf(state?.input),
      input_excluded: inputExcluded,
      // §3.2/§6: the 37,659-char `Read` bodies and 22,877-char `Write` inputs measured in
      // these rows stay out of the content layer; only their sizes are kept.
      observed_output_chars: output?.length ?? 0,
      observed_output_excluded: outputExcluded,
      state_title_present: str(state?.title) !== null,
    },
    payload: inputText === null ? null : { kind: 'tool_input', role: 'assistant', text: inputText },
  })
}

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === null || value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function contentAttrsOf(s: Scope): { kind: string | null; role: string | null; inherited: boolean } {
  const kind = str(s.row.__message_kind)
  const role = str(s.row.__message_role)
  if (kind !== null || role !== null) return { kind, role, inherited: false }
  // The row's own join columns are silent (`__message_*` absent, e.g. the LEFT JOIN missed
  // or the framing dropped them), so ask what THIS source already proved about that message.
  const seen = stateFor(s.ctx.source.id).message(str(s.row.message_id))
  if (seen && (seen.kind !== null || seen.role !== null)) {
    return { kind: seen.kind, role: seen.role, inherited: true }
  }
  return { kind: null, role: null, inherited: false }
}

/**
 * `text`/`reasoning` parts are content, dispatched on the owning message's SEMANTICS exactly
 * like the message rows themselves. Measured on the real store, 94 `todo_reminder`, 5
 * `background_notification` and 1 `system_reminder` messages each carry a `text` part while
 * still saying `role='user'` — a role-based mapping would turn all 100 runtime injections
 * into user turns on top of the 100 the message table already inflates.
 */
function fromContentPart(s: Scope, partKind: 'text' | 'reasoning'): AgentEvent[] {
  const { kind, role, inherited } = contentAttrsOf(s)
  const text = str(s.data?.text)
  if (inherited) s.diagnostics.push('content_kind_inherited_from_source_state')
  const isUserTurn = kind === SEMANTICS_USER_PROMPT || (kind === null && role === 'user')
  const isAssistantTurn = kind === SEMANTICS_ASSISTANT_RESPONSE || (kind === null && role === 'assistant')
  if (isUserTurn && partKind === 'reasoning') {
    // Reasoning on a user turn is not a shape this store produces (928/928 ride assistant
    // rows); report the mismatch instead of guessing which side it belongs to.
    return [fromUnknown(s, 'reasoning-on-user-message', true, { text_chars: text?.length ?? 0 })]
  }
  if (isUserTurn) {
    return [contentEvent(s, 'message.user', 'part-text-user', 'part-text', 'user_message', text, 'user')]
  }
  if (isAssistantTurn) {
    return [
      contentEvent(
        s,
        'message.assistant',
        'part-text-assistant',
        partKind === 'reasoning' ? 'reasoning' : 'part-text',
        partKind === 'reasoning' ? 'reasoning' : 'assistant_message',
        text,
        'assistant',
      ),
    ]
  }
  if (kind !== null) return [fromUnknown(s, kind, true, { text_chars: text?.length ?? 0, part_type: partKind })]
  return [fromUnknown(s, partKind, true, { reason: 'content_kind_unresolved', text_chars: text?.length ?? 0 })]
}

function contentEvent(
  s: Scope,
  type: EventType,
  discriminator: string,
  subtype: string,
  payloadKind: PayloadDraft['kind'],
  text: string | null,
  role: string,
): AgentEvent {
  return event(s, {
    type,
    discriminator,
    subtype,
    // The turn itself is anchored on the `message` row; this event only carries content.
    metadata: { content_only: true, message_id: str(s.row.message_id), part_id: s.nativeId },
    payload: text === null || text === '' ? null : { kind: payloadKind, role, text: truncate(text) },
  })
}

// ---------------------------------------------------------------- model_usage

/** §三 copy #1 — and the ONLY usage carrier in this adapter. */
function fromModelUsage(s: Scope): AgentEvent[] {
  const row = s.row
  const draft = usageFromModelUsage(row)
  const status = str(row.status)
  const errorType = str(row.error_type)
  const errorCode = str(row.error_code)
  const querySource = str(row.query_source)
  const background = querySource !== null && (BACKGROUND_QUERY_SOURCES as readonly string[]).includes(querySource)
  const errorMessage = str(row.error_message)
  return [
    event(s, {
      type: 'generation.end',
      discriminator: 'model-usage',
      // §五: `session_title`/`goal_summary_title`/`target_completion_verification`
      // (8/1/1 rows) are the model's own background calls. They are real spend, so they stay
      // in the ledger — but they must be nameable as not-user-driven, hence the subtype.
      subtype: background ? querySource : null,
      // §五: `trace_id` must never be the request key — 1,395 rows share only 10 of them and
      // the largest spans 15 sessions. `logical_request_id` is the measured 1:1 key.
      requestId: str(row.logical_request_id),
      usage: usageOf(draft),
      model: defaultModelOf(TABLE_MODEL_USAGE, null, row),
      durationMs: num(row.duration_ms),
      status: statusOf(status),
      errorFingerprint: errorFingerprintOf(errorType, errorCode),
      timestamp: ms(row.completed_at) ?? ms(row.started_at) ?? s.timestamp,
      metadata: {
        native_session_id: str(row.session_id),
        turn_id: str(row.turn_id),
        query_source: querySource,
        background_call: background,
        attempt_index: num(row.attempt_index),
        trace_id: str(row.trace_id),
        span_id: str(row.span_id),
        assistant_message_id: str(row.assistant_message_id),
        parent_user_message_id: str(row.parent_user_message_id),
        agent: str(row.agent),
        mode: str(row.mode),
        task_type: str(row.task_type) ?? str(row.__session_task_type),
        status,
        finish_reason: str(row.finish_reason),
        tool_call_count: num(row.tool_call_count),
        time_to_first_token_ms: num(row.time_to_first_token_ms),
        first_token_at: ms(row.first_token_at),
        started_at: ms(row.started_at),
        completed_at: ms(row.completed_at),
        error_type: errorType,
        error_code: errorCode,
        ...(errorMessage !== null ? { error_message: truncate(errorMessage, 500) } : {}),
        retry_count: num(row.retry_count),
        retryable: bool(row.retryable),
        cancelled_by_user: bool(row.cancelled_by_user),
        context_exceeded: bool(row.context_exceeded),
        // §四: these two ARE totals of the very fields `usage` was built from, so they are
        // reconciliation only, never summed, and the suite asserts they stay out of `usage`.
        rollup: draft.rollup,
        cost: null,
        cost_reason: COST_REASON,
        raw_usage_present: str(row.raw_usage_json) !== null,
      },
    }),
  ]
}

// ---------------------------------------------------------------- tool_usage

/**
 * §五: `tool.end` alone — not `tool.end` AND `tool.result`. Both are representable, but two
 * events for one insert-only record would double every tool-call count while adding no
 * information; `tool.end` is the type that carries status, duration and error class.
 * `metadata.call_id` is the pairing key to `part`'s `tool.start`.
 */
function fromToolUsage(s: Scope): AgentEvent[] {
  const row = s.row
  const status = str(row.status)
  const errorType = str(row.error_type)
  const errorCode = str(row.error_code)
  const errorMessage = str(row.error_message)
  const toolName = str(row.tool_name)
  return [
    event(s, {
      type: 'tool.end',
      discriminator: 'tool-usage',
      capability: capabilityOf(toolName, null),
      durationMs: num(row.duration_ms),
      status: statusOf(status),
      errorFingerprint: errorFingerprintOf(errorType, errorCode),
      timestamp: ms(row.completed_at) ?? ms(row.started_at) ?? s.timestamp,
      metadata: {
        call_id: str(row.tool_call_id),
        tool: toolName,
        native_session_id: str(row.session_id),
        turn_id: str(row.turn_id),
        trace_id: str(row.trace_id),
        status,
        // §五's column no other adapter has: what the call was allowed to touch. Kept
        // verbatim rather than folded into `capability`, since `capability` names the tool.
        side_effect_scope: str(row.side_effect_scope),
        read_only: bool(row.read_only),
        destructive: bool(row.destructive),
        approval_status: str(row.approval_status),
        exit_code: num(row.exit_code),
        output_bytes: num(row.output_bytes),
        stdout_bytes: num(row.stdout_bytes),
        stderr_bytes: num(row.stderr_bytes),
        truncated: bool(row.truncated),
        retry_count: num(row.retry_count),
        cancelled_by_user: bool(row.cancelled_by_user),
        first_output_at: ms(row.first_output_at),
        time_to_first_output_ms: num(row.time_to_first_output_ms),
        started_at: ms(row.started_at),
        completed_at: ms(row.completed_at),
        error_type: errorType,
        error_code: errorCode,
        ...(errorMessage !== null ? { error_message: truncate(errorMessage, 500) } : {}),
      },
    }),
  ]
}

// ------------------------------------------------------- agents metadata (§八·5)

/**
 * The subagent run statuses measured in `cli/agents/…/metadata.json`: `completed` 20 /
 * `failed` 8. `failed` is this document's own word for a run that did not finish, so it reads
 * as an error; it is NOT one of the SQLite CHECK vocabulary's values, which is why the store's
 * `statusOf` is not reused here.
 */
function agentsStatusOf(value: string | null): AgentEvent['status'] {
  if (value === 'completed') return 'ok'
  if (value === 'failed' || value === 'error' || value === 'cancelled') return 'error'
  return 'unknown'
}

/**
 * §八·5a — the closing row of one subagent chain.
 *
 * WHY a row in ANOTHER source can prove this one: `deriveEventId` needs the spawn's `rawSeq`,
 * which is the `part` table's rowid, and this document holds neither that nor the `part`
 * source's id. So the proof names the spawn's raw `parentToolUseId` and the shared linker
 * resolves it against the pool of stored spawns (`SubagentLinkVocabulary.proofNames:
 * 'tool-use-id'`), which is a fact about the store rather than a guess by this adapter (§5.2
 * forbids the query that would be needed to settle it here).
 *
 * WHY the ids line up at all: `sessionId` here is derived from the root the framing read off
 * the directory, which is the same root `parse`'s `parent_id` walk gives the child session's
 * own `subagent.start` — and `threadId`/`native_session_id` stay the child's own id, so the
 * closing row lands in the same session bucket as the chain it closes.
 *
 * WHAT does not come out of this document: §三's fifth usage copy. `totalTokens`, `usage` and
 * their friends go to `metadata.rollup` and nowhere near `usage` or `costReported`, because
 * the chain's model calls were already billed row-by-row by `model_usage`. And `prompt` /
 * `profileSnapshot` were dropped during framing (§八·5a's privacy rule), so this function
 * cannot emit them even by accident. The document's `error` line is unread for the same
 * reason §五 fingerprints a class rather than a message.
 */
function fromAgentsMetadata(s: Scope): AgentEvent[] {
  const doc = s.data ?? {}
  const childSessionId = str(doc.childSessionId)
  const parentToolUseId = str(doc.parentToolUseId)
  const status = str(doc.status)
  const spawnDir = s.parentSessionId

  const declaredParent = str(doc.parentSessionId)
  if (declaredParent !== null && spawnDir !== null && declaredParent !== spawnDir) {
    // Measured 28/28 agreement between the containing directory and this key. A disagreement is
    // a shape this mapping has not settled, and `sessionId` below comes from the directory —
    // so say so in the row instead of letting one of the two win silently.
    s.diagnostics.push('spawn_dir_disagrees_with_parent_session_id')
  }

  if (childSessionId === null || parentToolUseId === null) {
    // §八·5a: no key, no link. The row is still reported (§5.2 rule 1) as drift naming the
    // absent key, and it carries NO `parent_source`, so the shared pass cannot mistake it for
    // a proof.
    const absent: string[] = []
    if (childSessionId === null) absent.push('child-session-id')
    if (parentToolUseId === null) absent.push('parent-tool-use-id')
    return [
      fromUnknown(s, `metadata-missing-${absent.join('-and-')}`, false, {
        link_keys_absent: absent,
        status,
      }),
    ]
  }

  const createdAt = iso(doc.createdAt)
  const completedAt = iso(doc.completedAt)
  const durationMs =
    createdAt !== null && completedAt !== null && completedAt >= createdAt ? completedAt - createdAt : null

  return [
    event(s, {
      type: 'subagent.end',
      discriminator: `metadata:${childSessionId}`,
      // The document names no model, and a close that invented one would attribute a
      // generation the chain's own `generation.end` rows already state.
      model: null,
      // §三 copy #5: evidence only, never `usage` and never a reported cost.
      usage: null,
      durationMs,
      status: agentsStatusOf(status),
      // A subagent's close is a subagent fact whatever the directory said, and the flag is
      // what keeps this row in its chain's thread tree for the cube's subagent switch.
      subagentThread: true,
      metadata: {
        native_session_id: childSessionId,
        parent_source: 'foreign-key',
        linked_parent: parentToolUseId,
        agent_id: str(doc.agentId),
        status,
        ...(spawnDir !== null ? { spawn_dir: spawnDir } : {}),
        rollup: {
          totalTokens: num(doc.totalTokens),
          totalDurationMs: num(doc.totalDurationMs),
          totalToolUseCount: num(doc.totalToolUseCount),
          usage: redact(asRecord(doc.usage) ?? null),
        },
      },
    }),
  ]
}

// ------------------------------------------------------------------- unknown

function fromUnknown(s: Scope, upstreamType: string, mapped: boolean, extra: Record<string, unknown> = {}): AgentEvent {
  return event(s, {
    type: 'unknown',
    discriminator: `unknown:${upstreamType}`,
    // §7: the subtype IS the upstream kind, so `agentlens doctor` can group on it without a
    // per-source prefix convention.
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
