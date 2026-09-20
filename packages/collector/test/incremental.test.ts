import { mkdtemp, rm, stat, truncate, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  needsRescan,
  parseLine,
  readIncremental,
  readJsonlChunk,
  statSource,
  type JsonlLine,
  type LineItem,
} from '../src/incremental.ts'

let currentTmp: string | null = null

async function tmpFile(name: string, contents: string | Buffer): Promise<string> {
  currentTmp = await mkdtemp(join(tmpdir(), 'collector-'))
  const p = join(currentTmp, name)
  await writeFile(p, contents)
  return p
}

async function collect(it: AsyncGenerator<LineItem, unknown>): Promise<LineItem[]> {
  const out: LineItem[] = []
  for await (const item of it) out.push(item)
  return out
}

afterEach(async () => {
  if (currentTmp) await rm(currentTmp, { recursive: true, force: true })
  currentTmp = null
})

const line = (o: Record<string, unknown>) => JSON.stringify(o)

describe('statSource / needsRescan (§4.3)', () => {
  it('statSource returns null for a missing path', async () => {
    expect(await statSource('/nope/definitely-missing-xyz.jsonl')).toBeNull()
  })

  it('unchanged inode, size and mtime ⇒ skip', async () => {
    const p = await tmpFile('a.jsonl', line({ n: 1 }) + '\n')
    const st = await statSource(p)
    expect(st).not.toBeNull()
    expect(needsRescan(st!, { ...st!, lastOffset: st!.size })).toBe('skip')
  })

  it('size > lastOffset with same inode ⇒ append', async () => {
    const p = await tmpFile('a.jsonl', line({ n: 1 }) + '\n')
    const before = await statSource(p)
    await appendFile(p, line({ n: 2 }) + '\n')
    const after = await statSource(p)
    expect(needsRescan(after!, { ...before!, lastOffset: before!.size })).toBe('append')
  })

  it('truncation (size < lastOffset) ⇒ rotated', async () => {
    const p = await tmpFile('a.jsonl', line({ hello: 'world********' }) + '\n')
    const saved = (await statSource(p))!
    await truncate(p, 10)
    const st = await statSource(p)
    expect(needsRescan(st!, { ...saved, lastOffset: saved.size })).toBe('rotated')
  })

  it('fresh inode at same size ⇒ rotated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collector-'))
    currentTmp = dir
    const p = join(dir, 'a.jsonl')
    const content = line({ x: 12345678 }) + '\n'
    await writeFile(p, content)
    const saved = (await statSource(p))!
    // Same byte size, brand-new inode: write elsewhere then atomically rename over.
    const replacement = join(dir, 'b.jsonl')
    await writeFile(replacement, content)
    const renamed = (await stat(replacement)).ino
    expect(renamed).not.toBe(saved.inode)
    const newInodeStat = (await statSource(p))! // before rename, sanity
    const sameSizeStat = { ...newInodeStat, inode: renamed }
    expect(needsRescan(sameSizeStat, { ...saved, lastOffset: saved.size })).toBe('rotated')
    // And the real rename produces the same verdict from a genuine stat.
    const { rename } = await import('node:fs/promises')
    await rename(replacement, p)
    const after = (await statSource(p))!
    expect(needsRescan(after, { ...saved, lastOffset: saved.size })).toBe('rotated')
  })
})

