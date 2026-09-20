import { inflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { insertEvents } from '../src/write.ts'
import { dumpTable } from '../src/query-shape.ts'
import { makeEvent } from './helpers.ts'

const BIG = 'x'.repeat(40 * 1024)

describe('payloads (§3.2)', () => {
  it('content disabled (default): nothing lands in payloads and content_ref stays NULL', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    insertEvents(db, [
      makeEvent({ type: 'message.user', rawSeq: 901, payload: { kind: 'user_message', role: 'user', text: BIG } }),
    ])
    expect(dumpTable(db, 'payloads')).toHaveLength(0)
    const ev = db.prepare('SELECT content_ref FROM events').get() as { content_ref: string | null }
    expect(ev.content_ref).toBeNull()
    db.close()
  })

  it('content enabled: >32KB text is stored truncated, flagged, and inflates back', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    insertEvents(
      db,
      [
        makeEvent({
          id: 'ev-big',
          type: 'message.assistant',
          rawSeq: 902,
          payload: { kind: 'assistant_message', role: 'assistant', text: BIG },
        }),
      ],
      { contentEnabled: true },
    )
    const rows = dumpTable(db, 'payloads')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.truncated).toBe(1)
    expect(Number(row.bytes)).toBeLessThanOrEqual(32 * 1024)
    const inflated = inflateSync(row.text as Buffer)
    expect(inflated.length).toBe(Number(row.bytes))
    expect(inflated.toString('utf8')).toHaveLength(32 * 1024) // ASCII → exact cut
    expect(db.prepare('SELECT content_ref FROM events WHERE id = ?').get('ev-big')).toEqual({
      content_ref: 'assistant_message',
    })
    db.close()
  })

  it('small payload round-trips exactly; replay is still byte-identical', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const events = [
      makeEvent({ id: 'ev-small', type: 'message.user', rawSeq: 903, payload: { kind: 'user_message', role: 'user', text: 'こんにちは world' } }),
    ]
    insertEvents(db, events, { contentEnabled: true })
    const first = dumpTable(db, 'payloads')
    const text = inflateSync(first[0]!.text as Buffer).toString('utf8')
    expect(text).toBe('こんにちは world')
    expect(first[0]!.truncated).toBe(0)
    insertEvents(db, events, { contentEnabled: true })
    expect(dumpTable(db, 'payloads')).toEqual(first)
    db.close()
  })
})
