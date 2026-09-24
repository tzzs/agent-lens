/**
 * The §8 billing-mode declaration store. These tests pin the file shape because
 * three surfaces (CLI command, server route, the cube's `billingModeFor`) read and
 * write the same file; a format drift there is exactly the CLI/Web disagreement §14
 * forbids. All fixtures are synthetic paths under a tmp dir.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  BILLING_MODES,
  assertBillingMode,
  billingConfigPath,
  billingModeFor,
  billingModelKey,
  isBillingMode,
  liveBillingModes,
  parseBillingModes,
  planFeeFor,
  readBillingModesFile,
  writeBillingMode,
  writeBillingModelMode,
  writeBillingPlanFee,
  type BillingDeclaration,
} from '../src/billing-config.ts'
import type { BillingMode } from '../src/price-types.ts'

/** Parse a `billing` object the way the loader would, so a case reads as the file it stands for. */
const parse = (billing: Record<string, unknown>) => parseBillingModes({ billing })

/** A parsed declaration, spelled out so a test never passes by sharing a default with the code. */
const dec = (
  mode: BillingDeclaration['mode'],
  planUsdPerMonth: number | null = null,
  models: Record<string, BillingMode> = {},
): BillingDeclaration => ({ mode, planUsdPerMonth, models })

function tmpFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-billing-'))
  return { dir, path: join(dir, 'config.json') }
}

describe('billing mode validation', () => {
  it('accepts exactly the BillingMode union', () => {
    expect([...BILLING_MODES]).toEqual(['api', 'subscription', 'local'])
    for (const m of BILLING_MODES) {
      expect(isBillingMode(m)).toBe(true)
      expect(assertBillingMode(m)).toBe(m)
    }
  })

  it('rejects anything else with the accepted list in the message', () => {
    for (const bad of ['payg', 'FREE', '', 'byok', undefined, null, 0, true, {}]) {
      expect(isBillingMode(bad)).toBe(false)
      expect(() => assertBillingMode(bad)).toThrowError(/api \| subscription \| local/)
    }
    // The error must name what the user typed, not just the legal set.
    expect(() => assertBillingMode('payg')).toThrowError(/"payg"/)
  })
})