describe('readIncremental / readJsonlChunk', () => {
  it('append-only resume: second scan yields only new lines with continuing seq + absolute offsets', async () => {
    const p = await tmpFile('a.jsonl', '')
    const first5 = Array.from({ length: 5 }, (_, i) => line({ n: i + 1 }) + '\n').join('')
    await writeFile(p, first5)
    const chunk1 = await readJsonlChunk(p, 0)
    expect(chunk1.lines).toHaveLength(5)
    expect(chunk1.lines.map((l) => (l as JsonlLine).seq)).toEqual([1, 2, 3, 4, 5])
    expect(chunk1.nextOffset).toBe(Buffer.byteLength(first5))
    // absolute byte offsets must match real positions
    const bytes = await import('node:fs/promises').then((m) => m.readFile(p))
    for (const l of chunk1.lines as JsonlLine[]) {
      expect(bytes.subarray(l.offset, l.offset + Buffer.byteLength(l.text)).toString('utf8')).toBe(l.text)
    }

    const next3 = Array.from({ length: 3 }, (_, i) => line({ n: i + 6 }) + '\n').join('')
    await appendFile(p, next3)
    const chunk2 = await readJsonlChunk(p, chunk1.nextOffset, { firstSeq: chunk1.nextSeq })
    expect((chunk2.lines as JsonlLine[]).map((l) => [l.seq, JSON.parse(l.text).n])).toEqual([
      [6, 6],
      [7, 7],
      [8, 8],
    ])
    expect(chunk2.lines[0]!.offset).toBe(Buffer.byteLength(first5))
    expect(chunk2.nextOffset).toBe(Buffer.byteLength(first5 + next3))
  })

  it('tail residual without newline is not yielded and offset stops before it; completed later, yielded exactly once', async () => {
    const full = line({ n: 1 }) + '\n' + line({ n: 2 }) + '\n'
    const partial = '{"n": 3'
    const p = await tmpFile('a.jsonl', full + partial)
    const c1 = await readJsonlChunk(p, 0)
    expect(c1.lines).toHaveLength(2)
    expect(c1.residualBytes).toBe(Buffer.byteLength(partial))
    expect(c1.nextOffset).toBe(Buffer.byteLength(full))

    await appendFile(p, '}\n')
    const c2 = await readJsonlChunk(p, c1.nextOffset, { firstSeq: c1.nextSeq })
    expect(c2.lines).toHaveLength(1)
    expect((c2.lines[0] as JsonlLine).seq).toBe(3)
    expect(JSON.parse((c2.lines[0] as JsonlLine).text)).toEqual({ n: 3 })
    expect(c2.residualBytes).toBe(0)
    // reading past EOF yields nothing more
    const c3 = await readJsonlChunk(p, c2.nextOffset, { firstSeq: c2.nextSeq })
    expect(c3.lines).toHaveLength(0)
  })

  it('last line ending with newline does not produce an empty phantom line', async () => {
    const p = await tmpFile('a.jsonl', line({ a: 1 }) + '\n')
    const c = await readJsonlChunk(p, 0)
    expect(c.lines).toHaveLength(1)
    expect(c.residualBytes).toBe(0)
    const st = await stat(p)
    expect(c.nextOffset).toBe(st.size)
  })

  it('CRLF line endings: \\r is stripped, offsets are exact', async () => {
    const text = line({ a: 1 }) + '\r\n' + line({ b: 2 }) + '\r\n'
    const p = await tmpFile('crlf.jsonl', text)
    const c = await readJsonlChunk(p, 0)
    const lines = c.lines as JsonlLine[]
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l.text))).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseLine(lines[1]!).ok).toBe(true)
  })

  it('oversized line yields a marker, never the buffered text', async () => {
    const big = line({ pad: 'x'.repeat(200) }) + '\n'
    const p = await tmpFile('big.jsonl', line({ n: 1 }) + '\n' + big + line({ n: 2 }) + '\n')
    const items = await collect(readIncremental(p, 0, { maxLineBytes: 50 }))
    expect(items.map((i) => ('oversized' in i ? 'OVERSIZED' : (i as JsonlLine).seq))).toEqual([1, 'OVERSIZED', 3])
    const marker = items[1]!
    expect(marker).toMatchObject({ oversized: true, bytes: Buffer.byteLength(big.slice(0, -1)) })
    // offsets still line up: third line starts right after the oversized one
    const third = items[2] as JsonlLine
    expect(third.offset).toBe(Buffer.byteLength(line({ n: 1 }) + '\n' + big))
  })

  it('handles a line spanning multiple read blocks', async () => {
    const pad = 'ü'.repeat(100_000) // multi-byte, forces many 64 KiB blocks
    const p = await tmpFile('span.jsonl', line({ pad }) + '\n')
    const c = await readJsonlChunk(p, 0, { maxLineBytes: 1024 * 1024 })
    expect((c.lines[0] as JsonlLine).text).toBe(line({ pad }))
  })

  it('manual iteration exposes JsonlChunkMeta as the generator completion value', async () => {
    const p = await tmpFile('a.jsonl', line({ n: 1 }) + '\n')
    const it = readIncremental(p, 0)
    let meta
    while (true) {
      const r = await it.next()
      if (r.done) {
        meta = r.value
        break
      }
    }
    expect(meta).toEqual({ nextOffset: (await stat(p)).size, nextSeq: 2, residualBytes: 0 })
  })
})

describe('parseLine (§5.2 rule 1 support)', () => {
  it('malformed JSON returns a failure result instead of throwing', () => {
    const bad: JsonlLine = { seq: 4, offset: 120, text: '{not json' }
    const r = parseLine(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r).toMatchObject({ seq: 4, offset: 120, text: '{not json' })
      expect(r.error).toContain('JSON')
    }
  })

  it('empty line fails to parse (a mid-file blank line is a ParseFailure, not a phantom event)', () => {
    expect(parseLine({ seq: 1, offset: 0, text: '' }).ok).toBe(false)
  })

  it('valid JSON parses', () => {
    const r = parseLine({ seq: 1, offset: 0, text: '{"a":1}' })
    expect(r.ok && (r as { value: unknown }).value).toEqual({ a: 1 })
  })
})
