/**
 * §18 row 4 — the cache-token dialect, and the ONE place a cross-agent number can silently
 * double-count. Codex names them `cached_input_tokens` / `cache_write_input_tokens` AND its
 * `input_tokens` already contains the cached prefix, which is the opposite of Anthropic.
 * The shared column is priced as net input (packages/pricing/cost.ts bills
 * `input_tokens` at inputPerMTok and `cache_read_tokens` at cacheReadPerMTok separately),
 * so the adapter must emit the remainder.
 */
import { describe, expect, it } from 'vitest'
import { aggregateUsage, type AgentEvent } from '@agentlens/event-model'
import { CODEX_AGGREGATION, codexAdapter } from '../src/index.ts'
import { usageRow } from '../src/record.ts'
import { ctxFor, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

async function eventsOf(name: string): Promise<AgentEvent[]> {
  const ctx = ctxFor(name)
  resetStateFor(ctx)
  const out: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result = await codexAdapter.normalize(record, ctx)
    if ('failure' in result) continue
    out.push(...result.events)
  }
  return out
}

describe('cache-token dialect (§18 row 4)', () => {
  it('a cached-heavy Codex call does not count the cached prefix twice', async () => {
    const events = await eventsOf('cached-heavy-call.jsonl')
    const call = events.find((e) => e.rawSeq === 3)
    expect(call?.usage).toEqual({
      inputTokens: 4000, // 100000 reported − 96000 cached
      outputTokens: 500,
      cacheReadTokens: 96000,
      cacheWriteTokens: 1200,
      reasoningTokens: 200,
    })
    // The reported (cache-inclusive) value stays visible for audit, never as `usage`.
    expect(call?.metadata?.reported_input_tokens).toBe(100000)
    expect(call?.metadata?.cached_input_tokens).toBe(96000)

    const u = call!.usage!
    // The invariant: emitted input + emitted cacheRead reproduces exactly what Codex
    // reported once. Passing the reported value through as `inputTokens` would have
    // counted 196000 prompt tokens for a 100000-token call (1.96x, cache-only rows).
    expect(u.inputTokens + u.cacheReadTokens).toBe(call?.metadata?.reported_input_tokens)
  })

  it('the fold over a cached-heavy thread equals the non-overlapping union of fields', async () => {
    const usageRows = (await eventsOf('cached-heavy-call.jsonl')).filter((e) => e.usage)
    expect(usageRows).toHaveLength(2)
    const folded = aggregateUsage(usageRows, CODEX_AGGREGATION).usage
    // 100000 + 200 reported input, of which 96000 + 0 is cache read.
    expect(folded.inputTokens).toBe(4200)
    expect(folded.cacheReadTokens).toBe(96000)
    expect(folded.inputTokens + folded.cacheReadTokens).toBe(100200)
  })

  it('a pure cache-dialect record maps every field exactly once', () => {
    const row = usageRow({
      input_tokens: 1000,
      cached_input_tokens: 1000,
      cache_write_input_tokens: 5,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 1010,
    })
    expect(row?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 10,
      cacheReadTokens: 1000,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
    })
    expect(row?.reportedInputTokens).toBe(1000)
  })

  it('input never goes negative when a source over-reports cache', () => {
    const row = usageRow({ input_tokens: 100, cached_input_tokens: 400, output_tokens: 7 })
    expect(row?.usage.inputTokens).toBe(0)
    expect(row?.usage.cacheReadTokens).toBe(400)
  })

  it('reasoning-vs-output containment is decided from the record, not guessed', async () => {
    const events = await eventsOf('cached-heavy-call.jsonl')
    // total 100500 == input 100000 + output 500, with 200 reasoning → inside output.
    expect(events.find((e) => e.rawSeq === 3)?.metadata?.reasoning_overlap).toBe('included-in-output')
    // total 275 == 200 + 50 + 25 → reported as its own bucket.
    expect(events.find((e) => e.rawSeq === 4)?.metadata?.reasoning_overlap).toBe('separate')
  })
})
