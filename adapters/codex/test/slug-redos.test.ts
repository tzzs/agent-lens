/**
 * CodeQL alert #6: `slugOriginator` trimmed its edge dashes with `/^-+|-+$/g`, an anchored
 * quantifier that re-tries at every position of a long '-' run. The rewrite cuts by index,
 * which is only equivalent because the preceding `[^a-z0-9]+` collapse leaves at most one '-'
 * at each end — the first test pins that premise, so the second cannot quietly become wrong
 * if the collapse is ever edited.
 */
import { describe, expect, it } from 'vitest'
import { slugOriginator } from '../src/record.ts'

const oldWay = (originator: string): string =>
  originator.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

describe('slugOriginator still produces exactly what it produced before', () => {
  it('agrees with the old implementation over the shapes that reach it', () => {
    const cases = [
      'Codex Desktop',
      'codex_exec',
      'codex_cli_rs',
      '  Codex__Desktop  ',
      '',
      '-',
      '--',
      '---',
      '-a-',
      '----Desktop----',
      'a'.repeat(60),
      '-'.repeat(200),
      `-${'-'.repeat(300)}-`,
      'Codex  Desktop   TUI',
      '桌面',
      '123',
      'x-----y',
      '  ',
    ]
    for (const s of cases) expect(slugOriginator(s), JSON.stringify(s)).toBe(oldWay(s))
  })

  it('never leaves a doubled dash, which is what makes the index trim safe', () => {
    for (const s of ['-'.repeat(500), 'a' + '-'.repeat(500) + 'b', 'a!!??--b', '---']) {
      expect(slugOriginator(s)).not.toMatch(/--/)
    }
  })
})

describe('a long dash run no longer costs quadratic time', () => {
  it('slugs 200k separators in well under a second', () => {
    const started = performance.now()
    expect(slugOriginator('-'.repeat(200_000))).toBe('')
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
