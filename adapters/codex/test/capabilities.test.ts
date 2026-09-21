/**
 * §5.1 `capabilities` — the static catalog, and the honest empties around it.
 *
 * codex.md §3.2 measures ZERO hook records in 221,416 rollout records, while `~/.codex/hooks.json`
 * is a supported config file. That asymmetry is the point of this catalog: a configured Codex
 * hook is precisely "installed, never observable", so it must be reported from the config
 * layer and never invented as an event.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilities, codexAdapter } from '../src/index.ts'
import { hooksFileOf } from '../src/paths.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

function storeOf(dir: string) {
  const root = join(FIXTURES_DIR, dir)
  return hostCtx({ dataRoot: root, homedir: root })
}

describe('capabilities catalog (§11)', () => {
  it('reads the configured hooks out of hooks.json', async () => {
    const catalog = await capabilities(hostCtx())
    expect(catalog.length).toBeGreaterThan(0)
    expect(catalog.every((c) => c.type === 'hook')).toBe(true)
    expect(catalog.map((c) => c.name).sort()).toEqual(['bash', 'echo synthetic-pre', 'load-context'])
    expect(new Set(catalog.map((c) => c.type))).toEqual(new Set(['hook']))
    for (const entry of catalog) expect(entry.source).toBe(hooksFileOf(hostCtx()))
    // sorted by name so a rescan produces the same rows
    expect(catalog.map((c) => c.name)).toEqual([...catalog.map((c) => c.name)].sort())
  })

  it('tolerates the other shapes an agent config comes in, and dedupes by name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentlens-codex-caps-'))
    const file = join(dir, 'hooks.json')
    try {
      const shapes: unknown[] = [
        // flat array of names
        ['SessionStart', 'Stop'],
        // { hooks: [ … ] }
        { hooks: [{ name: 'a-hook', event: 'PreToolUse' }] },
        // nested command form, with the same command twice
        { hooks: { PostToolUse: [{ matcher: 'edit', hooks: [{ type: 'command', command: 'x' }, { type: 'command', command: 'x' }] }] } },
        // event list per entry
        { hooks: [{ events: ['PreCommit', 'PostCommit'] }] },
      ]
      const collected: string[][] = []
      for (const shape of shapes) {
        await writeFile(file, JSON.stringify(shape), 'utf8')
        const catalog = await capabilities(hostCtx({ dataRoot: dir, homedir: dir }))
        collected.push(catalog.map((c) => c.name))
        expect(catalog.every((c) => c.type === 'hook' && c.name.length > 0)).toBe(true)
      }
      expect(collected[0]).toEqual(['SessionStart', 'Stop'])
      expect(collected[1]).toEqual(['a-hook'])
      expect(collected[2]).toEqual(['edit', 'x'])
      expect(collected[3]).toEqual(['PostCommit', 'PreCommit'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absent, empty or unparseable catalog yields [] instead of guessing', async () => {
    expect(await capabilities(storeOf('host-noversion'))).toEqual([])
    expect(await capabilities(storeOf('host-empty'))).toEqual([])
    const dir = await mkdtemp(join(tmpdir(), 'agentlens-codex-caps-bad-'))
    try {
      await writeFile(join(dir, 'hooks.json'), '{ this is not json', 'utf8')
      expect(await capabilities(hostCtx({ dataRoot: dir, homedir: dir }))).toEqual([])
      await writeFile(join(dir, 'hooks.json'), JSON.stringify({ hooks: null }), 'utf8')
      expect(await capabilities(hostCtx({ dataRoot: dir, homedir: dir }))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the adapter exposes capabilities as an optional read-side method', async () => {
    expect(typeof codexAdapter.capabilities).toBe('function')
    expect(await codexAdapter.capabilities!(hostCtx())).toEqual(await capabilities(hostCtx()))
  })
})
