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
  [extra: string]: unknown
}

export interface PriceSnapshot {
  schemaVersion?: number
  fetchedAt: number
  source: string
  entries: RawLitellmEntry[]
}

export class PricingDataError extends Error {
  override readonly name = 'PricingDataError'
}

const PER_MTOK = 1_000_000

/** litellm publishes budget-priced duplicates (`*-budget`); they are aliases, not models. */
const BUDGET_KEY = /[-_]budget\b/i

function toPerMTok(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v * PER_MTOK : PRICE_MISSING
}

/**
 * Litellm's upstream file is one flat object (model id → cost dict). Wrap it in
 * our own snapshot envelope so fetchedAt/source/schema travel with the data.
 */
export function litellmRawMapToSnapshot(raw: Record<string, unknown>, opts: { fetchedAt: number; source: string }): PriceSnapshot {
  const entries: RawLitellmEntry[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue
    entries.push({ ...(value as object), model: key } as RawLitellmEntry)
  }
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, fetchedAt: opts.fetchedAt, source: opts.source, entries }
}

export function loadSnapshot(json: string): PriceSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new PricingDataError(`price snapshot is not valid JSON: ${(e as Error).message}`)
  }
  const s = parsed as Partial<PriceSnapshot> | null
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
