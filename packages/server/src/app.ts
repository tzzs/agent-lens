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
import { billingConfigPath, billingModeFor as billingModeForOwner, liveBillingModes, planFeeFor, type BillingMode } from '@agentlens/pricing'
import { createFoldCache, describeQuery, query } from '@agentlens/query'
import { migrate } from '@agentlens/storage'
import type { ServerCtx, ServerDeps } from './types.ts'
import { ApiError, toErrorBody } from './errors.ts'
import { BillingSettings, readJsonBody } from './settings.ts'
import { listParam, parseSpec } from './request-spec.ts'
import { overview } from './overview.ts'
import { listSessions, nodePayloads, sessionDetail, sessionDetailOptions } from './sessions.ts'
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
  // §8/§14: the server reads the same `config.json` beside the DB that the CLI writes and the
  // settings route declares into, and liveBillingModes re-reads on file change, so a declaration
  // through either surface folds into the NEXT request — no restart, no `'api'`-fallback silence.
  // Read whenever there is a file, INDEPENDENT of whether the caller injected its own mode view:
  // the fee lives in the same document, so gating this on `deps.billingModeFor` left `agl
  // --serve` — which injects one — silently unable to prorate a plan the page had declared.
  const declaredModes = deps.dbPath ? liveBillingModes(billingConfigPath(deps.dbPath)) : null
  const billingModeFor =
    deps.billingModeFor ??
    (declaredModes
      ? (agentId: string, provider?: string, model?: string): BillingMode =>
          billingModeForOwner(declaredModes, agentId, provider, model)
      : undefined)
  const billingPlanFor = declaredModes ? (agentId: string): number | null => planFeeFor(declaredModes, agentId) : undefined
  return {
    db: deps.db,
    now: deps.now,
    ...(deps.priceResolver ? { priceResolver: deps.priceResolver } : {}),
    ...(billingModeFor ? { billingModeFor } : {}),
    ...(billingPlanFor ? { billingPlanFor } : {}),
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
      ...(billingModeFor ? { billingModeFor } : {}),
      ...(billingPlanFor ? { billingPlanFor } : {}),
      ...(deps.aggregation ? { aggregation: deps.aggregation } : {}),
      // Same clock the routes stamp their window with, so a hand-built ctx is consistent too.
      now: deps.now,
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

  /**
   * One stage-1 fold cache AND one clock per request.
   *
   * The cache: a dashboard page asks the cube the same folded question a dozen times
   * (per-day tokens, per-agent tokens, per-project cost…); without it each call re-folds the
   * whole window. `node:sqlite` is synchronous, so a handler's cube calls never interleave
   * with another's and a materialised fold can never be older than the request that built it.
   *
   * The clock is what makes the cache hit at all: `since=30d` resolves against `now()` on
   * every cube call, so eight calls produced eight windows milliseconds apart and eight
   * "different" queries. Pinned, the fold is shared — and the page's cards, trend and splits
   * are then provably about the same span, which `generatedAt` already claimed.
   *
   * `/api/events` is deliberately not routed through here: its keepalive loop needs the real
   * wall clock for as long as the stream lives.
   */
  const route = <T>(handler: (ctx: ServerCtx, sp: URLSearchParams, c: Context) => T | Promise<T>) =>
    async (c: Context): Promise<Response> => {
      const stamp = ctx.now()
      const now = (): number => stamp
      const foldCache = createFoldCache(ctx.db)
      const scoped: ServerCtx = { ...ctx, now, cubeDeps: { ...ctx.cubeDeps, now, foldCache } }
      try {
        return c.json(await handler(scoped, searchParams(c), c))
      } catch (err) {
        const { status, body } = toErrorBody(err)
        return c.json(body, status as ContentfulStatusCode)
      } finally {
        foldCache.dispose()
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
  app.get('/api/sessions/:id', route((c, sp, hc) => {
    const wanted = hc.req.param('id')
    if (!wanted) throw ApiError.badRequest('missing session id in path')
    return sessionDetail(c, wanted, sessionDetailOptions(sp))
  }))
  /**
   * Payload text for one or more timeline nodes. The waterfall asks for a node's content
   * when it is opened instead of carrying every node's content on page load — with the
   * content layer on, that was the single largest response the server produced (§3.2).
   */
  app.get('/api/sessions/:id/nodes/:nodeId/payloads', route((c, sp, hc) =>
    nodePayloads(c, hc.req.param('id') ?? '', listParam(sp, 'node') ?? [hc.req.param('nodeId') ?? '']),
  ))
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
