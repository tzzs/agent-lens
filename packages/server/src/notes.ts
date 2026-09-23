/**
 * The codes behind the dashboard's explanatory notes.
 *
 * These used to be English sentences in the response body. Nothing outside the
 * dashboard read them — the terminal words the same facts from its own code — so
 * the server now sends *which* fact it means and lets the viewer say it, which is
 * also what keeps §14 intact: one wording per fact, in one language per surface,
 * and never a sentence frozen in the locale the process happened to be written in.
 *
 * `packages/i18n` carries the text for every code here, and
 * `apps/web/test/server-notes.test.ts` fails if one side adds a code the other
 * has never heard of.
 */

/** Which sentence explains the token totals (§3.1's de-duplication rule). */
export const TOKEN_BASIS_CODES = ['dedupRequestMax'] as const
export type TokenBasisCode = (typeof TOKEN_BASIS_CODES)[number]

/** Which sentence explains the cost columns (§8/§18's fusion rule). */
export const COST_BASIS_CODES = ['noPriceTable', 'fusedFormula'] as const
export type CostBasisCode = (typeof COST_BASIS_CODES)[number]

/** Why one agent's row reads the way it does. `probeError` also carries `detail`. */
export const AGENT_NOTE_CODES = ['notDetected', 'dataRootUnreadable', 'adapterNotInstalled', 'probeError'] as const
export type AgentNoteCode = (typeof AGENT_NOTE_CODES)[number]

/** Why the capability catalog could not be listed, or what it counted. */
export const CATALOG_NOTE_CODES = ['noCatalogInjected', 'catalogUnreadable', 'catalogCounts'] as const
export type CatalogNoteCode = (typeof CATALOG_NOTE_CODES)[number]

/** What the content layer is doing for this store / session. */
export const CONTENT_NOTE_CODES = ['contentOn', 'contentOff', 'contentPresent', 'contentWithheldByParam', 'contentMissing'] as const
export type ContentNoteCode = (typeof CONTENT_NOTE_CODES)[number]

/** How the project rows were grouped. */
export const PROJECT_NOTE_CODES = ['canonicalRootFold'] as const
export type ProjectNoteCode = (typeof PROJECT_NOTE_CODES)[number]

/** Why an unpriced model shows "n/a" rather than a number. */
export const MODEL_NOTE_CODES = ['naMeansUnpriced'] as const
export type ModelNoteCode = (typeof MODEL_NOTE_CODES)[number]
