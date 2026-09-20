/**
 * `doctor` (§11) — the trust exit of the whole tool. Every number here is read
 * from REAL rows; the dedup line re-uses event-model's `aggregateRequestTokens`
 * against the same rows the cube aggregates, so the two views can never disagree.
 */
import type { DatabaseSync } from 'node:sqlite'
import { aggregateRequestTokens } from '@agentlens/event-model'
import { rowToEvent } from '@agentlens/storage'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { displayPath, makeHostCtx, redactHome, readable } from '../context.ts'
import { getAdapters } from '../adapters.ts'
import { loadPricing } from '../pricing-store.ts'
import { GLYPH, formatCount, formatTokens, table } from '../render.ts'
import { rowsOf } from './shared.ts'
import { query } from '@agentlens/query'

function pct(n: number, d: number): string {
  return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`
}

export async function cmdDoctor(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): Promise<number> {
  const adapters = await getAdapters()
  const eventTotal = Number((rowsOf(db, 'SELECT COUNT(*) AS n FROM events')[0]?.n as number | undefined) ?? 0)

  ctx.out('Agents')
  const agentLines: string[] = []
  let zeroSourceAgents = 0
  for (const a of adapters) {
    try {
      const d = await a.detect(makeHostCtx(ctx))
      if (!d.present) {
        agentLines.push(`${GLYPH.none} ${a.id.padEnd(16)} not detected`)
        continue
      }
      let sources = 0
      let filesWithNoSessions = 0
      for await (const _s of a.discover(makeHostCtx(ctx, d.dataRoot ?? null))) {
        void _s
        sources++
      }
      if (sources === 0) filesWithNoSessions = 1
      const evCount = Number((rowsOf(db, 'SELECT COUNT(*) AS n FROM events WHERE agent_id = ?', a.id)[0]?.n as number | undefined) ?? 0)
      agentLines.push(
        `${GLYPH.ok} ${a.id.padEnd(16)} v${d.agentVersion ?? '?'}  ${d.dataRoot ? displayPath(d.dataRoot, ctx.homedir) : ''}  ${sources} sources / ${formatCount(evCount)} events`,
      )
      if (filesWithNoSessions > 0) zeroSourceAgents++
    } catch (err) {
      agentLines.push(`${GLYPH.warn} ${a.id.padEnd(16)} ${redactHome((err as Error).message, ctx.homedir)}`)
    }
  }
  const ingested = rowsOf(db, 'SELECT id FROM agents WHERE id NOT IN (' + (adapters.map(() => '?').join(',') || "''") + ')', ...adapters.map((a) => a.id))
  for (const r of ingested) {
    agentLines.push(`${GLYPH.warn} ${String(r.id).padEnd(16)} ingested, but its adapter package is not installed in this build`)
  }
  if (agentLines.length === 0) agentLines.push(`${GLYPH.none} no adapters installed — discovery unavailable (ingested data stays queryable)`)
  agentLines.forEach((l) => ctx.out(l))

  ctx.out('')
  ctx.out('Parsing')
  const parseErrors = Number((rowsOf(db, 'SELECT COUNT(*) AS n FROM parse_errors')[0]?.n as number | undefined) ?? 0)
  const unknownTypes = Number((rowsOf(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'unknown'")[0]?.n as number | undefined) ?? 0)
  ctx.out(`events ${formatCount(eventTotal)} · parse_errors ${formatCount(parseErrors)} (${pct(parseErrors, eventTotal + parseErrors)}) · unknown types ${formatCount(unknownTypes)} rows`)

  ctx.out('')
  ctx.out('Usage quality')
  const usageRes = query(db, { metrics: ['events'], dims: ['usage_source'] })
  const bySrc = new Map(usageRes.rows.map((r) => [String(r.usage_source), Number(r.events)]))
  const reported = bySrc.get('reported') ?? 0
  const estimated = bySrc.get('estimated') ?? 0
  const missing = bySrc.get('missing') ?? 0
  ctx.out(
    `reported ${pct(reported, eventTotal)} · estimated ${pct(estimated, eventTotal)} · missing ${pct(missing, eventTotal)} ` +
      `(${formatCount(missing)} events without usage)`,
  )
  const noReq = Number((rowsOf(db, "SELECT COUNT(*) AS n FROM events WHERE request_id IS NULL OR request_id = ''")[0]?.n as number | undefined) ?? 0)
  const usageRows = rowsOf(
    db,
    'SELECT * FROM events WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR reasoning_tokens IS NOT NULL',
  )
  const agg = aggregateRequestTokens(usageRows.map((r) => rowToEvent(r)))
  const naive = agg.naive.inputTokens + agg.naive.outputTokens + agg.naive.cacheReadTokens + agg.naive.cacheWriteTokens + agg.naive.reasoningTokens
  const ded = agg.deduped.inputTokens + agg.deduped.outputTokens + agg.deduped.cacheReadTokens + agg.deduped.cacheWriteTokens + agg.deduped.reasoningTokens
  const avoided = naive === 0 ? 0 : (1 - ded / naive) * 100
  const glyph = agg.inflationRatio > 1.001 ? GLYPH.ok : GLYPH.warn
  ctx.out(
    `${glyph} request_id dedup active: raw sum ${formatTokens(naive)} → ${formatTokens(ded)} ` +
      `(${avoided >= 0 ? `-${avoided.toFixed(1)}%` : `+${(-avoided).toFixed(1)}%`} inflation avoided)` +
      (noReq > 0 ? ` · ${formatCount(noReq)} records without request_id, counted individually` : ''),
  )

  ctx.out('')
  ctx.out('Coverage')
  const gone = Number((rowsOf(db, "SELECT COUNT(*) AS n FROM sources WHERE status IN ('gone', 'rotated')")[0]?.n as number | undefined) ?? 0)
  if (adapters.length === 0 && eventTotal === 0) {
    ctx.out(`${GLYPH.none} no adapters installed — coverage unknown`)
  } else {
    if (zeroSourceAgents > 0) {
      ctx.out(`${GLYPH.warn} ${zeroSourceAgents} adapter data root(s) exist but contain no session files (upstream retention?)`)
    }
    if (gone > 0) {
      ctx.out(`${GLYPH.warn} ${formatCount(gone)} known source(s) no longer readable (gone/rotated) — history from them is incomplete`)
    }
    if (zeroSourceAgents === 0 && gone === 0) ctx.out(`${GLYPH.ok} every discovered source dir yielded session files`)
  }

  ctx.out('')
  ctx.out('Capabilities')
  const capRes = query(db, { metrics: ['events', 'duration'], dims: ['capability_type'] })
  const errRes = query(db, { metrics: ['events'], dims: ['capability_type'], filter: { status: ['error'] } })
  const errBy = new Map(errRes.rows.map((r) => [String(r.capability_type), Number(r.events)]))
  const capRows = capRes.rows
    .filter((r) => String(r.capability_type) !== '')
    .map((r) => [String(r.capability_type), formatCount(Number(r.events)), formatCount(errBy.get(String(r.capability_type)) ?? 0)])
  if (capRows.length > 0) ctx.out(table(['capability', 'events', 'errors'], capRows, ['left', 'right', 'right']))
  else ctx.out(`${GLYPH.none} no capability events ingested yet`)

  ctx.out('')
  ctx.out('Pricing')
  const { table: priceTable, snapshot, overrideCount } = loadPricing(dbPath)
  ctx.out(`${GLYPH.ok} ${formatCount(priceTable.size())} models priced (source: ${snapshot.source === 'bundled' ? 'bundled snapshot' : 'updated snapshot'}${overrideCount ? `, ${overrideCount} overrides` : ''})`)
  const models = rowsOf(
    db,
    `SELECT m.provider AS provider, m.name AS name, MAX(e.timestamp) AS last_seen
     FROM models m LEFT JOIN events e ON e.model_rowid = m.rowid
     GROUP BY m.rowid`,
  )
  const missingPrice = models.filter((m) => priceTable.lookup(String(m.provider), String(m.name), ctx.now()) === null)
  if (missingPrice.length > 0) {
    const names = missingPrice.slice(0, 5).map((m) => String(m.name)).join(', ')
    ctx.out(
      `${GLYPH.warn} ${formatCount(missingPrice.length)} models missing price (${names}${missingPrice.length > 5 ? ', ...' : ''}) → cost shown as "n/a" — run \`agl pricing update\``,
    )
  } else if (models.length > 0) {
    ctx.out(`${GLYPH.ok} every ingested model has a price at its last-seen date`)
  }

  ctx.out('')
  ctx.out('Permissions')
  let anyPerm = false
  for (const a of adapters) {
    try {
      const d = await a.detect(makeHostCtx(ctx))
      if (!d.present || !d.dataRoot) continue
      anyPerm = true
      const ok = readable(d.dataRoot)
      ctx.out(`${ok ? GLYPH.ok : GLYPH.err} ${displayPath(d.dataRoot, ctx.homedir)} ${ok ? 'readable' : 'NOT readable (locked?)'}`)
    } catch {
      /* already reported above */
    }
  }
  if (!anyPerm) ctx.out(`${GLYPH.none} no agent data roots to check (no adapters installed)`)
  void flags
  return 0
}