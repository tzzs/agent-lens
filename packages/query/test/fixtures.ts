import { createHash } from 'node:crypto'
import type { AgentEvent } from '@agentlens/event-model'

/** Deterministic event factory: ids derive from the seed so merge order is stable. */
export function hexSeed(overrides: Partial<AgentEvent> = {}, seed = ''): AgentEvent {
  const id = createHash('sha256').update(seed).digest('hex')
  return {
    id,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-' + id.slice(0, 8),
    sessionId: 'sess-' + id.slice(0, 8),
    projectId: 'proj-' + id.slice(0, 8),
    timestamp: 1_750_000_000_000,
    type: 'generation.end',
    usageSource: overrides.usage ? 'reported' : 'missing',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...overrides,
  }
}
