/**
 * §5.1 `parse`: framing only. Codex rollout files are JSONL, so the guarantees under
 * test are the collector reader's (§4.3) plus the two things the adapter must never do:
 * throw on garbage, or claim a partial line as consumed.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveSourceId,
  isParseFailure,
  type AgentEvent,
  type NormalizeResult,
  type ParseCtx,
  type ParseFailure,
  type RawRecord,
  type SourceSpec,
} from '@agentlens/event-model'
import { codexAdapter, parse } from '../src/index.ts'
import { PARSE_ERROR_KEY } from '../src/record.ts'
import { FIXTURES_DIR, ctxFor, resetStateFor } from './helpers.ts'

function sourceFor(name: string): SourceSpec {
  const path = join(FIXTURES_DIR, name)
  return { id: deriveSourceId('codex', path), path, kind: 'jsonl', sessionHint: null }
}

interface Drained {
  records: RawRecord[]
  tail: { nextOffset: number; nextSeq: number }
}

/** Manual iteration, because `for await` discards the generator's `ParseTail` (§5.1). */
async function drain(name: string, from = 0, firstSeq = 1, maxLineBytes?: number): Promise<Drained> {
  const source = sourceFor(name)
  const ctx: ParseCtx = { source, agentId: 'codex', hostId: 'codex-desktop', ...(maxLineBytes ? { maxLineBytes } : {}) }
  const records: RawRecord[] = []
  const it = parse(source, { offset: from, firstSeq }, ctx)
  for (;;) {
    const next = await it.next()
    if (next.done) return { records, tail: next.value }
    records.push(next.value)
  }
}

function markerOf(record: RawRecord | undefined): Record<string, unknown> {
  const value = record?.value as Record<string, unknown> | undefined
  expect(typeof value?.[PARSE_ERROR_KEY], 'expected a parse-error marker').toBe('string')
  return value!
}

function failureOf(result: NormalizeResult | undefined): ParseFailure {
  if (!result || !isParseFailure(result)) throw new Error(`expected a ParseFailure, got ${JSON.stringify(result)}`)
  return result.failure
}

function eventsOf(result: NormalizeResult | undefined): AgentEvent[] {
  if (!result || isParseFailure(result)) throw new Error('expected events')
  return result.events
}

