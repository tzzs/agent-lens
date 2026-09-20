/**
 * §5.1 `discover` + §4.4 row 4: one source per session file under `projects/**`,
 * deterministically ordered, with the coverage-recovery history index appended.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveSourceId, type SourceSpec } from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { HOST_DIR, hostCtx } from './helpers.ts'

async function collect(ctx = hostCtx()): Promise<SourceSpec[]> {
  const out: SourceSpec[] = []
  for await (const spec of claudeCodeAdapter.discover(ctx)) out.push(spec)
  return out
}

describe('discover', () => {
  it('finds every session jsonl under projects/** and ids them from the path', async () => {
    const specs = await collect()
    const paths = specs.map((s) => s.path)
    expect(paths).toContain(join(HOST_DIR, 'projects', '-work-alpha', 'sess-alpha-1.jsonl'))
    expect(paths).toContain(join(HOST_DIR, 'projects', '-work-beta', 'sess-beta-1.jsonl'))
    for (const spec of specs) {
      expect(spec.kind).toBe('jsonl')
      expect(spec.id).toBe(deriveSourceId('claude-code', spec.path))
      expect(spec).not.toHaveProperty('lastOffset')
    }
  })

  it('is sorted and identical across two runs (§4.2 replay determinism)', async () => {
    const first = await collect()
    const second = await collect()
    expect(second).toEqual(first)
    const sessionPaths = first.filter((s) => s.sessionHint !== null).map((s) => s.path)
    expect(sessionPaths).toEqual([...sessionPaths].sort())
  })

  it('carries the file name as sessionHint (§2.1 one file is one session)', async () => {
    const specs = await collect()
    expect(specs.find((s) => s.path.endsWith('sess-beta-1.jsonl'))?.sessionHint).toBe('sess-beta-1')
  })

  it('appends ~/.claude/history.jsonl as a distinct, hint-less source last', async () => {
    const specs = await collect()
    const last = specs[specs.length - 1]!
    expect(last.path).toBe(join(HOST_DIR, 'history.jsonl'))
    expect(last.sessionHint).toBeNull()
    expect(specs.filter((s) => s.path.endsWith('history.jsonl'))).toHaveLength(1)
  })

  it('an absent history index simply yields no extra source', async () => {
    const ctx = hostCtx({ dataRoot: join(HOST_DIR, 'nope'), homedir: join(HOST_DIR, 'nope') })
    expect(await collect(ctx)).toEqual([])
  })
})
