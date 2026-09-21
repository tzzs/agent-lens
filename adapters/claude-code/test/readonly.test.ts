/**
 * §5.2 rule 3: every source-file access is read-only. Proof by snapshot: run the
 * whole adapter surface against the fixture store and show the tree is identical,
 * content and metadata alike, afterwards.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isParseFailure, type RawRecord } from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { HOST_DIR, ctxFor, hostCtx, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

async function snapshot(root: string): Promise<string[]> {
  const rows: string[] = []
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const path = join(dir, name)
      const s = await stat(path)
      rows.push(
        `${path.slice(root.length)}|${s.isDirectory() ? 'd' : 'f'}|${s.size}|${s.mtimeMs}|${s.ino}|${(s.mode & 0o777).toString(8)}|${s.nlink}`,
      )
      if (s.isDirectory()) await walk(path)
    }
  }
  await walk(root)
  return rows
}

describe('read-only guarantee (§5.2 rule 3)', () => {
  it('detect + discover + parse + normalize + capabilities change nothing on disk', async () => {
    const before = await snapshot(HOST_DIR)
    const host = hostCtx()
    const sources = []
    const eventCount = { events: 0, failures: 0 }

    await claudeCodeAdapter.detect(host)
    for await (const spec of claudeCodeAdapter.discover(host)) sources.push(spec)
    expect(sources.length).toBeGreaterThan(0)

    for (const spec of sources) {
      const records: RawRecord[] = []
      for await (const record of claudeCodeAdapter.parse(
        spec,
        { offset: 0 },
        { source: spec, agentId: 'claude-code', hostId: 'claude-code' },
      )) {
        records.push(record)
      }
      const ctx = ctxFor(spec.path, spec.sessionHint)
      resetStateFor(ctx)
      for (const record of records) {
        const result = await claudeCodeAdapter.normalize(record, ctx)
        if (isParseFailure(result)) eventCount.failures++
        else eventCount.events += result.events.length
      }
    }
    const catalog = await claudeCodeAdapter.capabilities!(host)

    expect(eventCount.events).toBeGreaterThan(0)
    expect(catalog.length).toBeGreaterThan(0)
    expect(await snapshot(HOST_DIR)).toEqual(before)
  })

  it('scenario fixtures are read as data and stay untouched', async () => {
    const before = await snapshot(HOST_DIR)
    const text = await readFixture('multi-block-usage.jsonl')
    const ctx = ctxFor('multi-block-usage.jsonl')
    resetStateFor(ctx)
    for (const record of recordsFromJsonl(text)) await claudeCodeAdapter.normalize(record, ctx)
    expect(await snapshot(HOST_DIR)).toEqual(before)
  })

  it('the adapter exposes only the read-side AgentAdapter surface', () => {
    expect(Object.keys(claudeCodeAdapter).sort()).toEqual([
      'aggregation',
      'capabilities',
      'detect',
      'discover',
      'displayName',
      'id',
      'normalize',
      'parse',
      'parserVersion',
    ])
  })
})
