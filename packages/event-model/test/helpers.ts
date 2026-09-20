import type { AgentEvent, Usage } from '../src/types.ts'

export function hex64(seed: number): string {
  return seed.toString(16).padStart(64, '0')
}

export const VALID_ID = hex64(1)

export function usage(partial: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...partial,
  }
}

let counter = 1
export function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  const n = counter++
  return {
    id: hex64(n),
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: hex64(100),
    sessionId: hex64(200),
    projectId: hex64(300),
    timestamp: 1_750_000_000_000 + n,
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: n,
    rawOffset: n * 32,
    ...overrides,
  }
}
