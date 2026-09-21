/**
 * GET /api/doctor (§11) — the trust report `agl doctor` prints, as JSON.
 *
 * Numbers are re-derived from the rows the cube aggregates: the dedup line uses
 * event-model's `aggregateRequestTokens` over the same usage rows, so "raw sum →
 * deduped" cannot disagree with the dashboard. This diagnostic scans all usage
 * rows on purpose; the hot dashboard routes never do.
 */
import { aggregateRequestTokens } from '@agentlens/event-model'
import { rowToEvent } from '@agentlens/storage'
import { query, type QueryFilter } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView, missingPriceModels } from './cost.ts'
import { coverageReport } from './coverage.ts'
import { hostContext, isReadable, loadAdapters } from './adapters.ts'
import { parseFilter } from './request-spec.ts'
import { redactHome, rowsOf } from './resolve.ts'
import type { Usage } from '@agentlens/event-model'

export interface DoctorAgentRow {
  id: string
  displayName: string | null
  detectedVersion: string | null
  dataRoot: string | null
  events: number
  sources: number
  status: 'ok' | 'ingested-only' | 'not-detected' | 'error'
  note: string | null
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
  coverage: ReturnType<typeof coverageReport>
  capabilities: { type: string; events: number; errors: number }[]
  capabilitySupport: { agentId: string; recorded: string[] }[]
  catalog: { available: boolean; note: string; installed: number; neverUsed: number }
  pricing: { pricingConfigured: boolean; modelsPriced: number | null; modelsSeen: number; missing: { provider: string; model: string; lastSeen: number | null }[] }
  cost: ReturnType<typeof costView>
  permissions: { path: string; readable: boolean }[]
  content: { available: boolean; payloads: number; note: string }
}

const pctOf = (n: number, d: number): number => (d === 0 ? 0 : (n / d) * 100)
const sumTokens = (u: Usage): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens

function count(db: ServerCtx['db'], sql: string, ...params: unknown[]): number {
  return Number(rowsOf(db, sql, ...params)[0]?.n ?? 0)
}
