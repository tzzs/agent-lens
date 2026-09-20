import { describe, expect, it } from 'vitest'
import {
  aggregateRequestTokens,
  dedupeByRequestId,
  isParseFailure,
  type AgentEvent,
} from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { ctxFor, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

async function eventsOf(name: string): Promise<AgentEvent[]> {
  const ctx = ctxFor(name)
  resetStateFor(ctx)
  const out: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result = await claudeCodeAdapter.normalize(record, ctx)
    if (!isParseFailure(result)) out.push(...result.events)
  }
  return out
}

/**
 * §1.5 rule 1 / §3.1: one API response is split per content block and every
 * duplicate carries the same usage, so the aggregate must equal ONE copy.
 */
describe('request_id dedupe through the adapter', () => {
  it('3 records of one response collapse to a single usage group', async () => {
    const all = await eventsOf('multi-block-usage.jsonl')
    const generations = all.filter((e) => e.type === 'generation.end')
    expect(generations).toHaveLength(3)
    expect(new Set(generations.map((e) => e.requestId))).toEqual(new Set(['req-mb-1']))

    const usage = {
      inputTokens: 8,
      outputTokens: 404,
      cacheReadTokens: 40551,
      cacheWriteTokens: 4164,
      reasoningTokens: 0,
    }
    for (const g of generations) expect(g.usage).toEqual(usage)

    const groups = dedupeByRequestId(generations)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.usage).toEqual(usage)

    const { deduped, naive, inflationRatio } = aggregateRequestTokens(generations)
    expect(deduped).toEqual(usage)
    expect(naive.inputTokens).toBe(usage.inputTokens * 3)
    expect(naive.cacheReadTokens).toBe(usage.cacheReadTokens * 3)
    const total = (u: typeof usage) =>
      u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
    expect(total(naive) / total(deduped)).toBeCloseTo(3, 10)
    expect(inflationRatio).toBeCloseTo(3, 10)
  })

  it('whole-fixture aggregate stays at one copy per requestId, including tool events', async () => {
    const all = await eventsOf('multi-block-usage.jsonl')
    const { deduped, naive } = aggregateRequestTokens(all)
    const total = (u: typeof deduped) =>
      u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
    expect(total(deduped)).toBe(8 + 404 + 40551 + 4164)
    expect(total(naive)).toBe(3 * (8 + 404 + 40551 + 4164))
  })

  it('a missing requestId degrades to a single-record group, never a shared one (§4.1)', async () => {
    const all = await eventsOf('legacy-task-entry.jsonl')
    const noReq = all.filter((e) => e.usage && e.requestId === null)
    expect(noReq).toHaveLength(0)
    const usageEvents = all.filter((e) => e.usage)
    const groups = dedupeByRequestId(usageEvents)
    expect(groups.length).toBe(usageEvents.length)
  })

  it('side chains bill independently of the parent request (§2.3)', async () => {
    const all = await eventsOf('agent-subagent-chain.jsonl')
    const side = all.filter((e) => e.type === 'generation.end' && e.requestId === 'req-sa-side-1')
    const main = all.filter((e) => e.type === 'generation.end' && e.requestId === 'req-sa-main-1')
    expect(side).toHaveLength(1)
    expect(main).toHaveLength(1)
    expect(side[0]?.usage).toEqual({
      inputTokens: 512,
      outputTokens: 640,
      cacheReadTokens: 2048,
      cacheWriteTokens: 128,
      reasoningTokens: 0,
    })
    const { deduped } = aggregateRequestTokens([...side, ...main])
    expect(deduped.inputTokens).toBe(512 + 40)
  })
})
