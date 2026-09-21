/**
 * §5.1 `parse` + §5.2 rule 1: framing never throws and never loses provenance.
 * An undecodable line becomes a marker record that `normalize` reports as a
 * `ParseFailure`, and a resume point is only ever a boundary the reader finished (§4.3).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveSourceId,
  isParseFailure,
  type AgentEvent,
  type NormalizeResult,
  type ParseCtx,
  type ParseFailure,
  type ParseTail,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { workbuddyAdapter } from '../src/index.ts'
import { PARSE_ERROR_KEY } from '../src/record.ts'
import { FIXTURES_DIR, ctxFor, recordsFromJsonl, resetStateFor } from './helpers.ts'

function sourceFor(name: string): SourceSpec {
  const path = join(FIXTURES_DIR, name)
  return { id: deriveSourceId('workbuddy', path), path, kind: 'jsonl', sessionHint: null }
}

/** Reads a real fixture through `parse`, keeping the completion value that is the resume point. */
async function readAll(
  name: string,
  from = 0,
  firstSeq = 1,
  maxLineBytes?: number,
): Promise<{ records: RawRecord[]; tail: ParseTail }> {
  const source = sourceFor(name)
  const ctx: ParseCtx = { source, agentId: 'workbuddy', hostId: 'workbuddy', maxLineBytes }
  const records: RawRecord[] = []
  const stream = workbuddyAdapter.parse(source, { offset: from, firstSeq }, ctx)
  while (true) {
    const next = await stream.next()
    if (next.done) return { records, tail: next.value }
    records.push(next.value)
  }
}

const textOf = (name: string): Promise<string> => readFile(join(FIXTURES_DIR, name), 'utf8')

/** Byte offset the line at `index` starts at, i.e. the sum of the preceding lines' widths. */
function startOfLine(text: string, index: number): number {
  let offset = 0
  for (const [i, line] of text.split('\n').entries()) {
    if (i === index) return offset
    offset += Buffer.byteLength(line, 'utf8') + 1
  }
  return offset
}

