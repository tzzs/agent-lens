/**
 * §5.1 `normalize` — the Claude Code record → unified event mapping.
 * Every rule here is traceable to docs/research/claude-code.md; the two
 * measurement-forced distinctions (§1.5) are `host_id` from `entrypoint` and
 * `request_id` as the token dedupe group key.
 */
import {
  deriveErrorFingerprint,
  deriveEventId,
  deriveProjectId,
  deriveSessionId,
  deriveSessionIdFromSource,
  SCHEMA_VERSION,
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
  parseCommandName,
  parseMcpToolName,
  parseSkillBaseDir,
  redact,
  resolveHost,
  resolveRequestId,
  safeStringify,
  str,
  strList,
  timestampMs,
  toolInputText,
  truncate,
  usageIsZero,
  usageOf,
  type UnknownRecord,
  type UsageDraft,
} from './record.ts'
import { ScanState, stateFor } from './state.ts'

/**
 * §4.1 rule 5: `cwd` is absent on every host-metadata record (16,330 measured), so a
 * record without an attributable cwd is reported as unattributed rather than guessed —
 * the collector/sink keeps the session's already-known project instead.
 */
export const UNATTRIBUTED_PROJECT_ID = deriveProjectId('unattributed')

/** §5.3 whitelist: 13 host-metadata record types measured at 24.6% of all records. */
export const HOST_METADATA_TYPES: readonly string[] = [
  'bridge-session',
  'atis-latch',
  'custom-title',
  'pr-link',
  'queue-operation',
  'mode',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'permission-mode',
  'last-prompt',
  'frame-link',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'ai-title',
]

/** §5.3: these three carry session titles / PR linkage / mode trajectory the UI wants. */
const KEPT_METADATA_TYPES = new Set(['pr-link', 'custom-title', 'ai-title', 'mode'])

const SUBAGENT_ENTRY_TOOLS = new Set(['Agent', 'Task'])

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
  ctx: NormalizeCtx
  state: ScanState
  hostId: string
  /** Session key used for state; native id when present (§2.1 every record carries one). */
  sessionKey: string
  sessionId: string
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
    // §5.2 rule 1: suppression must stay visible — a skill activation deduped
    // against another path degrades to a counted record instead of vanishing.
    events = [fromUnknown(scope, upstreamType ?? 'unknown', true, { suppressed: 'duplicate-skill-activation' })]
  }
  return { events }
}

/** §5.3: a non-string `type` is drift evidence too, so it is kept as text rather than lost. */
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
  if (upstreamType !== null && HOST_METADATA_TYPES.includes(upstreamType)) return fromHostMetadata(s, upstreamType)
  // No `type` + a session/display field ⇒ a ~/.claude/history.jsonl coverage record.
  if (upstreamType === null && (str(s.rec.display) !== null || s.rec.sessionId !== undefined)) return [fromHistory(s)]
  return [fromUnknown(s, upstreamType, /* mapped */ false)]
}

/**
 * §2.3: side chains are attributed to the nearest preceding `Agent`/`Task` call in the
 * same session; there is no foreign key upstream, so `parent_event_id` may stay NULL.
 * The chain keeps its own requestId/usage, so its cost is attributable on its own.
 */
