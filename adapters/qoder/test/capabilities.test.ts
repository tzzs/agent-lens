/**
 * Static capability catalog (§5.1): skills directories + mcp-router.json,
 * tolerant of absence, never throwing.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capabilities } from '../src/capabilities.ts'
import { HOST_DIR, hostCtx } from './helpers.ts'

describe('capabilities', () => {
  it('lists skill dirs and MCP servers from the fixture host', async () => {
    const cats = await capabilities(hostCtx({ dataRoot: HOST_DIR }))
    expect(cats).toContainEqual({ type: 'mcp', name: 'qoder_market', provider: 'http', source: join(HOST_DIR, 'mcp-router.json') })
    expect(cats).toContainEqual({ type: 'mcp', name: 'local_tool', provider: 'stdio', source: join(HOST_DIR, 'mcp-router.json') })
    expect(cats).toContainEqual({ type: 'skill', name: 'demo-skill', provider: 'userSettings', source: join(HOST_DIR, 'skills') })
    expect(cats).toContainEqual({ type: 'skill', name: 'other-skill', provider: 'userSettings', source: join(HOST_DIR, 'skills') })
    expect(cats.some((c) => c.name === 'README.md')).toBe(false)
    // sorted deterministically
    const names = cats.map((c) => `${c.type}/${c.name}`)
    expect(names).toEqual([...names].sort())
  })

  it('an absent root yields [] without throwing', async () => {
    const cats = await capabilities(hostCtx({ dataRoot: join(HOST_DIR, 'nowhere') }))
    expect(cats).toEqual([])
  })
})
