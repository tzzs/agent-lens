/**
 * The bare command's summary carries figures, not caveats that change none of them.
 *
 * It used to end with two warnings: a host-split line (one agent's events coming mostly
 * from one host) and a coverage line (a source dir that outlived its session files).
 * Neither moves a number on that screen — the host mix is a breakdown of a total that is
 * already right, and a retained dir's rows were ingested before upstream deleted the file —
 * so both were dropped from the first screen. The coverage fact still belongs to the
 * doctor, which is where this suite checks it went.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase, updateSourceProgress } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agl-first-screen-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function ev(hostId: string, i: number): AgentEvent {
  return {
    schemaVersion: 1,
    id: `e-${hostId}-${i}`,
    agentId: 'claude-code',
    hostId,
    sourceId: 'src-first-screen',
    sessionId: `sess-${i}`,
    projectId: 'proj-first-screen',
    timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: i,
    rawOffset: i,
    usage: null,
  }
}

async function run(...argv: string[]): Promise<string> {
  const lines: string[] = []
  const ctx: Ctx = {
    argv: [...argv, '--db', dbPath],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
    interactive: false,
  }
  await runCli(ctx)
  return lines.join('\n')
}

describe('the first screen', () => {
  {
    const db = openDatabase(dbPath)
    migrate(db)
    // 95% from one host, enough events: the old host-split warning fired on exactly this.
    insertEvents(db, [...Array(19).keys()].map((i) => ev('claude-desktop', i)).concat(ev('claude-code', 99)))
    // A source whose dir is still there but whose file is gone: the old coverage warning.
    updateSourceProgress(db, {
      id: 'src-retained',
      agentId: 'claude-code',
      path: join(tmp, 'deleted-session.jsonl'),
      kind: 'jsonl',
      inode: 1,
      size: 0,
      mtimeMs: 0,
      lastOffset: 0,
      parserVersion: 1,
      sessionIdHint: null,
      status: 'active',
      lastError: null,
      scanStartedAt: 0,
      scanFinishedAt: 0,
      rowsIngested: 0,
    })
    db.close()
  }

  it('prints neither the host split nor the coverage caveat', async () => {
    const out = await run('--no-serve')
    expect(out).toContain('20 sessions')
    expect(out).not.toMatch(/split by host|came from claude-desktop/)
    expect(out).not.toMatch(/history is incomplete|no session files/)
  })

  it('leaves the coverage fact to the doctor', async () => {
    const out = await run('doctor')
    expect(out).toMatch(/no session files/)
  })
})
