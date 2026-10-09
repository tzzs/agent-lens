/**
 * `mcpOf` was rewritten to drop `sep === rest.length - 2` (CodeQL js/incorrect-suffix-check).
 * The old function is kept here verbatim as the baseline, and compared over every string up to
 * length 7 of the alphabet that decides the answer: the `mcp__` prefix is fixed, the rest is
 * built from `_`, `a` and `b`, so every placement of `__` — leading, trailing, doubled,
 * tripled, absent — is covered, not just the ones somebody thought of.
 */
import { describe, expect, it } from 'vitest'
import { mcpOf } from '../src/record.ts'

function mcpOfOld(toolName: string | null): { server: string; tool: string } | null {
  if (!toolName || !toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

function* strings(alphabet: string, maxLength: number): Generator<string> {
  let level = ['']
  yield ''
  for (let n = 1; n <= maxLength; n++) {
    const next: string[] = []
    for (const prefix of level) for (const c of alphabet) next.push(prefix + c)
    for (const s of next) yield s
    level = next
  }
}

describe('mcpOf', () => {
  it('agrees with the pre-rewrite function on every short string', () => {
    let checked = 0
    for (const rest of strings('_ab', 7)) {
      const name = `mcp__${rest}`
      expect(mcpOf(name), JSON.stringify(name)).toEqual(mcpOfOld(name))
      checked++
    }
    expect(checked).toBeGreaterThan(3000)
  })

  it('splits the two MCP shapes the ZCode store actually writes', () => {
    expect(mcpOf('mcp__computer-use__screenshot')).toEqual({ server: 'computer-use', tool: 'screenshot' })
    expect(mcpOf('mcp__plugin_mimosa_mimosa__security_scan_start')).toEqual({
      server: 'plugin_mimosa_mimosa',
      tool: 'security_scan_start',
    })
  })

  it('refuses a name with no server, no tool, or no mcp prefix', () => {
    for (const name of [null, '', 'Read', 'mcp__', 'mcp____tool', 'mcp__server', 'mcp__server__']) {
      expect(mcpOf(name), String(name)).toBeNull()
    }
  })
})
