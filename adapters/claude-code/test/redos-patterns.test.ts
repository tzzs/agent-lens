/**
 * CodeQL alerts #2-#5: the token-count and skill-path patterns used anchored quantifiers and a
 * split-ambiguous `\s*[:=]?\s*`, which CodeQL scored as polynomial on a long run of one
 * character. These tests hold two things together:
 *
 *   1. equivalence — the new `parseTokenCount` returns exactly what the old pipeline returned,
 *      over adversarial runs and a seeded pseudo-random corpus of the alphabet that matters.
 *      A ReDoS fix that silently stops parsing "12,345 tokens" is worse than the alert.
 *   2. a wall-clock bound — loose on purpose (a second, on a machine this loaded), because it
 *      exists to fail if someone restores the old shape, not to benchmark.
 *
 * The old pipeline is reproduced here deliberately: it is the thing being compared against.
 */
import { describe, expect, it } from 'vitest'
import { parseTokenCount } from '../src/normalize.ts'

/** The pre-fix implementation, verbatim, as the equivalence baseline. */
function parseTokenCountOld(text: string | null): number | null {
  if (!text) return null
  const match =
    /tokens\s*[:=]?\s*([\d][\d,.]*)/i.exec(text) ?? /([\d][\d,.]*)\s+tokens\b/i.exec(text)
  const raw = match?.[1]?.replace(/[.,]+$/, '')
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function trimSlashesOld(path: string): string {
  return path.replace(/\/+$/, '')
}
function trimSlashesNew(path: string): string {
  let end = path.length
  while (path[end - 1] === '/') end--
  return end === path.length ? path : path.slice(0, end)
}

/** Adversarial shapes first, then a seeded random walk over the characters that matter. */
function corpus(): string[] {
  const out: string[] = []
  for (let n = 0; n <= 40; n++) {
    const slash = '/'.repeat(n)
    const space = ' '.repeat(n)
    const digit = '0'.repeat(n)
    const comma = ','.repeat(n)
    out.push(
      slash,
      `a${slash}`,
      `${slash}a`,
      `skills/${slash}`,
      `tokens${space}`,
      `tokens${space}1`,
      `tokens${space}:${space}${space}12`,
      `tokens:${space}${digit}`,
      `tokens${space}${digit}${space}tokens`,
      `${digit}${space}`,
      `${digit}${space}tokens`,
      `${digit}${space}tokens${comma}`,
      `${digit}${comma}`,
      `${digit}${comma}tokens`,
      `1${comma}${comma}2 tokens`,
      `tokens = ${digit}${comma}.`,
      'no numbers here at all',
      `SkILl${slash}SKILL`,
      `x/${digit}tokens${comma}`,
      `${digit}tokenstokens`,
      `${digit}  tokens  ${digit}`,
    )
  }
  let seed = 20260929
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const alphabet = ['0', '1', ',', '.', ' ', '/', 't', 'k', 'e', 'n', 's', ':', '=', 'x']
  for (let i = 0; i < 6000; i++) {
    let s = ''
    for (let j = 0, len = 1 + Math.floor(rand() * 30); j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)]
    out.push(s)
  }
  return out
}

describe('the rewritten parsing returns exactly what the old patterns returned', () => {
  const cases = corpus()

  it('agrees on every corpus string, including where neither finds a number', () => {
    for (const s of cases) expect(parseTokenCount(s), JSON.stringify(s)).toBe(parseTokenCountOld(s))
  })

  it('still reads the word orders the §2.6 reminder actually produces', () => {
    // The right-hand column is what the OLD pipeline does — measured, not assumed. Two of
    // these are worth pinning precisely: a number separated from `tokens` by prose is not a
    // count (we did not gain parsing we never had), and a leading `.` is dropped rather than
    // rejected, because `[.,]+$` only trims the tail.
    for (const [text, want] of [
      ['12,345 tokens used', 12345],
      ['tokens: 900', 900],
      ['tokens = 900', 900],
      ['tokens 900', 900],
      ['tokens: 1,024 of 8,192', 1024],
      ['tokens used: 1,024 of 8,192', null],
      ['no digits tokens', null],
      ['.5 tokens', 5],
    ] as [string, number | null][]) {
      expect(parseTokenCount(text), text).toBe(want)
      expect(parseTokenCountOld(text), text).toBe(want)
    }
  })

  it('trims a trailing .,-run exactly as /[.,]+$/ did, including the runs it leaves alone', () => {
    // Alert #20: the tail trim, not the capture, was the quadratic part. Every shape here is a
    // separator run in a different position relative to the digits that bound it.
    for (const text of [
      'tokens: 1',
      'tokens: 1,',
      'tokens: 1.,.,',
      'tokens: 1,,,.',
      'tokens: 1,,1',
      'tokens: 1.,1,',
      'tokens: 1,.,.,2.',
      '1,, tokens',
      '12,.,. tokens',
      '.,1 tokens',
      'tokens: .,',
      'tokens: ,1',
    ]) {
      expect(parseTokenCount(text), JSON.stringify(text)).toBe(parseTokenCountOld(text))
    }
  })

  it('trailing-slash trim is unchanged', () => {
    for (const s of cases) expect(trimSlashesNew(s), JSON.stringify(s)).toBe(trimSlashesOld(s))
  })
})

describe('the adversarial input no longer costs quadratic time', () => {
  it('trims a 200k separator run in well under a second', () => {
    const started = performance.now()
    expect(trimSlashesNew(`skills/a${'/'.repeat(200_000)}`)).toBe('skills/a')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('parses a digit, a 100k separator run, then a digit in well under a second (alert #20)', () => {
    // The old `/[.,]+$/` retried the whole run from every start position because the final
    // digit made `$` fail each time. The leading `tokens:` puts the run in the capture. Only
    // the new code runs at 100k — the old one is the quadratic path — so equivalence is
    // checked at a size where the old one is still instant.
    for (const sep of [',', '.', '.,']) {
      const small = `tokens: 1${sep.repeat(300)}1`
      expect(parseTokenCount(small), sep).toBe(parseTokenCountOld(small))
      const input = `tokens: 1${sep.repeat(100_000)}1`
      const started = performance.now()
      parseTokenCount(input)
      expect(performance.now() - started).toBeLessThan(1000)
    }
  })

  it('parses a 100k digit run against a 100k space run in well under a second', () => {
    const input = '0'.repeat(100_000) + ' '.repeat(100_000)
    const started = performance.now()
    expect(parseTokenCount(input)).toBeNull()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
