// Hash router. Hand-rolled so the SPA needs no routing dependency (and no
// network). Hash routing was chosen deliberately: packages/server/static.ts only
// rewrites non-/api paths to index.html as a fallback, and a hash never hits the
// server, so deep links and refreshes resolve client-side regardless of how the
// static fallback is configured. `window` access is guarded for SSR-safety of the
// module import (there is no SSR here, but the guard keeps it side-effect free).

function readPath() {
  if (typeof window === 'undefined') return '/'
  const h = window.location.hash.replace(/^#/, '')
  return h.length ? h : '/'
}

export const route = $state({ path: readPath() })

export function navigate(path) {
  if (typeof window === 'undefined') return
  const target = path.startsWith('#') ? path.slice(1) : path
  if (window.location.hash.replace(/^#/, '') !== target) window.location.hash = target
  else route.path = target
}

export function initRouter() {
  if (typeof window === 'undefined') return () => {}
  const onHash = () => {
    route.path = readPath()
  }
  window.addEventListener('hashchange', onHash)
  onHash()
  return () => window.removeEventListener('hashchange', onHash)
}

/** Split the current hash path into [name, ...segments], dropping empty parts. */
export function segments() {
  return route.path.split('/').filter((s) => s !== '')
}
