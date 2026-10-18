/**
 * §5.1 `discover` + §4.4 row 4: one source per session file under `projects/**`,
 * deterministically ordered, with the coverage-recovery history index appended.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

  /**
   * §5.3, measured on a real home: `~/.claude` plus `~/.claude-deepseek` (6 files, a
   * `deepseek-v4-flash` model, the same usage dialect). Reading one root reported a smaller
   * world than the machine ran. Both stores must be sources, with path-derived ids that
   * cannot collide, and the result must stay sorted across the two roots.
   */
  it('reads a second store beside the canonical one (§5.3 variant roots)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agl-cc-variants-'))
    try {
      const canonical = join(home, '.claude')
      const variant = join(home, '.claude-deepseek')
      await mkdir(join(canonical, 'projects', '-work'), { recursive: true })
      await mkdir(join(variant, 'projects', '-work'), { recursive: true })
      await writeFile(join(canonical, 'projects', '-work', 'sess-a.jsonl'), '{}\n', 'utf8')
      await writeFile(join(variant, 'projects', '-work', 'sess-b.jsonl'), '{}\n', 'utf8')
      await writeFile(join(variant, 'settings.json'), '{}', 'utf8')

      const ctx = hostCtx({ homedir: home, dataRoot: null, env: {} })
      const specs = await collect(ctx)
      const paths = specs.map((s) => s.path)
      expect(paths).toContain(join(canonical, 'projects', '-work', 'sess-a.jsonl'))
      expect(paths).toContain(join(variant, 'projects', '-work', 'sess-b.jsonl'))
      // §4.2: two roots still enumerate deterministically, and ids stay path-derived.
      expect(specs).toEqual(await collect(ctx))
      expect(specs.filter((s) => s.sessionHint !== null).map((s) => s.path)).toEqual(
        [...specs.filter((s) => s.sessionHint !== null).map((s) => s.path)].sort(),
      )
      expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('detect reports the extra store instead of hiding it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agl-cc-variants-detect-'))
    try {
      await mkdir(join(home, '.claude', 'projects', '-w'), { recursive: true })
      await mkdir(join(home, '.claude-deepseek', 'projects', '-w'), { recursive: true })
      await writeFile(join(home, '.claude', 'projects', '-w', 'a.jsonl'), '{}\n', 'utf8')
      await writeFile(join(home, '.claude-deepseek', 'projects', '-w', 'b.jsonl'), '{}\n', 'utf8')
      const d = await claudeCodeAdapter.detect(hostCtx({ homedir: home, dataRoot: null, env: {} }))
      expect(d.present).toBe(true)
      expect(d.variantRoots).toEqual([join(home, '.claude-deepseek')])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
