/**
 * §5.1 `normalize` — the Qoder record → unified event mapping. Qoder is a
 * Claude Code fork writing the same JSONL shape (§18, docs/research/
 * qoder-opencode.md §1), so the measurement-forced rules carry over: one file
 * = one session, `tool_result` inside user records ≠ a user turn, and
 * `<synthetic>` placeholders must not be billed. Qoder's own extensions — the
 * credit economy and `parent_tool_use_id` — are handled here, not in the
 * Claude adapter (§5.4 forbids adapter-to-adapter references).
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  deriveSessionId,
  deriveSessionIdFromSource,
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
  type UsageSource,
} from '@agentlens/event-model'
import {
  AGENT_ID,
  PARSE_ERROR_KEY,
  SYNTHETIC_MODEL,
  arr,
  asRecord,
  attachmentOf,
  bool,
  contentBlocks,
  contentText,
  messageOf,
  modelOf,
  modelRef,
  num,
  parseMcpToolName,
  redact,
  resolveHost,
  resolveRequestId,
  safeStringify,
  str,
  timestampMs,
  toolInputText,
  truncate,
  usageIsZero,
  usageOf,
  type QoderUsage,
  type UnknownRecord,
} from './record.ts'
import { ScanState, stateFor } from './state.ts'

/**
 * §4.1 rule 5 (inherited): `cwd` is absent on host-metadata records, so an
 * unattributable cwd is reported, never guessed.
 */
export { UNATTRIBUTED_PROJECT_ID }

/**
 * §5.3 whitelist — the record types the Qoder census measured besides the
 * conversational four (assistant/user/attachment/system): all are host
 * bookkeeping kept as counted `unknown` events.
 */
export const HOST_METADATA_TYPES: readonly string[] = [
  'active-leaf',
  'file-history-snapshot',
  'runtime-config',
  'last-prompt',
  'workspace-directories',
  'worktree-state',
]

const SUBAGENT_ENTRY_TOOLS = new Set(['Agent', 'Task'])

/**
 * Credits are NOT dollars (§18 rows 1–2): Qoder bills through a credit
 * economy and its usage objects carry no currency, so `credits` maps to
 * `AgentEvent.credits` only and `costReported`/`costSource` stay unset — that
 * lets §8's price table compute an API-equivalent. A record with an explicit
 * monetary amount (see `moneyOf` in record.ts) is the only thing that may set
 * `costReported`.
 */

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
  qoderUsage?: QoderUsage | null
}

interface Scope {
  rec: UnknownRecord
  ctx: NormalizeCtx
  state: ScanState
  hostId: string
  sessionId: string
  /** §18 row 3: thread = source-file grain; one Qoder file is one session, so both keys coexist. */
  threadId: string
  projectId: string
  projectSource: 'cwd' | 'unattributed'
  requestId: string | null
  timestamp: number
  rawSeq: number
  rawOffset: number
  model: ModelRef | null
  modelName: string | null
  diagnostics: string[]
  isSidechain: boolean
  agentId: string | null
  parentToolUseId: string | null
}

export async function normalize(record: RawRecord, ctx: NormalizeCtx): Promise<NormalizeResult> {
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

  const upstreamType = typeName(scope.rec.type)
  let events = dispatch(scope, upstreamType)

  if (scope.isSidechain && scope.agentId) {
    events = [...subagentStart(scope), ...events]
  }
  if (events.length === 0) {
    // §5.2 rule 1: suppression stays visible — a deduped activation is counted, not dropped.
    events = [fromUnknown(scope, upstreamType ?? 'unknown', { suppressed: 'duplicate-skill-activation' })]
  }
  return { events }
}

/** §5.3: a non-string `type` is drift evidence too, kept as text rather than lost. */
function typeName(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (value === undefined || value === null || typeof value === 'object') return null
  return String(value)
}

