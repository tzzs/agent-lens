/**
 * The framing/discovery helpers below moved to `@agentlens/event-model` (§5.4:
 * adapters may depend on event-model only, never on collector). They are
 * re-exported here so existing collector consumers see an unchanged surface
 * while the dependency arrow stays legal.
 */
export {
  isParseErrorRecord,
  PARSE_ERROR_KEY,
  parseJsonlRecords,
  resolveOccurredAt,
  truncate,
  type ParseErrorMarker,
} from '@agentlens/event-model'
export { walkForFiles, type WalkOptions } from '@agentlens/event-model'

export * from './incremental.ts'
export * from './sqlite-source.ts'
export * from './sqlite-snapshot.ts'
export * from './orchestrator.ts'
export * from './watch.ts'
