/**
 * `--explain` rendering: shows the resolved cube call, including the dedupe
 * semantics, so users can see WHY the numbers are what they are (§7).
 */
import type { QuerySpec } from './spec.ts'

export function describeQuery(spec: QuerySpec): string {
  const metrics = spec.metrics?.length ? spec.metrics.join(', ') : 'events'
  const dims = spec.dims?.length ? spec.dims.join(', ') : '(none)'
  const lines = [
    `metrics: ${metrics}`,
    `dims:    ${dims}`,
  ]
  if (spec.filter && Object.keys(spec.filter).length > 0) {
    const f = Object.entries(spec.filter)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join('|')}]` : String(v)}`)
      .join(' ')
    lines.push(`filter:  ${f}`)
  }
  if (spec.order) lines.push(`order:   ${spec.order}`)
  if (spec.limit !== undefined) lines.push(`limit:   ${spec.limit}`)
  lines.push(
    "semantics: tokens/duration fold per (agent, request) using that agent's §18 aggregation policy, then SUM; " +
      'a missing policy means request_max (MAX per request_id, the conservative Claude Code/Qoder rule); ' +
      'events/sessions count raw events; cost_reported is a raw SUM of what the agent reported and is never added ' +
      'to cost_api_equiv, a computed estimate; cost_total fuses them per request (§18 row 1): the reported number ' +
      'where the agent reported one, priced tokens only for the requests that reported nothing, NULL when a group ' +
      'has neither or an unreported slice lacks a price — never $0',
  )
  return lines.join('\n')
}
