import { afterEach, describe, expect, it } from 'vitest'
import { IntlMessageFormat } from 'intl-messageformat'
import {
  activeLocale,
  catalog,
  DEFAULT_LOCALE,
  matches,
  messageEntries,
  msg,
  resolveLocale,
  setActiveLocale,
  translate,
  type MessageKey,
} from '@agentlens/i18n'

const started = activeLocale()
afterEach(() => setActiveLocale(started))

/** Collect the leaf paths of a locale's tree, so parity is checked on the real shape. */
function leaves(node: unknown, path = ''): string[] {
  if (typeof node === 'string') return [path]
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
}

describe('message catalog', () => {
  it('compiles every message as ICU, in both locales', () => {
    const entries = messageEntries()
    expect(entries.length).toBeGreaterThan(0)
    for (const { locale, key, source } of entries) {
      expect(() => new IntlMessageFormat(source, locale), `${locale}:${key}`).not.toThrow()
    }
  })

  it('keeps the two locales key-for-key identical', () => {
    expect(leaves(catalog.zh).sort()).toEqual(leaves(catalog.en).sort())
  })

  it('substitutes values and agrees English with its count', () => {
    setActiveLocale('en')
    expect(msg('banner.coverageRetained', { count: 1, population: 'upstream retention' })).toBe(
      '1 source dir still exists but holds no session files (upstream retention, §4.4 row 4)',
    )
    expect(msg('banner.coverageRetained', { count: 12, population: 'upstream retention' })).toBe(
      '12 source dirs still exist but hold no session files (upstream retention, §4.4 row 4)',
    )
    expect(msg('fmt.durHM', { h: 55, m: 52 })).toBe('55h 52m')
  })

  it('gives Chinese one form, without an English plural tail', () => {
    setActiveLocale('zh')
    expect(msg('banner.coverageRetained', { count: 1, population: 'x' })).toBe('有 1 个源目录仍在，但已不含会话文件（x，§4.4 第 4 行）')
    expect(msg('fmt.durHM', { h: 55, m: 52 })).toBe('55 时 52 分')
  })

  it('formats with the active locale and defaults to English', () => {
    setActiveLocale(DEFAULT_LOCALE)
    expect(msg('common.na')).toBe('n/a')
    setActiveLocale('zh')
    expect(msg('common.na')).toBe('未定价')
  })

  it('folds a system tag onto a locale it has, and keeps the unknown ones English', () => {
    expect(resolveLocale(['zh-CN', 'zh', 'en'])).toBe('zh')
    expect(resolveLocale(['zh_Hans', 'en'])).toBe('zh')
    expect(resolveLocale(['zh-Hant-TW'])).toBe('zh')
    expect(resolveLocale(['en-GB'])).toBe('en')
    expect(resolveLocale(['fr', 'de'])).toBe('en')
    expect(resolveLocale([])).toBe('en')
  })

  it('degrades an unknown key to the key itself rather than to an empty string', () => {
    const missing = translate('en', 'nope.missing' as MessageKey)
    expect(missing).toBe('nope.missing')
  })

  it('rejects a locale half that is missing a key at the type level', () => {
    const en = { a: 'A', nested: { b: 'B' } }
    expect(matches(en)({ a: '甲', nested: { b: '乙' } })).toEqual({ a: '甲', nested: { b: '乙' } })
    // @ts-expect-error — `nested.b` is absent, which `matches` must not accept.
    const incomplete = matches(en)({ a: '甲', nested: {} })
    expect(typeof incomplete).toBe('object')
  })
})