function subagentStart(s: Scope): AgentEvent[] {
  const agentId = s.agentId
  if (agentId === null) return []
  const startEventId = deriveEventId({
    sourceId: s.ctx.source.id,
    rawSeq: s.rawSeq,
    type: 'subagent.start',
    timestamp: s.timestamp,
    discriminator: `subagent-start:${agentId}`,
  })
  const link = s.state.linkSidechain(s.sessionId, agentId, startEventId, {
    timestamp: s.timestamp,
    rawSeq: s.rawSeq,
  })
  if (!link.firstSeen) return []
  return [
    event(s, {
      type: 'subagent.start',
      discriminator: `subagent-start:${agentId}`,
      capability: { type: 'subagent', name: link.subagentType ?? agentId, provider: link.subagentType ? 'Agent' : 'agent' },
      parentEventId: link.parentEventId,
      metadata: { mapped: true, agent_id: agentId, parent_heuristic: true, parent_matched: link.parentEventId !== null },
    }),
  ]
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
  const sessionKey = nativeSession ?? hint ?? ''
  const uuid = str(rec.uuid)
  const sessionId = sessionKey
    ? deriveSessionId(AGENT_ID, sessionKey)
    : deriveSessionIdFromSource(ctx.source.id, uuid ?? `seq-${record.seq}`)
  const cwd = str(rec.cwd)
  const resolved = ctx.resolveProject(cwd)
  const diagnostics: string[] = diagnostic ? [diagnostic] : []

  return {
    rec,
    ctx,
    state,
    hostId,
    sessionKey: sessionId,
    sessionId,
    projectId: resolved ?? UNATTRIBUTED_PROJECT_ID,
    projectSource: resolved ? 'cwd' : 'unattributed',
    requestId: resolveRequestId(rec, nativeSession),
    timestamp: timestampMs(rec, record.occurredAt || ctx.now()),
    rawSeq: record.seq,
    rawOffset: record.offset,
    model: modelRef(modelOf(rec)),
    modelName: modelOf(rec),
    diagnostics,
    isSidechain: bool(rec.isSidechain),
    agentId: str(rec.agentId),
  }
}

