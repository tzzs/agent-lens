/**
 * `export --format jsonl|csv|otel` (§12): export is a thin writer over the OTel
 * attribute map in event-model — it never re-models events. Raw event streaming,
 * not aggregation, so no token SQL is composed here.
 */
import type { DatabaseSync } from 'node:sqlite'
import { otelSpanName, toOtelAttributes, type AgentEvent } from '@agentlens/event-model'
import { rowToEvent } from '@agentlens/storage'
import { resolveSince } from '@agentlens/query'
import { UsageError, type FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { filter, rowsOf } from './shared.ts'

const CSV_COLUMNS = [
  'id', 'schema_version', 'agent_id', 'host_id', 'source_id', 'session_id', 'project_id',
  'request_id', 'timestamp', 'type', 'subtype', 'model', 'provider',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'usage_source', 'capability_type', 'capability_name', 'duration_ms', 'status', 'metadata',
] as const

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function eventRow(e: AgentEvent): unknown[] {
  return [
    e.id, e.schemaVersion, e.agentId, e.hostId, e.sourceId, e.sessionId, e.projectId,
    e.requestId ?? null, e.timestamp, e.type, e.subtype ?? null,
    e.model?.name ?? null, e.model?.provider ?? null,
    e.usage?.inputTokens ?? null, e.usage?.outputTokens ?? null, e.usage?.cacheReadTokens ?? null,
    e.usage?.cacheWriteTokens ?? null, e.usage?.reasoningTokens ?? null,
    e.usageSource, e.capability?.type ?? null, e.capability?.name ?? null,
    e.durationMs ?? null, e.status, e.metadata ? JSON.stringify(e.metadata) : null,
  ]
}

export function cmdExport(db: DatabaseSync, flags: FlagView, ctx: Ctx): number {
  const format = flags.str('format')
  if (format !== 'jsonl' && format !== 'csv' && format !== 'otel') {
    throw new UsageError(`export requires --format jsonl|csv|otel (got ${JSON.stringify(format ?? '(none)')})`)
  }
  const f = filter(db, ctx, flags)
  const where: string[] = []
  const params: unknown[] = []
  if (f.since !== undefined) { where.push('timestamp >= ?'); params.push(typeof f.since === 'number' ? f.since : resolveSince(f.since)) }
  if (f.until !== undefined) { where.push('timestamp <= ?'); params.push(typeof f.until === 'number' ? f.until : resolveSince(f.until)) }
  const pushIn = (col: string, vals: string[] | undefined) => {
    if (vals?.length) {
      where.push(`${col} IN (${vals.map(() => '?').join(', ')})`)
      params.push(...vals)
    }
  }
  pushIn('agent_id', f.agent)
  pushIn('host_id', f.host)
  pushIn('project_id', f.project)
  pushIn('session_id', f.session)
  pushIn('status', f.status)
  pushIn('type', f.type)
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp, raw_seq, id`
  const events = rowsOf(db, sql, ...params).map((r) => rowToEvent(r))

  if (format === 'jsonl') {
    for (const e of events) ctx.out(JSON.stringify(e))
  } else if (format === 'csv') {
    ctx.out(CSV_COLUMNS.join(','))
    for (const e of events) ctx.out(eventRow(e).map(csvCell).join(','))
  } else {
    for (const e of events) {
      ctx.out(JSON.stringify({ name: otelSpanName(e), timestamp: e.timestamp, attributes: toOtelAttributes(e) }))
    }
  }
  ctx.err(`# ${events.length} events exported (${format})`)
  return 0
}
