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
import { existsSync, readFileSync } from 'node:fs'
import { createApp, createContext } from './app.ts'
import type { ServerCtx, ServerDeps } from './types.ts'
import { migrate } from '@agentlens/storage'
import {
  bundledSnapshot,
  PricingTable,
  readSnapshotFile,
  type PriceEntry,
  type PriceSnapshot,
} from '@agentlens/pricing'

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

/**
 * Prices from `<db dir>/price-snapshot.json` when present, else the bundled snapshot,
 * then the user's `<db dir>/pricing-overrides.jsonl` is merged on top — always, because
 * §8 says overrides win and the CLI's doctor counts that merged table, not the snapshot
 * (§14). This mirrors `loadPricing` in apps/cli/src/pricing-store.ts line for line:
 * @agentlens/pricing exposes no shared loader for the jsonl yet (it exports
 * `PricingTable.withOverride` and `readSnapshotFile` only), so the merge lives here
 * until a `loadMergedPricing` helper moves it into the pricing package — and the
 * agreement test in packages/server/test/pricing-overrides.test.ts pins both ends until then.
 */
export function priceTableFor(dbPath?: string): { table: PricingTable; snapshot: PriceSnapshot | null } {
  // Same `dirname(dbPath)` the CLI's pricing-store uses; a bare "x.db" means the cwd.
  const dir = dbPath === undefined ? null : dbPath.includes('/') ? dbPath.slice(0, dbPath.lastIndexOf('/') || 1) : '.'
  const overrideFile = dir === null ? null : `${dir}/pricing-overrides.jsonl`
  const found = dir ? readSnapshotFile(`${dir}/price-snapshot.json`) : null
  const snapshot = found ?? bundledSnapshot()
  return { table: withOverrides(PricingTable.fromSnapshot(snapshot), overrideFile), snapshot }
}

/** One `PriceEntry` per line, later lines win; same file, same order as the CLI (§14). */
function withOverrides(table: PricingTable, path: string | null): PricingTable {
  if (!path || !existsSync(path)) return table
  let out = table
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    out = out.withOverride(JSON.parse(t) as PriceEntry)
  }
  return out
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
  // Everything else on `options` is a `ServerDeps` field and travels as-is: listing them
  // out one by one is how an injected dep (adapters, once) can go missing in silence.
  const {
    db: _db,
    now: _now,
    dbPath: _dbPath,
    port: _port,
    host: _host,
    allowExternalBind: _external,
    runMigrations: _migrations,
    ...injected
  } = options
  const ctx = createContext({
    ...injected,
    db,
    now: options.now ?? Date.now,
    ...(options.priceResolver ? { priceResolver: options.priceResolver } : pricing ? { priceResolver: (p: string, m: string, t: number) => pricing.table.lookup(p, m, t) } : {}),
    ...(pricing ? { priceTableSize: () => pricing.table.size() } : {}),
    ...(dbPath ? { dbPath } : {}),
  })

  const server: ServerType = serve({ fetch: createApp(ctx).fetch, hostname: host, port })
  // `serve()` returns before the socket is listening, and closing a server that never
  // listened wedges it permanently (`Server is not running.` on every later close). A
  // SIGINT in the first tick would take down `agl --serve` that way, so `close` waits
  // for the bind — or for its error, which surfaces from `server.close` as usual.
  const bound = new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else {
      server.once('listening', () => resolve())
      server.once('error', () => resolve())
    }
  })
  const url = `http://${host}:${port}`
  return {
    port,
    host,
    url,
    ctx,
    close: async () => {
      await bound
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      if (ownsDb) db.close()
    },
  }
}
