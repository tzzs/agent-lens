import { deflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, ModelRef, ParseFailure } from '@agentlens/event-model'

/** §3.2 — content layer is off unless explicitly enabled (`--no-content` default). */
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024
/** §3.2 — payloads table-level retention. */
const DEFAULT_PAYLOAD_TTL_DAYS = 30

export interface SourceProgress {
  id: string
  agentId: string
  path: string
  kind: 'jsonl' | 'sqlite' | 'ndir'
  inode: number | null
  size: number | null
  mtimeMs: number | null
  lastOffset: number
  parserVersion: number | null
  sessionIdHint: string | null
  status: 'active' | 'gone' | 'error' | 'rotated'
  rowsIngested: number | null
  scanStartedAt: number | null
  scanFinishedAt: number | null
  lastError: string | null
}

export interface InsertOptions {
  contentEnabled?: boolean
  maxPayloadBytes?: number
  /**
   * Source watermark to commit alongside the batch. Applied as the FINAL statement
   * inside the same transaction — §4.2 forbids `last_offset` advancing unless the
   * events commit too. Omit when the collector drives the transaction itself.
   */
  progress?: SourceProgress
}

export interface PruneResult {
  payloadsDeleted: number
  eventsDeleted: number
}

/** node:sqlite refuses `undefined` binds; everything optional must pass through NULL. */
function nn<T>(v: T | null | undefined): T | null {
  return v ?? null
}

