/**
 * `doctor`'s Capabilities section (§11 · §5.1's optional `capabilities()` catalog).
 *
 * Two sides that only exist together: the STATIC catalog an adapter can enumerate without
 * a scan (installed) against `events.capability_*` (invoked). Their difference is the
 * "installed but never used" view §5.1 exists for, and reporting only one side would make
 * the section a plain event count.
 *
 * MCP needs-auth / failed states are per-session observations the adapter carries in
 * `attachment.deferred_tools_delta` metadata; when no adapter exposes them the line says
 * so instead of printing zeros (§18 row 5: a capability column with no data source must
 * not read as "used nothing").
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AgentAdapter, CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { query } from '@agentlens/query'
import type { Ctx } from '../context.ts'
import { GLYPH, formatCount } from '../render.ts'
import { rowsOf } from './shared.ts'

export const CAPABILITY_TYPES = ['tool', 'skill', 'mcp', 'plugin', 'connector', 'command', 'subagent', 'hook'] as const
export type CapabilityType = (typeof CAPABILITY_TYPES)[number]

export interface McpStates {
  attached: string[]
  needsAuth: string[]
  failed: string[]
  pending: string[]
  /** True when at least one adapter exposed the deferred-tools delta at all. */
  observed: boolean
}

export interface CapabilityReport {
  installed: Map<CapabilityType, number>
  invoked: Map<CapabilityType, number>
  catalogs: number
  catalogErrors: string[]
  hookFires: number
  hookFailures: number
  topFailingHook: string | null
  mcp: McpStates
}

function isCapabilityType(v: string): v is CapabilityType {
  return (CAPABILITY_TYPES as readonly string[]).includes(v)
}

function namesOf(meta: Record<string, unknown>, key: string): string[] {
  const v = meta[key]
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** Union of the deferred-tools delta observations; last state per server wins nowhere — these are additive sightings. */
function mcpStates(db: DatabaseSync, attachedMcp: Set<string>): McpStates {
  const needsAuth = new Set<string>()
  const failed = new Set<string>()
  const pending = new Set<string>()
  const rows = rowsOf(
    db,
    `SELECT metadata FROM events WHERE type = 'unknown' AND subtype = 'attachment:deferred_tools_delta' AND metadata IS NOT NULL`,
  )
  for (const row of rows) {
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(String(row.metadata)) as Record<string, unknown>
    } catch {
      continue
    }
    for (const n of namesOf(meta, 'needs_auth_mcp_servers')) needsAuth.add(n)
    for (const n of namesOf(meta, 'failed_mcp_servers')) failed.add(n)
    for (const n of namesOf(meta, 'pending_mcp_servers')) pending.add(n)
  }
  const attached = [...attachedMcp].filter((n) => !needsAuth.has(n) && !failed.has(n))
  return { attached, needsAuth: [...needsAuth], failed: [...failed], pending: [...pending], observed: rows.length > 0 }
}

export async function measureCapabilities(
  adapters: readonly AgentAdapter[],
  hosts: Map<string, HostContext>,
  db: DatabaseSync,
): Promise<CapabilityReport> {
  const installed = new Map<CapabilityType, number>()
  const catalogErrors: string[] = []
  let catalogs = 0
  const attachedMcp = new Set<string>()

  for (const a of adapters) {
    if (!a.capabilities) continue
    const host = hosts.get(a.id)
    if (!host) continue
    try {
      const cats: CapabilityCatalog[] = await a.capabilities(host)
      catalogs++
      for (const c of cats) {
        if (!isCapabilityType(c.type)) continue
        installed.set(c.type, (installed.get(c.type) ?? 0) + 1)
        if (c.type === 'mcp') attachedMcp.add(c.name)
      }
    } catch (err) {
      catalogErrors.push(`${a.id}: ${(err as Error).message}`)
    }
  }

  const invokedRes = query(db, { metrics: ['events'], dims: ['capability_type'] })
  const invoked = new Map<CapabilityType, number>()
  for (const r of invokedRes.rows) {
    const t = String(r.capability_type)
    if (!isCapabilityType(t)) continue
    invoked.set(t, (invoked.get(t) ?? 0) + Number(r.events))
    if (t === 'mcp') {
      const names = rowsOf(db, "SELECT DISTINCT capability_name AS n FROM events WHERE capability_type = 'mcp' AND capability_name IS NOT NULL")
      for (const n of names) attachedMcp.add(String(n.n))
    }
  }

  const hookRow = rowsOf(
    db,
    `SELECT COUNT(*) AS fired,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
     FROM events WHERE capability_type = 'hook'`,
  )[0]
  const topFailing = rowsOf(
    db,
    `SELECT capability_name AS n, COUNT(*) AS c FROM events
     WHERE capability_type = 'hook' AND status = 'error'
     GROUP BY n ORDER BY c DESC LIMIT 1`,
  )[0]

  return {
    installed,
    invoked,
    catalogs,
    catalogErrors,
    hookFires: Number(hookRow?.fired ?? 0),
    hookFailures: Number(hookRow?.failed ?? 0),
    topFailingHook: topFailing ? String(topFailing.n) : null,
    mcp: mcpStates(db, attachedMcp),
  }
}

