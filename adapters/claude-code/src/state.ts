/**
 * Per-source scan state. `normalize()` receives one record at a time, but several
 * rules are cross-record (§2.3 subagent parent linkage, §2.4 four skill-activation
 * paths describing one activation), so they live here.
 *
 * Rescan safety (§4.2): a full rescan restarts at seq 1, so a non-increasing seq
 * means "this source is being replayed" — the state is rebuilt rather than
 * accumulating activations across scans.
 */
import type { CapabilityRef } from '@agentlens/event-model'

export interface AgentEntryCall {
  /** Event id of the `Agent`/`Task` tool call — the candidate `parent_event_id`. */
  eventId: string
  toolUseId: string | null
  subagentType: string | null
  timestamp: number
  rawSeq: number
}

export interface SidechainLink {
  firstSeen: boolean
  startEventId: string
  parentEventId: string | null
  subagentType: string | null
}

export interface ToolCallRef {
  eventId: string
  capability: CapabilityRef | null
}

/** Two activation paths describing one activation land within a few records of each other. */
const SKILL_DEDUPE_WINDOW = 25

export class ScanState {
  private lastSeq = 0
  private readonly skillActivations = new Map<string, number>()
  private readonly knownSkills = new Set<string>()
  private readonly skillListingNames = new Set<string>()
  private readonly toolCalls = new Map<string, ToolCallRef>()
  private readonly agentEntries = new Map<string, AgentEntryCall[]>()
  private readonly sidechains = new Map<string, SidechainLink>()
  private readonly onceKeys = new Set<string>()

  observes(rawSeq: number): void {
    if (rawSeq <= this.lastSeq) this.reset()
    this.lastSeq = rawSeq
  }

  private reset(): void {
    this.skillActivations.clear()
    this.knownSkills.clear()
    this.skillListingNames.clear()
    this.toolCalls.clear()
    this.agentEntries.clear()
    this.sidechains.clear()
    this.onceKeys.clear()
  }

  /** §2.4: true when another activation path already produced this (session, skill). */
  skillAlreadyActive(sessionId: string, skillName: string, rawSeq: number): boolean {
    const key = `${sessionId}\u0000${skillName}`
    const prev = this.skillActivations.get(key)
    if (prev !== undefined && rawSeq - prev <= SKILL_DEDUPE_WINDOW) return true
    this.skillActivations.set(key, rawSeq)
    return false
  }

  noteSkillName(sessionId: string, skillName: string): void {
    this.knownSkills.add(`${sessionId}\u0000${skillName}`)
  }

  knowsSkill(sessionId: string, skillName: string): boolean {
    return this.knownSkills.has(`${sessionId}\u0000${skillName}`)
  }

  noteSkillListing(names: readonly string[]): void {
    for (const n of names) this.skillListingNames.add(n)
    for (const n of names) this.knownSkills.add(`*\u0000${n}`)
  }

  skillListing(): string[] {
    return [...this.skillListingNames].sort()
  }

  noteToolCall(toolUseId: string | null, ref: ToolCallRef): void {
    if (toolUseId) this.toolCalls.set(toolUseId, ref)
  }

  toolCall(toolUseId: string | null | undefined): ToolCallRef | undefined {
    return toolUseId ? this.toolCalls.get(toolUseId) : undefined
  }

  noteAgentEntry(sessionId: string, entry: AgentEntryCall): void {
    const list = this.agentEntries.get(sessionId)
    if (list) list.push(entry)
    else this.agentEntries.set(sessionId, [entry])
  }

  /**
   * §2.3: side chains carry no agentId <-> tool_use.id foreign key, so the parent
   * is the nearest preceding `Agent`/`Task` call in the same session; NULL is legal.
   */
  linkSidechain(
    sessionId: string,
    agentId: string,
    startEventId: string,
    at: { timestamp: number; rawSeq: number },
  ): SidechainLink {
    const key = `${sessionId}\u0000${agentId}`
    const existing = this.sidechains.get(key)
    if (existing) return { ...existing, firstSeen: false }
    const candidates = this.agentEntries.get(sessionId) ?? []
    let best: AgentEntryCall | null = null
    for (const e of candidates) {
      if (e.rawSeq > at.rawSeq || e.timestamp > at.timestamp) continue
      if (!best || e.rawSeq > best.rawSeq) best = e
    }
    const link: SidechainLink = {
      firstSeen: true,
      startEventId,
      parentEventId: best ? best.eventId : null,
      subagentType: best ? best.subagentType : null,
    }
    this.sidechains.set(key, link)
    return link
  }

  sidechain(sessionId: string, agentId: string): SidechainLink | undefined {
    return this.sidechains.get(`${sessionId}\u0000${agentId}`)
  }

  /** First call for a key returns true; used to keep one recovered input per session. */
  markOnce(key: string): boolean {
    if (this.onceKeys.has(key)) return false
    this.onceKeys.add(key)
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
