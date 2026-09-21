import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-cli2-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function ev(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    schemaVersion: 1, agentId: 'claude-code', hostId: 'claude-desktop', sourceId: 'src-x',
    sessionId: 'sess-x', projectId: 'proj-x', timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end', usageSource: 'reported', status: 'ok', rawSeq: 1, rawOffset: 0,
    ...overrides,
  }
}

const usage = { inputTokens: 500_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const events: AgentEvent[] = [
  ev({ id: 'e1', requestId: 'r1', usage, model: { provider: 'anthropic', name: 'test-model-smoke' } }),
  ev({ id: 'e2', requestId: 'r1', usage, model: { provider: 'anthropic', name: 'test-model-smoke' } }), // duplicate block
  ev({ id: 'e3', type: 'tool.end', capability: { type: 'tool', name: 'Bash' }, durationMs: 1234, usage: null, usageSource: 'missing', rawSeq: 2 }),
  ev({ id: 'e4', type: 'hook.fire', capability: { type: 'hook', name: 'PreToolUse:Bash' }, durationMs: 50, usage: null, usageSource: 'missing', status: 'error', rawSeq: 3 }),
  ev({ id: 'e5', sessionId: 'sess-y', type: 'session.start', usage: null, usageSource: 'missing' }),
]

const db = openDatabase(dbPath)
migrate(db)
insertEvents(db, events)
db.close()

async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const ctx: Ctx = { argv: [...argv, '--db', dbPath], out: (l) => lines.push(l), err: (l) => lines.push(l), homedir: tmp, env: {}, now: () => Date.UTC(2026, 8, 21) }
  const code = await runCli(ctx)
  return { code, lines }
}

/** `--serve` stub: the suite must never bind a socket or launch a browser (§14). */
async function runServe(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  let opened = 0
  const ctx: Ctx = {
    argv: [...argv, '--db', dbPath],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
    serve: async () => {
      opened += 1
      return { url: 'http://localhost:7317', closed: Promise.resolve(), close: async () => {} }
    },
  }
  const code = await runCli(ctx)
  expect(opened).toBe(1)
  return { code, lines }
}

describe('command shells smoke', () => {
  it('bare command prints the §14-style summary (no adapters → clear message, no crash)', async () => {
    const { code, lines } = await run()
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('AgentLens')
    // Adapters ship in this build but none of their data roots exist under `tmp`.
    expect(out).toContain('no agents detected')
    expect(out).toContain('2 sessions')
    expect(out).toContain('502k tokens') // 500k + 2k deduped once, NOT 1.004M naive
    expect(out).not.toContain('1M tokens')
    expect(out).toContain('1 tool calls')
    expect(out).not.toContain('Dashboard')
  })

  it('--serve prints the dashboard URL from the injected serve handle', async () => {
    const { code, lines } = await runServe('--serve')
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('Dashboard → http://localhost:7317')
  })

  it('status / doctor / projects / tools / hooks / sessions all exit 0', async () => {
    for (const cmd of [['status'], ['doctor'], ['projects'], ['tools'], ['hooks'], ['sessions'], ['scan']]) {
      const { code, lines } = await run(...cmd)
      expect(code, `${cmd.join(' ')}: ${lines.join('\n')}`).toBe(0)
    }
  })

  it('doctor reports the dedup line and parse counters from real rows', async () => {
    const { lines } = await run('doctor')
    const out = lines.join('\n')
    expect(out).toContain('request_id dedup active')
    expect(out).toContain('inflation avoided')
    expect(out).toContain('events 5')
  })

  it('session <id> shows a metrics-only timeline and says so', async () => {
    const { code, lines } = await run('session', 'sess-x')
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('content layer off')
    expect(out).toContain('hook.fire')
    expect(out).toContain('tool.end')
  })

  it('export jsonl / csv / otel emit one line per event', async () => {
    const jsonl = await run('export', '--format', 'jsonl')
    expect(jsonl.code).toBe(0)
    expect(jsonl.lines.filter((l) => l.startsWith('{'))).toHaveLength(5)
    const csv = await run('export', '--format', 'csv')
    expect(csv.lines[0]).toContain('agent_id')
    const otel = await run('export', '--format', 'otel', '--agent', 'claude-code')
    const spans = otel.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { name: string; attributes: Record<string, unknown> })
    expect(spans).toHaveLength(5)
    expect(spans[0]!.name).toContain('chat') // generation.end -> "chat <model>" via otelSpanName
    expect(spans[0]!.attributes['gen_ai.usage.input_tokens']).toBe(500000)
    expect(spans[0]!.attributes['agentlens.host_id']).toBe('claude-desktop')
  })

  it('prune keeps events by default, trims payloads', async () => {
    const { code, lines } = await run('prune')
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('events are permanent by default')
  })
})
