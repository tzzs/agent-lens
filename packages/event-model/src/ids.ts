import { createHash } from 'node:crypto'
import type { EventType } from './types.ts'

function digest(parts: (string | number | null | undefined)[]): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex')
}

/** §4.1 — `hash(agent_id + absolute_path)`. Inode changes re-key by path, history stays. */
export function deriveSourceId(agentId: string, absolutePath: string): string {
  return digest([agentId, absolutePath])
}

/** §4.1 — `hash(canonical_repo_root(cwd))`. */
export function deriveProjectId(canonicalRepoRoot: string): string {
  return digest(['project', canonicalRepoRoot])
}

/** §4.1 — native id namespaced by agent so two agents cannot collide on a UUID. */
export function deriveSessionId(agentId: string, nativeSessionId: string): string {
  return digest(['session', agentId, nativeSessionId])
}

/** §4.1 — fallback when the source carries no native session id. */
export function deriveSessionIdFromSource(sourceId: string, firstRecordUuid: string): string {
  return digest(['session-from-source', sourceId, firstRecordUuid])
}

/**
 * §4.1 — fingerprint = `hash(source_id + raw_seq + type + occurred_at + role/name)`.
 * Deterministic across rescans, so `INSERT OR IGNORE` replays are no-ops (§4.2).
 */
export function deriveEventId(input: {
  sourceId: string
  rawSeq: number
  type: EventType
  timestamp: number
  discriminator?: string | null
}): string {
  return digest([input.sourceId, input.rawSeq, input.type, input.timestamp, input.discriminator ?? ''])
}

/** §4.1 — error fingerprints collapse noisy messages into one class. */
export function deriveErrorFingerprint(message: string): string {
  const normalized = message
    .replace(/\d+/g, 'N')
    .replace(/0x[0-9a-f]+/gi, '0xADDR')
    .replace(/[\s.]+/g, ' ')
    .trim()
    .toLowerCase()
  return digest(['error', normalized])
}
