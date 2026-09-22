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
  // §19 ("8 Cost Engine 的一处数据修正"): the generated snapshot sets effective_from to
  // epoch so no historical window comes back unpriced. The price of that is retroactive
  // pricing, and BOTH surfaces that explain a number — doctor (§11) and --explain (§9) —
  // owe the user that fact in the same words rather than letting a $ total read as a bill.
  lines.push(
    'caveat:  prices are undated by default (effective_from 0 in the generated snapshot), so the current rate is ' +
      "applied to a model's whole history: the $ totals are what today's price would have cost, not what was " +
      'paid (§8) — `agl pricing update` fetches dated entries, `agl pricing override` pins one model.',
  )
  return lines.join('\n')
}
