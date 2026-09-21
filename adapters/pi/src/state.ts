/**
 * Per-source scan state. `normalize()` sees one record at a time, but three Pi rules
 * are cross-record (docs/research/pi.md §二):
 *  - only the `session` header (line 1) carries the native session id AND the `cwd`,
 *    so every later record inherits both from it;
 *  - a `toolResult` names the `toolCall` it answers only through `toolCallId`, so the
 *    `parent_event_id` comes from the call seen earlier in the file;
 *  - a later record's `parentId` names an earlier record's `id` (the message tree).
 *
 * Rescan safety (§4.2): a full rescan restarts at seq 1, so a non-increasing seq means
 * "this source is being replayed" and the state is rebuilt, which keeps a replay's
 * links and inheritance identical to the first pass.
 */
import type { CapabilityRef } from '@agentlens/event-model'

export interface ToolCallRef {
  eventId: string
  capability: CapabilityRef
  name: string
}

export class ScanState {
  private lastSeq = 0
  private readonly toolCalls = new Map<string, ToolCallRef>()
  private readonly recordEvents = new Map<string, string>()
  private readonly sessionProjects = new Map<string, string>()
  private headerNative: string | null = null
  private headerCwd: string | null = null

  observes(rawSeq: number): void {
    if (rawSeq <= this.lastSeq) this.reset()
    this.lastSeq = rawSeq
  }

  private reset(): void {
    this.toolCalls.clear()
    this.recordEvents.clear()
    this.sessionProjects.clear()
    this.headerNative = null
    this.headerCwd = null
  }

  /** The `session` header was seen: it owns the native id and the project cwd (§二.1). */
  noteHeader(nativeSessionId: string | null, cwd: string | null): void {
    if (nativeSessionId && !this.headerNative) this.headerNative = nativeSessionId
    if (cwd && !this.headerCwd) this.headerCwd = cwd
  }

  headerSession(): string | null {
    return this.headerNative
  }

  headerCwdPath(): string | null {
    return this.headerCwd
  }

  noteToolCall(callId: string | null, ref: ToolCallRef): void {
    if (callId) this.toolCalls.set(callId, ref)
  }

  toolCall(callId: string | null | undefined): ToolCallRef | undefined {
    return callId ? this.toolCalls.get(callId) : undefined
  }

  noteRecord(recordId: string, eventId: string): void {
    if (!this.recordEvents.has(recordId)) this.recordEvents.set(recordId, eventId)
  }

  recordEvent(recordId: string | null | undefined): string | undefined {
    return recordId ? this.recordEvents.get(recordId) : undefined
  }

  noteSessionProject(sessionId: string, projectId: string): void {
    if (!this.sessionProjects.has(sessionId)) this.sessionProjects.set(sessionId, projectId)
  }

  sessionProject(sessionId: string): string | undefined {
    return this.sessionProjects.get(sessionId)
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
