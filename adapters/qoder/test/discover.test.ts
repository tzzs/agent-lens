/**
 * `discover` over the synthetic host tree: one jsonl source per session file,
 * deterministically sorted, with the file stem as session hint (§1.1: one file
 * = one session).
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveSourceId, type SourceSpec } from '@agentlens/event-model'
import { discover } from '../src/discover.ts'
import { HOST_DIR, hostCtx } from './helpers.ts'

async function collect(ctx: Parameters<typeof discover>[0]): Promise<SourceSpec[]> {
  const out: SourceSpec[] = []
  for await (const s of discover(ctx)) out.push(s)
  return out
}

describe('discover', () => {
  it('yields every session file exactly once, sorted, with ids and hints', async () => {
    const sources = await collect(hostCtx({ dataRoot: HOST_DIR }))
    expect(sources.map((s) => s.path)).toEqual([
      join(HOST_DIR, 'projects/loose-file.jsonl'),
      join(HOST_DIR, 'projects/sub-Users-example-alpha/11111111-aaaa-4aaa-8aaa-111111111111.jsonl'),
      join(HOST_DIR, 'projects/sub-Users-example-alpha/empty-session.jsonl'),
      join(HOST_DIR, 'projects/sub-Users-example-beta/22222222-ffff-4fff-8fff-222222222222.jsonl'),
    ].sort())
    for (const s of sources) {
      expect(s.kind).toBe('jsonl')
      expect(s.id).toBe(deriveSourceId('qoder', s.path))
    }
    expect(sources[1]!.sessionHint).toBe('11111111-aaaa-4aaa-8aaa-111111111111')
    expect(sources[2]!.sessionHint).toBe('empty-session')
  })

  it('is deterministic across repeated runs', async () => {
    const a = await collect(hostCtx({ dataRoot: HOST_DIR }))
    const b = await collect(hostCtx({ dataRoot: HOST_DIR }))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('an absent store yields nothing without throwing', async () => {
    const sources = await collect(hostCtx({ dataRoot: join(HOST_DIR, 'does-not-exist') }))
    expect(sources).toEqual([])
  })
})
