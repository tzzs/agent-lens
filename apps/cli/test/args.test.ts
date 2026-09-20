import { describe, expect, it } from 'vitest'
import { CLI_FLAG_SCHEMA, parseArgs, UsageError } from '../src/args.ts'

const p = (argv: string[]) => parseArgs(argv, CLI_FLAG_SCHEMA)

describe('args parser grammar', () => {
  it('command words + value flags + repeats', () => {
    const r = p(['usage', '--by', 'model', '--agent', 'a', '--agent', 'b'])
    expect(r.words).toEqual(['usage'])
    expect(r.flags.list('by')).toEqual(['model'])
    expect(r.flags.list('agent')).toEqual(['a', 'b'])
  })

  it('--flag=value form', () => {
    const r = p(['usage', '--since=7d', '--limit=5'])
    expect(r.flags.str('since')).toBe('7d')
    expect(r.flags.num('limit')).toBe(5)
  })

  it('comma lists split in list()', () => {
    const r = p(['usage', '--by', 'day,model'])
    expect(r.flags.list('by')).toEqual(['day', 'model'])
  })

  it('boolean flags, =true/=false, aliases', () => {
    expect(p(['status', '--no-content']).flags.bool('no-content')).toBe(true)
    expect(p(['status', '--no-content=false']).flags.bool('no-content')).toBe(false)
    expect(p(['--help']).flags.bool('help')).toBe(true)
    expect(p(['-h']).flags.bool('help')).toBe(true)
    expect(p(['-V']).flags.bool('version')).toBe(true)
  })

  it('positionals after the command survive; `--` ends flags', () => {
    const r = p(['session', 'abc123', '--', '--weird'])
    expect(r.words).toEqual(['session', 'abc123', '--weird'])
  })

  it('unknown flag is a UsageError', () => {
    expect(() => p(['usage', '--bogus', '1'])).toThrow(UsageError)
    expect(() => p(['usage', '-x'])).toThrow(UsageError)
  })

  it('value flag without a value is a UsageError', () => {
    expect(() => p(['usage', '--since'])).toThrow(UsageError)
    expect(() => p(['usage', '--since', '--until', '7d'])).toThrow(UsageError)
  })

  it('num() rejects garbage with UsageError', () => {
    const r = p(['usage', '--limit', 'lots'])
    expect(() => r.flags.num('limit')).toThrow(UsageError)
  })
})