/** §4.2 — one transaction per batch; events INSERT OR IGNORE so replay is a no-op. */
export function insertEvents(
  db: DatabaseSync,
  events: readonly AgentEvent[],
  opts?: InsertOptions,
): { inserted: number } {
  return withTransaction(db, () => {
    const contentEnabled = opts?.contentEnabled ?? false
    const maxPayloadBytes = opts?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES

    const sessionIdentities = new Map<
      string,
      { agentId: string; hostId: string | null; projectId: string | null; sourceId: string | null; first: number | null; last: number | null }
    >()
    for (const ev of events) {
      const s = sessionIdentities.get(ev.sessionId)
      if (!s) {
        sessionIdentities.set(ev.sessionId, {
          agentId: ev.agentId,
          hostId: nn(ev.hostId),
          projectId: nn(ev.projectId),
          sourceId: nn(ev.sourceId),
          first: ev.timestamp ?? null,
          last: ev.timestamp ?? null,
        })
      } else {
        if (s.first === null || (ev.timestamp !== undefined && ev.timestamp < s.first)) s.first = ev.timestamp ?? null
        if (s.last === null || (ev.timestamp !== undefined && ev.timestamp > s.last)) s.last = ev.timestamp ?? null
        s.hostId ??= nn(ev.hostId)
        s.projectId ??= nn(ev.projectId)
        s.sourceId ??= nn(ev.sourceId)
      }
    }

    for (const ev of events) {
      db.prepare('INSERT OR IGNORE INTO agents (id) VALUES (?)').run(ev.agentId)
      if (ev.projectId) upsertProject(db, { id: ev.projectId })
      // FK placeholder: the collector owns real source rows (updateSourceProgress);
      // this only guarantees `events.source_id` resolves (§4.3).
      db.prepare(
        "INSERT OR IGNORE INTO sources (id, agent_id, kind, status) VALUES (?, ?, 'jsonl', 'active')",
      ).run(ev.sourceId, ev.agentId)
    }

    const upsertSession = db.prepare(`
      INSERT INTO sessions (id, agent_id, host_id, project_id, source_id, first_timestamp, last_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        host_id         = COALESCE(sessions.host_id, excluded.host_id),
        project_id      = COALESCE(sessions.project_id, excluded.project_id),
        source_id       = COALESCE(sessions.source_id, excluded.source_id),
        first_timestamp = COALESCE(min(sessions.first_timestamp, excluded.first_timestamp),
                                   sessions.first_timestamp, excluded.first_timestamp),
        last_timestamp  = COALESCE(max(sessions.last_timestamp, excluded.last_timestamp),
                                   sessions.last_timestamp, excluded.last_timestamp)
    `)
    for (const [id, s] of sessionIdentities) {
      upsertSession.run(id, s.agentId, s.hostId, s.projectId, s.sourceId, s.first, s.last)
    }

    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events (
        id, schema_version, agent_id, host_id, source_id, session_id, project_id,
        parent_event_id, request_id, timestamp, ingested_at, type, subtype,
        model_rowid, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, usage_source, capability_type, capability_name, capability_provider,
        duration_ms, status, error_fingerprint, raw_seq, raw_offset, content_ref, metadata
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    const insertPayload = db.prepare(`
      INSERT OR IGNORE INTO payloads (event_id, kind, role, text, bytes, truncated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    let inserted = 0
    for (const ev of events) {
      const modelRowid = ev.model ? upsertModel(db, ev.model) : null
      const payload = contentEnabled ? buildPayloadRow(ev, maxPayloadBytes) : null
      const { usage } = ev
      const res = insertEvent.run(
        ev.id,
        ev.schemaVersion,
        ev.agentId,
        ev.hostId,
        ev.sourceId,
        ev.sessionId,
        nn(ev.projectId),
        nn(ev.parentEventId),
        nn(ev.requestId),
        ev.timestamp,
        nn(ev.ingestedAt),
        ev.type,
        nn(ev.subtype),
        modelRowid,
        nn(usage?.inputTokens),
        nn(usage?.outputTokens),
        nn(usage?.cacheReadTokens),
        nn(usage?.cacheWriteTokens),
        nn(usage?.reasoningTokens),
        nn(ev.usageSource),
        nn(ev.capability?.type),
        nn(ev.capability?.name),
        nn(ev.capability?.provider),
        nn(ev.durationMs),
        nn(ev.status),
        nn(ev.errorFingerprint),
        nn(ev.rawSeq),
        nn(ev.rawOffset),
        payload ? payload.kind : null,
        ev.metadata === undefined || ev.metadata === null ? null : JSON.stringify(ev.metadata),
      )
      inserted += Number(res.changes)
      if (payload) {
        insertPayload.run(
          payload.eventId,
          payload.kind,
          payload.role,
          payload.blob,
          payload.bytes,
          payload.truncated,
          payload.createdAt,
        )
      }
    }

    // Recomputed (not incremented) so an INSERT-OR-IGNORE replay leaves the count identical.
    const recomputeCount = db.prepare(
      'UPDATE sessions SET event_count = (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.id) WHERE id = ?',
    )
    for (const id of sessionIdentities.keys()) recomputeCount.run(id)

    if (opts?.progress) updateSourceProgressTx(db, opts.progress)
    return { inserted }
  })
}

export interface ProjectUpsert {
  id: string
  canonicalRoot?: string | null
  displayName?: string | null
  source?: string | null
}

export function upsertProject(db: DatabaseSync, project: ProjectUpsert): void {
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO projects (id, canonical_root, display_name, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        canonical_root = COALESCE(excluded.canonical_root, projects.canonical_root),
        display_name   = COALESCE(excluded.display_name, projects.display_name),
        source         = COALESCE(excluded.source, projects.source)
    `).run(project.id, nn(project.canonicalRoot), nn(project.displayName), nn(project.source))
  })
}

/** models UNIQUE(provider,name,tier) treats NULL tier as distinct, so lookup precedes insert. */
export function upsertModel(db: DatabaseSync, ref: ModelRef): number {
  return lookupOrInsertModel(db, ref)
}

function lookupOrInsertModel(db: DatabaseSync, ref: ModelRef): number {
  const tier = nn(ref.tier)
  const found = db
    .prepare('SELECT rowid FROM models WHERE provider = ? AND name = ? AND tier IS ?')
    .get(ref.provider, ref.name, tier) as { rowid: number | bigint } | undefined
  if (found) return Number(found.rowid)
  const res = db
    .prepare('INSERT INTO models (provider, name, tier) VALUES (?, ?, ?)')
    .run(ref.provider, ref.name, tier)
  return Number(res.lastInsertRowid)
}

interface PreparedPayload {
  eventId: string
  kind: string
  role: string | null
  blob: Buffer
  bytes: number
  truncated: number
  createdAt: number
}

function buildPayloadRow(ev: AgentEvent, maxPayloadBytes: number): PreparedPayload | null {
  const p = ev.payload
  if (!p) return null
  let text = p.text
  let truncated = 0
  if (Buffer.byteLength(text, 'utf8') > maxPayloadBytes) {
    const slice = Buffer.from(text, 'utf8').subarray(0, maxPayloadBytes)
    // Non-fatal decode replaces a split codepoint; re-encoding keeps stored bytes
    // deterministic so a replay compresses to the identical BLOB.
    text = new TextDecoder('utf8').decode(slice)
    truncated = 1
  }
  const buf = Buffer.from(text, 'utf8')
  return {
    eventId: ev.id,
    kind: p.kind,
    role: nn(p.role),
    blob: deflateSync(buf),
    bytes: buf.length,
    truncated,
    createdAt: ev.ingestedAt ?? ev.timestamp,
  }
}

/**
 * Full source-row upsert. When called inside an open transaction (e.g. as
 * `InsertOptions.progress`) it is the LAST statement before COMMIT — §4.2 requires
 * `sources.last_offset` to advance only after the events are durable.
 */
export function updateSourceProgress(db: DatabaseSync, progress: SourceProgress): void {
  withTransaction(db, () => updateSourceProgressTx(db, progress))
}

function updateSourceProgressTx(db: DatabaseSync, p: SourceProgress): void {
  db.prepare('INSERT OR IGNORE INTO agents (id) VALUES (?)').run(p.agentId)
  db.prepare(`
    INSERT INTO sources (
      id, agent_id, path, kind, inode, size, mtime_ms, last_offset, parser_version,
      session_id_hint, status, last_error, scan_started_at, scan_finished_at, rows_ingested
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      agent_id        = excluded.agent_id,
      path            = excluded.path,
      kind            = excluded.kind,
      inode           = excluded.inode,
      size            = excluded.size,
      mtime_ms        = excluded.mtime_ms,
      last_offset     = excluded.last_offset,
      parser_version  = excluded.parser_version,
      session_id_hint = excluded.session_id_hint,
      status          = excluded.status,
      last_error      = excluded.last_error,
      scan_started_at = excluded.scan_started_at,
      scan_finished_at = excluded.scan_finished_at,
      rows_ingested   = excluded.rows_ingested
  `).run(
    p.id,
    p.agentId,
    p.path,
    p.kind,
    nn(p.inode),
    nn(p.size),
    nn(p.mtimeMs),
    p.lastOffset,
    nn(p.parserVersion),
    nn(p.sessionIdHint),
    p.status,
    nn(p.lastError),
    nn(p.scanStartedAt),
    nn(p.scanFinishedAt),
    nn(p.rowsIngested),
  )
}

export type ParseFailureRecord = ParseFailure & {
  sourceId?: string | null
  agentId?: string | null
  path?: string | null
}

/** §5.2 rule 1: the failure goes to `parse_errors`; doctor counts it, nothing is swallowed. */
export function recordParseFailure(db: DatabaseSync, failure: ParseFailureRecord): void {
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO parse_errors (source_id, agent_id, path, raw_seq, raw_offset, reason, raw_line, upstream_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nn(failure.sourceId),
      nn(failure.agentId),
      nn(failure.path),
      nn(failure.rawSeq),
      nn(failure.offset),
      failure.reason,
      failure.rawLine,
      nn(failure.upstreamType),
      Date.now(),
    )
  })
}

/**
 * §6 retention: payloads always respect the TTL (default 30 days); events are only
 * deleted when an explicit `olderThanDays` is supplied (events default to permanent).
 */
export function prune(db: DatabaseSync, opts?: { olderThanDays?: number }): PruneResult {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  return withTransaction(db, () => {
    const payloadCutoff = now - (opts?.olderThanDays ?? DEFAULT_PAYLOAD_TTL_DAYS) * dayMs
    const payloadsDeleted = Number(
      db.prepare('DELETE FROM payloads WHERE created_at < ?').run(payloadCutoff).changes,
    )
    let eventsDeleted = 0
    if (opts?.olderThanDays !== undefined) {
      const eventCutoff = now - opts.olderThanDays * dayMs
      eventsDeleted = Number(
        db.prepare('DELETE FROM events WHERE timestamp < ?').run(eventCutoff).changes,
      )
      db.prepare('DELETE FROM payloads WHERE event_id NOT IN (SELECT id FROM events)').run()
    }
    return { payloadsDeleted, eventsDeleted }
  })
}

/** Runs `fn` inside a transaction, or joins an already-open one (collectors batch their own). */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw err
  }
}
