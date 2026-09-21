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
export { ApiError, toErrorBody, type ErrorBody, type ErrorKind } from './errors.ts'
export { parseSpec, strParam, listParam } from './request-spec.ts'
export { overview, type OverviewResponse } from './overview.ts'
export { listSessions, sessionDetail, type SessionDetailResponse, type SessionListResponse } from './sessions.ts'
export { capabilities, catalogSummary, type CapabilityResponse, type CatalogView } from './capabilities.ts'
export { projects, type ProjectsResponse } from './projects.ts'
export { agents, type AgentsResponse } from './agents.ts'
export { models, type ModelsResponse } from './models.ts'
export { doctor } from './doctor.ts'
export type { DoctorReport, DoctorAgentRow } from './doctor-types.ts'
export { coverageReport, type CoverageReport } from './coverage.ts'
export { costView, missingPriceModels, type CostView } from './cost.ts'
export { banners, hostSplitBanner, hostSplitsByAgent, type HostSplitBanner } from './banners.ts'
export { DEFAULT_POLL_MS, SSE_KEEPALIVE_MS, pollChangeSource } from './changes.ts'
export { contentLayerPresent, loadPayloads, payloadCount } from './content.ts'
