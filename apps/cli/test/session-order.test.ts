/**
 * §14: `agl session <id>` and `/api/sessions/:id` can never disagree — both
 * print/return the shared loader's id list. Fixture: one session from two
 * sources where raw_seq order contradicts timestamp order.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, loadSessionEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const SESSION = 'sess-multi-source'
const T = Date.UTC(2026, 8, 20, 9)

// capability.name carries the event id so the printed line reveals the order.
function ev(id: string, sourceId: string, rawSeq: number, timestamp: number): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'cli',
    sourceId,
    sessionId: SESSION,
    projectId: 'proj-1',
    timestamp,
    type: 'tool.start',
    capability: { type: 'tool', name: id, provider: null },
    usageSource: 'missing',
    status: 'ok',
    rawSeq,
    rawOffset: rawSeq * 64,
  } as unknown as AgentEvent
}

const events = [
  ev('b1', 'src-B', 1, T + 10),
  ev('b2', 'src-B', 2, T + 20),
  ev('a1', 'src-A', 1, T + 30),
  ev('a2', 'src-A', 2, T + 40),
  ev('a3', 'src-A', 3, T + 50),
  ev('b3', 'src-B', 9, T + 50),
]

describe('session <id> timeline order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-cli-order-'))
  const dbPath = join(dir, 'agentlens.db')
  beforeAll(() => {
    const db = openDatabase(dbPath)
    migrate(db)
    insertEvents(db, events)
    db.close()
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('prints the same id sequence as the shared loader', async () => {
    const lines: string[] = []
    const ctx: Ctx = {
      argv: ['session', SESSION, '--db', dbPath],
      out: (l) => lines.push(l),
      err: () => {},
      homedir: dir,
      env: {},
      now: () => T + 1000,
    }
    expect(await runCli(ctx)).toBe(0)
    const printed = lines
      .map((l) => l.match(/\b([ab][0-9])\b/)?.[1])
      .filter((x): x is string => x !== undefined)
    const db = openDatabase(dbPath)
    const loaderIds = loadSessionEvents(db, SESSION).map((e) => e.id)
    db.close()
    expect(printed).toEqual(loaderIds)
    expect(printed).toEqual(['b1', 'b2', 'a1', 'a2', 'a3', 'b3'])
  })
})
