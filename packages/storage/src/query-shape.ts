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

/**
 * Metric-layer rehydration; the content layer is joined separately by the collector.
 *
 * `model` comes from the joined `models` columns rather than `model_rowid`, because that is the
 * only shape a caller can render: §12 found every exported row had an empty provider/model for
 * exactly this reason, and the same gap then showed up in both session timelines. A caller that
 * selects from `events` alone gets `null` and is saying "I did not join", not "this event had no
 * model" — `SESSION_EVENT_SQL` is the join that asks the question properly.
 */
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
    model:
      row.model_name === null || row.model_name === undefined
        ? null
        : {
            provider: String(row.model_provider ?? ''),
            name: String(row.model_name),
            tier: (row.model_tier as string | null) ?? null,
          },
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

/**
 * The one canonical event order (§14: nothing that lists events may reorder them).
 * Chronological timestamp is primary so a set whose events come from several sources still
 * reads like the log; `raw_seq` (per-source) breaks ties inside one source with NULLs last —
 * SQLite sorts NULL first, so the flag has to be written, not assumed — and `id` keeps the
 * whole thing deterministic. Its own export because `agl export` selects a store-wide set
 * rather than one session and cannot use the select below; a second hand-written `ORDER BY`
 * is exactly how the two came to disagree about rows with no `raw_seq`.
 */
export const CANONICAL_EVENT_ORDER = 'e.timestamp, e.raw_seq IS NULL, e.raw_seq, e.id'

/**
 * The canonical session-timeline select: the canonical order plus the `models` join that
 * `rowToEvent` needs to fill `model`. Exported because anything rendering a timeline must ask the
 * same question the same way — both `agl session <id>` and the Web timeline go through
 * `loadSessionEvents`, and a caller that hand-rolls `SELECT * FROM events` silently loses the
 * model (§12 hit that with `agl export`, §14 with the timelines).
 */
export const SESSION_EVENT_SQL = `
  SELECT e.*, m.provider AS model_provider, m.name AS model_name, m.tier AS model_tier
  FROM events e LEFT JOIN models m ON m.rowid = e.model_rowid
  WHERE e.session_id = ?
  ORDER BY ${CANONICAL_EVENT_ORDER}`

export function loadSessionEvents(db: DatabaseSync, sessionId: string): AgentEvent[] {
  const rows = db.prepare(SESSION_EVENT_SQL).all(sessionId) as Row[]
  return rows.map((r) => rowToEvent(r))
}