describe('parse', () => {
  it('one record per line, with a monotonic seq and byte offsets (§4.3)', async () => {
    const text = await textOf('tool-trace.jsonl')
    const { records, tail } = await readAll('tool-trace.jsonl')
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(records.map((r) => r.offset)).toEqual(
      records.map((_, i) => startOfLine(text, i)),
    )
    for (const record of records) {
      expect((record.value as { id?: string }).id).toMatch(/^rec-/)
    }
    // Timestamps come from the record, so replaying an old trace keeps its own clock.
    expect(records[0]!.occurredAt).toBe(Date.parse('2026-09-20T09:00:01.000Z'))
    expect(tail.nextSeq).toBe(7)
    expect(tail.nextOffset).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('a resume continues the byte boundary and the ordinal, so raw_seq stays absolute (§5.1)', async () => {
    const all = await readAll('tool-trace.jsonl')
    const third = all.records[2]!
    const resumed = await readAll('tool-trace.jsonl', third.offset, third.seq)
    expect(resumed.records.map((r) => r.seq)).toEqual([3, 4, 5, 6])
    // `raw_seq` fingerprints the event id (§4.2), so a resumed scan must reproduce the
    // ordinals a single pass gave or the same row would be stored twice.
    expect(resumed.records).toEqual(all.records.slice(2))
    expect(resumed.tail.nextOffset).toBe(all.tail.nextOffset)
  })

  it('a trailing fragment without its newline is not consumed (§4.3)', async () => {
    const text = await textOf('trailing-fragment.jsonl')
    const { records, tail } = await readAll('trailing-fragment.jsonl')
    expect(records.map((r) => (r.value as { id: string }).id)).toEqual(['frag-1'])
    expect(JSON.stringify(records.map((r) => r.value))).not.toContain('frag-2')
    // The half-written second record stays owed: resume at its first byte, not at EOF.
    expect(tail.nextOffset).toBe(startOfLine(text, 1))
    expect(tail.nextOffset).toBeLessThan(Buffer.byteLength(text, 'utf8'))
    expect(tail.nextSeq).toBe(2)
  })

  it('a bad line yields a marker record and its neighbours survive', async () => {
    const { records } = await readAll('parse-failure.jsonl')
    expect(records).toHaveLength(4)
    const broken = records[1]!.value as Record<string, unknown>
    expect(typeof broken[PARSE_ERROR_KEY]).toBe('string')
    expect(String(broken[PARSE_ERROR_KEY])).toContain('json-parse')
    expect(String(broken.rawLine)).toContain('"p2"')
    // `42` is valid JSON but not a record; the reader hands it over and normalize decides.
    expect(records[2]!.value).toBe(42)
    expect((records[0]!.value as { type?: string }).type).toBe('message')
    expect((records[3]!.value as { id?: string }).id).toBe('p3')
  })

  it('an oversized line is reported, never buffered (§4.3)', async () => {
    const { records } = await readAll('tool-trace.jsonl', 0, 1, 64)
    expect(records.length).toBe(6)
    for (const record of records) {
      const marker = record.value as Record<string, unknown>
      expect(String(marker[PARSE_ERROR_KEY])).toMatch(/^oversized-line: \d+ bytes exceed maxLineBytes$/)
      expect(marker.rawLine).toBe('')
    }
  })

  it('a vanished source surfaces as a read error to the caller, not a silent empty scan', async () => {
    const source: SourceSpec = {
      id: deriveSourceId('workbuddy', '/fixture/gone.jsonl'),
      path: join(FIXTURES_DIR, 'no-such-trace.jsonl'),
      kind: 'jsonl',
      sessionHint: null,
    }
    const stream = workbuddyAdapter.parse(source, { offset: 0 }, {
      source,
      agentId: 'workbuddy',
      hostId: 'workbuddy',
    })
    await expect(stream.next()).rejects.toThrow()
  })
})

function failureOf(result: NormalizeResult | undefined): ParseFailure {
  if (!result || !isParseFailure(result)) {
    throw new Error(`expected a ParseFailure, got ${JSON.stringify(result)}`)
  }
  return result.failure
}

describe('normalize of unreadable records', () => {
  it('a marker becomes a failure carrying reason/rawLine/offset/rawSeq (§5.2 rule 1)', async () => {
    const ctx = ctxFor('parse-failure.jsonl')
    resetStateFor(ctx)
    const { records } = await readAll('parse-failure.jsonl')
    const results: NormalizeResult[] = []
    for (const record of records) results.push(await workbuddyAdapter.normalize(record, ctx))

    expect(results.filter(isParseFailure)).toHaveLength(2)
    const broken = failureOf(results[1])
    expect(broken.reason).toContain('json-parse')
    expect(broken.rawLine).toContain('"p2"')
    expect(broken.offset).toBe(records[1]!.offset)
    expect(broken.rawSeq).toBe(2)
    expect(broken.upstreamType).toBeNull()
    // A scalar line is no more a record than a broken one, and says what it held.
    const scalar = failureOf(results[2])
    expect(scalar.reason).toBe('not-a-json-object')
    expect(scalar.rawLine).toBe('42')
    expect(scalar.rawSeq).toBe(3)
    // The two good lines around them still normalize.
    const ok = results.filter((r): r is { events: AgentEvent[] } => !isParseFailure(r))
    expect(ok.map((r) => r.events.map((e) => e.type))).toEqual([
      ['message.user'],
      ['message.user'],
    ])
  })

  it('a hostile record is reported, not thrown', async () => {
    const ctx = ctxFor('tool-trace.jsonl')
    resetStateFor(ctx)
    const boobyTrapped: RawRecord = {
      seq: 1,
      offset: 0,
      occurredAt: 1,
      value: {
        get type(): never {
          throw new Error('getter exploded')
        },
      },
    }
    const result = await workbuddyAdapter.normalize(boobyTrapped, ctx)
    expect(isParseFailure(result)).toBe(true)
    expect(failureOf(result).reason).toContain('normalize-internal')
    expect(failureOf(result).reason).toContain('getter exploded')
  })

  it('normalize never rejects for any value JSONL can hold', async () => {
    const ctx = ctxFor('unknown-record-type.jsonl')
    resetStateFor(ctx)
    const scalars: unknown[] = [null, undefined, 0, '', 'text', [], [1], true, Number.NaN]
    for (const [seq, value] of scalars.entries()) {
      const result = await workbuddyAdapter.normalize({ seq, offset: seq, occurredAt: 1, value }, ctx)
      expect(isParseFailure(result), `${String(value)} produced no failure`).toBe(true)
      expect(failureOf(result).reason).toBe('not-a-json-object')
      expect(failureOf(result).rawSeq).toBe(seq)
    }
  })

  it('the fixture set round-trips through parse and normalize without a throw', async () => {
    for (const name of ['tool-trace.jsonl', 'shared-usage.jsonl', 'parse-failure.jsonl']) {
      const ctx = ctxFor(name)
      resetStateFor(ctx)
      const { records } = await readAll(name)
      expect(records).toHaveLength(recordsFromJsonl(await textOf(name)).length)
      for (const record of records) await workbuddyAdapter.normalize(record, ctx)
    }
  })
})
