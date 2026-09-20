/**
 * §5.1 `capabilities`: the static catalog ("installed 62 / invoked 9", §11) built
 * from the enumerable places only — skills dir, installed-plugins file, MCP servers.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeCodeAdapter } from '../src/index.ts'
import { HOST_DIR, hostCtx } from './helpers.ts'

const catalog = await claudeCodeAdapter.capabilities!(hostCtx())
const byName = new Map(catalog.map((c) => [`${c.type}:${c.name}`, c]))

describe('capabilities', () => {
  it('enumerates installed skills from <root>/skills/*', () => {
    expect(byName.get('skill:grill-with-docs')).toMatchObject({
      type: 'skill',
      provider: 'userSettings',
      source: join(HOST_DIR, 'skills'),
    })
    expect(byName.has('skill:review-checklist')).toBe(true)
    expect(catalog.filter((c) => c.type === 'skill')).toHaveLength(2)
  })

  it('reads installed plugins, tolerating the {plugins:[...]} shape', () => {
    expect(byName.get('plugin:build-ios-apps')).toMatchObject({
      type: 'plugin',
      provider: 'anthropic-skills',
      source: join(HOST_DIR, 'plugins', 'installed_plugins.json'),
    })
    expect(byName.has('plugin:design')).toBe(true)
  })

  it('reads MCP servers from ~/.claude.json and marks plugin-provided ones', () => {
    expect(byName.get('mcp:Claude_Browser')).toMatchObject({
      type: 'mcp',
      provider: 'userSettings',
      source: join(HOST_DIR, '.claude.json'),
    })
    expect(byName.get('mcp:plugin_build-ios-apps_xcodebuildmcp')?.provider).toBe('plugin')
  })

  it('sorts deterministically and never throws on a missing store', async () => {
    const types = catalog.map((c) => `${c.type}:${c.name}`)
    expect(types).toEqual([...types].sort())
    const ctx = hostCtx({ dataRoot: join(HOST_DIR, 'nope'), homedir: join(HOST_DIR, 'nope') })
    await expect(claudeCodeAdapter.capabilities!(ctx)).resolves.toEqual([])
  })
})