const LABEL: Record<CapabilityType, string> = {
  tool: 'tools',
  skill: 'skills',
  mcp: 'mcp',
  plugin: 'plugins',
  connector: 'connectors',
  command: 'commands',
  subagent: 'subagents',
  hook: 'hooks',
}

export function renderCapabilities(ctx: Ctx, report: CapabilityReport): void {
  ctx.out('Capabilities')
  const types = [...new Set([...report.installed.keys(), ...report.invoked.keys()])].sort()
  if (report.catalogs === 0 && report.catalogErrors.length === 0 && types.length === 0) {
    ctx.out(`${GLYPH.none} no adapter exposes a capability catalog and no capability events are ingested`)
    return
  }
  if (report.catalogs === 0) {
    ctx.out(`${GLYPH.none} no adapter exposes capabilities() — "installed but never used" is unavailable, invoked side only (§5.1)`)
  }
  for (const t of types) {
    if (t === 'hook') continue // §11 gives hooks their own fired/failures line
    const has = report.installed.get(t)
    const used = report.invoked.get(t) ?? 0
    const glyph = has !== undefined && has > 0 && used === 0 ? GLYPH.warn : has === undefined ? GLYPH.none : GLYPH.ok
    const installedTxt = has === undefined ? (report.catalogs > 0 ? 'installed 0' : 'installed ?') : `installed ${formatCount(has)}`
    ctx.out(`${glyph} ${LABEL[t].padEnd(11)} ${installedTxt} · invoked ${formatCount(used)}` + (has !== undefined && has > 0 && used === 0 ? ' — never used' : ''))
  }
  for (const e of report.catalogErrors) ctx.out(`${GLYPH.warn} catalog ${e}`)

  const hookGlyph = report.hookFires === 0 ? GLYPH.none : report.hookFailures > 0 ? GLYPH.warn : GLYPH.ok
  ctx.out(
    `${hookGlyph} ${LABEL.hook.padEnd(11)} fired ${formatCount(report.hookFires)} · failures ${formatCount(report.hookFailures)}` +
      (report.topFailingHook ? ` (${report.topFailingHook})` : '') +
      (report.hookFires === 0 ? ' — no installed agent logs hook events (§18 row 5)' : ''),
  )

  const m = report.mcp
  const mcpGlyph = m.failed.length > 0 || m.needsAuth.length > 0 ? GLYPH.warn : report.installed.get('mcp') || report.invoked.get('mcp') ? GLYPH.ok : GLYPH.none
  if (!m.observed) {
    ctx.out(
      `${mcpGlyph} ${'mcp'.padEnd(11)} attached ${formatCount(m.attached.length)} · ` +
        'needs-auth / failed not exposed by any adapter catalog (deferred_tools_delta is a per-session observation, §5.1)',
    )
    return
  }
  ctx.out(
    `${mcpGlyph} ${'mcp'.padEnd(11)} ${formatCount(m.attached.length)} attached, ` +
      `${formatCount(m.needsAuth.length)} needs-auth, ${formatCount(m.failed.length)} failed` +
      (m.pending.length ? ` · ${formatCount(m.pending.length)} pending` : '') +
      '  ← deferred_tools_delta',
  )
}
