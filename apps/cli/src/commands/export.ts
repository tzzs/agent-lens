/**
 * §12: export is a thin writer over the OTel attribute map in event-model — it never
 * re-models events. Two sinks share that one mapping: stdout (`jsonl|csv|otel`, the
 * frozen contract) and, only when the user asks for it, OTLP/HTTP ingest so spans can
 * actually reach Langfuse / Phoenix. The ingest leg adds a transport envelope around the
 * exact spans `--format otel` prints — no second field model.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { otelSpanName, toOtelAttributes, type AgentEvent } from '@agentlens/event-model'
import { rowToEvent } from '@agentlens/storage'
import { resolveSince } from '@agentlens/query'
import { UsageError, type FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { filter, rowsOf } from './shared.ts'

// Frozen: names and order of the columns already shipped never move; new fields append.
const CSV_COLUMNS = [
  'id', 'schema_version', 'agent_id', 'host_id', 'source_id', 'session_id', 'project_id',
  'request_id', 'timestamp', 'type', 'subtype', 'model', 'provider',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'usage_source', 'capability_type', 'capability_name', 'duration_ms', 'status', 'metadata',
  'thread_id', 'cost_reported', 'cost_source',
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
    e.threadId ?? null, e.costReported ?? null, e.costSource ?? null,
  ]
}

/** `rowToEvent` reads the metric columns only; the joined model columns land here. */
function eventFromRow(row: Record<string, unknown>): AgentEvent {
  const e = rowToEvent(row)
  if (row.model_name === null || row.model_name === undefined) return e
  return {
    ...e,
    model: {
      provider: String(row.model_provider ?? ''),
      name: String(row.model_name),
      tier: (row.model_tier as string | null) ?? null,
    },
  }
}

/* ---------------------------------------------- OTLP/HTTP ingest (§12, third branch) */

/** OTLP/HTTP tolerates large bodies, but a smaller request bounds what a rejection loses. */
const OTLP_MAX_SPANS_PER_REQUEST = 500

interface PushTarget {
  url: string
  headers: Record<string, string>
}

