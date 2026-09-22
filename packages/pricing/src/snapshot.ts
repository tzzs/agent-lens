import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isMissingPrice, PRICE_MISSING, type PriceEntry } from './price-types.ts'

export const SNAPSHOT_SCHEMA_VERSION = 1

/** One litellm entry, keyed by its `model` id in the upstream map. */
export interface RawLitellmEntry {
  model: string
  litellm_provider?: string | null
  input_cost_per_token?: number | null
  output_cost_per_token?: number | null
  cache_read_input_token_cost?: number | null
  cache_creation_input_token_cost?: number | null
  input_cost_per_reasoning_token?: number | null
  effective_from?: number
  [extra: string]: unknown
}

/**
 * One OpenRouter model record, kept as the API returned it: `model` is its `id`
 * (`anthropic/claude-opus-4.8`) and `pricing` its USD-per-token string map.
 */
export interface RawOpenRouterEntry {
  model: string
  pricing?: Record<string, unknown> | null
  effective_from?: number
  [extra: string]: unknown
}

export interface PriceSnapshot<E extends { model: string } = RawLitellmEntry> {
  schemaVersion?: number
  fetchedAt: number
  source: string
  entries: E[]
}

export type OpenRouterSnapshot = PriceSnapshot<RawOpenRouterEntry>

export class PricingDataError extends Error {
  override readonly name = 'PricingDataError'
}

const PER_MTOK = 1_000_000

/** litellm publishes budget-priced duplicates (`*-budget`); they are aliases, not models. */
const BUDGET_KEY = /[-_]budget\b/i

/**
 * OpenRouter lists one model several times over: `:batch` is a half-price queue and
 * `:free` a quota route priced 0, and both normalize onto the base id in
 * `normalizeModelName`, so admitting them would let a discounted or free rate win a lookup.
 * `~vendor/model-latest` ids are rolling aliases that re-point whenever the vendor ships.
 */
const OPENROUTER_ROUTE_VARIANT = /:/
const OPENROUTER_ROLLING_ALIAS = /^[~^]/

function toPerMTok(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v * PER_MTOK : PRICE_MISSING
}

/** OpenRouter serializes every price as a string ("0.000005" USD per token). */
function priceStrToPerMTok(v: unknown): number {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n * PER_MTOK : PRICE_MISSING
}

/**
 * Litellm's upstream file is one flat object (model id → cost dict). Wrap it in
 * our own snapshot envelope so fetchedAt/source/schema travel with the data.
 *
 * Entries lacking `effective_from` are stamped 0 (undated), the way the build-time
 * generator stamps them: litellm publishes no price history, so a fetched rate is
 * today's rate for every model. Dating them to the fetch moment instead would make
 * `pickEffective` find no entry for any earlier event, and one `agl pricing update`
 * would turn the whole history of every cost figure into `n/a`.
 */
export function litellmRawMapToSnapshot(raw: Record<string, unknown>, opts: { fetchedAt: number; source: string }): PriceSnapshot {
  const entries: RawLitellmEntry[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as { effective_from?: unknown }
    entries.push({
      ...(value as object),
      model: key,
      effective_from: typeof entry.effective_from === 'number' ? entry.effective_from : 0,
    } as RawLitellmEntry)
  }
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, fetchedAt: opts.fetchedAt, source: opts.source, entries }
}

/**
 * OpenRouter's `/api/v1/models` envelope is `{ data: [{ id, pricing, ... }] }`.
 *
 * Each entry is stamped `effective_from: 0` (undated) because OpenRouter publishes no price
 * history — the same convention the generated litellm snapshot uses (§19). A fetched price
 * dated to the fetch moment would leave every earlier event with no effective price and
 * turn the whole history into `n/a`.
 */
export function openRouterRawToSnapshot(raw: unknown, opts: { fetchedAt: number; source: string }): OpenRouterSnapshot {
  const data = (raw as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new PricingDataError('openrouter models response must carry a "data" array')
  }
  const entries: RawOpenRouterEntry[] = []
  for (const item of data) {
    const o = item as { id?: unknown; pricing?: unknown } | null
    if (typeof o?.id !== 'string' || o.id === '') continue
    entries.push({
      model: o.id,
      pricing: typeof o.pricing === 'object' && o.pricing !== null ? (o.pricing as Record<string, unknown>) : null,
      effective_from: 0,
    })
  }
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, fetchedAt: opts.fetchedAt, source: opts.source, entries }
}

export function loadSnapshot<E extends { model: string } = RawLitellmEntry>(json: string): PriceSnapshot<E> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new PricingDataError(`price snapshot is not valid JSON: ${(e as Error).message}`)
  }
  const s = parsed as Partial<PriceSnapshot<E>> | null
  if (!s || typeof s !== 'object' || !Array.isArray(s.entries)) {
    throw new PricingDataError('price snapshot must have an "entries" array')
  }
  for (const e of s.entries) {
    if (typeof e?.model !== 'string') {
      throw new PricingDataError('every snapshot entry needs a string "model"')
    }
  }
  return {
    schemaVersion: s.schemaVersion ?? SNAPSHOT_SCHEMA_VERSION,
    fetchedAt: Number(s.fetchedAt),
    source: String(s.source ?? ''),
    entries: s.entries,
  }
}

