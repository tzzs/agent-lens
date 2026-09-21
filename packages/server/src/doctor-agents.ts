/**
 * Doctor's Agents + Permissions blocks (§11): adapter detection when adapter
 * packages are installed, otherwise the ingested entity rows with an explicit
 * "adapter not in this build" note — never a silent zero.
 */
import type { ServerCtx } from './types.ts'
import type { DoctorAgentRow } from './doctor-types.ts'
import { hostContext, isReadable, loadAdapters } from './adapters.ts'
import { redactHome, rowsOf } from './resolve.ts'

function count(db: ServerCtx['db'], sql: string, ...params: unknown[]): number {
  return Number(rowsOf(db, sql, ...params)[0]?.n ?? 0)
}

export async function doctorAgents(ctx: ServerCtx): Promise<{
  rows: DoctorAgentRow[]
  permissions: { path: string; readable: boolean }[]
  adaptersInstalled: boolean
}> {
  const adapters = await loadAdapters()
  const ingested = rowsOf(ctx.db, 'SELECT id, display_name, detected_version, data_root FROM agents')
  const rows: DoctorAgentRow[] = []
  const permissions: { path: string; readable: boolean }[] = []
  const seen = new Set<string>()

  for (const adapter of adapters) {
    seen.add(adapter.id)
    const row = ingested.find((r) => String(r.id) === adapter.id)
    const base = {
      id: adapter.id,
      displayName: adapter.displayName,
      detectedVersion: null as string | null,
      dataRoot: null as string | null,
      events: count(ctx.db, 'SELECT COUNT(*) AS n FROM events WHERE agent_id = ?', adapter.id),
      sources: count(ctx.db, 'SELECT COUNT(*) AS n FROM sources WHERE agent_id = ?', adapter.id),
    }
    try {
      const det = await adapter.detect(hostContext({ homedir: ctx.homedir }))
      if (!det.present) {
        rows.push({ ...base, status: 'not-detected', note: 'not detected on this machine' })
        continue
      }
      const root = det.dataRoot ?? null
      const readable = root ? isReadable(root) : false
      if (root) permissions.push({ path: redactHome(root, ctx.homedir), readable })
      rows.push({
        ...base,
        displayName: row?.display_name ? String(row.display_name) : adapter.displayName,
        detectedVersion: det.agentVersion ?? (row?.detected_version ? String(row.detected_version) : null),
        dataRoot: root ? redactHome(root, ctx.homedir) : null,
        status: 'ok',
        note: readable ? null : 'data root is not readable by this process',
      })
    } catch (err) {
      rows.push({ ...base, status: 'error', note: redactHome((err as Error).message, ctx.homedir) })
    }
  }

  for (const row of ingested) {
    const id = String(row.id)
    if (seen.has(id)) continue
    rows.push({
      id,
      displayName: row.display_name ? String(row.display_name) : null,
      detectedVersion: row.detected_version ? String(row.detected_version) : null,
      dataRoot: row.data_root ? redactHome(String(row.data_root), ctx.homedir) : null,
      events: count(ctx.db, 'SELECT COUNT(*) AS n FROM events WHERE agent_id = ?', id),
      sources: count(ctx.db, 'SELECT COUNT(*) AS n FROM sources WHERE agent_id = ?', id),
      status: 'ingested-only',
      note: 'its adapter package is not installed in this build (history stays queryable)',
    })
  }
  return { rows, permissions, adaptersInstalled: adapters.length > 0 }
}
