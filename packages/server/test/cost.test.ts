/**
 * The §8 read model on top of the §18 row 1 fused metric: `costView.totalUsd`
 * must come from the cube's `cost_total`, not from the route adding a reported
 * cost onto a priced estimate of the same work, and `parseSpec` is the only
 * place the wire vocabulary (metric names, the subagent switch) is validated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { createContext } from '../src/app.ts'
import { costView } from '../src/cost.ts'
import { parseSpec } from '../src/request-spec.ts'
import { testPriceResolver } from './helpers.ts'

function ev(id: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'cli',
    sourceId: 'src-cost',
    sessionId: 'sess-cost',
    projectId: 'proj-cost',
    timestamp: 1_700_000_000_000,
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 0,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

const MODEL = { provider: 'anthropic', name: 'test-model' } // TEST_PRICE: 1 USD per 1M tokens
const usage = (t: number) => ({ inputTokens: t, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

const events: AgentEvent[] = [
  // OpenCode-shaped row: its reported cost and its tokens describe the SAME work.
  // 2M input would price at $2; the agent says it cost $0.40.
  ev('oc1', { agentId: 'opencode', requestId: 'oc-r1', model: MODEL, usage: usage(2_000_000), costReported: 0.4, costSource: 'reported' }),
  // A subagent thread that reported its own slice: excludable via the §18 row 3 switch.
  ev('oc2', { agentId: 'opencode', requestId: 'oc-r2', model: MODEL, usage: usage(1_000_000), costReported: 0.1, costSource: 'reported', metadata: { subagentThread: true } }),
  // Claude-shaped row: no report, only priceable tokens.
  ev('cc1', { requestId: 'cc-r1', model: MODEL, usage: usage(1_000_000) }),
]

let db: DatabaseSync
beforeAll(() => {
  db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, events)
})
afterAll(() => db.close())

const ctx = () => createContext({ db, now: () => 1_700_000_100_000, priceResolver: testPriceResolver })

describe('costView reads the fused cost from the cube (§18 row 1)', () => {
  it('totalUsd is reported-where-reported + priced-where-not, never the hand-added pair', () => {
    const view = costView(ctx())
    const oc = view.perAgent.find((s) => s.agentId === 'opencode')
    const cc = view.perAgent.find((s) => s.agentId === 'claude-code')
    expect(oc?.apiEquivalentUsd).toBeCloseTo(3, 10) // every token priced, unchanged
    expect(oc?.reportedUsd).toBeCloseTo(0.5, 10) // raw SUM, unchanged
    expect(oc?.totalUsd).toBeCloseTo(0.5, 10) // reports exist: no priced slice for opencode
    expect(cc?.totalUsd).toBeCloseTo(1, 10) // no report: priced
    expect(view.totalUsd).toBeCloseTo(1.5, 10) // NOT 0.5+3+1=4.5 (the double count the fusion forbids)
    expect(view.totalPartial).toBe(false)
    expect(view.basis).toContain('cost_total')
  })

  it('the subagent switch flows through to the fused figure', () => {
    const ex = costView(ctx(), { includeSubagentThreads: false })
    const opencode = ex.perAgent.find((s) => s.agentId === 'opencode')
    expect(opencode?.totalUsd).toBeCloseTo(0.4, 10) // oc2 dropped, its report cannot be added twice
    expect(ex.reportedUsd).toBeCloseTo(0.4, 10)
    expect(ex.totalUsd).toBeCloseTo(1.4, 10)
  })
})

describe('parseSpec wire vocabulary', () => {
  const sp = (q: string) => new URLSearchParams(q)

  it('cost_total is a real metric now, orderable like any other', () => {
    const spec = parseSpec(sp('metrics=cost_total&order=metric:cost_total:desc'), db)
    expect(spec.metrics).toEqual(['cost_total'])
    expect(spec.order).toBe('metric:cost_total:desc')
  })

  it('subagents=exclude|include sets the cube filter; anything else is a 400', () => {
    expect(parseSpec(sp('subagents=exclude'), db).filter?.includeSubagentThreads).toBe(false)
    expect(parseSpec(sp('subagents=include'), db).filter?.includeSubagentThreads).toBe(true)
    expect(parseSpec(sp('metrics=events'), db).filter?.includeSubagentThreads).toBeUndefined() // default untouched
    expect(() => parseSpec(sp('subagents=sometimes'), db)).toThrow(/subagents/)
  })
})
