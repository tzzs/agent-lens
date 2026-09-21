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
  isBillingMode,
  liveBillingModes,
  readBillingModesFile,
  writeBillingMode,
} from '../src/billing-config.ts'

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
      expect(writeBillingMode(path, 'claude-code', 'subscription')).toEqual({ 'claude-code': 'subscription' })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ billing: { 'claude-code': 'subscription' } })
      expect(readBillingModesFile(path)).toEqual({ 'claude-code': 'subscription' })
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
      expect(readBillingModesFile(path)).toEqual({ ollama: 'local' })
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
      expect(readBillingModesFile(path)).toEqual({ a: 'local' })
      expect(() => writeBillingMode(path, 'b', 'whatever' as never)).toThrowError(/api \| subscription \| local/)
      // Rejected means untouched: the write never happened, and the other
      // declarations — valid or not — are still the user's own bytes.
      expect(readBillingModesFile(path)).toEqual({ a: 'local' })
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
      expect(view['claude-code']).toBe('local')
      writeBillingMode(path, 'ollama', 'local')
      expect(Object.keys(view)).toEqual(['claude-code', 'ollama'])
      expect({ ...view }).toEqual({ 'claude-code': 'local', ollama: 'local' })
      expect('ollama' in view).toBe(true)
      expect(view['nope']).toBeUndefined()
      writeBillingMode(path, 'claude-code', null)
      expect(view['claude-code']).toBeUndefined()
      expect(view).toEqual({ ollama: 'local' })
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
