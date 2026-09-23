/**
 * `agentlens --serve` (§9, §14): hand the database the CLI just scanned to the
 * HTTP+SSE server, print the loopback URL, open the dashboard and stay up.
 *
 * Everything the CLI knows — the price table, the billing modes, the persisted
 * §18 fold policies, the scanner and the static capability catalogs — is injected
 * here, so `@agentlens/server` keeps no dependency on this package and the Web can
 * never compute a number the terminal would not have printed.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { startServer, type CatalogEntry } from '@agentlens/server'
import { getAdapters } from './adapters.ts'
import type { Ctx } from './context.ts'
import { makeHostCtx } from './context.ts'
import { runScan } from './commands/scan.ts'
import type { FlagView } from './args.ts'
import type { QueryDeps } from './types.ts'

export interface ServeHandle {
  url: string
  /** Resolves once the user interrupts or `close()` is called. */
  closed: Promise<void>
  close: () => Promise<void>
}

/** Built apps/web output; without it the server still answers every §10 page's API. */
export function webDistDir(): string | undefined {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  return existsSync(join(dist, 'index.html')) ? dist : undefined
}

/** §15 M6: adapters' declared inventory, so the dashboard can show "installed but never used". */
async function staticCatalog(ctx: Ctx): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = []
  for (const adapter of await getAdapters()) {
    if (!adapter.capabilities) continue
    try {
      const detected = await adapter.detect(makeHostCtx(ctx))
      const catalog = await adapter.capabilities(makeHostCtx(ctx, detected.dataRoot ?? null))
      for (const entry of catalog) entries.push({ ...entry, agentId: adapter.id })
    } catch {
      // A catalog we cannot read is not a reason to refuse the dashboard.
    }
  }
  return entries
}

/** macOS/Linux/Windows launcher; a headless box simply keeps the printed URL. */
function openBrowser(url: string, ctx: Ctx): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    ctx.err(`! could not open the browser: ${(err as Error).message} — open ${url} yourself`)
  }
}

export async function serveDashboard(
  db: DatabaseSync,
  dbPath: string,
  flags: FlagView,
  ctx: Ctx,
  deps: QueryDeps,
): Promise<ServeHandle> {
  const running = startServer({
    db,
    dbPath,
    runMigrations: false,
    now: ctx.now,
    homedir: ctx.homedir,
    priceResolver: deps.priceResolver,
    billingModeFor: deps.billingModeFor,
    aggregation: deps.aggregation ?? {},
    scan: () => runScan(db, flags, ctx),
    capabilityCatalog: () => staticCatalog(ctx),
    adapters: getAdapters,
    ...(webDistDir() ? { staticDir: webDistDir() } : {}),
  })
  // The URL is only a fact once the socket owns the port. Announcing it early sends the user to
  // whatever else is listening there — a different AgentLens, reading different logs.
  try {
    await running.ready()
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    await running.close()
    throw new Error(
      e.code === 'EADDRINUSE'
        ? `cannot serve on ${running.url} — another process already owns port ${running.port}. Stop it first: the dashboard that port serves is that process's data, not this store's.`
        : `cannot serve on ${running.url}: ${e.message}`,
    )
  }
  openBrowser(running.url, ctx)

  let settle: () => void = () => {}
  const closed = new Promise<void>((resolveDone) => {
    settle = resolveDone
  })
  const stop = async () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await running.close()
    settle()
  }
  function onSignal(): void {
    void stop()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return { url: running.url, closed, close: stop }
}
