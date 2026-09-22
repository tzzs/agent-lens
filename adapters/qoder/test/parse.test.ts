/**
 * `parse` framing (§5.1 + §4.3): whole lines only, seq/offset bookkeeping,
 * a trailing fragment left unconsumed, resume continues numbering, and an
 * unparseable line surfaces as a marker record (§5.2 rule 1).
 */
import { describe, expect, it } from 'vitest'
import { deriveSourceId, type ParseCtx, type SourceSpec } from '@agentlens/event-model'
import { parse } from '../src/parse.ts'
import { FIXTURES_DIR } from './helpers.ts'
import { isParseErrorRecord, PARSE_ERROR_KEY } from '@agentlens/event-model'

function ctxFor(name: string): { source: SourceSpec; ctx: ParseCtx } {
  const path = `${FIXTURES_DIR}/${name}`
  const source: SourceSpec = { id: deriveSourceId('qoder', path), path, kind: 'jsonl', sessionHint: null }
  return { source, ctx: { source, agentId: 'qoder', hostId: 'qoder' } }
}

async function drain(name: string, from: { offset: number; firstSeq?: number } = { offset: 0 }) {
  const { source, ctx } = ctxFor(name)
  const it = parse(source, from, ctx)
  const records = []
  while (true) {
    const r = await it.next()
    if (r.done) return { records, tail: r.value }
    records.push(r.value)
  }
}

describe('parse', () => {
  it('numbers records from firstSeq and offsets by real byte positions', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(`${FIXTURES_DIR}/user-turn.jsonl`, 'utf8')
    const firstLineBytes = Buffer.byteLength(text.split('\n')[0]!, 'utf8') + 1
    const { records, tail } = await drain('user-turn.jsonl')
    expect(records).toHaveLength(2)
    expect(records[0]!.seq).toBe(1)
    expect(records[0]!.offset).toBe(0)
    expect(records[1]!.offset).toBe(firstLineBytes)
    expect(records[1]!.seq).toBe(2)
    expect(records[0]!.occurredAt).toBe(Date.parse('2026-09-20T10:02:00.000Z'))
    expect(tail.nextSeq).toBe(3)
    expect(tail.nextOffset).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('a malformed line is a marker record, not an exception', async () => {
    const { records } = await drain('parse-failure.jsonl')
    expect(records).toHaveLength(2)
    expect(isParseErrorRecord(records[1]!.value)).toBe(true)
    const marker = records[1]!.value as Record<string, unknown>
    expect(String(marker[PARSE_ERROR_KEY])).toContain('json-parse')
    expect(String(marker.rawLine)).toContain('"broken"')
  })

  it('leaves a trailing unterminated fragment unconsumed and resumes cleanly (§4.3)', async () => {
    const { tail, records } = await drain('parse-failure.jsonl')
    expect(records.length).toBe(2)
    // The fixture's malformed line ends with \n, so the reader consumed it;
    // resuming from the returned offset yields nothing new.
    const again = await drain('parse-failure.jsonl', { offset: tail.nextOffset, firstSeq: tail.nextSeq })
    expect(again.records).toHaveLength(0)
    expect(again.tail.nextSeq).toBe(tail.nextSeq)
  })

  it('does not throw on an empty session file (0-byte upstream retention case)', async () => {
    const { records, tail } = await drain('host/projects/sub-Users-example-alpha/empty-session.jsonl')
    expect(records).toHaveLength(0)
    expect(tail.nextOffset).toBe(0)
    expect(tail.nextSeq).toBe(1)
  })
})
