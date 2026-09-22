/**
 * Request querystring -> `QuerySpec`, 1:1 with §7.
 *
 * This is the only place user strings meet the query vocabulary: names are
 * validated against the cube's exported whitelist before the call, so the UI
 * cannot express an aggregation the CLI cannot, and no user text reaches SQL
 * (the cube binds every filter value as a parameter).
 */
import { DIMS, METRICS, resolveSince, type QuerySpec, type Metric, type Dim } from '@agentlens/query'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from './errors.ts'
import { resolveAgentIds, resolveProjectIds } from './resolve.ts'

/** §18 row 3: the subagent switch, spelled for the wire. Absent means the cube's default. */
const SUBAGENTS_VALUES: Record<string, boolean> = { include: true, exclude: false }

function resolveMetric(name: string): Metric {
  return assertKnown(name, METRICS, 'metric') as Metric
}

const LIST_PARAMS = [
  'agent',
  'host',
  'project',
  'session',
  'model',
  'provider',
  'capabilityType',
  'capabilityName',
  'status',
  'type',
] as const

export function listParam(sp: URLSearchParams, name: string): string[] | undefined {
  const raw = sp.getAll(name).length ? sp.getAll(name).join(',') : sp.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return parts.length ? parts : undefined
}

export function strParam(sp: URLSearchParams, name: string): string | undefined {
  const v = sp.get(name)
  return v === null || v.trim() === '' ? undefined : v.trim()
}

function assertKnown(name: string, allowed: readonly string[], label: string): string {
  if (!allowed.includes(name)) {
    throw ApiError.badRequest(`unknown ${label} ${JSON.stringify(name)}`, {
      requested: name,
      allowed,
    })
  }
  return name
}

function checkTime(value: string, label: string): string {
  try {
    resolveSince(value)
  } catch (err) {
    throw ApiError.badRequest(`${label}: ${(err as Error).message}`, { [label]: value })
  }
  return value
}

function checkOrder(order: string): string {
  const parts = order.split(':')
  if (parts.length !== 3 || (parts[0] !== 'metric' && parts[0] !== 'dim') || (parts[2] !== 'asc' && parts[2] !== 'desc')) {
    throw ApiError.badRequest(`invalid order ${JSON.stringify(order)}`, {
      expected: 'metric:<name>:<asc|desc> | dim:<name>:<asc|desc>',
    })
  }
  const name = parts[1]!
  if (parts[0] === 'metric') {
    resolveMetric(name)
  } else {
    assertKnown(name, DIMS, 'dim')
  }
  return order
}

/**
 * Parse + validate. `undefined` limit/`metrics` keep the cube's defaults; agent
 * and project names are turned into opaque ids here so downstream code only
 * ever hands ids to the cube.
 */
export function parseSpec(sp: URLSearchParams, db: DatabaseSync): QuerySpec {
  const metrics = listParam(sp, 'metrics')?.map(resolveMetric)
  const dims = listParam(sp, 'dims')?.map((d) => assertKnown(d, DIMS, 'dim') as Dim)
  // `metrics=` spelled out is a caller mistake; leaving it unset is the cube's default.
  // listParam drops empty values, so the distinction has to be made against the raw key.
  if (sp.has('metrics') && (metrics?.length ?? 0) === 0) throw ApiError.badRequest('metrics must not be empty')
  if (dims !== undefined && new Set(dims).size !== dims.length) throw ApiError.badRequest('duplicate dims')

  const since = strParam(sp, 'since')
  const until = strParam(sp, 'until')
  const filter: QuerySpec['filter'] = {}
  if (since !== undefined) filter.since = checkTime(since, 'since')
  if (until !== undefined) filter.until = checkTime(until, 'until')

  const agent = listParam(sp, 'agent')
  if (agent) filter.agent = resolveAgentIds(db, agent)
  const project = listParam(sp, 'project')
  if (project) filter.project = resolveProjectIds(db, project)
  for (const key of LIST_PARAMS) {
    if (key === 'agent' || key === 'project') continue
    const v = listParam(sp, key)
    if (v) (filter as Record<string, unknown>)[key] = v
  }

  const subagents = strParam(sp, 'subagents')
  if (subagents !== undefined) {
    const keep = SUBAGENTS_VALUES[subagents]
    if (keep === undefined) {
      throw ApiError.badRequest(`unknown subagents ${JSON.stringify(subagents)}`, { allowed: ['include', 'exclude'] })
    }
    filter.includeSubagentThreads = keep
  }

  const spec: QuerySpec = { filter }
  if (metrics) spec.metrics = metrics
  if (dims) spec.dims = dims
  const order = strParam(sp, 'order')
  if (order !== undefined) spec.order = checkOrder(order)
  const limit = strParam(sp, 'limit')
  if (limit !== undefined) {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 0 || n > 5000) {
      throw ApiError.badRequest(`invalid limit ${JSON.stringify(limit)}`, { min: 0, max: 5000 })
    }
    spec.limit = n
  }
  return spec
}

/** Filter-only parse for the entity pages: same validation, no dims/metrics from the caller. */
export function parseFilter(sp: URLSearchParams, db: DatabaseSync): NonNullable<QuerySpec['filter']> {
  const spec = parseSpec(sp, db)
  return spec.filter ?? {}
}
