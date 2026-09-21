/**
 * §5.1 `capabilities` — the static install surface (§一): `cli/plugins/installed_plugins.json`
 * and the unpacked `cli/plugins/data/<name>@<marketplace>/` directories.
 *
 * The catalog is deliberately narrow. §五's caveat says ZCode cannot show a dimension and
 * the adapter must not claim one: skills are visible as INVOCATIONS (the `Skill` tool names
 * them) but the store's `session_entry` table is empty here, so there is no
 * installed-but-never-used skill set to enumerate, and inventing one would put a wrong entity
 * into the canonical catalog.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilities } from '../src/capabilities.ts'
import { buildHost, writePluginCatalog } from '../fixtures/build-host.ts'
import { hostCtx } from './helpers.ts'

describe('zcode capabilities (§5.1)', () => {
  it('unions the install manifest with the unpacked plugin directories', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      await writePluginCatalog(host.dir)
      const catalog = await capabilities(hostCtx(host.dir))
      expect(catalog.map((c) => `${c.type}:${c.name}:${c.provider ?? '-'}`)).toEqual([
        'plugin:browser-use:demo-market',
        'plugin:computer-use:demo-market',
        'plugin:github:demo-market',
        // The manifest is authoritative, so it wins the clash on `lark-cli`'s marketplace.
        'plugin:lark-cli:no-market',
        'plugin:mimosa:demo-market',
      ])
      // A name both surfaces saw says so, rather than picking one and hiding the other.
      const mimosa = catalog.find((c) => c.name === 'mimosa')
      expect(String(mimosa?.source)).toContain('installed_plugins.json')
      expect(String(mimosa?.source)).toContain('data')
      expect(new Set(catalog.map((c) => c.type))).toEqual(new Set(['plugin']))
    } finally {
      await host.close()
    }
  })

  it('a manifest-only plugin keeps its own marketplace, including a null one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-plugins-'))
    try {
      const plugins = join(dir, 'cli', 'plugins')
      await mkdir(join(plugins, 'data'), { recursive: true })
      await writeFile(
        join(plugins, 'installed_plugins.json'),
        JSON.stringify({ version: 1, plugins: [{ name: 'only-in-manifest' }, { id: 'id-only@demo-market' }, {}, { name: '' }] }),
        'utf8',
      )
      const catalog = await capabilities(hostCtx(dir))
      // An entry with no name is skipped rather than reported as an empty capability; an
      // id-only entry is named by its id, since that is `name@marketplace` in the real file.
      expect(catalog.map((c) => c.name)).toEqual(['id-only', 'only-in-manifest'])
      expect(catalog[1]).toEqual({
        type: 'plugin',
        name: 'only-in-manifest',
        provider: null,
        source: join(plugins, 'installed_plugins.json'),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns nothing rather than failing when the surfaces are absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-plugins-empty-'))
    try {
      expect(await capabilities(hostCtx(dir))).toEqual([])
      await mkdir(join(dir, 'cli'), { recursive: true })
      expect(await capabilities(hostCtx(dir))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable manifest is an empty answer, not a throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-plugins-broken-'))
    try {
      const plugins = join(dir, 'cli', 'plugins')
      await mkdir(plugins, { recursive: true })
      await writeFile(join(plugins, 'installed_plugins.json'), '{"version":1,"plugins": [', 'utf8')
      expect(await capabilities(hostCtx(dir))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('claims no dimension ZCode cannot show (§五)', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      await writePluginCatalog(host.dir)
      const catalog = await capabilities(hostCtx(host.dir))
      const types = new Set(catalog.map((c) => c.type))
      expect(types.has('skill')).toBe(false)
      expect(types.has('mcp')).toBe(false)
      expect(types.has('connector')).toBe(false)
      expect(types.has('hook')).toBe(false)
      // A directory that is not `<name>@<marketplace>` is not evidence of an installed plugin.
      expect(catalog.map((c) => c.name)).not.toContain('marketplaces')
    } finally {
      await host.close()
    }
  })
})
