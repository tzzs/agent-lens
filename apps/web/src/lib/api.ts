/**
 * Same-origin API client for the AgentLens dashboard.
 *
 * SECURITY / PRODUCT RULE: every request is a relative `/api/...` path against
 * this same origin. The server binds loopback only and reads private local logs;
 * nothing here may point at another host, a CDN, or an analytics endpoint. There
 * is deliberately no base-URL configuration: `fetch('/api/health')` is the whole
 * transport story, which is also what keeps the local-first promise auditable.
 *
 * The types below mirror the response shapes re-exported from
 * `packages/server/src/index.ts`. They are read-only mirrors: the server owns the
 * contract, this file only describes it so the UI renders real fields.
 */

export interface ErrorBody {
  error: { kind: string; message: string; details?: Record<string, unknown> }
}

/** Thrown for any non-2xx so callers can branch on the server's error `kind`. */
export class ApiError extends Error {
  readonly status: number
  readonly kind: string
  readonly details?: Record<string, unknown>
  constructor(status: number, body: ErrorBody) {
    super(body?.error?.message ?? `request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.kind = body?.error?.kind ?? 'internal'
    if (body?.error?.details) this.details = body.error.details
  }
}

async function getJSON<T>(path: string, params?: Record<string, string | number | string[] | undefined>): Promise<T> {
  const url = buildURL(path, params)
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const body = (parsed && typeof parsed === 'object' && 'error' in (parsed as object) ? parsed : { error: { kind: 'internal', message: text || res.statusText } }) as ErrorBody
    throw new ApiError(res.status, body)
  }
  return parsed as T
}

/** The one write in the app: a JSON POST, same error contract as GET. */
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* an error body that is not JSON is reported as its own text */
  }
  if (!res.ok) {
    const err = parsed && typeof parsed === 'object' && 'error' in (parsed as object) ? parsed : { error: { kind: 'internal', message: text || res.statusText } }
    throw new ApiError(res.status, err as ErrorBody)
  }
  return parsed as T
}

/** Builds a relative /api URL from a base path and optional params (arrays repeat). */
export function buildURL(path: string, params?: Record<string, string | number | string[] | undefined>): string {
  const sp = new URLSearchParams()
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      if (Array.isArray(v)) {
        if (v.length) sp.set(k, v.join(','))
      } else {
        sp.set(k, String(v))
      }
    }
  }
  const q = sp.toString()
  return q ? `${path}?${q}` : path
}

/* ------------------------------------------------------------------ *
 * Shared vocabulary (mirrors @agentlens/query spec + server metrics.ts)
 * ------------------------------------------------------------------ */

export const QUERY_METRICS = [
  'events',
  'sessions',
  'duration',
  'tokens_total',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_reasoning',
  'cost_api_equiv',
  'cost_reported',
] as const

export const QUERY_DIMS = [
  'time',
  'day',
  'week',
  'month',
  'agent',
  'host',
  'project',
  'session',
  'thread',
  'model',
  'provider',
  'capability_type',
  'capability_name',
  'tool',
  'skill',
  'mcp',
  'plugin',
  'connector',
  'command',
  'subagent',
  'hook',
  'status',
  'usage_source',
] as const

export type Row = Record<string, unknown>

/** Capability axis whitelist (mirrors event-model CAPABILITY_TYPES). */
export const CAPABILITY_TYPES = ['tool', 'skill', 'mcp', 'plugin', 'connector', 'command', 'subagent', 'hook'] as const

/**
 * Dims that resolve to a capability *name*. The cube renders each of them as
 * `CASE WHEN e.capability_type = '<dim>' THEN COALESCE(e.capability_name,'') ELSE '' END`
 * (packages/query engine), so an event of any other kind contributes the empty
 * string. Without a matching `capabilityType` filter the whole event store
 * therefore collapses into one giant unnamed bucket and the page reports the
 * entire database as "skill invocations" — the bug `agl skills` shipped with.
 */
export const CAPABILITY_NAME_DIMS: readonly string[] = CAPABILITY_TYPES

/** How the empty value of a capability-name dim must read in the UI: never a name. */
export const UNNAMED_CAPABILITY = '(unnamed)'

export function isCapabilityNameDim(dim: string): boolean {
  return CAPABILITY_NAME_DIMS.includes(dim)
}

/**
 * Fold the capability-type restriction the cube needs into a request's params,
 * exactly the way the CLI's capability commands do. A caller-set `capabilityType`
 * is intersected with the types the dims ask for (an empty intersection stays
 * empty: no rows is honest, a widened window is not). Queries that select no
 * capability-name dim are returned untouched.
 */
export function withCapabilityType(dims: readonly string[], params: FilterParams): FilterParams {
  const requested = dims.filter(isCapabilityNameDim)
  if (requested.length === 0) return params
  const declared = params.capabilityType
  if (declared === undefined) return { ...params, capabilityType: requested }
  const list = Array.isArray(declared) ? declared.map(String) : String(declared).split(',')
  return { ...params, capabilityType: list.filter((t) => requested.includes(t)) }
}

/**
 * Label one cell of a capability-name dim. `''` is the engine's "no name for this
 * kind" bucket, so it is rendered as a disclosure instead of a blank the eye would
 * read as a real capability name. When several capability dims share one query the
 * same empty cell can also mean "this event is one of the other selected kinds",
 * and the label says so rather than inventing a name.
 */
export function capabilityDimCell(dim: string, value: unknown, selected: readonly string[] = [dim]): string {
  if (!isCapabilityNameDim(dim)) return String(value)
  const text = String(value ?? '')
  if (text !== '') return text
  return selected.some((d) => d !== dim && isCapabilityNameDim(d)) ? '(unnamed or other kind)' : UNNAMED_CAPABILITY
}

/**
 * Which explanatory note the server meant. These mirror `packages/server/src/notes.ts`
 * one-for-one, and `apps/web/test/server-notes.test.ts` fails if the two lists ever
 * disagree — the mirror is deliberate: this file is the HTTP contract as the browser
 * sees it, and it must not drag server code into the web program.
 */
export type TokenBasisCode = 'dedupRequestMax'
export type CostBasisCode = 'noPriceTable' | 'fusedFormula'
export type AgentNoteCode = 'notDetected' | 'dataRootUnreadable' | 'adapterNotInstalled' | 'probeError'
export type CatalogNoteCode = 'noCatalogInjected' | 'catalogUnreadable' | 'catalogCounts'
export type ContentNoteCode = 'contentOn' | 'contentOff' | 'contentPresent' | 'contentWithheldByParam' | 'contentMissing'
export type ProjectNoteCode = 'canonicalRootFold'
export type ModelNoteCode = 'naMeansUnpriced'
/** §11's stage-1 fold state; mirrors `RequestFoldCode` in @agentlens/storage. */
export type StageOneCode = 'absent' | 'drifted' | 'policyMismatch' | 'materialised'

/** A cost figure as the server emits it: null means "no basis", never $0. */
export interface CostView {
  pricingConfigured: boolean
  apiEquivalentUsd: number | null
  /** §18 row 1 resolved in the cube: what the agent reported where it did, priced cash where it did not. */
  totalUsd: number | null
  /** Mode-folded estimate that ignores reported facts — kept for the pricing view, not the spend. */
  actualUsd: number | null
  reportedUsd: number | null
  totalPartial: boolean
  apiEquivalentPartial: boolean
  actualPartial: boolean
  unpricedAgents: string[]
  perAgent: {
    agentId: string
    billingMode: string
    apiEquivalentUsd: number | null
    totalUsd: number | null
    actualUsd: number | null
    reportedUsd: number | null
  }[]
  basisCode: CostBasisCode
}

export interface Filter {
  since?: string
  until?: string
  agent?: string[]
  host?: string[]
  project?: string[]
  session?: string[]
  model?: string[]
  provider?: string[]
  capabilityType?: string[]
  capabilityName?: string[]
  status?: string[]
  type?: string[]
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export interface HealthResponse {
  status: string
  server: string
  now: number
  dbPath: string | null
  events: number
  sessions: number
  migrationsApplied: number
  contentAvailable: boolean
  payloads: number
  loopbackOnly: boolean
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

export interface HostShare {
  host: string
  events: number
  share: number
}
export interface HostSplitBanner {
  agentId: string
  dominantHost: string
  dominantShare: number
  hosts: HostShare[]
  /** The dominant host is only the agent's own name repeated; the banner is worded differently. */
  degenerate: boolean
  splitByDefault: true
  message: string
}
export interface OverviewResponse {
  generatedAt: number
  window: { since?: string; until?: string; sinceTs: number | null; granularity: string; defaultSinceApplied: boolean }
  cards: {
    tokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; basisCode: TokenBasisCode }
    cost: CostView
    sessions: number
    events: number
  }
  activity: Record<string, number>
  trend: Row[]
  trendByHost: Row[]
  agents: Row[]
  hosts: Row[]
  projects: Row[]
  capabilities: Row[]
  banners: { hostSplit: HostSplitBanner | null; coverage: CoverageReport }
  content: { available: boolean; payloads: number }
}

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

export interface UnreachableSource {
  id: string
  agentId: string
  path: string | null
  status: string
  lastError: string | null
  filePresent: boolean
  dirPresent: boolean
}
export interface EmptyDir {
  dir: string
  agentIds: string[]
  missingSources: number
  lastEventAt: number | null
}
export interface CoverageReport {
  generatedAt: number
  incomplete: boolean
  sourcesKnown: number
  unreachable: UnreachableSource[]
  emptyDirs: EmptyDir[]
  projectDirsWithoutSessions: { project: string; root: string }[]
  eventlessSessions: number
  banner: string | null
  limits: string
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export interface SessionRow {
  sessionId: string
  agentId: string
  hostId: string
  projectId: string
  project: string
  title: string | null
  firstTimestamp: number | null
  lastTimestamp: number | null
  events: number
  tokensTotal: number
  durationMs: number
  costApiEquiv: number | null
  payloads: number
  contentAvailable: boolean
}
export interface SessionListResponse {
  rows: SessionRow[]
  totalSessions: number
  truncated: boolean
  content: { available: boolean }
  filter: Filter
}

export interface PayloadView {
  kind: string
  role: string | null
  text: string
  bytes: number | null
  truncated: boolean
}
export interface TimelineNode {
  id: string
  type: string
  subtype: string | null
  timestamp: number | null
  rawSeq: number | null
  requestId: string | null
  parentEventId: string | null
  agentId: string
  hostId: string
  model: { provider: string; name: string } | null
  capability: { type: string; name: string; provider: string | null } | null
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
  } | null
  usageSource: string
  durationMs: number | null
  status: string
  errorFingerprint: string | null
  metadata: Record<string, unknown> | null
  payloads: PayloadView[]
  /**
   * How many payload rows this node has. The timeline is fetched with `payloads=0`, so on
   * first load this is the only sign a row has content worth opening — and the count comes
   * without the text, which for a 40k-event session was a 48 MB response body.
   */
  payloadCount: number
}
export interface SessionDetailResponse {
  session: {
    id: string
    agentId: string
    hostId: string
    projectId: string | null
    project: string | null
    title: string | null
    firstTimestamp: number | null
    lastTimestamp: number | null
    eventCount: number
  }
  contentAvailable: boolean
  contentNoteCode: ContentNoteCode
  totals: Record<string, number | null>
  nodes: TimelineNode[]
  explain: string
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

export interface CapabilityNameRow {
  name: string
  events: number
  durationMs: number
  tokensTotal: number
  costApiEquiv: number | null
  errors: number
}
export interface CapabilityTypeRow {
  type: string
  events: number
  durationMs: number
  tokensTotal: number
  costApiEquiv: number | null
  errors: number
  agents: { agentId: string; events: number; sessions: number }[]
  names: CapabilityNameRow[]
}
export interface CatalogView {
  available: boolean
  noteCode: CatalogNoteCode
  noteDetail?: string
  installed: number
  neverUsed: { agentId: string | null; type: string; name: string; source: string }[]
}
export interface CapabilityResponse {
  filter: Filter
  types: CapabilityTypeRow[]
  supports: { agentId: string; recorded: string[]; missing: string[] }[]
  catalog: CatalogView
  explain: string
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export interface ProjectRow {
  projectId: string
  project: string
  canonicalRoot: string | null
  observedCwds: { cwd: string; events: number }[]
  agents: { agentId: string; sessions: number; tokensTotal: number; events: number; costApiEquiv: number | null }[]
  models: { model: string; events: number; tokensTotal: number }[]
  capabilities: { type: string; events: number }[]
  recentSessions: { id: string; agentId: string; hostId: string; lastTimestamp: number | null; title: string | null }[]
  metrics: Record<string, number | null>
}
export interface ProjectsResponse {
  filter: Filter
  rows: ProjectRow[]
  totals: Record<string, number | null>
  truncated: boolean
  cost: CostView
  noteCode: ProjectNoteCode
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export interface AgentRow {
  agentId: string
  displayName: string | null
  recorded: boolean
  billingMode: string
  hosts: { host: string; events: number; sessions: number }[]
  capabilities: { type: string; events: number; errors: number }[]
  models: { model: string; events: number; tokensTotal: number; costApiEquiv: number | null }[]
  metrics: Record<string, number | null>
}
export interface AgentsResponse {
  filter: Filter
  rows: AgentRow[]
  totals: Record<string, number | null>
  cost: CostView
}

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

export type PriceSource = 'litellm' | 'openrouter' | 'override' | 'manual'

export interface ModelRow {
  provider: string
  model: string
  events: number
  sessions: number
  tokensTotal: number
  costApiEquiv: number | null
  priced: boolean | null
  /** Which price source stands behind `costApiEquiv` (§8); null when pricing is off. Mirror of `ModelRow` server-side. */
  priceSource: PriceSource | null
}
export interface ModelsResponse {
  filter: Filter
  rows: ModelRow[]
  totals: Record<string, number | null>
  truncated: boolean
  pricingConfigured: boolean
  unpriced: { provider: string; model: string; lastSeen: number | null }[]
  cost: CostView
  noteCode: ModelNoteCode
}

/* ------------------------------------------------------------------ *
 * Query cube (Usage explorer)
 * ------------------------------------------------------------------ */

export interface QueryResponse {
  spec: { metrics?: string[]; dims?: string[]; filter?: Filter; order?: string; limit?: number }
  explain: string
  rows: Row[]
  columns: string[]
  totals: Record<string, number | null>
  truncated: boolean
}

/* ------------------------------------------------------------------ *
 * Doctor
 * ------------------------------------------------------------------ */

export interface DoctorAgentRow {
  id: string
  displayName: string | null
  detectedVersion: string | null
  dataRoot: string | null
  events: number
  sources: number
  status: 'ok' | 'ingested-only' | 'not-detected' | 'error'
  noteCode: AgentNoteCode | null
  noteDetail?: string
}
export interface DoctorReport {
  generatedAt: number
  adaptersInstalled: boolean
  agents: DoctorAgentRow[]
  parsing: { events: number; parseErrors: number; parseErrorPct: number; unknownTypes: number }
  usageQuality: {
    reported: number
    estimated: number
    missing: number
    withoutRequestId: number
    naiveTokens: number
    dedupedTokens: number
    inflationAvoidedPct: number
    dedupActive: boolean
  }
  coverage: CoverageReport
  capabilities: { type: string; events: number; errors: number }[]
  capabilitySupport: { agentId: string; recorded: string[] }[]
  catalog: { available: boolean; noteCode: CatalogNoteCode; noteDetail?: string; installed: number; neverUsed: number }
  pricing: {
    pricingConfigured: boolean
    modelsPriced: number | null
    modelsSeen: number
    missing: { provider: string; model: string; lastSeen: number | null }[]
  }
  cost: CostView
  permissions: { path: string; readable: boolean }[]
  content: { available: boolean; payloads: number; noteCode: ContentNoteCode }
}

/* ------------------------------------------------------------------ *
 * Billing-mode declarations (§8)
 * ------------------------------------------------------------------ */

/** The three §8口径; the server validates against this union. */
export type BillingMode = 'api' | 'subscription' | 'local'
export const BILLING_MODES: readonly BillingMode[] = ['api', 'subscription', 'local']

export interface BillingAgentRow {
  agentId: string
  displayName: string | null
  /** The mode the cost figures are folded with right now. */
  billingMode: BillingMode
  /** False when the agent simply has no declaration and inherits the `api` default. */
  declared: boolean
}
export interface BillingSettingsResponse {
  configFile: string
  modes: Record<string, BillingMode>
  agents: BillingAgentRow[]
}
export interface BillingWriteResponse {
  agent: string
  /** Effective mode after the write: clearing returns the agent to `api`. */
  mode: BillingMode
  modes: Record<string, BillingMode>
}

/* ------------------------------------------------------------------ *
 * Route helpers — every path is relative to this origin.
 * ------------------------------------------------------------------ */

export type FilterParams = Record<string, string | number | string[] | undefined>

export const api = {
  health: () => getJSON<HealthResponse>('/api/health'),
  overview: (params?: FilterParams) => getJSON<OverviewResponse>('/api/overview', params),
  query: (params: FilterParams) => getJSON<QueryResponse>('/api/query', params),
  sessions: (params?: FilterParams) => getJSON<SessionListResponse>('/api/sessions', params),
  session: (id: string, params?: FilterParams) =>
    getJSON<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`, params),
  /**
   * Payload text for one node, fetched when the inspector opens it. `?node=` repeats, so a
   * caller that wants several can batch them.
   */
  nodePayloads: (id: string, nodeId: string) =>
    getJSON<{ sessionId: string; payloads: Record<string, PayloadView[]> }>(
      `/api/sessions/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}/payloads`,
    ),
  capabilities: (params?: FilterParams) => getJSON<CapabilityResponse>('/api/capabilities', params),
  projects: (params?: FilterParams) => getJSON<ProjectsResponse>('/api/projects', params),
  agents: (params?: FilterParams) => getJSON<AgentsResponse>('/api/agents', params),
  models: (params?: FilterParams) => getJSON<ModelsResponse>('/api/models', params),
  doctor: (params?: FilterParams) => getJSON<DoctorReport>('/api/doctor', params),
  coverage: () => getJSON<CoverageReport>('/api/coverage'),
  billingSettings: () => getJSON<BillingSettingsResponse>('/api/settings/billing'),
  /** `mode: null` drops the declaration, so the agent falls back to the `api` default. */
  setBilling: (body: { agent: string; mode: BillingMode | null }) =>
    postJSON<BillingWriteResponse>('/api/settings/billing', body),
}
