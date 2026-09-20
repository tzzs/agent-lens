import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { buildFilter } from '../context.ts'
import type { DatabaseSync } from 'node:sqlite'
import type { QueryFilter } from '@agentlens/query'

export interface FilterInputs {
  since?: string
  until?: string
  agent: string[]
  host: string[]
  project: string[]
  session: string[]
  model: string[]
  provider: string[]
  status: string[]
  type: string[]
}

export function filterInputs(flags: FlagView): FilterInputs {
  return {
    since: flags.str('since'),
    until: flags.str('until'),
    agent: flags.list('agent'),
    host: flags.list('host'),
    project: flags.list('project'),
    session: flags.list('session'),
    model: flags.list('model'),
    provider: flags.list('provider'),
    status: flags.list('status'),
    type: flags.list('type'),
  }
}

export function filter(db: DatabaseSync, ctx: Ctx, flags: FlagView): QueryFilter {
  return buildFilter(db, ctx, filterInputs(flags))
}

export function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id
}

export function rowsOf(db: DatabaseSync, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql)
  return (params.length ? stmt.all(...(params as never[])) : stmt.all()).map((r) => ({ ...r })) as Record<string, unknown>[]
}

export function one(db: DatabaseSync, sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
  const r = rowsOf(db, sql, ...params)
  return r[0]
}
