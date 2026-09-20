/** Re-exports so CLI modules import their vocabulary from one local path. */
export type { QueryFilter, QueryDeps, Metric, Dim, Row, QueryResult } from '@agentlens/query'
export { query, describeQuery, resolveSince, bucketTs, DIMS, METRICS } from '@agentlens/query'
export type { BillingMode, PriceEntry } from '@agentlens/pricing'
export type { AgentEvent, AgentAdapter, SourceSpec, ParseFailure } from '@agentlens/event-model'
