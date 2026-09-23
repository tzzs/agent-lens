/**
 * The dashboard's half of `packages/server/src/notes.ts`: the server names which
 * fact a note carries, this file says it in the viewer's language.
 *
 * Each map is a `Record<Code, MessageKey>`, so a code the server can send and the
 * catalog cannot word is a type error, not a blank paragraph. The rendered English
 * is the sentence the API used to carry, byte for byte — `server-notes.test.ts`
 * pins that, along with the code lists matching on both sides.
 *
 * These are plain functions reading the catalog's active locale rather than
 * reactive store reads; the language switcher remounts the page (see App.svelte),
 * which is what keeps a note from outliving the language it was drawn in.
 */
import { msg, type MessageKey } from '@agentlens/i18n'
import { formatInt } from './format.ts'
import type {
  AgentNoteCode,
  CatalogNoteCode,
  ContentNoteCode,
  CostBasisCode,
  ModelNoteCode,
  ProjectNoteCode,
  StageOneCode,
  TokenBasisCode,
} from './api.ts'

const TOKEN_BASIS: Record<TokenBasisCode, MessageKey> = { dedupRequestMax: 'notes.dedupRequestMax' }
const COST_BASIS: Record<CostBasisCode, MessageKey> = { noPriceTable: 'notes.noPriceTable', fusedFormula: 'notes.fusedFormula' }
const AGENT_NOTE: Record<AgentNoteCode, MessageKey> = {
  notDetected: 'notes.notDetected',
  dataRootUnreadable: 'notes.dataRootUnreadable',
  adapterNotInstalled: 'notes.adapterNotInstalled',
  probeError: 'notes.probeError',
}
const CATALOG_NOTE: Record<CatalogNoteCode, MessageKey> = {
  noCatalogInjected: 'notes.noCatalogInjected',
  catalogUnreadable: 'notes.catalogUnreadable',
  catalogCounts: 'notes.catalogCounts',
}
const CONTENT_NOTE: Record<ContentNoteCode, MessageKey> = {
  contentOn: 'notes.contentOn',
  contentOff: 'notes.contentOff',
  contentPresent: 'notes.contentPresent',
  contentWithheldByParam: 'notes.contentWithheldByParam',
  contentMissing: 'notes.contentMissing',
}
const PROJECT_NOTE: Record<ProjectNoteCode, MessageKey> = { canonicalRootFold: 'notes.canonicalRootFold' }
const MODEL_NOTE: Record<ModelNoteCode, MessageKey> = { naMeansUnpriced: 'notes.naMeansUnpriced' }
const STAGE_ONE: Record<StageOneCode, MessageKey> = {
  absent: 'notes.absent',
  drifted: 'notes.drifted',
  policyMismatch: 'notes.policyMismatch',
  materialised: 'notes.materialised',
}

export function tokenBasis(code: TokenBasisCode): string {
  return msg(TOKEN_BASIS[code])
}

export function costBasis(code: CostBasisCode): string {
  return msg(COST_BASIS[code])
}

/** `detail` is server text (an error message), and stays untranslatable by design. */
export function agentNote(code: AgentNoteCode, detail?: string | null): string {
  return msg(AGENT_NOTE[code], { detail: detail ?? '' })
}

export function catalogNote(code: CatalogNoteCode, counts: { installed: number; neverUsed: number; detail?: string | null }): string {
  return msg(CATALOG_NOTE[code], {
    installed: String(counts.installed),
    neverUsed: String(counts.neverUsed),
    detail: counts.detail ?? '',
  })
}

export function contentNote(code: ContentNoteCode): string {
  return msg(CONTENT_NOTE[code])
}

/** §11's stage-1 health: the counts arrive from the store, the sentence is the viewer's. */
export function stageOneNote(code: StageOneCode, counts: { rows: number; members: number; events: number }): string {
  // Grouped, exactly as storage groups them for the terminal's line (§14).
  return msg(STAGE_ONE[code], { rows: formatInt(counts.rows), members: formatInt(counts.members), events: formatInt(counts.events) })
}

export function projectNote(code: ProjectNoteCode): string {
  return msg(PROJECT_NOTE[code])
}

export function modelNote(code: ModelNoteCode): string {
  return msg(MODEL_NOTE[code])
}
