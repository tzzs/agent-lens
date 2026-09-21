/**
 * createApp: the HTTP surface of the cube.
 *
 * Every stats route is a thin wrapper over `query(db, spec)` (§7) with a fixed
 * dim/metric list, so no page can express an aggregation the CLI cannot and the
 * two ends cannot drift apart. Failures leave as structured JSON with a
 * meaningful status, including 501 for the two routes that need a capability this
 * build may not have (an injected scanner, a database file to declare billing in).
 */
import { homedir as osHomedir } from 'node:os'
import type { Context, Hono } from 'hono'
import { Hono as HonoClass } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { billingConfigPath } from '@agentlens/pricing'
import { describeQuery, query } from '@agentlens/query'
import { migrate } from '@agentlens/storage'
import type { ServerCtx, ServerDeps } from './types.ts'
import { ApiError, toErrorBody } from './errors.ts'
import { BillingSettings, readJsonBody } from './settings.ts'
import { parseSpec } from './request-spec.ts'
import { overview } from './overview.ts'
import { listSessions, sessionDetail } from './sessions.ts'
import { capabilities } from './capabilities.ts'
import { projects } from './projects.ts'
import { agents } from './agents.ts'
import { models } from './models.ts'
import { doctor } from './doctor.ts'
import { coverageReport } from './coverage.ts'
import { pollChangeSource } from './changes.ts'
import { eventsStream } from './sse.ts'
import { registerStatic } from './static.ts'
import { contentLayerPresent, payloadCount } from './content.ts'
import { redactHome, rowsOf } from './resolve.ts'

export const SERVER_NAME = '@agentlens/server'

export function createContext(deps: ServerDeps): ServerCtx {
  const homedir = deps.homedir ?? osHomedir()
  return {
    db: deps.db,
    now: deps.now,
    ...(deps.priceResolver ? { priceResolver: deps.priceResolver } : {}),
    ...(deps.billingModeFor ? { billingModeFor: deps.billingModeFor } : {}),
    ...(deps.aggregation ? { aggregation: deps.aggregation } : {}),
    ...(deps.priceTableSize ? { priceTableSize: deps.priceTableSize } : {}),
    ...(deps.staticDir ? { staticDir: deps.staticDir } : {}),
    ...(deps.scan ? { scan: deps.scan } : {}),
    ...(deps.capabilityCatalog ? { capabilityCatalog: deps.capabilityCatalog } : {}),
    ...(deps.adapters ? { adapters: deps.adapters } : {}),
    ...(deps.dbPath ? { dbPath: redactHome(deps.dbPath, homedir) } : {}),
    homedir,
    cubeDeps: {
      ...(deps.priceResolver ? { priceResolver: deps.priceResolver } : {}),
      ...(deps.billingModeFor ? { billingModeFor: deps.billingModeFor } : {}),
      ...(deps.aggregation ? { aggregation: deps.aggregation } : {}),
    },
    changeSource: deps.changeSource ?? (() => pollChangeSource(deps.db, deps.now)),
  }
}

function searchParams(c: Context): URLSearchParams {
  return new URL(c.req.url).searchParams
}

export function createApp(deps: ServerDeps): Hono {
  const ctx = createContext(deps)
  const app = new HonoClass()

  const route = <T>(handler: (ctx: ServerCtx, sp: URLSearchParams, c: Context) => T | Promise<T>) =>
    async (c: Context): Promise<Response> => {
      try {
        return c.json(await handler(ctx, searchParams(c), c))
      } catch (err) {
        const { status, body } = toErrorBody(err)
        return c.json(body, status as ContentfulStatusCode)
      }
    }

  /** Migrations are applied once per app, not once per health poll. */
  let migrationsApplied: number | null = null
  const migrationCount = (): number => {
    if (migrationsApplied === null) migrationsApplied = migrate(ctx.db).length
    return migrationsApplied
  }

  app.get('/api/health', route((c) => ({
    status: 'ok',
    server: SERVER_NAME,
    now: c.now(),
    dbPath: c.dbPath ?? null,
    events: Number(rowsOf(c.db, 'SELECT COUNT(*) AS n FROM events')[0]?.n ?? 0),
    sessions: Number(rowsOf(c.db, 'SELECT COUNT(*) AS n FROM sessions')[0]?.n ?? 0),
    migrationsApplied: migrationCount(),
    contentAvailable: contentLayerPresent(c.db),
    payloads: payloadCount(c.db),
    loopbackOnly: true,
  })))

  /** The §7 cube, 1:1: metrics/dims/filters/order/limit straight from the querystring. */
  app.get('/api/query', route((c, sp) => {
    const spec = parseSpec(sp, c.db)
    const res = query(c.db, spec, c.cubeDeps)
    return { spec, explain: describeQuery(spec), ...res }
  }))

  app.get('/api/overview', route((c, sp) => overview(c, sp)))
  app.get('/api/sessions', route((c, sp) => listSessions(c, sp)))
  app.get('/api/sessions/:id', route((c, _sp, hc) => {
    const wanted = hc.req.param('id')
    if (!wanted) throw ApiError.badRequest('missing session id in path')
    return sessionDetail(c, wanted)
  }))
  app.get('/api/capabilities', route((c, sp) => capabilities(c, sp)))
  app.get('/api/projects', route((c, sp) => projects(c, sp)))
  app.get('/api/agents', route((c, sp) => agents(c, sp)))
  app.get('/api/models', route((c, sp) => models(c, sp)))
  app.get('/api/doctor', route((c, sp) => doctor(c, sp)))
  app.get('/api/coverage', route((c) => coverageReport(c)))
  app.get('/api/events', (c) => eventsStream(ctx, c))

  /**
   * Scanning is the CLI's job (it owns adapter wiring, §5.4), so the server only
   * exposes an injected closure. Without it the honest answer is 501, not a
   * silently empty scan.
   */
  app.post('/api/scan', route(async (c) => {
    if (!c.scan) {
      throw ApiError.notImplemented('this server build has no scanner injected', {
        hint: 'run `agentlens scan` (CLI), or construct the app with deps.scan',
      })
    }
    const started = c.now()
    const summary = await c.scan()
    return { startedAt: started, finishedAt: c.now(), summary }
  }))

  /**
   * §8's per-Agent billing declaration. This writes the same `<dir of --db>/config.json`
   * the CLI's `billingModeFor` reads, so the page and the terminal state one fact (§14);
   * with no database FILE there is nowhere honest to persist it — an in-memory DB would
   * accept the write and lose it on restart, so the answer is 501, like the scanner.
   */
  const billing = deps.dbPath ? new BillingSettings(deps.db, billingConfigPath(deps.dbPath), ctx.homedir) : null
  const billingStore = (): BillingSettings => {
    if (!billing) {
      throw ApiError.notImplemented('this server has no database file to keep config.json beside', {
        hint: 'serve a --db <file>, or declare modes with `agl pricing billing set <agent> <mode>`',
      })
    }
    return billing
  }

  app.get('/api/settings/billing', route(() => billingStore().view()))
  app.post('/api/settings/billing', route(async (_c, _sp, hc) => billingStore().declare(await readJsonBody(hc.req))))

  app.notFound((c) =>
    c.json({ error: { kind: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` } }, 404))

  registerStatic(app, ctx)
  return app
}
