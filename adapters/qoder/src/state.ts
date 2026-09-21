/**
 * Per-source scan state. `normalize()` sees one record at a time, but tool
 * results, hook events and subagent starts must attach to the earlier
 * `tool_use` event, so those references are remembered here.
 *
 * Rescan safety (§4.2): a full rescan restarts at seq 1, so a non-increasing
 * seq means "this source is being replayed" — the state is rebuilt rather than
 * accumulating references across scans.
 */
import type { CapabilityRef } from '@agentlens/event-model'

export interface ToolCallRef {
  eventId: string
  capability: CapabilityRef | null
}

/** Two activation paths describing one skill activation land within a few records. */
const SKILL_DEDUPE_WINDOW = 25

export class ScanState {
  private lastSeq = 0
  private readonly toolCalls = new Map<string, ToolCallRef>()
  private readonly skillActivations = new Map<string, number>()
  private readonly sidechains = new Map<string, string>()

  observes(rawSeq: number): void {
    if (rawSeq <= this.lastSeq) this.reset()
    this.lastSeq = rawSeq
  }

  private reset(): void {
    this.toolCalls.clear()
    this.skillActivations.clear()
    this.sidechains.clear()
  }

  noteToolCall(toolUseId: string | null, ref: ToolCallRef): void {
    if (toolUseId) this.toolCalls.set(toolUseId, ref)
  }

  toolCall(toolUseId: string | null | undefined): ToolCallRef | undefined {
    return toolUseId ? this.toolCalls.get(toolUseId) : undefined
  }

  /** True when this (session, skill) was already activated within the dedupe window. */
  skillAlreadyActive(sessionId: string, skillName: string, rawSeq: number): boolean {
    const key = `${sessionId}\u0000${skillName}`
    const prev = this.skillActivations.get(key)
    if (prev !== undefined && rawSeq - prev <= SKILL_DEDUPE_WINDOW) return true
    this.skillActivations.set(key, rawSeq)
    return false
  }

  /** First call for (session, agentId) returns true — one `subagent.start` per chain. */
  markSidechainOpen(sessionId: string, agentId: string): boolean {
    const key = `${sessionId}\u0000${agentId}`
    if (this.sidechains.has(key)) return false
    this.sidechains.set(key, agentId)
    return true
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
