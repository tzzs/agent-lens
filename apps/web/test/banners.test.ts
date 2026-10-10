/**
 * The §14 anti-drift seam for the doctor's coverage line.
 *
 * The dashboard composes these sentences itself from the API's structured fields
 * so they can be said in the viewer's language — which is only honest while the
 * English it produces is the sentence the server and the terminal produce from the
 * same numbers. The cases below assert byte equality against the builder the
 * terminal uses, so a reword on one surface fails the other's test.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { coverageBanner } from '@agentlens/server'
import { activeLocale, setActiveLocale } from '@agentlens/i18n'
import { coverageText } from '../src/lib/banners.ts'

const started = activeLocale()
afterEach(() => setActiveLocale(started))

describe('coverage banner', () => {
  const dirs = (n: number) => Array.from({ length: n }, (_, i) => ({ dir: `d${i}`, agentIds: ['a'], missingSources: 1, lastEventAt: null }))
  const roots = (n: number) => Array.from({ length: n }, (_, i) => ({ project: `p${i}`, root: `/r${i}` }))

  it('matches the server clause-for-clause in English', () => {
    setActiveLocale('en')
    expect(coverageText({ emptyDirs: dirs(3), projectDirsWithoutSessions: roots(2) })).toBe(
      coverageBanner(3, 2),
    )
    expect(coverageText({ emptyDirs: dirs(1), projectDirsWithoutSessions: [] })).toBe(coverageBanner(1, 0))
    expect(coverageText({ emptyDirs: [], projectDirsWithoutSessions: roots(1) })).toBe(coverageBanner(0, 1))
  })

  it('stays silent exactly when the server sends no banner', () => {
    expect(coverageText({ emptyDirs: [], projectDirsWithoutSessions: [] })).toBe('')
    expect(coverageBanner(0, 0)).toBeNull()
  })

  it('drops the English plural agreement in Chinese', () => {
    setActiveLocale('zh')
    const line = coverageText({ emptyDirs: dirs(3), projectDirsWithoutSessions: roots(2) })
    expect(line).toContain('有 3 个源目录仍在')
    expect(line).toContain('2 个已归属项目')
    expect(line).toContain('历史并不完整')
  })
})
