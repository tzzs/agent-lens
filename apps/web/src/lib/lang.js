// @ts-check
/**
 * The viewer's language: a preference ('system' | 'en' | 'zh'), the locale it
 * resolves to, and `t` — the one formatter every component renders strings
 * through.
 *
 * `t` is a *store* of a function, not a function, so that `$t('nav.overview')`
 * re-renders when the language changes; its key argument is typed against the
 * catalog, which is what stops a renamed message from quietly printing its own
 * name. svelte-i18n owns the reactive locale and `@agentlens/i18n` owns the
 * words; `activeLocale` there is kept in step so the pure display helpers
 * (`lib/format.ts`, which cannot subscribe to anything) agree with the screen.
 *
 * localStorage is a per-viewer convenience, so every access is guarded — a
 * private window can throw. Same contract as `lib/theme.svelte.js`.
 */
import { derived, get, writable } from 'svelte/store'
import { addMessages, init as initI18n, locale as i18nLocale, _ } from 'svelte-i18n'
import { catalog, DEFAULT_LOCALE, resolveLocale, setActiveLocale } from '@agentlens/i18n'

const KEY = 'agl-lang'

/** @typedef {'system' | 'en' | 'zh'} LangPref */

/** @returns {LangPref} */
function readPref() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'en' || v === 'zh' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** The browser's own tags, best first. */
function systemTags() {
  if (typeof navigator === 'undefined') return []
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
  return list.filter((tag) => !!tag)
}

/** @param {LangPref} pref */
function resolve(pref) {
  return pref === 'system' ? resolveLocale(systemTags()) : pref
}

/** @type {import('svelte/store').Writable<LangPref>} */
export const pref = writable(readPref())

/**
 * A bump signal for `languagechange`. Without it a 'system' reader who changes
 * the browser language mid-session would keep the old locale until reload,
 * because writing the same preference back changes nothing.
 * @type {import('svelte/store').Writable<number>}
 */
const systemTick = writable(0)

/** The locale actually on screen: 'en' or 'zh', never 'system'. */
export const code = derived([pref, systemTick], ([$pref]) => resolve($pref))

addMessages('en', /** @type {any} */ (catalog.en))
addMessages('zh', /** @type {any} */ (catalog.zh))
initI18n({ fallbackLocale: DEFAULT_LOCALE, initialLocale: get(code) })

code.subscribe((c) => {
  setActiveLocale(c)
  i18nLocale.set(c)
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', c)
})

/**
 * `$_` from svelte-i18n, narrowed so a key must exist in the catalog. The cast
 * is the price of the compile error on every mistyped key in 40 components.
 * @type {import('svelte/store').Readable<(key: import('@agentlens/i18n').MessageKey, options?: { values?: import('@agentlens/i18n').MessageValues }) => string>}
 */
export const t = /** @type {any} */ (_)

/** @param {LangPref} next */
export function setLang(next) {
  pref.set(next)
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    /* preference just won't persist */
  }
}

export function initLang() {
  /** @type {EventListener} */
  const onLanguageChange = () => systemTick.update((n) => n + 1)
  if (typeof window !== 'undefined') window.addEventListener('languagechange', onLanguageChange)
  return () => {
    if (typeof window !== 'undefined') window.removeEventListener('languagechange', onLanguageChange)
  }
}
