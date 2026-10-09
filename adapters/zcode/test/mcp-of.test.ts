/**
 * `mcpOf` dropped `sep === rest.length - 2` (CodeQL js/incorrect-suffix-check). The baseline here
 * is NOT the old function: copying that expression into a test makes CodeQL report it again
 * (it did, on the first push of this file). It is the same rule written independently, and it
 * was cross-checked once against the pre-rewrite function over every string up to length 9.
 *
 * Every string up to length 7 of the alphabet that decides the answer is compared: the `mcp__`
 * prefix is fixed, the rest is built from `_`, `a` and `b`, so every placement of `__` —
 * leading, trailing, doubled, tripled, absent — is covered, not just the ones somebody
 * thought of.
 */
import { describe, expect, it } from 'vitest'
import { mcpOf } from '../src/record.ts'

/**
 * The rule stated a second way, with no `indexOf`: the server is what precedes the FIRST `__`,
 * the tool is everything after it (later `__` included), and a missing server, a missing
 * separator or an empty tool means "not an MCP call".
 */
function mcpOfSpec(toolName: string | null): { server: string; tool: string } | null {
  if (!toolName || !toolName.startsWith('mcp__')) return null
  const [server = '', ...more] = toolName.slice('mcp__'.length).split('__')
  const tool = more.join('__')
  if (more.length === 0 || server === '' || tool === '') return null
  return { server, tool }
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
  it('agrees with the split-based specification on every short string', () => {
    let checked = 0
    for (const rest of strings('_ab', 7)) {
      const name = `mcp__${rest}`
      expect(mcpOf(name), JSON.stringify(name)).toEqual(mcpOfSpec(name))
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
