/**
 * §14 at the cost headline. The terminal's `agl usage` total line and the dashboard's cost card
 * read one store, and both fall back through three rungs when part of that window has no price:
 * the complete answer, then the priced portion re-folded per model, then what the agent logged.
 * Three rungs is three chances for the two surfaces to disagree, and they did: the dashboard
 * printed `≥ $0.00` for a window whose priced half the terminal also refused to show.
 *
 * So this test drives BOTH ends over one DB file and one overrides file and compares the numbers
 * they print, not the functions they call.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { PRICING_OVERRIDES_FILENAME } from '@agentlens/pricing'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { createApp, priceTableFor } from '@agentlens/server'
import { CLI_FLAG_SCHEMA, parseArgs } from '../src/args.ts'
import type { Ctx } from '../src/context.ts'
import { cmdUsage } from '../src/commands/usage.ts'

const DIR = mkdtempSync(join(tmpdir(), 'agentlens-cost-agreement-'))
const DB_PATH = join(DIR, 'agentlens.db')
const T0 = 1_700_000_000_000

const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

function ev(id: string, model: { provider: string; name: string }): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'codex',
    hostId: 'cli',
    sourceId: 'src-1',
    sessionId: 'sess-1',
    projectId: 'proj-1',
    timestamp: T0,
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: Number(id),
    rawOffset: 0,
    requestId: `req-${id}`,
    model,
    usage,
  } as AgentEvent
}

const db = openDatabase(DB_PATH)
migrate(db)
// One model the user pinned a price for, one the price table has never heard of. Nothing was
// reported by the agent, so the reported rung contributes nothing and the floor IS the portion.
insertEvents(db, [ev('1', { provider: 'anthropic', name: 'pinned-model' }), ev('2', { provider: 'nope', name: 'unobtainium' })])
writeFileSync(
  join(DIR, PRICING_OVERRIDES_FILENAME),
  `${JSON.stringify({
    provider: 'anthropic',
    model: 'pinned-model',
    inputPerMTok: 1,
    outputPerMTok: 1,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 1,
    reasoningPerMTok: null,
    effectiveFrom: 0,
    source: 'override',
  })}\n`,
  'utf8',
)

afterAll(() => {
  db.close()
  rmSync(DIR, { recursive: true, force: true })
})

describe('§14 the cost floor the terminal prints is the floor the dashboard prints', () => {
  let cliLine = ''
  let cost: any

  beforeAll(async () => {
    const lines: string[] = []
    const ctx = {
      argv: [],
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      homedir: DIR,
      env: {},
      now: () => T0 + 86_400_000,
    } satisfies Ctx
    const { flags } = parseArgs(['usage', '--by', 'model', '--since', '9999d', '--db', DB_PATH], CLI_FLAG_SCHEMA)
    expect(cmdUsage(db, flags, ctx, DB_PATH)).toBe(0)
    cliLine = lines.find((l) => l.startsWith('total: ')) ?? '(no total line)'

    // `createContext` wires billing from the store path but pricing comes from `startServer`
    // (serve.ts builds the table with `priceTableFor`), so the served half is assembled the way
    // the real `agl --serve` assembles it rather than being handed a fake resolver.
    const pricing = priceTableFor(DB_PATH)
    const app = createApp({
      db,
      dbPath: DB_PATH,
      now: () => T0 + 86_400_000,
      homedir: DIR,
      priceResolver: (provider: string, model: string, at: number) => pricing.table.lookup(provider, model, at),
    })
    const res = await app.request('/api/overview?since=9999d')
    expect(res.status).toBe(200)
    cost = (await res.json()).cards.cost
  })

  it('both surfaces price the half they can and mark the rest unknown', () => {
    expect(cost.totalUsd).toBeCloseTo(1, 10) // $1/M x 1M of the priced model, not $0 and not $2
    expect(cost.apiEquivalentUsd).toBeCloseTo(1, 10)
    expect(cost.totalPartial).toBe(true)
    expect(cost.apiEquivalentPartial).toBe(true)
    expect(cost.unpricedAgents).toEqual(['codex'])
    expect(cliLine).toContain('≥ $1.00 cost (partly unpriced)')
    expect(cliLine).toContain('≥ $1.00 api-equiv (partly unpriced)')
  })

  it('the two printed figures are the same number, read back out of the text', () => {
    const fromCli = Number(/≥ \$([\d.]+) cost/.exec(cliLine)?.[1])
    const fromServed = Number(cost.totalUsd.toFixed(2))
    expect(fromCli).toBeCloseTo(fromServed, 2)
    const cliApi = Number(/≥ \$([\d.]+) api-equiv/.exec(cliLine)?.[1])
    expect(cliApi).toBeCloseTo(Number(cost.apiEquivalentUsd.toFixed(2)), 2)
  })

  it('does not turn a window with nothing priced into money', () => {
    // The same store, with the override removed: every rung is empty, so the floor must stay
    // `n/a` on both ends rather than degrade to the $0 it would otherwise print.
    writeFileSync(join(DIR, PRICING_OVERRIDES_FILENAME), '', 'utf8')
    const lines: string[] = []
    const ctx = { argv: [], out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), homedir: DIR, env: {}, now: () => T0 + 86_400_000 }
    const { flags } = parseArgs(['usage', '--by', 'model', '--since', '9999d', '--db', DB_PATH], CLI_FLAG_SCHEMA)
    expect(cmdUsage(db, flags, ctx as Ctx, DB_PATH)).toBe(0)
    const total = (lines.find((l) => l.startsWith('total: ')) ?? '').replace(/\s+/g, ' ')
    expect(total).toContain('n/a cost')
    expect(total).toContain('n/a api-equiv')
    expect(total).not.toMatch(/≥ \$0\.00/)
  })
})
