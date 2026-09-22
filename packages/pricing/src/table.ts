import { normalizeLitellmEntries, normalizeOpenRouterEntries, type OpenRouterSnapshot, type PriceSnapshot } from './snapshot.ts'
import type { PriceEntry } from './price-types.ts'

/**
 * Keys agents put in logs are messier than litellm ids: bracket forms
 * (`claude-opus-4-8[1m]`) and tier suffixes (`gpt-5:low`). Strip them for
 * matching; the raw `entry.model` is kept for display.
 */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[:@].*$/, '')
    .trim()
}

/**
 * Highest wins among entries effective at the same date. `openrouter` sits below
 * `litellm` because its published rate is a reseller route price, not the vendor list
 * price §8's API-equivalent is quoted at — it is a fallback, and `withGapFill` is what
 * keeps it out of litellm's way even before this tie-break is reached.
 */
const SOURCE_PRIORITY: Record<PriceEntry['source'], number> = {
  openrouter: 0,
  litellm: 1,
  manual: 2,
  override: 3,
}

/** Sources that come from an upstream price file rather than from the user. */
const SNAPSHOT_SOURCES: ReadonlySet<PriceEntry['source']> = new Set(['litellm', 'openrouter'])

function candidateKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}|${normalizeModelName(model)}`
}

export class PricingTable {
  private readonly byProviderModel: Map<string, PriceEntry[]>
  private readonly byModel: Map<string, PriceEntry[]>

  private constructor(entries: Iterable<PriceEntry>) {
    this.byProviderModel = new Map()
    this.byModel = new Map()
    for (const e of entries) {
      push(this.byProviderModel, candidateKey(e.provider, e.model), e)
      push(this.byModel, normalizeModelName(e.model), e)
    }
    for (const list of [...this.byProviderModel.values(), ...this.byModel.values()]) {
      list.sort(byEffectiveDate)
    }
  }

  static fromSnapshot(snapshot: PriceSnapshot, opts: { generatedAt?: number } = {}): PricingTable {
    return new PricingTable(
      normalizeLitellmEntries(snapshot, { generatedAt: opts.generatedAt ?? snapshot.fetchedAt }),
    )
  }

  static fromOpenRouterSnapshot(snapshot: OpenRouterSnapshot, opts: { generatedAt?: number } = {}): PricingTable {
    return new PricingTable(
      normalizeOpenRouterEntries(snapshot, { generatedAt: opts.generatedAt ?? snapshot.fetchedAt }),
    )
  }

  static empty(): PricingTable {
    return new PricingTable([])
  }

  /** Entry with the greatest effectiveFrom <= occurredAt, or null if unpriced at that time. */
  lookup(provider: string, model: string, occurredAt: number): PriceEntry | null {
    const key = candidateKey(provider, model)
    let list = this.byProviderModel.get(key)
    if (!list) {
      // Providers disagree about prefixes (logs often say 'unknown'); fall back to a
      // model-name match when it is unambiguous.
      const anyProvider = this.byModel.get(normalizeModelName(model))
      if (!anyProvider) return null
      const providers = new Set(anyProvider.map((e) => e.provider.toLowerCase()))
      if (providers.size > 1) return null
      list = anyProvider
    }
    return pickEffective(list, occurredAt)
  }

  models(): string[] {
    return [...new Set([...this.byModel.values()].flat().map((e) => e.model))].sort()
  }

  /** Distinct (provider, model) pairs priced. */
  size(): number {
    return this.byProviderModel.size
  }

  /** Immutable: returns a new table where `entry` wins ties against litellm data. */
  withOverride(entry: PriceEntry): PricingTable {
    // A line from the overrides file is the user's own statement, even when they pasted it
    // out of a snapshot with its source label still attached.
    const source = SNAPSHOT_SOURCES.has(entry.source) ? 'override' : entry.source
    return new PricingTable([...this.allEntries(), { ...entry, source }])
  }

  /**
   * Immutable: admit `fallback`'s entries ONLY for models this table has no price for (§8).
   *
   * Matching is by model name rather than the (provider, model) key because `lookup` already
   * falls back to a name-only match when the log's provider disagrees, so a second provider
   * for an already-priced name would both override litellm through that path and trip its
   * ambiguity guard (>1 provider → no price), turning priced history into gaps.
   */
  withGapFill(fallback: PricingTable): { table: PricingTable; added: number } {
    const priced = new Set(this.byModel.keys())
    const added = [...fallback.allEntries()].filter((e) => !priced.has(normalizeModelName(e.model)))
    return { table: new PricingTable([...this.allEntries(), ...added]), added: added.length }
  }

  private *allEntries(): Generator<PriceEntry> {
    for (const list of this.byProviderModel.values()) yield* list
  }
}

const byEffectiveDate = (a: PriceEntry, b: PriceEntry): number =>
  a.effectiveFrom - b.effectiveFrom || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]

function push(map: Map<string, PriceEntry[]>, key: string, entry: PriceEntry): void {
  const list = map.get(key)
  if (list) list.push(entry)
  else map.set(key, [entry])
}

function pickEffective(sortedAsc: PriceEntry[], occurredAt: number): PriceEntry | null {
  let best: PriceEntry | null = null
  for (const e of sortedAsc) {
    if (e.effectiveFrom > occurredAt) break
    if (!best || e.effectiveFrom >= best.effectiveFrom) best = e
  }
  return best
}
