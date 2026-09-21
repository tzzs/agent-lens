/**
 * §9's capability shells. `tools` and `hooks` were already smoked; the remaining shells
 * are the same function over a different dim, and the dim trap (§18's capability note:
 * every other kind yields '' for a capability dim) is per-command, so each one needs its
 * own test. Numbers are cross-checked against the cube the Web queries, so CLI and Web
 * cannot print two different call counts for one fact (§14).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent, CapabilityType, EventType } from '@agentlens/event-model'
import { query } from '@agentlens/query'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-caps-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 8, 20, 9)

/** kind → the shell command §9 maps it to, and the event type its adapter emits. */
const SHELLS: { command: string; kind: CapabilityType; type: EventType; name: string }[] = [
  { command: 'skills', kind: 'skill', type: 'skill.invoke', name: 'test-skill-alpha' },
  { command: 'mcp', kind: 'mcp', type: 'mcp.invoke', name: 'test-mcp-beta' },
  { command: 'plugins', kind: 'plugin', type: 'plugin.invoke', name: 'test-plugin-gamma' },
  { command: 'connectors', kind: 'connector', type: 'connector.invoke', name: 'test-connector-delta' },
  { command: 'subagents', kind: 'subagent', type: 'subagent.start', name: 'test-subagent-epsilon' },
  { command: 'commands', kind: 'command', type: 'command.execute', name: 'test-command-zeta' },
]

function ev(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-caps',
    sessionId: 'sess-caps',
    projectId: 'proj-caps',
    timestamp: T0,
    type: 'message.assistant',
    usageSource: 'missing',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...overrides,
  }
}

/** Two calls per capability, the second one failing, so counts and the Errors column both bite. */
const events: AgentEvent[] = SHELLS.flatMap(({ kind, type, name }, i) => [
  ev({ id: `ok-${i}`, type, capability: { type: kind, name, provider: null }, rawSeq: i * 2 + 1 }),
  ev({
    id: `err-${i}`,
    type,
    capability: { type: kind, name, provider: null },
    status: 'error',
    rawSeq: i * 2 + 2,
  }),
])

const db = openDatabase(dbPath)
migrate(db)
insertEvents(db, events)
db.close()

async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const ctx: Ctx = {
    argv: [...argv, '--db', dbPath],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => T0 + 86_400_000,
  }
  return { code: await runCli(ctx), lines }
}

describe('§9 capability shells beyond tools/hooks', () => {
  for (const { command, kind, name } of SHELLS) {
    it(`${command} lists only its own capability kind, with calls and errors`, async () => {
      const { code, lines } = await run(command)
      const out = lines.join('\n')
      expect(code, out).toBe(0)
      const row = out.split('\n').find((l) => l.includes(name))
      expect(row, out).toBeDefined()
      expect(out).toContain(kind.toUpperCase())
      for (const other of SHELLS) {
        if (other.kind === kind) continue
        expect(out, `${command} leaked ${other.kind}`).not.toContain(other.name)
      }
      // The §18 collapse: without a capabilityType filter every event lands in one bucket.
      expect(out).not.toContain('(unnamed)')
      expect(out).not.toContain(String(events.length))

      // Cells: NAME Calls Duration Tokens Cost Errors.
      const cells = row!.trim().split(/\s+/)
      expect(cells[1]).toBe('2')
      expect(cells[cells.length - 1]).toBe('1')

      // §14: the shell and the cube the Web asks must agree on the same two numbers.
      const read = openDatabase(dbPath, { readonly: true })
      try {
        const cube = query(read, { metrics: ['events'], dims: [kind], filter: { capabilityType: [kind] } })
        expect(cube.rows.filter((r) => String(r[kind]) === name).map((r) => Number(r.events))).toEqual([2])
        const errs = query(read, { metrics: ['events'], dims: [kind], filter: { capabilityType: [kind], status: ['error'] } })
        expect(errs.rows.filter((r) => String(r[kind]) === name).map((r) => Number(r.events))).toEqual([1])
      } finally {
        read.close()
      }
    })
  }

  it('an empty kind prints no rows rather than inventing one', async () => {
    const { code, lines } = await run('tools')
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).not.toContain('(unnamed)')
    for (const s of SHELLS) expect(out).not.toContain(s.name)
  })
})
