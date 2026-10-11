/**
 * `/api/sessions?limit=N` cuts the list at N, and `truncated` must say so: the
 * dashboard's "Load more" keys off it. It used to carry only the cube's own
 * truncation, so a store with 486 sessions answered 100 rows and `truncated: false`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'

const T = 1_700_000_000_000

function ev(session: number): AgentEvent {
  return {
    id: `e${session}`,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'cli',
    sourceId: `src-${session}`,
    sessionId: `sess-${session}`,
    projectId: 'proj-1',
    timestamp: T + session * 1000,
    type: 'message.assistant',
    usageSource: 'missing',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
  } as unknown as AgentEvent
}

describe('GET /api/sessions limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-server-limit-'))
  const db = openDatabase(join(dir, 'test.db'))
  beforeAll(() => {
    migrate(db)
    insertEvents(db, [1, 2, 3, 4, 5].map(ev))
  })
  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const list = async (limit: number) => {
    const app = createApp({ db, now: () => T + 10_000 })
    const res = await app.request(`/api/sessions?since=365d&limit=${limit}`)
    expect(res.status).toBe(200)
    return (await res.json()) as { rows: { sessionId: string }[]; totalSessions: number; truncated: boolean }
  }

  it('flags a list cut short by the limit, newest first', async () => {
    const body = await list(3)
    expect(body.rows.map((r) => r.sessionId)).toEqual(['sess-5', 'sess-4', 'sess-3'])
    expect(body.totalSessions).toBe(5)
    expect(body.truncated).toBe(true)
  })

  it('does not flag a limit the list exactly fills or never reaches', async () => {
    expect((await list(5)).truncated).toBe(false)
    expect((await list(50)).truncated).toBe(false)
  })
})
