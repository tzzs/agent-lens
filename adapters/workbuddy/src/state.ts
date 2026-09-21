/**
 * Per-source scan state. `normalize()` sees one record at a time, but two WorkBuddy
 * rules are cross-record:
 *  - a `function_call_result` names the `function_call` it answers only through `callId`,
 *    so the capability and `parent_event_id` come from the call seen earlier in the file;
 *  - 2 of the 52 measured records carry no `sessionId` and no `cwd`, so they inherit both
 *    from the enclosing trace (§4.1).
 *
 * Rescan safety (§4.2): a full rescan restarts at seq 1, so a non-increasing seq means
 * "this source is being replayed" and the state is rebuilt, which keeps a replay's
 * parent links and project inheritance identical to the first pass.
 */
import type { CapabilityRef } from '@agentlens/event-model'

export interface ToolCallRef {
  eventId: string
  capability: CapabilityRef | null
  name: string | null
}

export class ScanState {
  private lastSeq = 0
  private readonly toolCalls = new Map<string, ToolCallRef>()
  private readonly recordEvents = new Map<string, string>()
  private readonly sessionProjects = new Map<string, string>()
  private lastNativeSession: string | null = null

  observes(rawSeq: number): void {
    if (rawSeq <= this.lastSeq) this.reset()
    this.lastSeq = rawSeq
  }

  private reset(): void {
    this.toolCalls.clear()
    this.recordEvents.clear()
    this.sessionProjects.clear()
    this.lastNativeSession = null
  }

  noteToolCall(callId: string | null, ref: ToolCallRef): void {
    if (callId) this.toolCalls.set(callId, ref)
  }

  toolCall(callId: string | null | undefined): ToolCallRef | undefined {
    return callId ? this.toolCalls.get(callId) : undefined
  }

  /** The record-graph edge: a later record's `parentId` names an earlier record's `id`. */
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

  /** §4.1 tier 2: a sessionless record belongs to the session its trace is writing. */
  noteNativeSession(sessionId: string | null): void {
    if (sessionId) this.lastNativeSession = sessionId
  }

  nativeSession(): string | null {
    return this.lastNativeSession
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
