/**
 * §14: `/api/sessions/:id` must return exactly the order the shared loader
 * produces. Fixture is one session fed by two sources whose raw_seq and
 * timestamp orders disagree — the regression that made the waterfall jump
 * across time in real stores.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, loadSessionEvents, migrate, openDatabase } from '@agentlens/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'

const SESSION = 'sess-multi-source'
const T = 1_700_000_000_000

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
    type: 'message.assistant',
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

describe('GET /api/sessions/:id ordering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-server-order-'))
  const db = openDatabase(join(dir, 'test.db'))
  beforeAll(() => {
    migrate(db)
    insertEvents(db, events)
  })
  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns nodes in the shared loader's exact order", async () => {
    const app = createApp({ db, now: () => T + 1000 })
    const res = await app.request(`/api/sessions/${SESSION}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nodes: { id: string; timestamp: number }[] }
    const nodeIds = body.nodes.map((n) => n.id)
    expect(nodeIds).toEqual(loadSessionEvents(db, SESSION).map((e) => e.id))
    expect(nodeIds).toEqual(['b1', 'b2', 'a1', 'a2', 'a3', 'b3'])
    const ts = body.nodes.map((n) => n.timestamp)
    expect(ts).toEqual([...ts].sort((x, y) => x - y))
  })
})
