import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, CapabilityType, EventStatus, EventType, UsageSource } from '@agentlens/event-model'

export type Row = Record<string, unknown>

/**
 * Snapshot of a whole table ordered by rowid: stable across replays because
 * INSERT OR IGNORE never rewrites or moves existing rows. Tests compare these
 * byte-for-byte (§15 M0 acceptance ①).
 */
export function dumpTable(db: DatabaseSync, table: string): Row[] {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  if (!exists) throw new Error(`unknown table: ${table}`)
  const rows = db.prepare(`SELECT rowid AS _rowid, * FROM "${table}" ORDER BY rowid`).all()
  return rows.map((r) => ({ ...r }) as Row)
}

/** Metric-layer rehydration; the content layer is joined separately by the collector. */
export function rowToEvent(row: Row): AgentEvent {
  const usage =
    row.input_tokens === null &&
    row.output_tokens === null &&
    row.cache_read_tokens === null &&
    row.cache_write_tokens === null &&
    row.reasoning_tokens === null
      ? null
      : {
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          cacheReadTokens: Number(row.cache_read_tokens ?? 0),
          cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
          reasoningTokens: Number(row.reasoning_tokens ?? 0),
        }
  const event: AgentEvent = {
    id: String(row.id),
    schemaVersion: Number(row.schema_version),
    agentId: String(row.agent_id),
    hostId: String(row.host_id ?? ''),
    sourceId: String(row.source_id),
    sessionId: String(row.session_id),
    projectId: String(row.project_id ?? ''),
    parentEventId: (row.parent_event_id as string | null) ?? null,
    requestId: (row.request_id as string | null) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    timestamp: Number(row.timestamp),
    ingestedAt: row.ingested_at === null ? undefined : Number(row.ingested_at),
    type: row.type as EventType,
    subtype: (row.subtype as string | null) ?? null,
    usage,
    usageSource: row.usage_source as UsageSource,
    costReported: (row.cost_reported as number | null) ?? null,
    costSource: (row.cost_source as AgentEvent['costSource']) ?? undefined,
    credits: (row.credits as number | null) ?? null,
    capability:
      row.capability_type === null
        ? null
        : {
            type: row.capability_type as CapabilityType,
            name: String(row.capability_name ?? ''),
            provider: (row.capability_provider as string | null) ?? null,
          },
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    status: row.status as EventStatus,
    errorFingerprint: (row.error_fingerprint as string | null) ?? null,
    rawSeq: Number(row.raw_seq),
    rawOffset: Number(row.raw_offset),
    payload: null,
    metadata: row.metadata === null ? null : (JSON.parse(String(row.metadata)) as Record<string, unknown>),
  }
  return event
}
