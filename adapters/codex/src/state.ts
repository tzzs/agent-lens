/**
 * Per-source scan state.
 *
 * WHY this exists at all (and why it differs from Claude Code's): one Codex rollout file is
 * ONE thread and its thread identity, `session_id`, `cwd`, `originator` and `dynamic_tools`
 * live ONLY in the first `session_meta` record (codex.md §2.2, 100% presence on that field
 * set). Every later record must inherit them, so a per-record pure function cannot resolve
 * them. `model` likewise lives in `turn_context`, not on the usage rows.
 *
 * Rescan safety (§4.2): a full rescan restarts at seq 1, so a non-increasing seq means
 * "this source is being replayed" — the thread context is rebuilt, not accumulated.
 */
import type { CapabilityRef } from '@agentlens/event-model'
import { arr, asRecord, num, str, type UnknownRecord } from './record.ts'

export interface ThreadContext {
  threadId: string | null
  nativeSessionId: string | null
  cwd: string | null
  originator: string | null
  modelProvider: string | null
  threadSource: string | null
  parentThreadId: string | null
  forkedFromId: string | null
  agentRole: string | null
  cliVersion: string | null
  model: string | null
  contextWindow: number | null
  /** Dynamic-tool name → namespace (`codex_app`, `plugin_management`, …). */
  dynamicTools: Map<string, string | null>
}

export interface ToolCallRef {
  eventId: string
  capability: CapabilityRef | null
  /** Event type the result should link to, so `tool.result` never claims a phantom tool. */
  type: string
}

function emptyThread(): ThreadContext {
  return {
    threadId: null,
    nativeSessionId: null,
    cwd: null,
    originator: null,
    modelProvider: null,
    threadSource: null,
    parentThreadId: null,
    forkedFromId: null,
    agentRole: null,
    cliVersion: null,
    model: null,
    contextWindow: null,
    dynamicTools: new Map(),
  }
}

export class ScanState {
  private lastSeq = 0
  private thread = emptyThread()
  private readonly toolCalls = new Map<string, ToolCallRef>()
  private readonly turnStarts = new Map<string, number>()
  private readonly unknownCounts = new Map<string, number>()

  observes(rawSeq: number): void {
    if (rawSeq <= this.lastSeq) this.reset()
    this.lastSeq = rawSeq
  }

  private reset(): void {
    this.thread = emptyThread()
    this.toolCalls.clear()
    this.turnStarts.clear()
    this.unknownCounts.clear()
  }

  /** The thread's inherited identity (thread id, session, cwd, host, model, tools). */
  threadCtx(): ThreadContext {
    return this.thread
  }

  /**
   * `session_meta` IS the thread's identity statement and appears exactly once per file
   * (codex.md §2.2, 100% field presence), so it rebuilds the context instead of merging:
   * a field it does not carry is genuinely absent, not "unchanged since the last thread".
   */
  noteSessionMeta(payload: UnknownRecord): void {
    const t = emptyThread()
    t.threadId = str(payload.id)
    t.nativeSessionId = str(payload.session_id)
    t.cwd = str(payload.cwd)
    t.originator = str(payload.originator)
    t.modelProvider = str(payload.model_provider)
    t.threadSource = str(payload.thread_source)
    t.parentThreadId = str(payload.parent_thread_id)
    t.forkedFromId = str(payload.forked_from_id)
    t.agentRole = str(payload.agent_role) ?? str(payload.agent_nickname)
    t.cliVersion = str(payload.cli_version)
    if (!t.cwd) t.cwd = str(asRecord(payload.git)?.root)
    for (const tool of arr(payload.dynamic_tools)) {
      const name = str(tool.name)
      if (!name) continue
      t.dynamicTools.set(name, str(tool.namespace) ?? str(tool.server) ?? str(tool.source) ?? null)
    }
    this.thread = t
  }

  /** `turn_context` carries the model for the turns that follow it. */
  noteTurnContext(payload: UnknownRecord): void {
    const model = str(payload.model)
    if (model) this.thread.model = model
    const cwd = str(payload.cwd)
    if (cwd) this.thread.cwd = cwd
    const window = num(payload.model_context_window)
    if (window !== null) this.thread.contextWindow = window
  }

  noteContextWindow(window: number | null): void {
    if (window !== null) this.thread.contextWindow = window
  }

  toolCall(callId: string | null | undefined): ToolCallRef | undefined {
    return callId ? this.toolCalls.get(callId) : undefined
  }

  noteToolCall(callId: string | null, ref: ToolCallRef): void {
    if (callId) this.toolCalls.set(callId, ref)
  }

  turnStartedAt(turnId: string | null | undefined): number | null {
    return turnId ? (this.turnStarts.get(turnId) ?? null) : null
  }

  noteTurnStarted(turnId: string | null | undefined, at: number): void {
    if (turnId) this.turnStarts.set(turnId, at)
  }

  /** §5.2 rule 1: unknown types are counted per source so "dropped" is visible in doctor. */
  noteUnknown(upstreamType: string): number {
    const next = (this.unknownCounts.get(upstreamType) ?? 0) + 1
    this.unknownCounts.set(upstreamType, next)
    return next
  }

  unknownTotals(): Record<string, number> {
    return Object.fromEntries(this.unknownCounts)
  }
}

const states = new Map<string, ScanState>()

export function stateFor(sourceId: string): ScanState {
  let s = states.get(sourceId)
  if (!s) {
    s = new ScanState()
    states.set(sourceId, s)
  }
  return s
}

export function forgetState(sourceId: string): void {
  states.delete(sourceId)
}
