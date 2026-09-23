/**
 * Three lists have to agree, and nothing but a test makes them:
 *
 *   the codes `packages/server/src/notes.ts` says the API can send,
 *   the codes this browser's contract (`lib/api.ts`) is typed against, and
 *   the messages `packages/i18n` can actually word.
 *
 * The server used to send these as English sentences, which is why the lists are
 * separate at all: a note now arrives as a fact and the viewer words it. That only
 * stays honest while an unworded code is impossible — `translate` echoes an unknown
 * key back, so the first case below is exactly that tripwire, run against the code
 * list the server exports rather than one copied here.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_NOTE_CODES,
  CATALOG_NOTE_CODES,
  CONTENT_NOTE_CODES,
  COST_BASIS_CODES,
  MODEL_NOTE_CODES,
  PROJECT_NOTE_CODES,
  TOKEN_BASIS_CODES,
} from '@agentlens/server'
import { REQUEST_FOLD_CODES, requestFoldSentence, requestFoldVerdict, type RequestFoldHealth } from '@agentlens/storage'
import { catalog, translate, type Locale, type MessageKey } from '@agentlens/i18n'
import { agentNote, catalogNote, contentNote, costBasis, modelNote, projectNote, stageOneNote, tokenBasis } from '../src/lib/notes.ts'

const SERVER_CODES = [
  ...TOKEN_BASIS_CODES,
  ...COST_BASIS_CODES,
  ...AGENT_NOTE_CODES,
  ...CATALOG_NOTE_CODES,
  ...CONTENT_NOTE_CODES,
  ...PROJECT_NOTE_CODES,
  ...MODEL_NOTE_CODES,
  ...REQUEST_FOLD_CODES,
]

describe('server note codes', () => {
  it('words every code the server can send, in both locales', () => {
    // Every placeholder any note can carry, so a message that needs one still
    // formats; ICU ignores values a message never mentions.
    const values = { detail: 'x', installed: '1', neverUsed: '2', rows: '3', members: '4', events: '5' }
    for (const code of new Set(SERVER_CODES)) {
      for (const locale of ['en', 'zh'] as Locale[]) {
        const text = translate(locale, `notes.${code}` as MessageKey, values)
        expect(text, `${locale}:${code} has no message`).not.toBe(`notes.${code}`)
        expect(text.trim(), `${locale}:${code} is blank`).not.toBe('')
      }
    }
  })

  it('carries no message the server will never ask for', () => {
    expect(Object.keys(catalog.en.notes).sort()).toEqual([...new Set(SERVER_CODES)].sort())
  })

  it('keeps the English the API used to carry, so the screen does not reword', () => {
    expect(tokenBasis('dedupRequestMax')).toBe('deduped by request_id (MAX per request, then SUM) — §3.1 invariant')
    expect(contentNote('contentOff')).toBe(
      'content layer off (the default; scan with --content) or expired: timelines are metrics-only, statistics unaffected',
    )
    expect(catalogNote('catalogCounts', { installed: 412, neverUsed: 37 })).toBe(
      '412 catalogued entries · 37 never observed in the event stream',
    )
    expect(projectNote('canonicalRootFold')).toContain('(§4.1)')
    expect(modelNote('naMeansUnpriced')).toContain('n/a')
  })

  it('still says which cube column the cost figure came from', () => {
    // The assertion `packages/server/test/cost.test.ts` handed over with the sentence.
    expect(costBasis('fusedFormula')).toContain('cost_total')
    expect(costBasis('fusedFormula')).toContain('§18 row 1')
  })

  it('says the stage-1 verdict in the same words and the same digits as the terminal (§14)', () => {
    // Four cases, from storage's own decision function, so neither side can drift:
    // `agl doctor` and the dashboard must print one sentence for one store state.
    const stores: RequestFoldHealth[] = [
      { present: false, rows: 0, members: 0, events: 12_345, policyMatches: false },
      { present: true, rows: 900, members: 11_004, events: 12_345, policyMatches: true },
      { present: true, rows: 4_210, members: 12_345, events: 12_345, policyMatches: false },
      { present: true, rows: 4_210, members: 12_345, events: 12_345, policyMatches: true },
    ]
    for (const health of stores) {
      const { ok, code } = requestFoldVerdict(health)
      expect(stageOneNote(code, health), code).toBe(requestFoldSentence(health).text)
      expect(translate('zh', `notes.${code}` as MessageKey, { rows: '1', members: '1', events: '1' }), code).not.toBe(`notes.${code}`)
      expect(ok, code).toBe(code === 'materialised')
    }
  })

  it('passes a probe failure through untranslated, because a user pastes it', () => {
    const detail = 'stat failed for ~/.local/share/opencode'
    expect(agentNote('probeError', detail)).toBe(detail)
    expect(agentNote('probeError', detail)).not.toBe(agentNote('dataRootUnreadable'))
    expect(catalogNote('catalogUnreadable', { installed: 0, neverUsed: 0, detail: 'EACCES' })).toContain('EACCES')
  })
})
