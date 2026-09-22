// Theme preference: 'system' follows prefers-color-scheme live; 'light'/'dark'
// pin it. index.html applies the stored choice before first paint; this module
// owns every change after mount. localStorage is a per-viewer convenience only,
// so every access is guarded (private windows can throw).

const KEY = 'agl-theme'

/** @returns {'system' | 'light' | 'dark'} */
function readPref() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** @type {{ pref: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }} */
export const theme = $state({ pref: readPref(), resolved: 'light' })

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function apply() {
  const dark = theme.pref === 'dark' || (theme.pref === 'system' && !!media?.matches)
  theme.resolved = dark ? 'dark' : 'light'
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', theme.resolved)
}

/** @param {'system' | 'light' | 'dark'} pref */
export function setTheme(pref) {
  theme.pref = pref
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    /* preference just won't persist */
  }
  apply()
}

export function initTheme() {
  apply()
  const onChange = () => {
    if (theme.pref === 'system') apply()
  }
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
