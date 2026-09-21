/**
 * `sessions` / `session <id>` (§9): the session list is a cube query grouped by
 * the session dim; the timeline reads the metric layer directly and joins the
 * content layer when it exists — degrading explicitly when it does not.
 */
import { inflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type { DatabaseSync } from 'node:sqlite'
import { rowToEvent } from '@agentlens/storage'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { queryDeps } from '../context.ts'
import { query } from '@agentlens/query'
import { UsageError } from '../args.ts'
import { formatCount, formatMs, formatTime, formatTokens, formatUsd, table } from '../render.ts'
import { filter, rowsOf, shortId } from './shared.ts'

export function cmdSessions(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): number {
  const limit = flags.num('limit') ?? 20
  const res = query(
    db,
    {
      metrics: ['events', 'duration', 'tokens_total', 'cost_api_equiv'],
      dims: ['session'],
      filter: filter(db, ctx, flags),
      totals: false,
    },
    queryDeps(db, dbPath, ctx),
  )
  const bySession = new Map(res.rows.map((r) => [String(r.session), r]))
  const meta = rowsOf(
    db,
    'SELECT id, agent_id, host_id, project_id, first_timestamp, last_timestamp, title FROM sessions ORDER BY last_timestamp DESC',
  )
  const shown: (string | number)[][] = []
  for (const m of meta) {
    const id = String(m.id)
    const agg = bySession.get(id)
    if (!agg) continue // filtered out or metricless
    shown.push([
      shortId(id),
      String(m.agent_id ?? ''),
      String(m.host_id ?? ''),
      m.project_id ? shortId(String(m.project_id)) : '',
      m.first_timestamp !== null ? `${formatTime(Number(m.first_timestamp))}→${m.last_timestamp !== null ? formatTime(Number(m.last_timestamp)) : ''}` : '',
      (agg.events as number) ?? 0,
      formatTokens(agg.tokens_total as number),
      formatMs(agg.duration as number),
      formatUsd(agg.cost_api_equiv as number | null),
    ])
    if (shown.length >= limit) break
  }
  ctx.out(table(
    ['Session', 'Agent', 'Host', 'Project', 'Time (UTC)', 'Events', 'Tokens', 'Duration', 'Cost'],
    shown,
    ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'],
  ))
  ctx.out(`${shown.length} of ${res.rows.length} sessions`)
  return 0
}

function resolveSessionId(db: DatabaseSync, wanted: string): string {
  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(wanted) as { id: string } | undefined
  if (exact) return exact.id
  const pref = rowsOf(db, 'SELECT id FROM sessions WHERE id LIKE ? LIMIT 2', `${wanted}%`)
  if (pref.length === 1) return String(pref[0]!.id)
  if (pref.length === 0) throw new UsageError(`no session matches ${JSON.stringify(wanted)} (try \`agl sessions\`)`)
  throw new UsageError(`session prefix ${JSON.stringify(wanted)} is ambiguous (${pref.length}+ matches); use a longer id`)
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export function cmdSession(db: DatabaseSync, words: string[], flags: FlagView, ctx: Ctx): number {
  const wanted = words[0]
  if (!wanted) throw new UsageError("usage: agentlens session <id>  (list ids with `agl sessions`)")
  const sessionId = resolveSessionId(db, wanted)
  const rows = rowsOf(
    db,
    'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp, raw_seq, id',
    sessionId,
  )
  if (rows.length === 0) {
    ctx.out(`session ${sessionId} has no events (metrics layer empty)`)
    return 0
  }
  const events = rows.map((r) => rowToEvent(r))

  const payloads = loadPayloads(db, events.map((e) => e.id))
  const contentOff = payloads.size === 0

  const meta = rowsOf(db, 'SELECT agent_id, host_id, project_id, title FROM sessions WHERE id = ?', sessionId)[0]
  ctx.out(`Session ${sessionId}`)
  ctx.out(`  agent=${meta?.agent_id ?? '?'} host=${meta?.host_id ?? '?'} project=${meta?.project_id ? shortId(String(meta.project_id)) : '—'} events=${events.length}`)
  if (contentOff) {
    ctx.out('  (content layer off — showing the metrics-only timeline; re-scan with --content to capture message/tool text)')
  }
  ctx.out('')
  for (const ev of events) {
    const subject = ev.capability?.name ?? ev.model?.name ?? ev.subtype ?? ''
    const tokens = ev.usage ? `in ${formatTokens(ev.usage.inputTokens)} out ${formatTokens(ev.usage.outputTokens)}` : ''
    const dur = ev.durationMs != null ? formatMs(ev.durationMs) : ''
    ctx.out(
      [
        formatTime(ev.timestamp),
        ev.type.padEnd(16),
        subject.padEnd(20),
        (ev.status !== 'ok' ? ev.status + ' ' : '').padEnd(7),
        tokens,
        dur,
      ].join(' ').trimEnd(),
    )
    if (contentOff) continue
    for (const p of payloads.get(ev.id) ?? []) {
      ctx.out(`      ${p.kind}${p.role ? `(${p.role})` : ''}: ${oneLine(p.text, 100)}`)
    }
  }
  return 0
}

interface PayloadText {
  kind: string
  role: string | null
  text: string
}

function loadPayloads(db: DatabaseSync, eventIds: string[]): Map<string, PayloadText[]> {
  const out = new Map<string, PayloadText[]>()
  const CHUNK = 400
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const chunk = eventIds.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = rowsOf(
      db,
      `SELECT event_id, kind, role, text FROM payloads WHERE event_id IN (${placeholders})`,
      ...chunk,
    )
    for (const r of rows) {
      let text = ''
      try {
        const blob = r.text
        text = inflateSync(blob instanceof Uint8Array ? Buffer.from(blob) : Buffer.from(String(blob))).toString('utf8')
      } catch {
        text = '(unreadable payload)'
      }
      const id = String(r.event_id)
      const list = out.get(id) ?? []
      list.push({ kind: String(r.kind ?? ''), role: r.role === null || r.role === undefined ? null : String(r.role), text })
      out.set(id, list)
    }
  }
  return out
}