export function normalizeLitellmEntries(snapshot: PriceSnapshot, opts: { generatedAt: number }): PriceEntry[] {
  const out: PriceEntry[] = []
  for (const raw of snapshot.entries) {
    const rawModel = raw.model
    if (BUDGET_KEY.test(rawModel)) continue

    let provider = typeof raw.litellm_provider === 'string' ? raw.litellm_provider : 'unknown'
    let model = rawModel
    const slash = rawModel.indexOf('/')
    if (slash > 0) {
      provider = rawModel.slice(0, slash)
      model = rawModel.slice(slash + 1)
    }

    const reasoning = raw.input_cost_per_reasoning_token
    out.push({
      provider,
      model,
      tier: null,
      inputPerMTok: toPerMTok(raw.input_cost_per_token),
      outputPerMTok: toPerMTok(raw.output_cost_per_token),
      cacheReadPerMTok: toPerMTok(raw.cache_read_input_token_cost),
      cacheWritePerMTok: toPerMTok(raw.cache_creation_input_token_cost),
      reasoningPerMTok: typeof reasoning === 'number' && Number.isFinite(reasoning) ? reasoning * PER_MTOK : null,
      // A curated snapshot may pin `effective_from` per model (litellm itself has no history);
      // otherwise every entry inherits the generation date.
      effectiveFrom: typeof raw.effective_from === 'number' ? raw.effective_from : opts.generatedAt,
      source: 'litellm',
    })
  }
  return out
}

/**
 * OpenRouter's `pricing` keys map onto our buckets one-for-one, with two name traps:
 * `internal_reasoning` is its reasoning-token rate (there is no `reasoning` key), and
 * `input_cache_write` is its 5-minute-TTL rate — the 1-hour rate is published separately as
 * `input_cache_write_1h`, which `Usage` cannot express because it keeps one cacheWrite bucket.
 * Absent and unparseable prices become PRICE_MISSING, so §8's gap rule turns them into `n/a`
 * rather than a $0 bucket.
 */
export function normalizeOpenRouterEntries(snapshot: OpenRouterSnapshot, opts: { generatedAt: number }): PriceEntry[] {
  const out: PriceEntry[] = []
  for (const raw of snapshot.entries) {
    const rawModel = raw.model
    if (OPENROUTER_ROUTE_VARIANT.test(rawModel) || OPENROUTER_ROLLING_ALIAS.test(rawModel)) continue

    const pricing = raw.pricing
    if (typeof pricing !== 'object' || pricing === null) continue
    const slash = rawModel.indexOf('/')
    const reasoning = priceStrToPerMTok(pricing.internal_reasoning)

    out.push({
      provider: slash > 0 ? rawModel.slice(0, slash) : 'unknown',
      model: slash > 0 ? rawModel.slice(slash + 1) : rawModel,
      tier: null,
      inputPerMTok: priceStrToPerMTok(pricing.prompt),
      outputPerMTok: priceStrToPerMTok(pricing.completion),
      cacheReadPerMTok: priceStrToPerMTok(pricing.input_cache_read),
      cacheWritePerMTok: priceStrToPerMTok(pricing.input_cache_write),
      reasoningPerMTok: isMissingPrice(reasoning) ? null : reasoning,
      effectiveFrom: typeof raw.effective_from === 'number' ? raw.effective_from : opts.generatedAt,
      source: 'openrouter',
    })
  }
  return out
}

const DAY_MS = 86_400_000

/**
 * How old a snapshot is, in the words a report prints beside it. An undated table is not a
 * wrong one, but "priced off a table last refreshed four months ago" is the difference
 * between a cost figure and a bill, and no surface's numbers change unless somebody says it.
 */
export function snapshotAgePhrase(fetchedAt: number, now: number): string {
  if (!Number.isFinite(fetchedAt)) return 'fetched date unknown'
  const days = Math.floor((now - fetchedAt) / DAY_MS)
  return days <= 0 ? 'fetched today' : `fetched ${days}d ago`
}

const BUNDLED_SNAPSHOT_URL = new URL('./default-snapshot.json', import.meta.url)

let bundledCache: PriceSnapshot | null = null

/** The checked-in bootstrap snapshot; `pricing update` replaces it at the runtime cache path. */
export function bundledSnapshot(): PriceSnapshot {
  if (!bundledCache) {
    bundledCache = loadSnapshot(readFileSync(fileURLToPath(BUNDLED_SNAPSHOT_URL), 'utf8'))
  }
  return bundledCache
}

export { isMissingPrice, PRICE_MISSING }
