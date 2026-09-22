/**
 * GET /api/doctor (§11): the same report `agl doctor` prints, as JSON.
 *
 * The fold and the deeper checks are NOT reimplemented here: they come from storage's shared
 * doctor checks, which the CLI calls too, so the two ends cannot drift apart on identical
 * rows (§14). What this route adds is the per-agent policy read back from the stored rows
 * (§18 row 2) and the honest "cannot be evaluated" states when this build has no adapters
 * injected — the only inputs the server genuinely cannot produce alone (§5.4).
 * This route scans all usage rows on purpose; hot dashboard routes do not.
 */
import { parserVersionDrift, sourceRetention, subagentOrphans, timestampGuesses } from '@agentlens/storage'
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView, missingPriceModels } from './cost.ts'
import { coverageReport } from './coverage.ts'
import { catalogSummary } from './capabilities.ts'
import { doctorAgents } from './doctor-agents.ts'
import { usageQualityBlock } from './doctor-usage.ts'
import { parseFilter } from './request-spec.ts'
import { rowsOf } from './resolve.ts'
import { contentLayerPresent, payloadCount } from './content.ts'
import type { DoctorReport, DoctorSubagentLinkage, DoctorTimestampGuess } from './doctor-types.ts'

const pctOf = (n: number, d: number): number => (d === 0 ? 0 : (n / d) * 100)

export async function doctor(ctx: ServerCtx, sp: URLSearchParams): Promise<DoctorReport> {
  const filter = parseFilter(sp, ctx.db)
  const adapters = ctx.adapters ? await ctx.adapters() : []
  const agents = await doctorAgents(ctx, adapters)
  const events = Number(rowsOf(ctx.db, 'SELECT COUNT(*) AS n FROM events')[0]?.n ?? 0)
  const parseErrors = Number(rowsOf(ctx.db, 'SELECT COUNT(*) AS n FROM parse_errors')[0]?.n ?? 0)
  const unknownTypes = Number(rowsOf(ctx.db, "SELECT COUNT(*) AS n FROM events WHERE type = 'unknown'")[0]?.n ?? 0)

  // §5.3: a source is stale against the parser that wrote it, and only the adapter set knows
  // that version — without it the claim has to stay unmade rather than default to green.
  const parserDrift = parserVersionDrift(ctx.db, Object.fromEntries(adapters.map((a) => [a.id, a.parserVersion])))
  const subagents: DoctorSubagentLinkage[] = subagentOrphans(ctx.db).map((s) => ({
    ...s,
    orphanPct: pctOf(s.orphan, s.total),
  }))
  // §5.2: the same count `agl doctor` prints, from the same storage check.
  const guessedTimestamps: DoctorTimestampGuess[] = timestampGuesses(ctx.db).map((g) => ({
    agentId: g.agentId,
    events: g.events,
    guessed: g.guessed,
    guessedPct: pctOf(g.guessed, g.events),
    fromIngestClock: g.fromIngestClock,
    fromFileMtime: g.guessed - g.fromIngestClock,
  }))

  const withoutRequestId = Number(
    rowsOf(ctx.db, "SELECT COUNT(*) AS n FROM events WHERE request_id IS NULL OR request_id = ''")[0]?.n ?? 0,
  )

  const caps = query(ctx.db, { metrics: ['events'], dims: ['capability_type'], filter, totals: false }, ctx.cubeDeps)
  const capErrs = query(ctx.db, { metrics: ['events'], dims: ['capability_type'], filter: { ...filter, status: ['error'] }, totals: false }, ctx.cubeDeps)
  const errBy = new Map(capErrs.rows.map((r) => [String(r.capability_type), Number(r.events ?? 0)]))
  const supportRows = query(ctx.db, { metrics: ['events'], dims: ['agent', 'capability_type'], filter, totals: false }, ctx.cubeDeps)
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
  const usageQuality = usageQualityBlock(ctx, adapters)

  return {
    generatedAt: ctx.now(),
    adaptersInstalled: agents.adaptersInstalled,
    agents: agents.rows,
    parsing: { events, parseErrors, parseErrorPct: pctOf(parseErrors, events + parseErrors), unknownTypes, parserDrift },
    usageQuality: { ...usageQuality, withoutRequestId },
    coverage: coverageReport(ctx),
    subagents,
    guessedTimestamps,
    retention: sourceRetention(ctx.db),
    capabilities: caps.rows
      .filter((r) => String(r.capability_type) !== '')
      .map((r) => ({ type: String(r.capability_type), events: Number(r.events ?? 0), errors: errBy.get(String(r.capability_type)) ?? 0 })),
    capabilitySupport: [...support.entries()].map(([agentId, recorded]) => ({ agentId, recorded })),
    catalog: {
      available: catalog.available,
      noteCode: catalog.noteCode,
      ...(catalog.noteDetail ? { noteDetail: catalog.noteDetail } : {}),
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
      noteCode: contentLayerPresent(ctx.db) ? 'contentOn' : 'contentOff',
    },
  }
}
