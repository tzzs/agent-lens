/**
 * The two §14 first-screen banners, composed in the browser from the structured
 * fields the API already sends.
 *
 * The server still answers with its own English `message` / `banner` strings (the
 * terminal reads the same rule through `@agentlens/storage`), so the numbers are
 * the server's and only the *wording* is the viewer's. `apps/web/test/banners.test.ts`
 * pins the English rendering against the server's, because two phrasings of one
 * fact is the failure §14 exists to prevent.
 */
import { msg } from '@agentlens/i18n'
import type { CoverageReport, HostSplitBanner } from './api.ts'

/** "73.4%" for a 0.734 share — the same one-decimal rendering the server quotes. */
const sharePct = (share: number) => (share * 100).toFixed(1)

export function hostSplitText(b: HostSplitBanner): string {
  const others = b.hosts.slice(1).map((h) => h.host)
  const tail = b.hosts
    .slice(1)
    .map((h) => `${h.host} ${sharePct(h.share)}%`)
    .join(', ')
  const body = b.degenerate
    ? msg('banner.hostSplitOwnHost', {
        share: sharePct(b.dominantShare),
        agent: b.agentId,
        rest: tail || msg('banner.hostSplitRestNone'),
      })
    : msg('banner.hostSplitNormal', {
        share: sharePct(b.dominantShare),
        agent: b.agentId,
        host: b.dominantHost,
        others: others.length ? others.join(', ') : msg('banner.hostSplitOtherHost'),
      })
  return body + msg('banner.hostSplitTail')
}

/** '' when the history is complete, which is also when the API sends no banner. */
export function coverageText(c: Pick<CoverageReport, 'emptyDirs' | 'projectDirsWithoutSessions'>): string {
  const clauses: string[] = []
  if (c.emptyDirs.length > 0) clauses.push(msg('banner.coverageRetained', { count: c.emptyDirs.length, population: msg('banner.coverageIngestedPopulation') }))
  if (c.projectDirsWithoutSessions.length > 0) clauses.push(msg('banner.coverageProjectRows', { count: c.projectDirsWithoutSessions.length }))
  if (clauses.length === 0) return ''
  return clauses.join(msg('banner.coverageClauseJoin')) + msg('banner.coverageTail')
}