/** Explicit dispatch (§5.3): anything outside this table becomes a counted `unknown`. */
function dispatch(s: Scope, upstreamType: string | null): AgentEvent[] {
  switch (upstreamType) {
    case 'assistant':
      return fromAssistant(s)
    case 'user':
      return fromUser(s)
    case 'attachment':
      return fromAttachment(s)
    case 'system':
      return fromSystem(s)
    default:
      break
  }
  if (upstreamType !== null && HOST_METADATA_TYPES.includes(upstreamType)) {
    return [fromUnknown(s, upstreamType, { host_metadata: true })]
  }
  return [fromUnknown(s, upstreamType, {})]
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

function buildScope(record: RawRecord, ctx: NormalizeCtx, state: ScanState): Scope {
  const rec = record.value as UnknownRecord
  const { hostId, diagnostic } = resolveHost(rec.entrypoint)
  const nativeSession = str(rec.sessionId)
  const hint = typeof ctx.sessionHint === 'string' && ctx.sessionHint ? ctx.sessionHint : null
  const sessionKey = nativeSession ?? hint
  const uuid = str(rec.uuid)
  const sessionId = sessionKey
    ? deriveSessionId(AGENT_ID, sessionKey)
    : deriveSessionIdFromSource(ctx.source.id, uuid ?? `seq-${record.seq}`)
  const cwd = str(rec.cwd)
  const resolved = ctx.resolveProject(cwd)
  const diagnostics: string[] = diagnostic ? [diagnostic] : []
  const usage = usageOf(rec)

  return {
    rec,
    ctx,
    state,
    hostId,
    sessionId,
    threadId: `t/${ctx.source.id}`,
    projectId: resolved ?? UNATTRIBUTED_PROJECT_ID,
    projectSource: resolved ? 'cwd' : 'unattributed',
    requestId: resolveRequestId(rec, usage),
    timestamp: timestampMs(rec, record.occurredAt || ctx.now()),
    rawSeq: record.seq,
    rawOffset: record.offset,
    model: modelRef(modelOf(rec)),
    modelName: modelOf(rec),
    diagnostics,
    isSidechain: bool(rec.isSidechain),
    agentId: str(rec.agentId),
    parentToolUseId: str(rec.parent_tool_use_id),
  }
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const metadata: Record<string, unknown> = { ...(init.metadata ?? {}) }
  if (s.diagnostics.length > 0) metadata.host_diagnostics = s.diagnostics.slice()
  if (s.projectSource === 'unattributed') metadata.project_unattributed = true
  if (s.isSidechain && s.agentId) metadata.agent_id = s.agentId
  if (init.qoderUsage) {
    const q = init.qoderUsage
    if (q.credits !== null) metadata.qoder_credits = q.credits
    if (q.originalCredits !== null) metadata.qoder_original_credits = q.originalCredits
    if (q.billable !== null) metadata.qoder_billable = q.billable
    if (q.contextUsageRatio !== null) metadata.qoder_context_usage_ratio = q.contextUsageRatio
    if (q.billing) metadata.qoder_billing = redact(q.billing)
  }
  const type = init.type
  const e: AgentEvent = {
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
    projectId: s.projectId,
    parentEventId: init.parentEventId ?? null,
    requestId: init.requestId ?? null,
    threadId: s.threadId,
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
  const q = init.qoderUsage
  if (q) {
    if (q.credits !== null) e.credits = q.credits
    const money = moneyReported(q)
    if (money !== null) {
      e.costReported = money
      e.costSource = 'reported'
    }
  }
  return e
}

/** Only an explicit monetary amount counts as a reported cost — never a credit number. */
function moneyReported(q: QoderUsage): number | null {
  return q.money
}

// ---------------------------------------------------------------- assistant

function fromAssistant(s: Scope): AgentEvent[] {
  const message = messageOf(s.rec)
  const q = usageOf(s.rec)

  // §4.4 row 6 (inherited): `<synthetic>` placeholder records (~1/file, tokens
  // all 0) must not become billed generations — every session would gain a
  // ghost call. They land as counted diagnostics.
  if (s.modelName === SYNTHETIC_MODEL) {
    return [
      event(s, {
        type: 'error',
        subtype: 'synthetic-placeholder',
        discriminator: 'error:synthetic-placeholder',
        usage: null,
        usageSource: 'missing',
        status: 'error',
        requestId: null,
        qoderUsage: q,
        errorFingerprint: deriveErrorFingerprint('qoder synthetic placeholder response'),
        metadata: {
          reason: 'model=<synthetic>',
          usage_present: q !== null,
          message_keys: message ? Object.keys(message).sort() : [],
        },
      }),
    ]
  }

  const blocks = contentBlocks(s.rec)
  const text = contentText(s.rec)
  const draft = q?.tokens ?? null
  // Measured: Qoder emits usage with all token fields 0 while credits > 0.
  // Such a row carries no trustworthy token counts, so it becomes a diagnostic
  // generation with `usageSource:'missing'` (no usage to fold or double-count),
  // while its credits are still kept.
  const zeroUsage = draft !== null && usageIsZero(draft)
  const usage: Usage | null = draft && !zeroUsage ? { ...draft } : null

  const primary = event(s, {
    // §3.1: exactly one usage-bearing row per request (§18 row 2 measurement),
    // and request_max folding still protects against future fork drift.
    type: q ? 'generation.end' : 'message.assistant',
    discriminator: 'role:assistant',
    subtype: q ? (zeroUsage ? 'zero-usage' : null) : 'assistant-without-usage',
    usage,
    usageSource: usage ? 'reported' : 'missing',
    status: zeroUsage ? 'error' : str(message?.stop_reason) === 'error' ? 'error' : 'ok',
    errorFingerprint: zeroUsage ? deriveErrorFingerprint('qoder zero-usage billing row') : null,
    requestId: s.requestId,
    qoderUsage: q,
    parentEventId: s.parentToolUseId ? (s.state.toolCall(s.parentToolUseId)?.eventId ?? null) : null,
    payload: text ? { kind: 'assistant_message', role: 'assistant', text: truncate(text, 64 * 1024) } : null,
    metadata: {
      block_types: blocks.map((b) => str(b.type) ?? '?'),
      message_id: str(message?.id),
      stop_reason: str(message?.stop_reason),
      leaf_uuid: str(s.rec.leafUuid),
    },
  })
  const out: AgentEvent[] = [primary]

  blocks.forEach((block, index) => {
    const kind = str(block.type)
    if (kind === 'text' || kind === 'thinking' || kind === 'redacted_thinking') return
    out.push(...fromAssistantBlock(s, block, kind ?? 'unknown', index, primary.id))
  })
  return out
}

const TOOL_USE_BLOCK_KINDS = new Set(['tool_use', 'function', 'function_call', 'server_tool_use'])

function fromAssistantBlock(s: Scope, block: UnknownRecord, kind: string, index: number, parentEventId: string): AgentEvent[] {
  if (!TOOL_USE_BLOCK_KINDS.has(kind)) {
    return [fromUnknown(s, `assistant-block:${kind}`, { mapped: true, block_index: index })]
  }
  const name = str(block.name) ?? 'unknown'
  const toolUseId = str(block.id)
  const input = asRecord(block.input)
  const payload: PayloadDraft | null =
    block.input === undefined || block.input === null
      ? null
      : { kind: 'tool_input', role: 'assistant', text: toolInputText(block.input) }

  if (name === 'Skill') {
    const raw = str(input?.skill) ?? str(input?.command) ?? 'unknown'
    return skillActivation(s, raw, 'skill-tool', payload, parentEventId, index)
  }

  const mcp = parseMcpToolName(name)
  if (mcp) {
    const capability: CapabilityRef = {
      type: mcp.isPlugin ? 'plugin' : 'mcp',
      name: mcp.tool,
      provider: mcp.server,
    }
    return [
      event(s, {
        type: mcp.isPlugin ? 'plugin.invoke' : 'mcp.invoke',
        discriminator: `mcp:${toolUseId ?? index}`,
        capability,
        requestId: s.requestId,
        parentEventId,
        payload,
        metadata: { tool_name: name, tool_use_id: toolUseId },
      }),
    ]
  }

  const isSubagentEntry = SUBAGENT_ENTRY_TOOLS.has(name)
  const capability: CapabilityRef = isSubagentEntry
    ? { type: 'subagent', name: str(input?.subagent_type) ?? name, provider: name }
    : { type: 'tool', name, provider: null }

  const toolEvent = event(s, {
    type: 'tool.start',
    discriminator: `tool:${toolUseId ?? index}`,
    subtype: isSubagentEntry ? `${name}:spawn` : null,
    capability,
    requestId: s.requestId,
    parentEventId,
    payload,
    metadata: isSubagentEntry
      ? { tool_name: name, tool_use_id: toolUseId, description: str(input?.description) }
      : { tool_name: name, tool_use_id: toolUseId },
  })
  s.state.noteToolCall(toolUseId ?? `${parentEventId}#${index}`, { eventId: toolEvent.id, capability })
  return [toolEvent]
}

// ---------------------------------------------------------------- user

function fromUser(s: Scope): AgentEvent[] {
  const blocks = contentBlocks(s.rec)
  const out: AgentEvent[] = []
  let sawToolResult = false

  blocks.forEach((block, index) => {
    if (str(block.type) !== 'tool_result') return
    sawToolResult = true
    const toolUseId = str(block.tool_use_id) ?? str(block.toolUseID)
    // §3.3 (inherited measurement): the overwhelming majority of Qoder user
    // records are tool_result carriers, not user turns — mapping them to
    // `message.user` would inflate turn counts ~18x.
    const ref = s.state.toolCall(toolUseId)
    const isError = bool(block.is_error)
    const resultText = toolResultText(block)
    out.push(
      event(s, {
        type: 'tool.result',
        discriminator: `tool-result:${toolUseId ?? index}`,
        capability: ref?.capability ?? null,
        parentEventId: ref?.eventId ?? null,
        status: isError ? 'error' : 'ok',
        errorFingerprint: isError ? deriveErrorFingerprint(truncate(resultText ?? '', 512)) : null,
        requestId: null,
        payload: resultText ? { kind: 'tool_output', role: 'user', text: truncate(resultText, 64 * 1024) } : null,
        metadata: { tool_use_id: toolUseId, is_error: isError || null, prompt_id: str(s.rec.promptId) },
      }),
    )
  })

  const sidechainEnd = sidechainClose(s)
  if (sidechainEnd) out.push(sidechainEnd)

  if (sawToolResult) return out

  const text = contentText(s.rec)
  const hasImage = blocks.some((b) => str(b.type) === 'image')
  out.push(
    event(s, {
      type: 'message.user',
      discriminator: 'role:user',
      subtype: hasImage ? 'with-image' : null,
      payload: text ? { kind: 'user_message', role: 'user', text: truncate(text, 64 * 1024) } : null,
      metadata: {
        prompt_id: str(s.rec.promptId),
        has_image: hasImage || null,
        content_shape: typeof messageOf(s.rec)?.content === 'string' ? 'string' : blocks.map((b) => str(b.type) ?? '?').join('+'),
      },
    }),
  )
  return out
}

function toolResultText(block: UnknownRecord): string | null {
  const content = block.content
  if (typeof content === 'string') return content
  const parts = arr(content)
    .map((b) => (str(b.type) === 'text' ? str(b.text) : null))
    .filter((t): t is string => t !== null)
  return parts.length > 0 ? parts.join('\n') : null
}

/** The fork keeps Claude's `toolUseResult.agentId` close for subagent chains. */
function sidechainClose(s: Scope): AgentEvent | null {
  const result = asRecord(s.rec.toolUseResult)
  if (!result) return null
  const agentId = str(result.agentId) ?? str(result.agent_id)
  if (!agentId) return null
  const parent = s.parentToolUseId ? s.state.toolCall(s.parentToolUseId) : undefined
  return event(s, {
    type: 'subagent.end',
    discriminator: `subagent-end:${agentId}`,
    capability: { type: 'subagent', name: agentId, provider: 'agent' },
    parentEventId: parent?.eventId ?? null,
    status: bool(result.isError) || bool(result.is_error) ? 'error' : 'ok',
    metadata: { agent_id: agentId, parent_link: parent ? 'native-fk' : null },
  })
}

/** §18: Qoder carries a real `parent_tool_use_id` FK — no nearest-preceding heuristic needed. */
function subagentStart(s: Scope): AgentEvent[] {
  const agentId = s.agentId
  if (agentId === null || !s.state.markSidechainOpen(s.sessionId, agentId)) return []
  const parent = s.parentToolUseId ? s.state.toolCall(s.parentToolUseId) : undefined
  return [
    event(s, {
      type: 'subagent.start',
      discriminator: `subagent-start:${agentId}`,
      capability: { type: 'subagent', name: agentId, provider: 'agent' },
      parentEventId: parent?.eventId ?? null,
      requestId: null,
      metadata: { host_metadata: true, agent_id: agentId, parent_link: parent ? 'native-fk' : null },
    }),
  ]
}

// ---------------------------------------------------------------- attachment

function fromAttachment(s: Scope): AgentEvent[] {
  const att = attachmentOf(s.rec)
  if (!att) return [fromUnknown(s, 'attachment', { reason: 'attachment record without an attachment object' })]
  const kind = str(att.type) ?? 'unknown'

  // §18 row 5: hook events exist in Qoder (probe-capabilities: 77 hook refs,
  // e.g. PostToolUse:Edit) with the fork's attachment shape.
  if (kind.startsWith('hook_')) return [hookFire(s, att, kind)]

  if (kind === 'invoked_skills') {
    const out: AgentEvent[] = []
    arr(att.skills).forEach((skill, i) => {
      const name = str(skill.name)
      if (name) out.push(...skillActivation(s, name, 'invoked_skills', null, null, i))
    })
    if (out.length > 0) return out
  }
  return [fromUnknown(s, `attachment:${kind}`, { fields: Object.keys(att).sort() })]
}

function hookFire(s: Scope, att: UnknownRecord, kind: string): AgentEvent {
  const hookName = str(att.hookName) ?? str(s.rec.hookName) ?? kind
  const hookEvent = str(att.hookEvent) ?? str(s.rec.hookEvent) ?? null
  const exitCode = num(att.exitCode ?? s.rec.exitCode)
  const durationMs = num(att.durationMs ?? s.rec.durationMs)
  const toolUseId = str(att.toolUseID) ?? str(att.tool_use_id) ?? str(s.rec.toolUseID)
  const ref = s.state.toolCall(toolUseId)
  return event(s, {
    type: 'hook.fire',
    discriminator: `hook:${hookName}`,
    subtype: kind,
    capability: { type: 'hook', name: hookName, provider: hookEvent },
    parentEventId: ref?.eventId ?? null,
    durationMs,
    status: exitCode === null ? 'unknown' : exitCode === 0 ? 'ok' : 'error',
    errorFingerprint: exitCode !== null && exitCode !== 0 ? deriveErrorFingerprint(`hook exit ${String(exitCode)} ${hookName}`) : null,
    metadata: {
      hook_event: hookEvent,
      exit_code: exitCode,
      tool_use_id: toolUseId,
      stderr_chars: str(att.stderr)?.length ?? null,
      stdout_chars: str(att.stdout)?.length ?? null,
    },
  })
}

function skillActivation(s: Scope, rawName: string, path: string, payload: PayloadDraft | null, parentEventId: string | null, index = 0): AgentEvent[] {
  const name = rawName.replace(/^\//, '')
  if (s.state.skillAlreadyActive(s.sessionId, name, s.rawSeq)) return []
  return [
    event(s, {
      type: 'skill.invoke',
      discriminator: `skill:${path}:${rawName}#${index}`,
      capability: { type: 'skill', name, provider: path },
      parentEventId,
      payload,
      metadata: { mapped: true, activation_path: path, skill_ref: rawName },
    }),
  ]
}

// ---------------------------------------------------------------- system

function fromSystem(s: Scope): AgentEvent[] {
  const subtype = str(s.rec.subtype) ?? 'system'
  switch (subtype) {
    case 'compact_boundary':
      return [
        event(s, {
          type: 'context.compact',
          subtype: 'compact_boundary',
          discriminator: 'compact_boundary',
          durationMs: durationOf(s.rec),
          metadata: { mapped: true, trigger: str(s.rec.trigger) ?? null, pre_tokens: num(s.rec.preTokens) },
        }),
      ]
    case 'api_error': {
      const message = str(s.rec.message) ?? str(s.rec.error) ?? contentText(s.rec) ?? 'api_error'
      return [
        event(s, {
          type: 'error',
          subtype: 'api_error',
          discriminator: 'api_error',
          status: 'error',
          errorFingerprint: deriveErrorFingerprint(message),
          metadata: { mapped: true, message: truncate(message, 512) },
        }),
      ]
    }
    case 'stop_hook_summary':
      return [
        event(s, {
          type: 'hook.fire',
          subtype: 'stop_hook_summary',
          discriminator: 'stop_hook_summary',
          capability: { type: 'hook', name: str(s.rec.hookName) ?? 'Stop', provider: 'Stop' },
          durationMs: durationOf(s.rec),
          metadata: { mapped: true, hook_count: num(s.rec.hookCount), summary: true },
        }),
      ]
    default:
      // An unseen system subtype is genuine drift: keep the redacted raw JSON (§5.3).
      return [fromUnknown(s, `system:${subtype}`, { fields: Object.keys(s.rec).sort() })]
  }
}

function durationOf(r: UnknownRecord): number | null {
  return num(r.durationMs) ?? num(r.duration_ms) ?? num(r.totalDurationMs) ?? num(asRecord(r.metadata)?.durationMs)
}

// ---------------------------------------------------------------- unknown

function fromUnknown(s: Scope, upstreamType: string | null, extra: Record<string, unknown>): AgentEvent {
  // §5.3: unmapped records are counted with their (redacted) raw JSON kept in
  // metadata — a number quietly shrinking is the fatal failure mode (§16).
  return event(s, {
    type: 'unknown',
    subtype: upstreamType,
    discriminator: `unknown:${upstreamType ?? 'none'}`,
    requestId: null,
    metadata: {
      upstream_type: upstreamType,
      ...extra,
      raw: extra.mapped === true ? undefined : redact(s.rec),
    },
  })
}
