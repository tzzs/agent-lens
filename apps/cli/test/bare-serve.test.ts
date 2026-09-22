/**
 * §9: `agentlens` with no subcommand is scan + summary + dashboard, and §14's target
 * experience ends in `Dashboard → http://localhost:7317`. The suite must still never bind
 * a socket or launch a browser, so the serve step is the injected `ctx.serve` plug point
 * and interactivity is the only thing that decides the default.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agl-bare-serve-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const events: AgentEvent[] = [
  {
    id: 'e1',
    schemaVersion: 1, agentId: 'claude-code', hostId: 'claude-desktop', sourceId: 'src-x',
    sessionId: 'sess-x', projectId: 'proj-x', timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end', usageSource: 'reported', status: 'ok', rawSeq: 1, rawOffset: 0,
    usage: { inputTokens: 500_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  },
]

async function bare(interactive: boolean, ...argv: string[]): Promise<{ opened: number; lines: string[] }> {
  const lines: string[] = []
  let opened = 0
  const ctx: Ctx = {
    argv: [...argv, '--db', dbPath],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
    interactive,
    serve: async () => {
      opened += 1
      return { url: 'http://localhost:7317', closed: Promise.resolve(), close: async () => {} }
    },
  }
  await runCli(ctx)
  return { opened, lines }
}

describe('the bare command serves by default (§9)', () => {
  {
    const db = openDatabase(dbPath)
    migrate(db)
    insertEvents(db, events)
    db.close()
  }

  it('a terminal run reaches the dashboard without --serve', async () => {
    const { opened, lines } = await bare(true)
    expect(opened).toBe(1)
    expect(lines.join('\n')).toContain('Dashboard → http://localhost:7317')
  })

  it('--no-serve stops after the summary', async () => {
    const { opened, lines } = await bare(true, '--no-serve')
    expect(opened).toBe(0)
    expect(lines.join('\n')).toContain('1 session')
    expect(lines.join('\n')).not.toContain('Dashboard')
  })

  it('a pipe or CI run does not start a server nobody can see', async () => {
    const { opened, lines } = await bare(false)
    expect(opened).toBe(0)
    expect(lines.join('\n')).not.toContain('Dashboard')
  })

  it('--serve forces it even when stdout is not a terminal', async () => {
    expect((await bare(false, '--serve')).opened).toBe(1)
  })
})
