/**
 * The §14 anti-drift seam for the two first-screen banners.
 *
 * The dashboard composes these sentences itself from the API's structured fields
 * so they can be said in the viewer's language — which is only honest while the
 * English it produces is the sentence the server and the terminal produce from the
 * same numbers. Both cases below assert byte equality against the builders the
 * terminal uses, so a reword on one surface fails the other's test.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { coverageBanner } from '@agentlens/server'
import { hostSplitFor, hostSplitNotice, isDegenerateHost, type HostCount } from '@agentlens/storage'
import { activeLocale, setActiveLocale } from '@agentlens/i18n'
import { coverageText, hostSplitText } from '../src/lib/banners.ts'
import type { HostSplitBanner } from '../src/lib/api.ts'

const started = activeLocale()
afterEach(() => setActiveLocale(started))

/** The same derivation `packages/server/src/banners.ts` does, from the same parts. */
function banner(agentId: string, counts: HostCount[]): HostSplitBanner {
  const split = hostSplitFor(agentId, counts)
  if (!split) throw new Error('fixture is not splittable')
  return {
    agentId: split.agentId,
    dominantHost: split.dominant.host,
    dominantShare: split.dominant.share,
    hosts: split.hosts,
    degenerate: isDegenerateHost(split.agentId, split.dominant.host),
    splitByDefault: true,
    message: `${hostSplitNotice(split)} — shown split by default`,
  }
}

const twoHosts = (): HostCount[] => [
  { host: 'claude-desktop', events: 45_285 },
  { host: 'claude-code', events: 29_772 },
]

describe('host-split banner', () => {
  it('says in English exactly what the server says', () => {
    setActiveLocale('en')
    const b = banner('claude-code', twoHosts())
    expect(b.degenerate).toBe(false)
    expect(hostSplitText(b)).toBe(b.message)
    expect(hostSplitText(b)).toBe('60.3% of claude-code records came from claude-desktop, not claude-code — shown split by default')
  })

  it('switches to the minority when the dominant host is the agent\'s own name', () => {
    setActiveLocale('en')
    const b = banner('claude-code', [
      { host: 'claude-code', events: 90 },
      { host: 'mac-mini', events: 10 },
    ])
    expect(b.degenerate).toBe(true)
    expect(hostSplitText(b)).toBe(b.message)
    expect(hostSplitText(b)).toContain('are its own host, the rest is mac-mini 10.0%')
  })

  it('keeps the one number when it says it in Chinese', () => {
    setActiveLocale('zh')
    const b = banner('claude-code', twoHosts())
    const line = hostSplitText(b)
    expect(line).toContain('60.3%')
    expect(line).toContain('claude-desktop')
    expect(line).not.toContain(' came from ')
  })
})

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
