import { describe, expect, it } from 'vitest'
import { buildHash, listOf, parseHash, patchQuery } from '../src/lib/hashquery.ts'

describe('hash query', () => {
  it('splits the path from the query and keeps the bare path routes working', () => {
    expect(parseHash('')).toEqual({ path: '/', query: {} })
    expect(parseHash('#/')).toEqual({ path: '/', query: {} })
    expect(parseHash('#/sessions/abc')).toEqual({ path: '/sessions/abc', query: {} })
    expect(parseHash('#/sessions?agents=codex,claude-code&q=fix%20bug')).toEqual({
      path: '/sessions',
      query: { agents: 'codex,claude-code', q: 'fix bug' },
    })
    expect(parseHash('#?since=7d')).toEqual({ path: '/', query: { since: '7d' } })
  })

  it('drops empty values so a default never lands in the URL', () => {
    expect(parseHash('#/x?agent=&since=7d')).toEqual({ path: '/x', query: { since: '7d' } })
    expect(buildHash('/sessions', { agents: '', q: undefined, since: null })).toBe('#/sessions')
  })

  it('builds a stable hash: sorted keys, so equal queries compare equal', () => {
    expect(buildHash('/sessions', { q: 'a b', agents: 'codex' })).toBe('#/sessions?agents=codex&q=a+b')
    expect(buildHash('/sessions', { agents: 'codex', q: 'a b' })).toBe(buildHash('/sessions', { q: 'a b', agents: 'codex' }))
  })

  it('keeps list commas readable and still round-trips them', () => {
    expect(buildHash('/projects', { open: 'a,b' })).toBe('#/projects?open=a,b')
    expect(parseHash('#/projects?open=a,b').query.open).toBe('a,b')
    expect(parseHash('#/projects?open=a%2Cb').query.open).toBe('a,b')
  })

  it('round-trips ids that carry reserved characters', () => {
    const project = 'repo&name=1?#x'
    expect(parseHash(buildHash('/projects', { open: project })).query.open).toBe(project)
  })

  it('patches: set, replace, remove, and leaves the input alone', () => {
    const q = { since: '7d', agent: 'codex' }
    expect(patchQuery(q, { agent: undefined, host: 'mac' })).toEqual({ since: '7d', host: 'mac' })
    expect(patchQuery(q, { since: '' })).toEqual({ agent: 'codex' })
    expect(q).toEqual({ since: '7d', agent: 'codex' })
  })

  it('reads comma lists', () => {
    expect(listOf(undefined)).toEqual([])
    expect(listOf('')).toEqual([])
    expect(listOf('a,,b')).toEqual(['a', 'b'])
  })
})
