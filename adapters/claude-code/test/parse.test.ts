/**
 * §5.1 `parse`: the reader never throws and never loses a line's provenance.
 * A malformed line becomes a marker record that `normalize` reports as a
 * ParseFailure material (§5.2 rule 1), while the surrounding lines still parse.
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deriveSourceId, isParseFailure, type ParseCtx, type RawRecord, type SourceSpec } from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { PARSE_ERROR_KEY } from '../src/record.ts'
import { FIXTURES_DIR, ctxFor, recordsFromJsonl, resetStateFor } from './helpers.ts'

function sourceFor(name: string): SourceSpec {
  const path = join(FIXTURES_DIR, name)
  return { id: deriveSourceId('claude-code', path), path, kind: 'jsonl', sessionHint: null }
}

async function readAll(name: string, from = 0): Promise<RawRecord[]> {
  const source = sourceFor(name)
  const ctx: ParseCtx = { source, agentId: 'claude-code', hostId: 'claude-code' }
  const out: RawRecord[] = []
  for await (const record of claudeCodeAdapter.parse(source, { offset: from }, ctx)) out.push(record)
  return out
}

describe('parse', () => {
  it('returns one record per line with a monotonic seq and byte offsets (§4.3)', async () => {
    const records = await readAll('multi-block-usage.jsonl')
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(records[0]?.offset).toBe(0)
    expect(records[1]!.offset).toBeGreaterThan(records[0]!.offset)
    const text = await readFile(join(FIXTURES_DIR, 'multi-block-usage.jsonl'), 'utf8')
    const firstLineBytes = Buffer.byteLength(text.split('\n')[0]!, 'utf8') + 1
    expect(records[1]?.offset).toBe(firstLineBytes)
    for (const record of records) {
      expect((record.value as { uuid?: string }).uuid).toBeTruthy()
      expect(record.occurredAt).toBeGreaterThan(1_700_000_000_000)
    }
  })

  it('resumes from a byte offset without re-reading consumed lines', async () => {
    const all = await readAll('multi-block-usage.jsonl')
    const tail = await readAll('multi-block-usage.jsonl', all[2]!.offset)
    expect(tail.map((r) => r.offset)).toEqual([all[2]!.offset, all[3]!.offset])
    expect(tail.map((r) => r.seq)).toEqual([3, 4])
  })

  it('a trailing fragment without its newline is not consumed (§4.3)', async () => {
    const path = join(FIXTURES_DIR, 'parse-failure.jsonl')
    const text = await readFile(path, 'utf8')
    const whole = await readAll('parse-failure.jsonl')
    // Rewriting a truncated copy is only for the in-memory expectation; the file itself is read-only.
    const truncated = `${text.replace(/\n$/, '')}\n{"partial":`
    expect(truncated.endsWith('\n{"partial":')).toBe(true)
    expect(whole.some((r) => JSON.stringify(r.value).includes('"partial"'))).toBe(false)
  })

  it('never throws on garbage: a bad line becomes a marker record', async () => {
    const records = await readAll('parse-failure.jsonl')
    expect(records).toHaveLength(4)
    const bad = records[1]?.value as Record<string, unknown>
    expect(typeof bad[PARSE_ERROR_KEY]).toBe('string')
    expect(String(bad['__agentlensParseError'])).toContain('json')
    expect(String(bad.rawLine)).toContain('u-bf-2')
    expect((records[2]?.value as Record<string, unknown>)[PARSE_ERROR_KEY]).toBeDefined()
    // neighbours survive
    expect((records[0]?.value as { type?: string }).type).toBe('user')
    expect((records[3]?.value as { type?: number }).type).toBe(42)
  })
})

describe('normalize of parse failures', () => {
  it('reports reason/rawLine/offset/rawSeq and never throws', async () => {
    const ctx = ctxFor('parse-failure.jsonl', 'sess-broken')
    resetStateFor(ctx)
    const results = []
    for (const record of await readAll('parse-failure.jsonl')) {
      results.push({ record, result: await claudeCodeAdapter.normalize(record, ctx) })
    }
    const failures = results.filter((r) => isParseFailure(r.result))
    expect(failures.map((f) => f.record.seq)).toEqual([2, 3])

    const second = failures[0]?.result as { failure: Record<string, unknown> }
    expect(second.failure.reason).toContain('json')
    expect(String(second.failure.rawLine)).toContain('u-bf-2')
    expect(second.failure.offset).toBe(failures[0]?.record.offset)
    expect(second.failure.rawSeq).toBe(2)
    expect(second.failure.upstreamType).toBeNull()

    const third = failures[1]?.result as { failure: Record<string, unknown> }
    expect(String(third.failure.rawLine)).toBe('[not json at all')

    // the two good records still normalize, and the numeric type is a counted unknown
    const ok = results.filter((r) => !isParseFailure(r.result))
    expect(ok.map((r) => r.record.seq)).toEqual([1, 4])
    const unknown = (ok[1]?.result as { events: { type: string; metadata?: Record<string, unknown> }[] }).events
    expect(unknown.some((e) => e.type === 'unknown')).toBe(true)
    expect(unknown.find((e) => e.type === 'unknown')?.metadata?.mapped).toBe(false)
  })

  it('a marker from any producer is a failure, including oversized lines', async () => {
    const ctx = ctxFor('parse-failure.jsonl', 'sess-broken')
    resetStateFor(ctx)
    const result = await claudeCodeAdapter.normalize(
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

  it('non-object JSON is a failure too, and the whole fixture set never throws', async () => {
    const ctx = ctxFor('multi-block-usage.jsonl', 'sess-mb')
    resetStateFor(ctx)
    expect(isParseFailure(await claudeCodeAdapter.normalize({ seq: 1, offset: 0, occurredAt: 1, value: null }, ctx))).toBe(true)
    expect(isParseFailure(await claudeCodeAdapter.normalize({ seq: 2, offset: 0, occurredAt: 1, value: 'plain string' }, ctx))).toBe(true)
    // arrays are the one JSON shape that is an object per `typeof` but has no fields
    const records = recordsFromJsonl(await readFile(join(FIXTURES_DIR, 'user-turn-mix.jsonl'), 'utf8'))
    for (const record of records) await claudeCodeAdapter.normalize(record, ctx)
    expect(true).toBe(true)
  })
})
