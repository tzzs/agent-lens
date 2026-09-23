/**
 * @agentlens/server — Hono HTTP + SSE over the single §7 cube (§13).
 *
 * The route handlers are deliberately thin: anything that counts goes through
 * `query()`, so `agl usage --by project` and the Projects page are the same code
 * path with a different transport.
 */
export { createApp, createContext, SERVER_NAME } from './app.ts'
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  assertLoopbackBind,
  isLoopbackHost,
  priceTableFor,
  startServer,
  type RunningServer,
  type StartOptions,
} from './serve.ts'
export type {
  CatalogEntry,
  ChangeSource,
  ChangeTick,
  PriceResolver,
  ScanSummary,
  ServerCtx,
  ServerDeps,
} from './types.ts'
export {
  AGENT_NOTE_CODES,
  CATALOG_NOTE_CODES,
  CONTENT_NOTE_CODES,
  COST_BASIS_CODES,
  MODEL_NOTE_CODES,
  PROJECT_NOTE_CODES,
  TOKEN_BASIS_CODES,
  type AgentNoteCode,
  type CatalogNoteCode,
  type ContentNoteCode,
  type CostBasisCode,
  type ModelNoteCode,
  type ProjectNoteCode,
  type TokenBasisCode,
} from './notes.ts'
export { ApiError, toErrorBody, type ErrorBody, type ErrorKind } from './errors.ts'
export { parseSpec, strParam, listParam } from './request-spec.ts'
export { overview, type OverviewResponse } from './overview.ts'
export { listSessions, nodePayloads, sessionDetail, sessionDetailOptions, type SessionDetailOptions, type SessionDetailResponse, type SessionListResponse } from './sessions.ts'
export { capabilities, catalogSummary, type CapabilityResponse, type CatalogView } from './capabilities.ts'
export { projects, type ProjectsResponse } from './projects.ts'
export { agents, type AgentsResponse } from './agents.ts'
export { models, type ModelsResponse } from './models.ts'
export { doctor } from './doctor.ts'
export type { DoctorReport, DoctorAgentRow } from './doctor-types.ts'
export {
  coverageBanner,
  coverageReport,
  INGESTED_RETENTION,
  projectRowsPhrase,
  retentionPhrase,
  UPSTREAM_RETENTION,
  type CoverageReport,
  type RetentionScope,
} from './coverage.ts'
export {
  actualUsdFor,
  costView,
  gappedModels,
  isGapped,
  missingPriceModels,
  modelPrices,
  priceVerdictsByModel,
  modelSpend,
  reportedCostDrift,
  unpricedBuckets,
  unpricedModelKey,
  unpricedModels,
  type CostDrift,
  type CostView,
  type ModelPrice,
  type ModelSpend,
  type UnpricedModel,
} from './cost.ts'
export { banners, hostSplitBanner, hostSplitsByAgent, type HostSplitBanner } from './banners.ts'
export { DEFAULT_POLL_MS, SSE_KEEPALIVE_MS, pollChangeSource } from './changes.ts'
export { contentLayerPresent, loadPayloads, payloadCount } from './content.ts'
