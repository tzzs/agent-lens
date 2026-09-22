/**
 * The message catalog for every AgentLens surface.
 *
 * Kept free of Svelte, DOM and Node APIs on purpose: the catalog is the one copy
 * of "what a number or a state is called", so the dashboard can render it today
 * and the terminal can ask for the same strings later without either owning them.
 * Each namespace file carries its `en` and `zh` side by side, and `matches()`
 * makes a missing or extra key in either locale a compile error.
 *
 * Messages are ICU: `{name}` substitutes, `{n, plural, one {…} other {…}}`
 * agrees an English sentence with its count (Chinese has one form). A literal
 * brace must be quoted as `'{'` / `'}'`; apostrophes need no escaping.
 */
import { IntlMessageFormat } from 'intl-messageformat'

import banner from './catalog/banner.ts'
import common from './catalog/common.ts'
import comps from './catalog/comps.ts'
import viz from './catalog/viz.ts'
import doctor from './catalog/doctor.ts'
import ev from './catalog/ev.ts'
import fmt from './catalog/fmt.ts'
import overview from './catalog/overview.ts'
import projects from './catalog/projects.ts'
import agents from './catalog/agents.ts'
import sessions from './catalog/sessions.ts'
import sessionDetail from './catalog/sessionDetail.ts'
import settings from './catalog/settings.ts'
import shell from './catalog/shell.ts'
import sidebar from './catalog/sidebar.ts'
import states from './catalog/states.ts'
import usage from './catalog/usage.ts'
import capabilities from './catalog/capabilities.ts'
import models from './catalog/models.ts'

/** The two locales this tool speaks. `zh` covers `zh-*`; region tags fold onto it. */
export type Locale = 'en' | 'zh'

export const locales: Locale[] = ['en', 'zh']

/** What a reader who asks for no locale gets: every existing assertion is English. */
export const DEFAULT_LOCALE: Locale = 'en'

export const catalog = {
  en: {
    common: common.en,
    fmt: fmt.en,
    ev: ev.en,
    shell: shell.en,
    sidebar: sidebar.en,
    states: states.en,
    banner: banner.en,
    overview: overview.en,
    sessions: sessions.en,
    sessionDetail: sessionDetail.en,
    projects: projects.en,
    agents: agents.en,
    usage: usage.en,
    capabilities: capabilities.en,
    models: models.en,
    doctor: doctor.en,
    settings: settings.en,
    comps: comps.en,
    viz: viz.en,
  },
  zh: {
    common: common.zh,
    fmt: fmt.zh,
    ev: ev.zh,
    shell: shell.zh,
    sidebar: sidebar.zh,
    states: states.zh,
    banner: banner.zh,
    overview: overview.zh,
    sessions: sessions.zh,
    sessionDetail: sessionDetail.zh,
    projects: projects.zh,
    agents: agents.zh,
    usage: usage.zh,
    capabilities: capabilities.zh,
    models: models.zh,
    doctor: doctor.zh,
    settings: settings.zh,
    comps: comps.zh,
    viz: viz.zh,
  },
} as const

type Shape<T> = T extends string ? string : { [K in keyof T]: Shape<T[K]> }

/**
 * Author a locale's half of a namespace against the other half's key tree. A key
 * present in one locale and absent in the other stops compiling, which is the
 * only guarantee that holds across 40-odd files edited by different hands.
 */
export function matches<T extends object>(reference: T) {
  return <V extends Shape<T>>(messages: V): Shape<T> & V => messages
}

/** Every dotted path to a message, so a typo in `msg('…')` is a type error. */
export type MessageKey = LeafPaths<typeof catalog.en>

type LeafPaths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPaths<T[K]>}` }[keyof T & string]

export type MessageValues = Record<string, string | number>

let active: Locale = DEFAULT_LOCALE

/**
 * The locale the display layer formats with. Set by whoever owns the viewer's
 * preference (the dashboard's language switcher); pure helpers like `formatUsd`
 * read it so a caller does not have to thread a locale through every call.
 */
export function setActiveLocale(locale: Locale): void {
  active = locale
}

export function activeLocale(): Locale {
  return active
}

/**
 * Fold a browser or system tag onto a locale we actually have messages for.
 * Underscores are normalised because `Intl` and some platforms emit `zh_Hans`
 * where BCP-47 says `zh-Hans`; `zh-Hant` lands on the Simplified table rather
 * than on English, since readable-again is the better failure.
 */
export function localeFor(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const t = tag.toLowerCase().replace(/_/g, '-')
  if (t === 'en' || t.startsWith('en-')) return 'en'
  if (t === 'zh' || t.startsWith('zh-')) return 'zh'
  return null
}

/** Fold a browser or system tag onto a locale we actually have messages for. */
export function resolveLocale(tags: readonly string[]): Locale {
  for (const tag of tags) if (localeFor(tag)) return localeFor(tag)!
  return DEFAULT_LOCALE
}

function lookup(locale: Locale, key: string): string | undefined {
  let node: unknown = catalog[locale]
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

const compiled = new Map<string, IntlMessageFormat>()

function formatter(locale: Locale, key: string, source: string): IntlMessageFormat {
  const id = `${locale}\u0000${source}`
  let cached = compiled.get(id)
  if (!cached) {
    cached = new IntlMessageFormat(source, locale)
    compiled.set(id, cached)
  }
  return cached
}

/**
 * Format one message for one locale. Falls back to the default locale, then to
 * the key itself, so a missing string degrades to something inspectable on
 * screen instead of blanking a card.
 */
export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const source = lookup(locale, key) ?? lookup(DEFAULT_LOCALE, key)
  if (source === undefined) return key
  return String(formatter(locale, key, source).format(values))
}

/** Format with the locale the display layer is currently using. */
export function msg(key: MessageKey, values?: MessageValues): string {
  return translate(active, key, values)
}

/** The whole catalog, for the compile-every-message guard and the locale loader. */
export function messageEntries(): { locale: Locale; key: string; source: string }[] {
  const out: { locale: Locale; key: string; source: string }[] = []
  for (const locale of locales) {
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        out.push({ locale, key: path, source: node })
        return
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k)
      }
    }
    walk(catalog[locale], '')
  }
  return out
}
