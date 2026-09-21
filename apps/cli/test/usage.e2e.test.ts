import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-cli-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function ev(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-e2e',
    sessionId: 'sess-e2e',
    projectId: 'proj-e2e',
    timestamp: Date.UTC(2026, 8, 20, 10),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...overrides,
  }
}

// Two records of ONE response (§3.1): repeated usage must count once.
const usage = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const events: AgentEvent[] = [
  ev({ id: 'a'.repeat(64), requestId: 'req-1', usage, model: { provider: 'anthropic', name: 'test-model-e2e' } }),
  ev({ id: 'b'.repeat(64), requestId: 'req-1', usage, model: { provider: 'anthropic', name: 'test-model-e2e' } }),
]

function seedDb() {
  const db = openDatabase(dbPath)
  migrate(db)
  insertEvents(db, events)
  db.close()
}

function makeCtx(argv: string[]): { ctx: Ctx; lines: string[] } {
  const lines: string[] = []
  const ctx: Ctx = {
    argv,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
  }
  return { ctx, lines }
}

describe('agentlens usage --by model (e2e against a temp db file)', () => {
  it('prints deduped tokens, not the naive sum; unpriced model shows n/a', async () => {
    seedDb()
    const { ctx, lines } = makeCtx(['usage', '--by', 'model', '--db', dbPath])
    const code = await runCli(ctx)
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('test-model-e2e')
    // deduped: 1 request -> 100 in / 40 out / 140 total; naive would be 200/80/280
    expect(out).toMatch(/Model\s+Events\s+Sessions\s+Tokens\s+Input\s+Output\s+CacheR\s+Cost/)
    expect(out).toContain('140')
    expect(out).not.toContain('280')
    expect(out).toContain('n/a') // unpriced model is n/a, never $0 (§8)
    expect(out).toContain('total: 2 events · 1 sessions · 140 tokens (deduped) · n/a cost · n/a api-equiv')
  })

  it('pricing override then usage renders a real cost', async () => {
    const o = makeCtx([
      'pricing', 'override', '--db', dbPath,
      '--model', 'test-model-e2e', '--provider', 'anthropic',
      '--input', '3', '--output', '15',
    ])
    expect(await runCli(o.ctx)).toBe(0)
    expect(o.lines.join('\n')).toContain('override saved')

    const { ctx, lines } = makeCtx(['usage', '--by', 'model', '--db', dbPath])
    expect(await runCli(ctx)).toBe(0)
    const out = lines.join('\n')
    // 100 * 3/M + 40 * 15/M = 0.0003 + 0.0006 = 0.0009
    expect(out).toContain('$0.0009')
    expect(out).not.toContain('n/a')
  })

  it('unknown --by dim exits 2 (usage error)', async () => {
    const { ctx, lines } = makeCtx(['usage', '--by', 'zodiac', '--db', dbPath])
    expect(await runCli(ctx)).toBe(2)
    expect(lines.join('\n')).toContain('unknown dim')
  })

  it('--explain prints the resolved cube call', async () => {
    const { ctx, lines } = makeCtx(['usage', '--by', 'day', '--since', '2026-09-01', '--explain', '--db', dbPath])
    expect(await runCli(ctx)).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('metrics:')
    // §18: the fold口径 must be visible in --explain, per agent, never implied
    expect(out).toContain('aggregation policy')
    expect(out).toContain('request_max')
  })

  it('unknown command exits 2; unknown flag exits 2', async () => {
    expect(await runCli(makeCtx(['frobnicate', '--db', dbPath]).ctx)).toBe(2)
    expect(await runCli(makeCtx(['usage', '--nope', 'x', '--db', dbPath]).ctx)).toBe(2)
  })
})

describe('agl usage --no-subagents (§18 row 3 explicit switch)', () => {
  const subDb = join(tmp, 'usage-subagents.db')
  const subUsage = { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

  it('default keeps subagent rows and prints no exclusion label; the flag drops them and says so', async () => {
    const db = openDatabase(subDb)
    migrate(db)
    insertEvents(db, [
      ev({ id: 'p'.repeat(64), requestId: 'req-p', usage, model: { provider: 'anthropic', name: 'test-model-e2e' } }),
      ev({
        id: 'q'.repeat(64),
        requestId: 'req-q',
        usage: subUsage,
        model: { provider: 'anthropic', name: 'test-model-e2e' },
        metadata: { subagentThread: true },
      }),
    ])
    db.close()

    const plain = makeCtx(['usage', '--by', 'session', '--db', subDb])
    expect(await runCli(plain.ctx)).toBe(0)
    const plainOut = plain.lines.join('\n')
    // include-by-default is deliberate (spec.ts); the number then needs no label.
    expect(plainOut).toContain('total: 2 events · 1 sessions · 640 tokens (deduped)')
    expect(plainOut).not.toContain('subagent')

    const ex = makeCtx(['usage', '--by', 'session', '--no-subagents', '--db', subDb])
    expect(await runCli(ex.ctx)).toBe(0)
    const out = ex.lines.join('\n')
    expect(out).toContain('total: 1 events · 1 sessions · 140 tokens (deduped)')
    // §14: the printed 口径 must match the number — an excluded total says so.
    expect(out).toContain('subagent threads excluded')

    const explained = makeCtx(['usage', '--no-subagents', '--explain', '--db', subDb])
    expect(await runCli(explained.ctx)).toBe(0)
    expect(explained.lines.join('\n')).toContain('includeSubagentThreads=false')
  })
})
