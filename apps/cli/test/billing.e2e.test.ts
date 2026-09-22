/**
 * §8 billing-mode declaration from the CLI, e2e against a temp DB file. Two things
 * are pinned here: the command writes the same store the cube reads (§14 — one
 * source of truth, so `--serve` cannot disagree with the terminal), and a `local`
 * agent's tokens keep pricing out as an API-equivalent instead of collapsing to $0.
 * Synthetic events only.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'
import { queryDeps } from '../src/context.ts'
import { configPath, loadBillingModes } from '../src/pricing-store.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-billing-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function ev(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-billing',
    sessionId: 'sess-billing',
    projectId: 'proj-billing',
    timestamp: Date.UTC(2026, 8, 20, 10),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...overrides,
  }
}

// 1M in / 1M out at the $3/$15 override below = $3 + $15 = $18 api-equivalent.
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const events: AgentEvent[] = [
  ev({ id: 'a'.repeat(64), requestId: 'req-1', usage, model: { provider: 'anthropic', name: 'test-model-billing' } }),
]

function makeCtx(argv: string[]): { ctx: Ctx; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    ctx: { argv, out: (l) => lines.push(l), err: (l) => lines.push(l), homedir: tmp, env: {}, now: () => Date.UTC(2026, 8, 21) },
  }
}

describe('agentlens pricing billing (declaration surface, §8)', () => {
  it('seeds: an unpriced model reads n/a, and a price override makes it $18', async () => {
    const db = openDatabase(dbPath)
    migrate(db)
    insertEvents(db, events)
    db.close()

    const o = makeCtx([
      'pricing', 'override', '--db', dbPath,
      '--model', 'test-model-billing', '--provider', 'anthropic', '--input', '3', '--output', '15',
    ])
    expect(await runCli(o.ctx)).toBe(0)

    const u = makeCtx(['usage', '--by', 'agent', '--db', dbPath])
    expect(await runCli(u.ctx)).toBe(0)
    expect(u.lines.join('\n')).toContain('$18.00')
  })

  it('set writes the declaration store the cube reads, and an undeclared agent defaults to api', async () => {
    const s = makeCtx(['pricing', 'billing', 'set', 'claude-code', 'subscription', '--db', dbPath])
    expect(await runCli(s.ctx)).toBe(0)
    expect(s.lines.join('\n')).toContain('subscription')
    expect(loadBillingModes(dbPath)).toEqual({ 'claude-code': 'subscription' })
    // The documented file shape, since the server route writes the same one.
    expect(JSON.parse(readFileSync(configPath(dbPath), 'utf8'))).toEqual({ billing: { 'claude-code': 'subscription' } })

    const l = makeCtx(['pricing', 'billing', 'list', '--db', dbPath])
    expect(await runCli(l.ctx)).toBe(0)
    const out = l.lines.join('\n')
    expect(out).toMatch(/claude-code\s+subscription/)
    expect(out).toContain('declared')
  })

  it('a live queryDeps view (what --serve holds) picks the declaration up without a restart', async () => {
    const db = openDatabase(dbPath)
    const ctx = makeCtx(['pricing', 'billing', 'list', '--db', dbPath]).ctx
    const deps = queryDeps(db, dbPath, ctx)
    expect(deps.billingModeFor!('claude-code')).toBe('subscription')
    expect(deps.billingModeFor!('never-scanned')).toBe('api')
    expect(await runCli(makeCtx(['pricing', 'billing', 'set', 'claude-code', 'local', '--db', dbPath]).ctx)).toBe(0)
    expect(deps.billingModeFor!('claude-code')).toBe('local')
    db.close()
  })

  it('local: cash is $0 while the same tokens still price out as api-equivalent (§8 table)', async () => {
    const u = makeCtx(['usage', '--by', 'agent', '--db', dbPath])
    expect(await runCli(u.ctx)).toBe(0)
    // §8 asks for both numbers at once: `cost` follows the declared mode (a local model
    // costs no cash per token), `api-equiv` is what the identical tokens would have cost
    // against the price table. Before the §8 fix the local agent collapsed the second one
    // too, and 18 dollars of token volume vanished from the terminal.
    const out = u.lines.join('\n')
    expect(out).toContain('$18.00')
    expect(out).toContain('$0.00')
    expect(out).toMatch(/total: .*\$0\.00 cost · \$18\.00 api-equiv/)
  })

  it('clear removes the declaration and the agent falls back to the default', async () => {
    const c = makeCtx(['pricing', 'billing', 'clear', 'claude-code', '--db', dbPath])
    expect(await runCli(c.ctx)).toBe(0)
    expect(c.lines.join('\n')).toContain('cleared')
    expect(loadBillingModes(dbPath)).toEqual({})

    const l = makeCtx(['pricing', 'billing', 'list', '--db', dbPath])
    expect(await runCli(l.ctx)).toBe(0)
    expect(l.lines.join('\n')).toMatch(/claude-code\s+api\s+default/)
  })

  it('an invalid mode exits 2 naming the accepted set; an unknown agent exits 2', async () => {
    const bad = makeCtx(['pricing', 'billing', 'set', 'claude-code', 'payg', '--db', dbPath])
    expect(await runCli(bad.ctx)).toBe(2)
    expect(bad.lines.join('\n')).toContain('api | subscription | local')
    expect(loadBillingModes(dbPath)).toEqual({})

    const ghost = makeCtx(['pricing', 'billing', 'set', 'no-such-agent', 'local', '--db', dbPath])
    expect(await runCli(ghost.ctx)).toBe(2)
    expect(ghost.lines.join('\n')).toContain('no-such-agent')
    expect(ghost.lines.join('\n')).toContain('claude-code')
    expect(loadBillingModes(dbPath)).toEqual({})
  })

  it('a missing subcommand or operand exits 2', async () => {
    for (const argv of [['pricing', 'billing'], ['pricing', 'billing', 'set', 'claude-code'], ['pricing', 'frobnicate']]) {
      const c = makeCtx([...argv, '--db', dbPath])
      expect(await runCli(c.ctx)).toBe(2)
      const out = c.lines.join('\n')
      expect(out).toContain('billing')
      expect(out).toMatch(/set <agent> <mode>/)
    }
    expect(loadBillingModes(dbPath)).toEqual({})
  })
})