describe('parse framing (§4.3)', () => {
  it('one record per line, 1-based seq, absolute byte offsets', async () => {
    const { records, tail } = await drain('message-turns.jsonl')
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(records[0]?.offset).toBe(0)
    const text = await readFile(join(FIXTURES_DIR, 'message-turns.jsonl'), 'utf8')
    const lines = text.split('\n')
    expect(records[1]?.offset).toBe(Buffer.byteLength(lines[0]!, 'utf8') + 1)
    // monotonic and consistent with the file size: the tail is the only safe resume point
    for (let i = 1; i < records.length; i++) expect(records[i]!.offset).toBeGreaterThan(records[i - 1]!.offset)
    expect(tail.nextOffset).toBe(Buffer.byteLength(text, 'utf8'))
    expect(tail.nextSeq).toBe(8)
    // timestamps come from the envelope's ISO string, not the clock (§5.1 occurredAt)
    expect(records[0]?.occurredAt).toBe(Date.parse('2026-09-15T21:00:00.000Z'))
  })

  it('a resume offset continues seq instead of restarting it', async () => {
    const all = await drain('message-turns.jsonl')
    const resumed = await drain('message-turns.jsonl', all.records[4]!.offset, all.records[4]!.seq)
    expect(resumed.records.map((r) => r.seq)).toEqual([5, 6, 7])
    expect(resumed.records.map((r) => r.offset)).toEqual(all.records.slice(4).map((r) => r.offset))
    expect(resumed.tail).toEqual(all.tail)
  })

  it('a trailing fragment without its newline is NOT consumed (§4.3)', async () => {
    const text = await readFile(join(FIXTURES_DIR, 'message-turns.jsonl'), 'utf8')
    const dir = await mkdtemp(join(tmpdir(), 'agentlens-codex-parse-'))
    const path = join(dir, 'rollout-2026-09-15T21-00-00-01JTMPFRAGMENTAAAAAAAAAAAA.jsonl')
    try {
      // written outside the repo: the fixture tree is read-only evidence (§5.2 rule 3)
      await writeFile(path, `${text.replace(/\n$/, '')}\n{"timestamp":"2026-09-15T21:00:07.000Z","type":"`, 'utf8')
      const source: SourceSpec = { id: deriveSourceId('codex', path), path, kind: 'jsonl', sessionHint: null }
      const ctx: ParseCtx = { source, agentId: 'codex', hostId: 'codex-desktop' }
      const records: RawRecord[] = []
      const it = parse(source, { offset: 0 }, ctx)
      for (;;) {
        const next = await it.next()
        if (next.done) {
          expect(next.value.nextOffset).toBe(Buffer.byteLength(text, 'utf8'))
          expect(next.value.nextSeq).toBe(8)
          break
        }
        records.push(next.value)
      }
      expect(records).toHaveLength(7)
      // the half-written line is the 8th record of the temp file: not emitted, not claimed
      expect(records.some((r) => (r.value as { timestamp?: string }).timestamp === '2026-09-15T21:00:07.000Z')).toBe(false)
      const whole = await readFile(path, 'utf8')
      expect(Buffer.byteLength(whole, 'utf8')).toBeGreaterThan(Buffer.byteLength(text, 'utf8'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an oversized line yields a marker with its byte count, never its text', async () => {
    const { records } = await drain('per-call-and-cumulative.jsonl', 0, 1, 64)
    const markers = records.filter((r) => typeof (r.value as Record<string, unknown>)[PARSE_ERROR_KEY] === 'string')
    expect(markers.length).toBeGreaterThan(0)
    const reason = String(markerOf(markers[0])[PARSE_ERROR_KEY])
    expect(reason).toMatch(/^oversized-line: \d+ bytes exceed maxLineBytes$/)
    expect(markerOf(markers[0]).rawLine).toBe('')
  })

  it('an aborted context yields nothing and claims no progress', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = sourceFor('message-turns.jsonl')
    const ctx: ParseCtx = { source, agentId: 'codex', hostId: 'codex-desktop', signal: controller.signal }
    const records: RawRecord[] = []
    const it = parse(source, { offset: 10, firstSeq: 3 }, ctx)
    for (;;) {
      const next = await it.next()
      if (next.done) {
        expect(next.value).toEqual({ nextOffset: 10, nextSeq: 3 })
        break
      }
      records.push(next.value)
    }
    expect(records).toEqual([])
  })
})

describe('normalize of framing failures (§5.2 rule 1)', () => {
  it('a malformed line reports reason/rawLine/offset/rawSeq and never throws', async () => {
    const ctx = ctxFor('parse-failure.jsonl', '01JBROKENPPPPPPPPPPPPPPPPP')
    resetStateFor(ctx)
    const { records } = await drain('parse-failure.jsonl')
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5])
    const results: { seq: number; result: NormalizeResult }[] = []
    for (const record of records) results.push({ seq: record.seq, result: await codexAdapter.normalize(record, ctx) })

    const failures = results.filter((r) => isParseFailure(r.result))
    expect(failures.map((f) => f.seq)).toEqual([2, 4])

    const broken = failureOf(failures[0]?.result)
    expect(broken.reason).toContain('json-parse')
    expect(String(broken.rawLine)).toContain('"type":"event_msg"')
    expect(broken.offset).toBe(records[1]!.offset)
    expect(broken.rawSeq).toBe(2)
    expect(broken.upstreamType).toBeNull()

    // a JSON scalar is a valid line but not a record: still a failure, with its own text
    const scalar = failureOf(failures[1]?.result)
    expect(scalar.rawLine).toBe('42')
    expect(scalar.reason).toBe('not-a-json-object')
    expect(scalar.rawSeq).toBe(4)

    // neighbours survive: the good lines around the bad ones still normalize
    const ok = results.filter((r) => !isParseFailure(r.result))
    expect(ok.map((r) => r.seq)).toEqual([1, 3, 5])
    expect(eventsOf(ok[0]?.result).map((e) => e.type)).toEqual(['session.start'])
    const usage = eventsOf(ok[2]?.result)[0] as unknown as { type: string; usage: { inputTokens: number } }
    expect(usage.type).toBe('generation.end')
    expect(usage.usage).toEqual({
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it('a marker from any producer is a failure, including oversized lines', async () => {
    const ctx = ctxFor('parse-failure.jsonl', '01JBROKENPPPPPPPPPPPPPPPPP')
    resetStateFor(ctx)
    const result = await codexAdapter.normalize(
      {
        seq: 7,
        offset: 4096,
        occurredAt: 1,
        value: { [PARSE_ERROR_KEY]: 'oversized-line: 12345 bytes exceed maxLineBytes', rawLine: '' },
      },
      ctx,
    )
    expect(result).toEqual({
      failure: {
        reason: 'oversized-line: 12345 bytes exceed maxLineBytes',
        rawLine: '',
        offset: 4096,
        rawSeq: 7,
        upstreamType: null,
      },
    })
  })

  it('null, strings and arrays are failures, not events', async () => {
    const ctx = ctxFor('hosts.jsonl')
    resetStateFor(ctx)
    for (const [seq, value] of [[1, null], [2, 'plain string'], [3, [1, 2]], [4, undefined]] as const) {
      const result = await codexAdapter.normalize({ seq, offset: seq, occurredAt: 1, value }, ctx)
      expect(isParseFailure(result), `value ${JSON.stringify(value)}`).toBe(true)
    }
  })
})
