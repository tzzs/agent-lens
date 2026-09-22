/**
 * §5.1 `capabilities` — the static install surface: SKILL.md directories and `.ts`
 * extensions, nothing else, in a stable order (§11: no guessed MCP).
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilities } from '../src/index.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

describe('capabilities', () => {
  it('catalogs exactly the marker-bearing skills and the extension files', async () => {
    const catalog = await capabilities(hostCtx())
    expect(catalog).toEqual([
      { type: 'plugin', name: 'orca-status', provider: null, source: join(HOST_DIR, 'extensions') },
      { type: 'skill', name: 'alpha-skill', provider: 'userSettings', source: join(HOST_DIR, 'skills') },
      { type: 'skill', name: 'beta-skill', provider: 'userSettings', source: join(HOST_DIR, 'skills') },
    ])
  })

  it('a directory without SKILL.md, and a loose file, are not skills', async () => {
    const names = (await capabilities(hostCtx())).map((c) => c.name)
    expect(names).not.toContain('not-a-skill')
    expect(names).not.toContain('stray')
    expect(names).not.toContain('README')
  })

  it('missing catalogs degrade to an empty list, never a throw', async () => {
    expect(await capabilities(hostCtx({ dataRoot: join(FIXTURES_DIR, 'host-empty') }))).toEqual([])
    expect(await capabilities(hostCtx({ dataRoot: join(FIXTURES_DIR, 'no-such-root') }))).toEqual([])
  })
})
