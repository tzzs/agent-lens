/**
 * GET /api/doctor (§11) — the trust report `agl doctor` prints, as JSON.
 *
 * The per-agent fold and the deeper checks come from the shared storage helpers the CLI calls
 * too (§14: the two ends must not disagree), so every token total here is folded under the
 * policy persisted with that agent's own rows (§18 row 2) — never one global rule. This route
 * scans all usage rows on purpose; the hot dashboard routes never do.
 */
import type { AggregationMode } from '@agentlens/event-model'
import type { AgentUsageQuality, ParserVersionDrift, RetentionCounts } from '@agentlens/storage'
import { costView } from './cost.ts'
import { coverageReport } from './coverage.ts'
import type { AgentNoteCode, CatalogNoteCode, ContentNoteCode } from './notes.ts'

export interface DoctorAgentRow {
  id: string
  displayName: string | null
  detectedVersion: string | null
  dataRoot: string | null
  events: number
  sources: number
  status: 'ok' | 'ingested-only' | 'not-detected' | 'error'
  /** Which sentence explains this row; null when the row needs none. */
  noteCode: AgentNoteCode | null
  /** Verbatim diagnostic text, for `probeError` only: never a translatable sentence. */
  noteDetail?: string
}

/** One agent's Usage quality row, plus whether its cube total and event-model's fold agree. */
export interface DoctorUsageAgentRow extends AgentUsageQuality {
  agrees: boolean
}

export interface DoctorSubagentLinkage {
  agentId: string
  total: number
  orphan: number
  orphanPct: number
}

/** §5.2: events whose stored timestamp the source never stated, counted per agent. */
export interface DoctorTimestampGuess {
  agentId: string
  events: number
  guessed: number
  guessedPct: number
  /** The unbounded case (§19): dated by the instant the scan ran. */
  fromIngestClock: number
  /** Bounded by the source file's last write instead. */
  fromFileMtime: number
}

export interface DoctorReport {
  generatedAt: number
  adaptersInstalled: boolean
  agents: DoctorAgentRow[]
  parsing: {
    events: number
    parseErrors: number
    parseErrorPct: number
    unknownTypes: number
    /** §5.3: sources whose stored parser is older than the adapter's current one. */
    parserDrift: ParserVersionDrift
  }
  usageQuality: {
    reported: number
    estimated: number
    missing: number
    withoutRequestId: number
    naiveTokens: number
    dedupedTokens: number
    inflationAvoidedPct: number
    dedupActive: boolean
    /** §18 row 2: more than one mode here is the mixed-fold case; no global rule fits it. */
    modes: AggregationMode[]
    perAgent: DoctorUsageAgentRow[]
  }
  coverage: ReturnType<typeof coverageReport>
  /** §4.4 row 8: subagent events whose parent the time heuristic could not resolve. */
  subagents: DoctorSubagentLinkage[]
  /** §5.2: per-agent count of events whose time the source never stated. */
  guessedTimestamps: DoctorTimestampGuess[]
  /** §4.4 row 4: sources upstream deleted or rotated after they were read. */
  retention: RetentionCounts
  capabilities: { type: string; events: number; errors: number }[]
  capabilitySupport: { agentId: string; recorded: string[] }[]
  catalog: { available: boolean; noteCode: CatalogNoteCode; noteDetail?: string; installed: number; neverUsed: number }
  pricing: { pricingConfigured: boolean; modelsPriced: number | null; modelsSeen: number; missing: { provider: string; model: string; lastSeen: number | null }[] }
  cost: ReturnType<typeof costView>
  permissions: { path: string; readable: boolean }[]
  content: { available: boolean; payloads: number; noteCode: ContentNoteCode }
}
