/**
 * GET /api/doctor (§11): the same report `agl doctor` prints, as JSON.
 *
 * The dedup line re-runs event-model's `aggregateRequestTokens` over the very
 * rows the cube folds, so the diagnostic can never disagree with the dashboard.
 * This route scans all usage rows on purpose; hot dashboard routes do not.
 */
import { aggregateRequestTokens } from '@agentlens/event-model'
import { rowToEvent } from '@agentlens/storage'
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView, missingPriceModels } from './cost.ts'
import { coverageReport } from './coverage.ts'
import { catalogSummary } from './capabilities.ts'
import { doctorAgents } from './doctor-agents.ts'
import { parseFilter } from './request-spec.ts'
import { rowsOf } from './resolve.ts'
import { contentLayerPresent, payloadCount } from './content.ts'
import type { DoctorReport } from './doctor-types.ts'

const pctOf = (n: number, d: number): number => (d === 0 ? 0 : (n / d) * 100)
const tokenSum = (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens

export async function doctor(ctx: ServerCtx, sp: URLSearchParams): Promise<DoctorReport> {
  const filter = parseFilter(sp, ctx.db)
  const agents = await doctorAgents(ctx)
  const events = Number(rowsOf(ctx.db, 'SELECT COUNT(*) AS n FROM events')[0]?.n ?? 0)
  const parseErrors = Number(rowsOf(ctx.db, 'SELECT COUNT(*) AS n FROM parse_errors')[0]?.n ?? 0)
  const unknownTypes = Number(rowsOf(ctx.db, "SELECT COUNT(*) AS n FROM events WHERE type = 'unknown'")[0]?.n ?? 0)

  const usageRes = query(ctx.db, { metrics: ['events'], dims: ['usage_source'] }, ctx.cubeDeps)
  const bySrc = new Map(usageRes.rows.map((r) => [String(r.usage_source), Number(r.events ?? 0)]))
  const withoutRequestId = Number(
    rowsOf(ctx.db, "SELECT COUNT(*) AS n FROM events WHERE request_id IS NULL OR request_id = ''")[0]?.n ?? 0,
  )
  const usageRows = rowsOf(
    ctx.db,
    `SELECT * FROM events
     WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL
       OR cache_write_tokens IS NOT NULL OR reasoning_tokens IS NOT NULL`,
  )
  const agg = aggregateRequestTokens(usageRows.map((r) => rowToEvent(r)))
  const naive = tokenSum(agg.naive)
  const deduped = tokenSum(agg.deduped)

  const caps = query(ctx.db, { metrics: ['events'], dims: ['capability_type'], filter }, ctx.cubeDeps)
  const capErrs = query(ctx.db, { metrics: ['events'], dims: ['capability_type'], filter: { ...filter, status: ['error'] } }, ctx.cubeDeps)
  const errBy = new Map(capErrs.rows.map((r) => [String(r.capability_type), Number(r.events ?? 0)]))
  const supportRows = query(ctx.db, { metrics: ['events'], dims: ['agent', 'capability_type'], filter }, ctx.cubeDeps)
  const support = new Map<string, string[]>()
  for (const r of supportRows.rows) {
    if (!String(r.capability_type)) continue
    const list = support.get(String(r.agent)) ?? []
    list.push(String(r.capability_type))
    support.set(String(r.agent), list)
  }

  const modelsSeen = Number(rowsOf(ctx.db, 'SELECT COUNT(*) AS n FROM models')[0]?.n ?? 0)
  const missing = missingPriceModels(ctx)
  const catalog = await catalogSummary(ctx, filter)

  return {
    generatedAt: ctx.now(),
    adaptersInstalled: agents.adaptersInstalled,
    agents: agents.rows,
    parsing: { events, parseErrors, parseErrorPct: pctOf(parseErrors, events + parseErrors), unknownTypes },
    usageQuality: {
      reported: bySrc.get('reported') ?? 0,
      estimated: bySrc.get('estimated') ?? 0,
      missing: bySrc.get('missing') ?? 0,
      withoutRequestId,
      naiveTokens: naive,
      dedupedTokens: deduped,
      // §11's "raw sum X → Y (-Z% inflation avoided)" line, as numbers.
      inflationAvoidedPct: naive === 0 ? 0 : (1 - deduped / naive) * 100,
      dedupActive: agg.inflationRatio > 1.001,
    },
    coverage: coverageReport(ctx),
    capabilities: caps.rows
      .filter((r) => String(r.capability_type) !== '')
      .map((r) => ({ type: String(r.capability_type), events: Number(r.events ?? 0), errors: errBy.get(String(r.capability_type)) ?? 0 })),
    capabilitySupport: [...support.entries()].map(([agentId, recorded]) => ({ agentId, recorded })),
    catalog: {
      available: catalog.available,
      note: catalog.note,
      installed: catalog.installed,
      neverUsed: catalog.neverUsed.length,
    },
    pricing: {
      pricingConfigured: Boolean(ctx.priceResolver),
      modelsPriced: ctx.priceTableSize ? ctx.priceTableSize() : null,
      modelsSeen,
      missing,
    },
    cost: costView(ctx, filter),
    permissions: agents.permissions,
    content: {
      available: contentLayerPresent(ctx.db),
      payloads: payloadCount(ctx.db),
      note: contentLayerPresent(ctx.db)
        ? 'content layer on: timelines show message/tool text'
        : 'content layer off (--no-content) or expired: timelines are metrics-only, statistics unaffected',
    },
  }
}