function event(s: Scope, init: EventInit): AgentEvent {
  const usage = init.usage ?? null
  const metadata: Record<string, unknown> = { ...(init.metadata ?? {}) }
  if (s.diagnostics.length > 0) metadata.host_diagnostics = s.diagnostics.slice()
  if (s.projectSource === 'unattributed') metadata.project_unattributed = true
  if (s.isSidechain && s.agentId) metadata.agent_id = s.agentId
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

function usageFrom(d: UsageDraft | null): Usage | null {
  if (!d) return null
  return {
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheWriteTokens: d.cacheWriteTokens,
    reasoningTokens: d.reasoningTokens,
  }
}

/** §3.1: `request_id` rides every event of the response so the group is complete. */
function requestIdFor(s: Scope): string | null {
  return s.requestId
}

// ---------------------------------------------------------------- assistant

function fromAssistant(s: Scope): AgentEvent[] {
  const message = messageOf(s.rec)
  const draft = usageOf(s.rec)

  // §4.4 row 6: `<synthetic>` is a placeholder (~1 per file, all token fields 0).
  // Billing it would add a ghost call to every session, so it is a diagnostic only.
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
        errorFingerprint: deriveErrorFingerprint('claude-code synthetic placeholder response'),
        metadata: {
          reason: 'model=<synthetic>',
          usage_present: draft !== null,
          usage_zero: draft ? usageIsZero(draft) : null,
          message_keys: message ? Object.keys(message).sort() : [],
        },
      }),
    ]
  }

  const blocks = contentBlocks(s.rec)
  const text = contentText(s.rec)
  const usage = usageFrom(draft)
  const thinkingChars = blocks
    .filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
    .reduce((sum, b) => sum + (str(b.thinking)?.length ?? str(b.data)?.length ?? 0), 0)

  const primary = event(s, {
    // §3.1: a record carrying usage is the request's generation; one of them wins
    // the dedupe group, and the query layer's MAX makes duplicates harmless.
    type: usage ? 'generation.end' : 'message.assistant',
    discriminator: 'role:assistant',
    subtype: usage ? null : 'assistant-without-usage',
    usage,
    usageSource: usage ? 'reported' : 'missing',
    requestId: requestIdFor(s),
    status: str(message?.stop_reason) === 'error' ? 'error' : 'ok',
    payload: text ? { kind: 'assistant_message', role: 'assistant', text: truncate(text, 64 * 1024) } : null,
    metadata: {
      block_types: blocks.map((b) => str(b.type) ?? '?'),
      api_block_index: num(s.rec.apiBlockIndex),
      message_id: str(message?.id),
      stop_reason: str(message?.stop_reason),
      thinking_chars: thinkingChars || null,
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

/** `tool_use` plus the `<function>`-shaped block variants seen across 2.1.x (§5.3). */
const TOOL_USE_BLOCK_KINDS = new Set(['tool_use', 'function', 'function_call', 'tool_function', 'server_tool_use'])

function fromAssistantBlock(s: Scope, block: UnknownRecord, kind: string, index: number, parentEventId: string): AgentEvent[] {
  if (!TOOL_USE_BLOCK_KINDS.has(kind)) {
    return [fromUnknown(s, `assistant-block:${kind}`, true, { block_index: index })]
  }
  const name = str(block.name) ?? 'unknown'
  const toolUseId = str(block.id)
  const input = asRecord(block.input)
  const payload: PayloadDraft | null =
    block.input === undefined || block.input === null
      ? null
      : { kind: 'tool_input', role: 'assistant', text: toolInputText(block.input) }

  if (name === 'Skill') {
    // §2.4 path 1: the `Skill` tool is only 15/68,314 records — it is one path, not the rule.
    const raw = str(input?.skill) ?? str(input?.command) ?? firstKey(input)
    return skillActivation(s, raw ?? 'unknown', 'skill-tool', raw ?? null, payload, parentEventId, index)
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
        requestId: requestIdFor(s),
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
    requestId: requestIdFor(s),
    parentEventId,
    payload,
    metadata: isSubagentEntry
      ? { tool_name: name, tool_use_id: toolUseId, description: str(input?.description) }
      : { tool_name: name, tool_use_id: toolUseId },
  })
  s.state.noteToolCall(toolUseId ?? `${parentEventId}#${index}`, { eventId: toolEvent.id, capability })
  if (isSubagentEntry) {
    s.state.noteAgentEntry(s.sessionId, {
      eventId: toolEvent.id,
      toolUseId,
      subagentType: str(input?.subagent_type),
      timestamp: s.timestamp,
      rawSeq: s.rawSeq,
    })
  }
  return [toolEvent]
}

function firstKey(input: UnknownRecord | null): string | null {
  if (!input) return null
  return Object.keys(input)[0] ?? null
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
    // §2.7: 93.2% of user records are tool results, not user turns.
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
  const commandName = text === null ? null : parseCommandName(text)
  if (commandName) {
    // §2.4 paths 3+4: a `<command-name>` turn is either a skill activation or a slash command.
    return isSkillCommand(s, commandName)
      ? skillActivation(s, commandName, 'command-name', null, null, null)
      : [
          event(s, {
            type: 'command.execute',
            discriminator: `command:${commandName}`,
            capability: { type: 'command', name: commandName, provider: 'command-name' },
            metadata: { prompt_id: str(s.rec.promptId), text_chars: text?.length ?? 0 },
          }),
        ]
  }

  if (text !== null && text.includes('<local-command')) {
    return [
      event(s, {
        type: 'command.execute',
        discriminator: 'local-command',
        capability: { type: 'command', name: str(s.rec.commandName) ?? 'local-command', provider: 'local-command' },
        payload: { kind: 'user_message', role: 'user', text: truncate(text, 8 * 1024) },
      }),
    ]
  }

  const skillDir = bool(s.rec.isMeta) && text !== null ? parseSkillBaseDir(text) : null
  if (skillDir) {
    return skillActivation(s, skillNameFromPath(skillDir), 'meta-injection', skillDir, null, null)
  }

  const hasImage = blocks.some((b) => str(b.type) === 'image')
  return [
    event(s, {
      type: 'message.user',
      discriminator: 'role:user',
      subtype: hasImage ? 'with-image' : bool(s.rec.isMeta) ? 'meta-injection' : null,
      capability: null,
      payload: text ? { kind: 'user_message', role: 'user', text: truncate(text, 64 * 1024) } : null,
      metadata: {
        prompt_id: str(s.rec.promptId),
        is_meta: bool(s.rec.isMeta) || null,
        has_image: hasImage || null,
        content_shape: typeof messageOf(s.rec)?.content === 'string' ? 'string' : blocks.map((b) => str(b.type) ?? '?').join('+'),
      },
    }),
  ]
}

function toolResultText(block: UnknownRecord): string | null {
  const content = block.content
  if (typeof content === 'string') return content
  const parts = arr(content)
    .map((b) => (str(b.type) === 'text' ? str(b.text) : null))
    .filter((t): t is string => t !== null)
  return parts.length > 0 ? parts.join('\n') : null
}

/** §2.3: the `Agent`/`Task` result carries `agentId`, which closes that side chain. */
function sidechainClose(s: Scope): AgentEvent | null {
  const result = asRecord(s.rec.toolUseResult)
  if (!result) return null
  const agentId = str(result.agentId) ?? str(result.agent_id)
  if (!agentId) return null
  const link = s.state.sidechain(s.sessionId, agentId)
  return event(s, {
    type: 'subagent.end',
    discriminator: `subagent-end:${agentId}`,
    capability: { type: 'subagent', name: link?.subagentType ?? agentId, provider: link?.subagentType ? 'Agent' : 'agent' },
    parentEventId: link?.parentEventId ?? null,
    status: bool(result.isError) || bool(result.is_error) ? 'error' : 'ok',
    metadata: { agent_id: agentId, linked_parent: link?.parentEventId ?? null, parent_heuristic: true },
  })
}

function skillNameFromPath(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const last = clean.split('/').pop() ?? clean
  return last.replace(/^SKILL$/, 'skill') || clean
}

function isSkillCommand(s: Scope, commandName: string): boolean {
  // Namespaced commands (`/apple-design:apple-design`) are plugin/user skills; built-ins
  // (`/model`, `/compact`, `/init`) are not, unless the store named them in a listing.
  const bare = bareSkillName(commandName)
  return commandName.includes(':') || s.state.knowsSkill(s.sessionId, bare) || s.state.knowsSkill('*', bare)
}

function bareSkillName(name: string): string {
  const trimmed = name.replace(/^\//, '')
  const parts = trimmed.split(':')
  return parts.length > 1 ? (parts[parts.length - 1] ?? trimmed) : trimmed
}

function skillNamespace(name: string): string | null {
  const trimmed = name.replace(/^\//, '')
  const i = trimmed.lastIndexOf(':')
  return i > 0 ? trimmed.slice(0, i) : null
}

type SkillPath = 'skill-tool' | 'invoked_skills' | 'meta-injection' | 'command-name'

function skillActivation(
  s: Scope,
  rawName: string,
  path: SkillPath,
  sourceRef: string | null,
  payload: PayloadDraft | null,
  parentEventId: string | null,
  index = 0,
): AgentEvent[] {
  const name = bareSkillName(rawName)
  if (s.state.skillAlreadyActive(s.sessionId, name, s.rawSeq)) return []
  s.state.noteSkillName(s.sessionId, name)
  return [
    event(s, {
      type: 'skill.invoke',
      discriminator: `skill:${path}:${rawName}#${index}`,
      capability: { type: 'skill', name, provider: path },
      parentEventId,
      payload,
      metadata: {
        mapped: true,
        activation_path: path,
        skill_ref: rawName,
        skill_path: sourceRef,
        namespace: skillNamespace(rawName) ?? skillNamespace(sourceRef ?? ''),
      },
    }),
  ]
}

// ---------------------------------------------------------------- attachment

function fromAttachment(s: Scope): AgentEvent[] {
  const att = attachmentOf(s.rec)
  if (!att) return [fromUnknown(s, 'attachment', true, { reason: 'attachment record without an attachment object' })]
  const kind = str(att.type) ?? 'unknown'

  if (kind.startsWith('hook_')) return [hookFire(s, att, kind)]

  switch (kind) {
    case 'invoked_skills': {
      const skills = arr(att.skills)
      const out: AgentEvent[] = []
      skills.forEach((skill, i) => {
        const name = str(skill.name)
        if (!name) return
        // §2.4: `path` ("userSettings:grill-with-docs") carries the skill's own provenance.
        out.push(...skillActivation(s, name, 'invoked_skills', str(skill.path), null, null, i))
      })
      if (out.length === 0) out.push(fromUnknown(s, `attachment:${kind}`, true, { reason: 'invoked_skills without a name' }))
      return out
    }
    case 'skill_listing': {
      const names = strList(att.names)
      s.state.noteSkillListing(names)
      return [
        fromUnknown(s, `attachment:${kind}`, true, {
          skill_count: num(att.skillCount),
          is_initial: bool(att.isInitial) || null,
          names: names.slice(0, 64),
        }),
      ]
    }
    case 'deferred_tools_delta':
      return [
        fromUnknown(s, `attachment:${kind}`, true, {
          pending_mcp_servers: strList(att.pendingMcpServers),
          needs_auth_mcp_servers: strList(att.needsAuthMcpServers),
          failed_mcp_servers: strList(att.failedMcpServers),
          added_names: strList(att.addedNames),
          removed_names: strList(att.removedNames),
        }),
      ]
    case 'total_tokens_reminder':
      return [
        fromUnknown(s, `attachment:${kind}`, true, {
          context_tokens: parseTokenCount(str(att.content) ?? str(att.text) ?? contentText(s.rec)),
        }),
      ]
    case 'remote_session_change':
      return [fromUnknown(s, `attachment:${kind}`, true, { url: str(att.url), commit: str(att.commit), pr: str(att.pr) })]
    default:
      // Known-by-name but content-bearing (prompt_snapshot, file, edited_text_file …) and
      // anything new: counted, redacted, never payloaded (§3.2 disk-blowup rule).
      return [fromUnknown(s, `attachment:${kind}`, true, { fields: Object.keys(att).sort() })]
  }
}

function parseTokenCount(text: string | null): number | null {
  if (!text) return null
  // §2.6: the reminder is prose, so both word orders appear upstream ("N tokens", "tokens: N of M").
  const match =
    /tokens\s*[:=]?\s*([\d][\d,.]*)/i.exec(text) ?? /([\d][\d,.]*)\s+tokens\b/i.exec(text)
  const raw = match?.[1]?.replace(/[.,]+$/, '')
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** §1.5-3 / §2.5: hooks are the largest capability class and the only duration source. */
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
    // §3.1: `toolUseID` is the real foreign key from a hook to the hooked tool call.
    parentEventId: ref?.eventId ?? null,
    durationMs,
    status: exitCode === null ? 'unknown' : exitCode === 0 ? 'ok' : 'error',
    errorFingerprint: exitCode !== null && exitCode !== 0 ? deriveErrorFingerprint(`hook exit ${String(exitCode)} ${hookName}`) : null,
    metadata: {
      hook_event: hookEvent,
      exit_code: exitCode,
      tool_use_id: toolUseId,
      command: str(att.command),
      stderr_chars: str(att.stderr)?.length ?? null,
      stdout_chars: str(att.stdout)?.length ?? null,
    },
  })
}

// ---------------------------------------------------------------- system

function fromSystem(s: Scope): AgentEvent[] {
  const subtype = str(s.rec.subtype) ?? 'system'
  switch (subtype) {
    // §3.3: the only real source of `context.compact` (16 measured).
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
    case 'turn_duration':
      return [
        event(s, {
          type: 'unknown',
          subtype: 'turn_duration',
          discriminator: 'turn_duration',
          durationMs: durationOf(s.rec),
          metadata: { mapped: true, reason: 'turn timing has no first-class event type (§3.3)' },
        }),
      ]
    case 'stop_hook_summary':
      return [
        event(s, {
          type: 'hook.fire',
          subtype: 'stop_hook_summary',
          discriminator: 'stop_hook_summary',
          capability: { type: 'hook', name: str(s.rec.hookName) ?? 'Stop', provider: 'Stop' },
          durationMs: durationOf(s.rec),
          status: num(s.rec.exitCode) === null || num(s.rec.exitCode) === 0 ? 'ok' : 'error',
          metadata: { mapped: true, hook_count: num(s.rec.hookCount), summary: true },
        }),
      ]
    case 'local_command':
      return [
        event(s, {
          type: 'command.execute',
          subtype: 'local_command',
          discriminator: 'local_command',
          capability: { type: 'command', name: str(s.rec.command) ?? 'local-command', provider: 'system' },
          metadata: { mapped: true },
        }),
      ]
    default:
      return [fromUnknown(s, `system:${subtype}`, true, { fields: Object.keys(s.rec).sort() })]
  }
}

function durationOf(rec: UnknownRecord): number | null {
  return num(rec.durationMs) ?? num(rec.duration_ms) ?? num(rec.totalDurationMs) ?? num(asRecord(rec.metadata)?.durationMs)
}

// ---------------------------------------------------------------- metadata / unknown / history

function fromHostMetadata(s: Scope, upstreamType: string): AgentEvent[] {
  const kept = KEPT_METADATA_TYPES.has(upstreamType)
  const value = kept
    ? {
        title: str(s.rec.title) ?? str(s.rec.customTitle) ?? str(s.rec.aiTitle),
        pr_number: num(s.rec.prNumber) ?? num(s.rec.pr),
        pr_url: str(s.rec.prUrl) ?? str(s.rec.url) ?? str(s.rec.link),
        mode: str(s.rec.mode) ?? str(s.rec.permissionMode),
        agent_name: str(s.rec.agentName) ?? str(s.rec.name),
      }
    : { fields: Object.keys(s.rec).sort() }
  return [
    event(s, {
      // §5.3: host metadata has no first-class enum slot; keeping it as a counted
      // `unknown` with a subtype preserves titles / PR links without inventing types.
      type: 'unknown',
      subtype: upstreamType,
      discriminator: `metadata:${upstreamType}`,
      metadata: {
        mapped: true,
        session_scoped: kept || undefined,
        upstream_type: upstreamType,
        value: pruneNulls(value),
        raw: kept ? undefined : redact(s.rec),
      },
    }),
  ]
}

function fromUnknown(s: Scope, upstreamType: string | null, mapped: boolean, extra?: Record<string, unknown>): AgentEvent {
  return event(s, {
    type: 'unknown',
    subtype: upstreamType,
    discriminator: `unknown:${upstreamType ?? 'none'}:${s.rawSeq}`,
    metadata: {
      mapped,
      upstream_type: upstreamType,
      ...(extra ?? {}),
      raw: mapped ? undefined : redact(s.rec),
    },
  })
}

/**
 * `~/.claude/history.jsonl` (§4.4 row 4): `{display, timestamp, project, sessionId}`.
 * It proves a session existed after upstream deleted its file, so it lands as a
 * session-scoped marker rather than a user turn (which would double-count).
 */
function fromHistory(s: Scope): AgentEvent {
  const display = str(s.rec.display)
  const native = str(s.rec.sessionId)
  const firstForSession = native !== null && s.state.markOnce(`history:${native}`)
  const projectField = str(s.rec.project)
  return event(s, {
    type: 'session.start',
    subtype: 'history-entry',
    discriminator: `history:${native ?? s.rawSeq}`,
    status: 'ok',
    requestId: null,
    payload: firstForSession && display ? { kind: 'user_message', role: 'user', text: truncate(display, 8 * 1024) } : null,
    metadata: {
      mapped: true,
      coverage_recovery: true,
      project_hint: projectField,
      first_input_recovered: firstForSession || null,
      display_chars: display?.length ?? 0,
      pasted_contents: asRecord(s.rec.pastedContents) ? Object.keys(s.rec.pastedContents as object).length : 0,
    },
  })
}

function pruneNulls<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v
  return out as T
}
