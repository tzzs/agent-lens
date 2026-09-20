import { normalizeLitellmEntries, type PriceSnapshot } from './snapshot.ts'
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

const SOURCE_PRIORITY: Record<PriceEntry['source'], number> = { litellm: 0, manual: 1, override: 2 }

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
    return new PricingTable([...this.allEntries(), { ...entry, source: entry.source === 'litellm' ? 'override' : entry.source }])
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
