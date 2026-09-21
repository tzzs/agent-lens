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

/** §4.1 tier 3's bucket width: a gap of this long opens a new session. */
export const SESSION_TIME_BUCKET_MS = 30 * 60 * 1000

/**
 * §4.1 tier 3 — the source has neither a native session id nor a record uuid.
 *
 * Bucketed on fixed 30-minute epochs rather than "gap since the previous record", because
 * a running counter is not reproducible: a scan resumed mid-file has no previous record, so
 * the same bytes would yield two different session ids and break §4.2's replay safety. The
 * accepted cost is that one record on each side of a boundary starts a second session.
 */
export function deriveSessionIdFromTimeBucket(
  sourceId: string,
  timestampMs: number,
  bucketMs: number = SESSION_TIME_BUCKET_MS,
): string {
  return digest(['session-from-bucket', sourceId, String(Math.floor(timestampMs / bucketMs))])
}

export interface SessionIdInput {
  agentId: string
  /** Tier 1: the record's native session id — or the hint that stands in for it. */
  nativeSessionId?: string | null
  sourceId: string
  /** Tier 2: the record's own uuid. */
  recordUuid?: string | null
  /** Tier 3: this record's timestamp, ms epoch. */
  timestampMs: number
}

/**
 * §4.1's three session-id tiers in one place, so no adapter can reorder or skip one.
 * Tiers 1 and 2 keep their original digests byte for byte: stored rows already carry them.
 */
export function resolveSessionId(input: SessionIdInput): string {
  if (input.nativeSessionId) return deriveSessionId(input.agentId, input.nativeSessionId)
  if (input.recordUuid) return deriveSessionIdFromSource(input.sourceId, input.recordUuid)
  return deriveSessionIdFromTimeBucket(input.sourceId, input.timestampMs)
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
