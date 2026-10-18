/**
 * The doctor's coverage line, composed in the browser from the structured fields
 * the API already sends. It used to head every page; it now lives only in the
 * doctor, because neither population it counts changes a figure (the rows were
 * ingested before upstream deleted the files).
 *
 * The server still answers with its own English `banner` string (`agl doctor`
 * prints it), so the numbers are the server's and only the *wording* is the viewer's. `apps/web/test/banners.test.ts`
 * pins the English rendering against the server's, because two phrasings of one
 * fact is the failure §14 exists to prevent.
 */
import { msg } from '@agentlens/i18n'
import type { CoverageReport } from './api.ts'

/** '' when the history is complete, which is also when the API sends no banner. */
export function coverageText(c: Pick<CoverageReport, 'emptyDirs' | 'projectDirsWithoutSessions'>): string {
  const clauses: string[] = []
  if (c.emptyDirs.length > 0) clauses.push(msg('banner.coverageRetained', { count: c.emptyDirs.length, population: msg('banner.coverageIngestedPopulation') }))
  if (c.projectDirsWithoutSessions.length > 0) clauses.push(msg('banner.coverageProjectRows', { count: c.projectDirsWithoutSessions.length }))
  if (clauses.length === 0) return ''
  return clauses.join(msg('banner.coverageClauseJoin')) + msg('banner.coverageTail')
}
