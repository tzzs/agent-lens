/**
 * Public types for the AgentLens API server (§10, §13).
 *
 * The server holds NO statistics SQL of its own: every aggregated number on
 * every route comes out of the single §7 cube (`query()`), which is what keeps
 * Web and CLI figures identical (§7: "CLI 与 Web 共用这一个查询器"). Raw-row
 * reads that exist here are presence checks (content layer, coverage, entity
 * metadata) — never token/cost aggregations.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AgentAdapter, AggregationPolicy, CapabilityCatalog } from '@agentlens/event-model'
import type { BillingMode, PriceEntry } from '@agentlens/pricing'
import type { QueryDeps } from '@agentlens/query'

/**
 * Mirrors `ScanOutcome` in apps/cli WITHOUT importing it (§5.4 keeps the
 * dependency arrow cli -> query -> storage; the server takes an injected
 * closure so it never has a compile-time edge to an app).
 */
export interface ScanSummary {
  adaptersFound: number
  sourcesScanned: number
  events: number
  failures: number
  notDetected: string[]
}

/** Cheap "the DB changed" signal. M6 replaces its producer with the watcher. */
export interface ChangeTick {
  /** MAX(events.timestamp); NULL while the table is empty. */
  maxTimestamp: number | null
  events: number
  emittedAt: number
}

export interface ChangeSource {
  snapshot(): ChangeTick
  /** Starts emitting; returns the stop handle. */
  watch(emit: (tick: ChangeTick) => void): () => void
}

export type PriceResolver = (provider: string, model: string, occurredAt: number) => PriceEntry | null
export type CatalogEntry = CapabilityCatalog & { agentId?: string | null }

export interface ServerDeps {
  db: DatabaseSync
  /**
   * Absent pricing is not an error: every cost then renders `n/a`, never `$0`
   * (§8 forbids reading an unknown price as free).
   */
  priceResolver?: PriceResolver
  /** §8 billing mode per agent, optionally narrowed to one model; default 'api'. */
  billingModeFor?: (agentId: string, provider?: string, model?: string) => BillingMode
  /** What an agent's plan actually costs per calendar month; null = undeclared (so actual is unknown, not $0). */
  billingPlanFor?: (agentId: string) => number | null
  /**
   * §18 row 2: the per-agent fold each adapter declares, passed straight to the cube.
   * Absent means the cube's most conservative default (`request_max`).
   */
  aggregation?: Record<string, AggregationPolicy>
  /** How many (provider, model) pairs the injected table prices; for /api/doctor's header line. */
  priceTableSize?: () => number | null
  now: () => number
  /** Built apps/web output; when set the SPA is served with an index.html fallback. */
  staticDir?: string
  /** Injected so the server has no dependency on apps/cli; absent ⇒ POST /api/scan answers 501. */
  scan?: () => Promise<ScanSummary>
  /** Static capability catalogs (§5.1) powering "installed but never used". */
  capabilityCatalog?: () => Promise<CatalogEntry[]>
  /**
   * The adapter set, injected because the CLI owns adapter wiring (§5.4): the
   * server declares no dependency on any adapter package, so an `import` here
   * would silently resolve to nothing and Doctor would list every agent as
   * ingested-only. Absent ⇒ Doctor reports only what is already in the DB.
   */
  adapters?: () => Promise<AgentAdapter[]>
  /** Transport plug point for GET /api/events; default polls `events` (M6 swaps in the watcher). */
  changeSource?: () => ChangeSource
  /** Home dir for read-only coverage probes; defaults to the ambient user. */
  homedir?: string
  /** Path of the opened DB, reported by /api/health for transparency. */
  dbPath?: string
}

/** deps after defaults, shared by every route module. */
export interface ServerCtx {
  readonly db: DatabaseSync
  readonly now: () => number
  readonly priceResolver?: PriceResolver
  readonly billingModeFor?: (agentId: string, provider?: string, model?: string) => BillingMode
  readonly billingPlanFor?: (agentId: string) => number | null
  readonly aggregation?: Record<string, AggregationPolicy>
  readonly priceTableSize?: () => number | null
  readonly cubeDeps: QueryDeps
  readonly staticDir?: string
  readonly scan?: () => Promise<ScanSummary>
  readonly capabilityCatalog?: () => Promise<CatalogEntry[]>
  readonly adapters?: () => Promise<AgentAdapter[]>
  readonly changeSource: () => ChangeSource
  readonly homedir: string
  readonly dbPath?: string
}