function pushTarget(flags: FlagView): PushTarget | null {
  const raw = flags.str('push')
  if (raw === undefined) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UsageError(`--push expects an http(s) OTLP endpoint URL, got ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`--push expects an http(s) OTLP endpoint URL, got ${JSON.stringify(raw)}`)
  }
  const headers: Record<string, string> = {}
  // FlagView.list() splits on commas, so a header value must not carry one; tokens never
  // do in practice (Basic/Bearer), and this keeps the surface to one flag.
  for (const entry of flags.list('push-header')) {
    const colon = entry.indexOf(':')
    if (colon <= 0) throw new UsageError(`--push-header expects "Name: value", got ${JSON.stringify(entry)}`)
    headers[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim()
  }
  if (url.username || url.password) {
    throw new UsageError('--push URL must not carry credentials; pass them with --push-header')
  }
  return { url: url.toString(), headers }
}

type AttributeValue = string | number | boolean

/** OTLP `AnyValue`, in the shape the JS SDK's JSON encoder emits. */
function anyValue(v: AttributeValue): Record<string, unknown> {
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') return { doubleValue: v }
  return { stringValue: v }
}

/** OTLP/HTTP JSON wants base16 ids; sha256 over the model's own keys gives that for any id. */
function hexId(seed: string, chars: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, chars)
}

function otlpSpan(e: AgentEvent): Record<string, unknown> {
  const startNs = BigInt(Math.trunc(e.timestamp)) * 1_000_000n
  const endNs = startNs + BigInt(Math.max(0, Math.trunc(e.durationMs ?? 0))) * 1_000_000n
  return {
    // One trace per request so a viewer groups an exchange's spans; content-derived ids
    // keep a re-push of the same rows idempotent (§4.2).
    traceId: hexId(`agentlens:trace:${e.requestId ?? e.sessionId}`, 32),
    spanId: hexId(`agentlens:span:${e.id}`, 16),
    name: otelSpanName(e),
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: Object.entries(toOtelAttributes(e)).map(([key, value]) => ({ key, value: anyValue(value) })),
    status: { code: e.status === 'error' ? 2 : e.status === 'ok' ? 1 : 0 },
  }
}

function otlpBody(events: AgentEvent[]): string {
  const byResource = new Map<string, Record<string, unknown>[]>()
  for (const e of events) {
    const key = `${e.agentId}\u0000${e.hostId}`
    const spans = byResource.get(key) ?? []
    spans.push(otlpSpan(e))
    byResource.set(key, spans)
  }
  return JSON.stringify({
    resourceSpans: [...byResource.entries()].map(([key, spans]) => {
      const [agentId, hostId] = key.split('\u0000')
      return {
        // service.name is what Langfuse/Phoenix attribute a trace to — the agent is the unit.
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: agentId } },
            { key: 'agentlens.host_id', value: { stringValue: hostId } },
          ],
        },
        scopeSpans: [{ scope: { name: 'agentlens' }, spans }],
      }
    }),
  })
}

async function pushOtlp(events: AgentEvent[], target: PushTarget, ctx: Ctx): Promise<void> {
  let sent = 0
  for (let i = 0; i < events.length; i += OTLP_MAX_SPANS_PER_REQUEST) {
    const batch = events.slice(i, i + OTLP_MAX_SPANS_PER_REQUEST)
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...target.headers },
        body: otlpBody(batch),
      })
    } catch (err) {
      throw new Error(
        `export --push: cannot reach ${target.url}: ${(err as Error).message} ` +
          `(${sent} of ${events.length} spans sent)`,
      )
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300)
      throw new Error(
        `export --push: ${target.url} responded ${res.status}${detail ? `: ${detail}` : ''} ` +
          `(${sent} of ${events.length} spans sent)`,
      )
    }
    sent += batch.length
  }
  ctx.err(`# ${sent} events pushed to ${target.url} (otel)`)
}

/* ---------------------------------------------------------------------------- command */

export async function cmdExport(db: DatabaseSync, flags: FlagView, ctx: Ctx): Promise<number> {
  const format = flags.str('format')
  if (format !== 'jsonl' && format !== 'csv' && format !== 'otel') {
    throw new UsageError(`export requires --format jsonl|csv|otel (got ${JSON.stringify(format ?? '(none)')})`)
  }
  const push = pushTarget(flags)
  if (push && format !== 'otel') {
    throw new UsageError('--push sends the OTel spans, so it requires --format otel')
  }
  const f = filter(db, ctx, flags)
  const where: string[] = []
  const params: unknown[] = []
  if (f.since !== undefined) { where.push('e.timestamp >= ?'); params.push(typeof f.since === 'number' ? f.since : resolveSince(f.since)) }
  if (f.until !== undefined) { where.push('e.timestamp <= ?'); params.push(typeof f.until === 'number' ? f.until : resolveSince(f.until)) }
  const pushIn = (col: string, vals: string[] | undefined) => {
    if (vals?.length) {
      where.push(`${col} IN (${vals.map(() => '?').join(', ')})`)
      params.push(...vals)
    }
  }
  pushIn('e.agent_id', f.agent)
  pushIn('e.host_id', f.host)
  pushIn('e.project_id', f.project)
  pushIn('e.session_id', f.session)
  pushIn('e.status', f.status)
  pushIn('e.type', f.type)
  // events stores a model rowid, so the join is what makes the map's gen_ai.*model attributes
  // and the CSV model/provider columns carry anything at all.
  const sql = `SELECT e.*, m.provider AS model_provider, m.name AS model_name, m.tier AS model_tier
    FROM events e LEFT JOIN models m ON m.rowid = e.model_rowid
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.timestamp, e.raw_seq, e.id`
  const events = rowsOf(db, sql, ...params).map(eventFromRow)

  if (push) {
    await pushOtlp(events, push, ctx)
    return 0
  }
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