describe('declaration file', () => {
  it('reads an absent file as no declarations, never an error', () => {
    const { dir, path } = tmpFile()
    rmSync(dir, { recursive: true, force: true })
    expect(readBillingModesFile(path)).toEqual({})
    expect(liveBillingModes(path)['anything']).toBeUndefined()
  })

  it('writes the documented shape and drops back to empty on clear', () => {
    const { dir, path } = tmpFile()
    try {
      expect(writeBillingMode(path, 'claude-code', 'subscription')).toEqual({ 'claude-code': dec('subscription') })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ billing: { 'claude-code': 'subscription' } })
      expect(readBillingModesFile(path)).toEqual({ 'claude-code': dec('subscription') })
      expect(writeBillingMode(path, 'claude-code', null)).toEqual({})
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ billing: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps unrelated keys the user hand-edited into the same file', () => {
    const { dir, path } = tmpFile()
    try {
      writeFileSync(path, `${JSON.stringify({ retentionDays: 90, billing: { ollama: 'local' } }, null, 2)}\n`, 'utf8')
      writeBillingMode(path, 'codex', 'api')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        retentionDays: 90,
        billing: { ollama: 'local', codex: 'api' },
      })
      // Clearing one declaration leaves the other standing.
      writeBillingMode(path, 'codex', null)
      expect(readBillingModesFile(path)).toEqual({ ollama: dec('local') })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite an unparseable file instead of silently clobbering it', () => {
    const { dir, path } = tmpFile()
    try {
      writeFileSync(path, '{ not json', 'utf8')
      expect(() => writeBillingMode(path, 'codex', 'api')).toThrowError(/not valid JSON/)
      expect(readFileSync(path, 'utf8')).toBe('{ not json')
      // Reading stays tolerant (a bad file must not break every query), so the loader
      // gives no declarations rather than throwing.
      expect(readBillingModesFile(path)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores malformed declarations on read but rejects them on write', () => {
    const { dir, path } = tmpFile()
    try {
      writeFileSync(path, JSON.stringify({ billing: { a: 'local', b: 'whatever', c: 7 } }), 'utf8')
      expect(readBillingModesFile(path)).toEqual({ a: dec('local') })
      expect(() => writeBillingMode(path, 'b', 'whatever' as never)).toThrowError(/api \| subscription \| local/)
      // Rejected means untouched: the write never happened, and the other
      // declarations — valid or not — are still the user's own bytes.
      expect(readBillingModesFile(path)).toEqual({ a: dec('local') })
      expect(JSON.parse(readFileSync(path, 'utf8')).billing).toEqual({ a: 'local', b: 'whatever', c: 7 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty agent id', () => {
    const { dir, path } = tmpFile()
    try {
      expect(() => writeBillingMode(path, '  ', 'api')).toThrowError(/agent id/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('live view (a long-lived --serve process must see another surface write)', () => {
  it('re-reads when the file changes and behaves like a plain record', () => {
    const { dir, path } = tmpFile()
    try {
      const view = liveBillingModes(path)
      expect(view['claude-code']).toBeUndefined()
      writeBillingMode(path, 'claude-code', 'local')
      expect(view['claude-code']).toEqual(dec('local'))
      writeBillingMode(path, 'ollama', 'local')
      expect(Object.keys(view)).toEqual(['claude-code', 'ollama'])
      expect({ ...view }).toEqual({ 'claude-code': dec('local'), ollama: dec('local') })
      expect('ollama' in view).toBe(true)
      expect(view['nope']).toBeUndefined()
      writeBillingMode(path, 'claude-code', null)
      expect(view['claude-code']).toBeUndefined()
      expect(view).toEqual({ ollama: dec('local') })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('per-model declarations and the plan fee', () => {
  it('keeps the agent default and the fee when only a model is written', () => {
    const { dir, path } = tmpFile()
    try {
      writeBillingMode(path, 'claude-code', 'subscription')
      writeBillingPlanFee(path, 'claude-code', 20)
      writeBillingModelMode(path, 'claude-code', 'anthropic/claude-sonnet-5', 'api')
      expect(readBillingModesFile(path)).toEqual({
        'claude-code': dec('subscription', 20, { 'anthropic/claude-sonnet-5': 'api' }),
      })
      // The file says the same thing in the shape the parser promises.
      expect(JSON.parse(readFileSync(path, 'utf8')).billing).toEqual({
        'claude-code': { mode: 'subscription', planUsdPerMonth: 20, models: { 'anthropic/claude-sonnet-5': 'api' } },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the model entry first, then the agent default, then api', () => {
    const modes = parse({
      claude: { mode: 'subscription', planUsdPerMonth: 20, models: { 'anthropic/sonnet': 'api' } },
      ollama: 'local',
    })
    expect(billingModeFor(modes, 'claude', 'anthropic', 'sonnet')).toBe('api')
    expect(billingModeFor(modes, 'claude', 'anthropic', 'opus')).toBe('subscription')
    // No model named is a question about the agent as a whole.
    expect(billingModeFor(modes, 'claude')).toBe('subscription')
    expect(billingModeFor(modes, 'ollama', 'x', 'anything')).toBe('local')
    expect(billingModeFor(modes, 'never-declared', 'x', 'y')).toBe('api')
    expect(billingModelKey('', 'unknown-model')).toBe('/unknown-model')
    expect(billingModeFor(parse({ qoder: { models: { 'zhipu/glm': 'subscription' } } }), 'qoder', 'zhipu', 'glm')).toBe(
      'subscription',
    )
    // An agent that declared only some models still defaults the rest to api (§8).
    expect(billingModeFor(parse({ qoder: { models: { 'zhipu/glm': 'subscription' } } }), 'qoder', 'zhipu', 'other')).toBe(
      'api',
    )
  })

  it('reads a fee as unknown rather than free, and drops a bad fee without losing the mode', () => {
    const modes = parse({ a: { mode: 'subscription', planUsdPerMonth: 20 }, b: { mode: 'subscription' }, c: 'local' })
    expect(planFeeFor(modes, 'a')).toBe(20)
    expect(planFeeFor(modes, 'b')).toBeNull()
    expect(planFeeFor(modes, 'never-declared')).toBeNull()
    // A fee that cannot be money invalidates itself, not the mode that prices the tokens.
    expect(parse({ x: { mode: 'subscription', planUsdPerMonth: -3 } })).toEqual({})
    expect(parse({ y: { mode: 'subscription', planUsdPerMonth: 'twenty' } })).toEqual({})
    expect(planFeeFor(modes, 'c')).toBeNull()
    // A model key no read can produce is carried and inert, not fatal: it costs the
    // agent its default for that name and nothing else. Writing one is what refuses.
    const odd = parse({ z: { mode: 'api', models: { nodash: 'api' } } })
    expect(odd).toEqual({ z: dec('api', null, { nodash: 'api' }) })
    expect(billingModeFor(odd, 'z', 'anthropic', 'nodash')).toBe('api')
  })

  it('refuses a model key that no read can produce', () => {
    const { dir, path } = tmpFile()
    try {
      writeBillingMode(path, 'codex', 'api')
      expect(() => writeBillingModelMode(path, 'codex', 'gpt-5', 'api')).toThrowError(/"<provider>\/<name>"/)
      expect(readBillingModesFile(path)).toEqual({ codex: dec('api') })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shrinks back to the plain string, then to nothing, as fields are undeclared', () => {
    const { dir, path } = tmpFile()
    try {
      writeBillingMode(path, 'codex', 'subscription')
      writeBillingPlanFee(path, 'codex', 50)
      expect(JSON.parse(readFileSync(path, 'utf8')).billing.codex).toEqual({ mode: 'subscription', planUsdPerMonth: 50 })
      writeBillingPlanFee(path, 'codex', null)
      // mode-only goes back to the shape this file had before models existed, so an
      // untouched config never churns.
      expect(JSON.parse(readFileSync(path, 'utf8')).billing.codex).toBe('subscription')
      writeBillingMode(path, 'codex', null)
      expect(JSON.parse(readFileSync(path, 'utf8')).billing).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('billingConfigPath', () => {
  it('puts the file next to the database, which is what every surface must use', () => {
    expect(billingConfigPath('/x/y/agentlens.db')).toBe('/x/y/config.json')
  })
})
