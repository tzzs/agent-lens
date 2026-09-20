import { normalizeModelName } from './table.ts'

export interface Gap {
  provider: string
  model: string
  firstSeen: number
  lastSeen: number
  occurrences: number
}

/** Accumulator of (provider, model) pairs that failed pricing; feeds the `doctor` Pricing block (§11). */
export class PricingGaps {
  private readonly gaps = new Map<string, Gap>()

  record(provider: string, model: string, occurredAt: number): void {
    const key = `${provider.toLowerCase()}|${normalizeModelName(model)}`
    const existing = this.gaps.get(key)
    if (existing) {
      existing.occurrences += 1
      existing.firstSeen = Math.min(existing.firstSeen, occurredAt)
      existing.lastSeen = Math.max(existing.lastSeen, occurredAt)
    } else {
      this.gaps.set(key, { provider, model, firstSeen: occurredAt, lastSeen: occurredAt, occurrences: 1 })
    }
  }

  list(): Gap[] {
    return [...this.gaps.values()].sort((a, b) => b.occurrences - a.occurrences || a.model.localeCompare(b.model))
  }

  count(): number {
    return this.gaps.size
  }
}
