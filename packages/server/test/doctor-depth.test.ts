/**
 * GET /api/doctor's depth (§11) and its agreement with the CLI's fold (§14, §18 row 2).
 *
 * The served report used to apply one GLOBAL `request_max` to every agent, which is the
 * exact mistake §18 measured: for a `last_call_sum` agent it silently deletes tokens. These
 * tests run over synthetic rows in a temp DB and pin the per-agent fold rule, the mixed-fold
 * warning, and the three checks the web report used to be too shallow to make
 * (parser_version drift, subagent parent links, gone/rotated retention).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, setAgentAggregations, updateSourceProgress } from '@agentlens/storage'
import { harness } from './helpers.ts'

const HOME = '/home/tester'

function ev(over: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    schemaVersion: 1,
    agentId: 'codex',
    hostId: 'codex',
    sourceId: 'src-cx',
    sessionId: 'sess-cx',
    projectId: 'proj-1',
    timestamp: 1_700_000_000_000,
    type: 'message.assistant',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

const usage = (inputTokens: number, outputTokens: number): AgentEvent['usage'] => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

const rowFor = (body: any, id: string) => body.usageQuality.perAgent.find((r: { agentId: string }) => r.agentId === id)

let h: ReturnType<typeof harness> | null = null
afterEach(() => {
  h?.close()
  h = null
})

/** The harness fixture: claude-code with one request logged twice (1200 x2) plus 550. */
const CLAUDE_NAIVE = 2_950
const CLAUDE_FOLDED = 1_750

describe('GET /api/doctor usage fold (§18 row 2)', () => {
  it('folds each agent under its own persisted policy, not a global request_max', async () => {
    h = harness({ homedir: HOME })
    // Codex ships per-call rows carrying the SAME request id: a global MAX fold would
    // report 330 where the agent's own rule reports 550.
    insertEvents(h.seeded.db, [
      ev({ id: 'cx1', requestId: 'cx-req', usage: usage(200, 20) }),
      ev({ id: 'cx2', requestId: 'cx-req', usage: usage(300, 30), rawSeq: 2 }),
    ])
    setAgentAggregations(h.seeded.db, { codex: { mode: 'last_call_sum', subagentsIncluded: false } })

    const { body } = await h.get('/api/doctor')
    const codex = rowFor(body, 'codex')
    expect(codex.policy).toEqual({ mode: 'last_call_sum', subagentsIncluded: false })
    expect(codex.policySource).toBe('persisted')
    expect(codex.naive).toBe(550)
    expect(codex.folded).toBe(550)
    expect(codex.modelFolded).toBe(550)
    expect(codex.globalFolded).toBe(330)
    expect(codex.agrees).toBe(true)

    const claude = rowFor(body, 'claude-code')
    expect(claude.policy.mode).toBe('request_max')
    expect(claude.naive).toBe(CLAUDE_NAIVE)
    expect(claude.folded).toBe(CLAUDE_FOLDED)
    expect(claude.groups).toBe(2)

    // The headline totals follow the per-agent rules: a global fold would have said 2080.
    expect(body.usageQuality.naiveTokens).toBe(CLAUDE_NAIVE + 550)
    expect(body.usageQuality.dedupedTokens).toBe(CLAUDE_FOLDED + 550)
    expect(body.usageQuality.inflationAvoidedPct).toBeCloseTo((1 - (CLAUDE_FOLDED + 550) / (CLAUDE_NAIVE + 550)) * 100, 10)
    expect(body.usageQuality.modes).toEqual(['last_call_sum', 'request_max'])
  })

  it('keeps one fold per agent when nothing declared one, and flags a cube that disagrees', async () => {
    h = harness({ homedir: HOME })
    insertEvents(h.seeded.db, [ev({ id: 'lg1', agentId: 'legacy', requestId: 'q1', usage: usage(5, 5) })])
    const { body } = await h.get('/api/doctor')
    const legacy = rowFor(body, 'legacy')
    expect(legacy.policySource).toBe('default')
    expect(legacy.policy.mode).toBe('request_max')
    // Only claude-code actually duplicates usage, so only its agent is mixed-fold material.
    expect(body.usageQuality.modes).toEqual(['request_max'])
    expect(body.usageQuality.perAgent.every((r: { agrees: boolean }) => r.agrees)).toBe(true)
  })

  it('carries the whole-store buckets the per-agent rows add up to (§14)', async () => {
    h = harness({ homedir: HOME })
    const { body } = await h.get('/api/doctor')
    const sum = (k: string) => body.usageQuality.perAgent.reduce((a: number, r: any) => a + r[k], 0)
    expect(body.usageQuality.reported).toBe(sum('reported'))
    expect(body.usageQuality.estimated).toBe(sum('estimated'))
    expect(body.usageQuality.missing).toBe(sum('missing'))
    expect(body.usageQuality.withoutRequestId).toBe(sum('noRequestId'))
    expect(body.usageQuality.naiveTokens).toBe(sum('naive'))
    expect(body.usageQuality.dedupedTokens).toBe(sum('folded'))
  })
})

describe('GET /api/doctor checks the web used to lack (§11)', () => {
  it('reports parser_version drift against the injected adapter set', async () => {
    h = harness({
      homedir: HOME,
      adapters: async () => [{ id: 'claude-code', displayName: 'Claude Code', parserVersion: 7, aggregation: { mode: 'request_max', subagentsIncluded: true }, detect: async () => ({ present: false }) }] as any,
    })
    updateSourceProgress(h.seeded.db, {
      id: 'src-1',
      agentId: 'claude-code',
      path: '/home/tester/.claude/projects/p/a.jsonl',
      kind: 'jsonl',
      inode: 11,
      size: 10,
      mtimeMs: 1,
      lastOffset: 10,
      parserVersion: 5,
      sessionIdHint: null,
      status: 'gone',
      rowsIngested: 1,
      scanStartedAt: 0,
      scanFinishedAt: 1,
      lastError: null,
    })
    const { body } = await h.get('/api/doctor')
    expect(body.parsing.parserDrift).toMatchObject({ checked: 1, drifted: 1, unmapped: 0, stale: [{ agentId: 'claude-code', parserVersion: 5, sources: 1 }] })
    expect(body.retention).toMatchObject({ gone: 1, rotated: 0 })
    expect(body.subagents).toEqual([{ agentId: 'claude-code', total: 1, orphan: 0, orphanPct: 0 }])
  })

  it('says drift cannot be evaluated when no adapter is installed in this build', async () => {
    h = harness({ homedir: HOME })
    const { body } = await h.get('/api/doctor')
    expect(body.parsing.parserDrift.checked).toBe(0)
    // The fixture's two source rows are FK placeholders with no parser version at all:
    // nothing is stale, but nothing was verified either.
    expect(body.parsing.parserDrift.unmapped).toBe(0)
    expect(body.parsing.parserDrift.unscanned).toBe(2)
    expect(body.subagents).toEqual([{ agentId: 'claude-code', total: 1, orphan: 0, orphanPct: 0 }])
    expect(body.retention).toEqual({ gone: 0, rotated: 0, active: 2 })
  })
})
