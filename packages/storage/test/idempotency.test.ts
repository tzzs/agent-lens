import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { insertEvents } from '../src/write.ts'
import { cleanup, makeEvent, SESSION_ID, SOURCE_ID, snapshot as snap, tempDir } from './helpers.ts'

/** A batch exercising every parent upsert path: usage, model, capability, metadata. */
function buildBatch(): AgentEvent[] {
  return [
    makeEvent({ type: 'session.start', subtype: null, rawSeq: 1 }),
    makeEvent({
      type: 'message.user',
      rawSeq: 2,
      payload: { kind: 'user_message', role: 'user', text: 'hello' },
    }),
    makeEvent({
      type: 'generation.end',
      rawSeq: 3,
      requestId: 'req-1',
      model: { provider: 'anthropic', name: 'claude-sonnet-5', tier: null },
      usage: {
        inputTokens: 120,
        outputTokens: 340,
        cacheReadTokens: 90_000,
        cacheWriteTokens: 1_200,
        reasoningTokens: 0,
      },
      durationMs: 2_300,
      payload: { kind: 'assistant_message', role: 'assistant', text: 'hi there' },
    }),
    makeEvent({
      type: 'tool.end',
      rawSeq: 4,
      capability: { type: 'tool', name: 'Bash', provider: null },
      durationMs: 42,
    }),
    makeEvent({
      type: 'hook.fire',
      rawSeq: 5,
      capability: { type: 'hook', name: 'PreToolUse:Bash', provider: 'userSettings' },
      metadata: { exitCode: 0, nested: { ok: true } },
    }),
    makeEvent({ type: 'session.end', rawSeq: 6 }),
  ]
}

describe('M0 acceptance ① — replay idempotency (§4.2)', () => {
  it('re-inserting the same batch (even after reopen + rescan from zero) leaves the DB byte-identical', () => {
    const dir = tempDir()
    const path = `${dir}/agentlens.db`
    let db = openDatabase(path)
    migrate(db)

    const batch = buildBatch()
    insertEvents(db, batch)
    const snap1 = JSON.parse(snap(db))

    // Replay of the same batch: every INSERT OR IGNORE must be a no-op.
    insertEvents(db, batch)
    const snap2 = JSON.parse(snap(db))
    expect(snap2).toStrictEqual(snap1)

    // Rescan from zero after reopen: same deterministic ids, fresh connection.
    db.close()
    db = openDatabase(path)
    migrate(db) // startup auto-migration must be a no-op
    insertEvents(db, batch)
    const snap3 = JSON.parse(snap(db))
    expect(snap3).toStrictEqual(snap1)
    expect(JSON.stringify(snap3)).toBe(JSON.stringify(snap1))

    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(count.n).toBe(batch.length)
    db.close()
    cleanup(dir)
  })

  it('out-of-order and duplicated replay still converges to the same state', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const batch = buildBatch()
    insertEvents(db, batch.slice(0, 3))
    insertEvents(db, [...batch].reverse())
    const snapA = snap(db)
    insertEvents(db, batch)
    insertEvents(db, batch)
    expect(snap(db)).toBe(snapA)
    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    expect(count.n).toBe(batch.length)
    db.close()
  })

  it('session event_count counts committed events, not batch size', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const batch = buildBatch()
    insertEvents(db, batch)
    insertEvents(db, batch)
    const s = db.prepare('SELECT event_count FROM sessions WHERE id = ?').get(SESSION_ID) as {
      event_count: number
    }
    expect(s.event_count).toBe(batch.length)
    expect(db.prepare('SELECT id FROM sources WHERE id = ?').get(SOURCE_ID)).toBeTruthy()
    db.close()
  })
})
