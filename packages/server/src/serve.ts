/**
 * Process entry for the dashboard server.
 *
 * SECURITY: this service answers from SQLite rows built out of other tools'
 * private logs (prompts, file contents, paths). It therefore binds to loopback
 * only. A non-loopback host is refused unless the caller passes
 * `allowExternalBind: true` on purpose — the default must never expose private
 * logs to a LAN, and there is no auth layer here to fall back on.
 */
import { openDatabase } from '@agentlens/storage'
import { serve, type ServerType } from '@hono/node-server'
import { createApp, createContext } from './app.ts'
import type { ServerCtx, ServerDeps } from './types.ts'
import { migrate } from '@agentlens/storage'
import { bundledSnapshot, PricingTable, readSnapshotFile, type PriceSnapshot } from '@agentlens/pricing'

export const DEFAULT_PORT = 7317
export const DEFAULT_HOST = '127.0.0.1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true
  return host.startsWith('127.')
}

/** Throws rather than bind: a wrong default here would leak private logs. */
export function assertLoopbackBind(host: string, allowExternalBind?: boolean): void {
  if (isLoopbackHost(host) || allowExternalBind) return
  throw new Error(
    `refusing to bind ${host}:${'…'} — AgentLens reads private local logs and serves them without auth. ` +
      `Use 127.0.0.1, or pass allowExternalBind / --allow-external-bind if you really mean it.`,
  )
}

/** Everything ServerDeps takes, with the boot-only knobs added and `db`/`now` made optional. */
export type StartOptions = Omit<ServerDeps, 'db' | 'now'> & {
  db?: ServerDeps['db']
  now?: () => number
  port?: number
  host?: string
  allowExternalBind?: boolean
  /** Applied on boot so the CLI and the server never disagree about schema state. */
  runMigrations?: boolean
}

export interface RunningServer {
  port: number
  host: string
  url: string
  ctx: ServerCtx
  close: () => Promise<void>
}

/** Prices from `<db dir>/price-snapshot.json` when present, else the bundled snapshot (§8). */
export function priceTableFor(dbPath?: string): { table: PricingTable; snapshot: PriceSnapshot | null } {
  if (dbPath) {
    const found = readSnapshotFile(`${dbPath.replace(/\/[^/]*$/, '')}/price-snapshot.json`)
    if (found) return { table: PricingTable.fromSnapshot(found), snapshot: found }
  }
  return { table: PricingTable.fromSnapshot(bundledSnapshot()), snapshot: bundledSnapshot() }
}

export function startServer(options: StartOptions = {}): RunningServer {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  assertLoopbackBind(host, options.allowExternalBind)

  const ownsDb = options.db === undefined
  const dbPath = options.dbPath
  const db = options.db ?? openDatabase(dbPath ?? ':memory:')
  if (options.runMigrations !== false) migrate(db)

  const pricing = dbPath ? priceTableFor(dbPath) : null
  const ctx = createContext({
    db,
    now: options.now ?? Date.now,
    ...(options.priceResolver ? { priceResolver: options.priceResolver } : pricing ? { priceResolver: (p: string, m: string, t: number) => pricing.table.lookup(p, m, t) } : {}),
    ...(pricing ? { priceTableSize: () => pricing.table.size() } : {}),
    ...(options.billingModeFor ? { billingModeFor: options.billingModeFor } : {}),
    ...(options.aggregation ? { aggregation: options.aggregation } : {}),
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    ...(options.scan ? { scan: options.scan } : {}),
    ...(options.capabilityCatalog ? { capabilityCatalog: options.capabilityCatalog } : {}),
    ...(options.changeSource ? { changeSource: options.changeSource } : {}),
    ...(options.homedir ? { homedir: options.homedir } : {}),
    ...(dbPath ? { dbPath } : {}),
  })

  const server: ServerType = serve({ fetch: createApp(ctx).fetch, hostname: host, port })
  const url = `http://${host}:${port}`
  return {
    port,
    host,
    url,
    ctx,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      if (ownsDb) db.close()
    },
  }
}
