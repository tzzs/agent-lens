import { deflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type { DatabaseSync } from 'node:sqlite'
import { assertAggregationMode, UNATTRIBUTED_PROJECT_ID, type AgentEvent, type AggregationPolicy, type ModelRef, type ParseFailure } from '@agentlens/event-model'

/** §3.2/§6 — the content layer is off unless a scan opts in (`--content`). */
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
  /**
   * §4.3: for a `sqlite` source, the table whose rowid high-water `lastOffset` counts; NULL
   * otherwise. Optional so an omitted value reads as "this commit does not speak for it",
   * which the upsert below preserves rather than erases.
   */
  sqliteTable?: string | null
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

/**
 * §4.1: `UNATTRIBUTED_PROJECT_ID` records that THIS line carried no cwd — it is not a claim
 * about the session, so it must not win the seed race against a line that did name one. The
 * first record of a qoder / claude-code transcript is a bookkeeping line (`workspace-directories`,
 * `runtime-config`, `active-leaf`) with no cwd, and a plain `??=` let that one row hold the
 * session in the unknown bucket against the tens of thousands of attributed rows behind it.
 */
function seedProject(current: string | null, next: string | null): string | null {
  if (current === null || current === UNATTRIBUTED_PROJECT_ID) return next ?? current
  return current
}

/**
 * Columns a parser derives from the raw record (§3.1), rewritten on an id conflict so a §5.3
 * version-drift rescan actually LANDS a changed derivation instead of `INSERT OR IGNORE`-ing the
 * new values away. `event.id` fingerprints `source_id + raw_seq + type + occurred_at +
 * discriminator`; it deliberately omits everything here, so a re-derived row collides with its
 * own stored row and only this update can move it (session_id is the motivating case).
 *
 * Deliberately NOT repaired — a fact about storage/provenance, not the parse:
 *  - `id` — the conflict key itself.
 *  - `schema_version` — event-model's global tag (§3.1); changing it is a §6 migration, not a
 *    parser bump, and a row's schema version is provenance we do not silently rewrite.
 *  - `agent_id` / `source_id` — which adapter and which physical file own the row; `source_id` is
 *    an input to `id` so it is equal on every conflict, and `agent_id` is fixed per source.
 *  - `ingested_at` — the instant we read it, a fact about the ingest.
 *  - `raw_seq` / `raw_offset` — the record's physical position in the source; `raw_seq` is an
 *    input to `id` (equal on conflict) and a from-0 rescan re-reads identical positions.
 */
const REPAIRED_EVENT_COLUMNS = [
  'host_id', 'session_id', 'project_id', 'parent_event_id', 'request_id', 'thread_id',
  'timestamp', 'type', 'subtype', 'model_rowid',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'usage_source', 'cost_reported', 'cost_source', 'credits',
  'capability_type', 'capability_name', 'capability_provider',
  'duration_ms', 'status', 'error_fingerprint', 'content_ref', 'metadata',
] as const

// NULL-safe (`IS NOT`) so a repair fires only when some derived value actually differs: a §4.2
// replay of unchanged rows then stays a genuine no-op — no rewrite, and `changes()` holds at 0 so
// `inserted` keeps counting real writes rather than every conflict.
const EVENT_REPAIR_SET = REPAIRED_EVENT_COLUMNS.map((c) => `${c} = excluded.${c}`).join(',\n        ')
const EVENT_REPAIR_WHERE = REPAIRED_EVENT_COLUMNS.map((c) => `events.${c} IS NOT excluded.${c}`).join('\n           OR ')

/** §4.2/§5.3 — one transaction per batch; events upsert their derived columns so a version-drift
 * rescan repairs stored rows, while a replay of identical input is a no-op (conflict guard). */
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
        s.projectId = seedProject(s.projectId, nn(ev.projectId))
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

    // §5.2/§5.3: the conflict path deliberately does NOT touch the timestamps. A
    // min/max widening here would be a one-way ratchet: once an event's stored timestamp
    // is re-derived (ingest-clock guess → source time) or re-homed to another session,
    // the stale extreme it contributed can never leave, and the columns silently drift
    // away from the truth they claim to summarize. The single owner of these columns is
    // the min/max recompute below, which runs after the event rows land. The INSERT arm
    // still seeds fresh rows from this batch, which that recompute then confirms.
    //
    // `project_id` keeps the COALESCE because it is not this statement's fact to settle: a row
    // already in the store holds whatever an earlier batch derived, and the single owner of that
    // column is `deriveSessionProjects`, which re-reads the session's own event rows after the
    // scan. Widening it here would only see this batch, which is exactly the partial view that
    // mislabels a session whose cwd evidence arrives later.
    const upsertSession = db.prepare(`
      INSERT INTO sessions (id, agent_id, host_id, project_id, source_id, first_timestamp, last_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        host_id         = COALESCE(sessions.host_id, excluded.host_id),
        project_id      = COALESCE(sessions.project_id, excluded.project_id),
        source_id       = COALESCE(sessions.source_id, excluded.source_id)
    `)
    for (const [id, s] of sessionIdentities) {
      upsertSession.run(id, s.agentId, s.hostId, s.projectId, s.sourceId, s.first, s.last)
    }

    // A repaired row leaves its old session behind, and that session's tally has to be
    // recomputed too — so read the pre-existing ids before the rows are touched.
    const recountSessions = new Set(sessionIdentities.keys())
    {
      const ids = events.map((ev) => ev.id)
      const chunkSize = 500
      const readSessions = (chunk: string[]) =>
        db
          .prepare(`SELECT session_id FROM events WHERE id IN (${chunk.map(() => '?').join(',')})`)
          .all(...chunk) as { session_id: string | null }[]
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize)!
        for (const r of readSessions(chunk)) if (r.session_id !== null) recountSessions.add(r.session_id)
      }
    }

    const insertEvent = db.prepare(`
      -- §5.3: a parser_version bump replays the whole source from offset 0, and the replayed
      -- records can now resolve to *different* derived columns. Plain INSERT OR IGNORE would drop
      -- them on the floor — event.id fingerprints source_id + raw_seq + type + occurred_at +
      -- discriminator and omits exactly those — so a row would keep its stale derivation forever.
      -- ON CONFLICT re-derives them; REPAIRED_EVENT_COLUMNS fixes what is repaired and what stays
      -- provenance. parent_event_id / request_id are overwritten outright (not COALESCE'd): a
      -- from-0 rescan reproduces the current parser's own answer, and the store should reflect
      -- that answer rather than an older scan's. The WHERE guard makes a byte-identical replay
      -- touch zero rows, which keeps §4.2's replay guarantee observable in rows and counts alike.
      INSERT INTO events (
        id, schema_version, agent_id, host_id, source_id, session_id, project_id,
        parent_event_id, request_id, thread_id, timestamp, ingested_at, type, subtype,
        model_rowid, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, usage_source, cost_reported, cost_source, credits,
        capability_type, capability_name, capability_provider,
        duration_ms, status, error_fingerprint, raw_seq, raw_offset, content_ref, metadata
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        ${EVENT_REPAIR_SET}
      WHERE ${EVENT_REPAIR_WHERE}
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
        nn(ev.threadId),
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
        nn(ev.costReported),
        nn(ev.costSource),
        nn(ev.credits),
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

    // Recomputed (not incremented) so a byte-identical replay leaves the count
    // identical — and so a session the rows just left drops to its true count (§5.3).
    // first/last_timestamp are recomputed in the same statement for the same reason:
    // they mean MIN/MAX over the session's events, and after a repair that moved or
    // re-timed rows only this makes the columns converge back (a repair rescan must
    // be able to SHRINK a span, which the widening upsert could never do).
    const recomputeSession = db.prepare(`
      UPDATE sessions SET
        event_count     = (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.id),
        first_timestamp = (SELECT MIN(timestamp) FROM events WHERE events.session_id = sessions.id),
        last_timestamp  = (SELECT MAX(timestamp) FROM events WHERE events.session_id = sessions.id)
      WHERE id = ?
    `)
    for (const id of recountSessions) recomputeSession.run(id)

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
      session_id_hint, sqlite_table, status, last_error, scan_started_at, scan_finished_at, rows_ingested
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      -- §4.3: a commit that does not carry a table name (jsonl, or a source re-upserted
      -- from a partial row) must not wipe the table a prior sqlite commit recorded.
      sqlite_table    = COALESCE(excluded.sqlite_table, sources.sqlite_table),
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
    nn(p.sqliteTable),
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
    let payloadsDeleted = Number(
      db.prepare('DELETE FROM payloads WHERE created_at < ?').run(payloadCutoff).changes,
    )
    let eventsDeleted = 0
    if (opts?.olderThanDays !== undefined) {
      const eventCutoff = now - opts.olderThanDays * dayMs
      // `payloads.event_id` has no ON DELETE action, so an event can only go once the
      // payloads referencing it have. Their own TTL is independent — a first `--content`
      // scan writes young payloads for old events, and deleting the events first is a
      // FOREIGN KEY failure that aborts the whole prune.
      payloadsDeleted += Number(
        db
          .prepare('DELETE FROM payloads WHERE event_id IN (SELECT id FROM events WHERE timestamp < ?)')
          .run(eventCutoff).changes,
      )
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

/**
 * Persist the aggregation rule each adapter declares (§18 row 2), keyed by agent id.
 * Read back by every query, so the rule that produced stored rows keeps applying to them.
 */
export function setAgentAggregations(db: DatabaseSync, policies: Record<string, AggregationPolicy>): void {
  withTransaction(db, () => {
    const stmt = db.prepare(`
      INSERT INTO agents (id, aggregation_mode, subagents_included) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        aggregation_mode   = excluded.aggregation_mode,
        subagents_included = excluded.subagents_included
    `)
    for (const [agentId, policy] of Object.entries(policies)) {
      stmt.run(agentId, policy.mode, policy.subagentsIncluded ? 1 : 0)
    }
  })
}

/** Agents with no persisted policy are absent, so the caller's default applies. */
export function loadAgentAggregations(db: DatabaseSync): Record<string, AggregationPolicy> {
  const rows = db
    .prepare('SELECT id, aggregation_mode, subagents_included FROM agents WHERE aggregation_mode IS NOT NULL')
    .all()
    .map((r) => ({ ...r })) as { id: string; aggregation_mode: string; subagents_included: number }[]
  const out: Record<string, AggregationPolicy> = {}
  for (const r of rows) {
    out[r.id] = {
      mode: assertAggregationMode(r.aggregation_mode),
      subagentsIncluded: r.subagents_included === 1,
    }
  }
  return out
}
