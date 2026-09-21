/**
 * `@agentlens/web` public entry.
 *
 * The web package is a built SPA (apps/web/dist served by packages/server), so
 * this barrel only re-exports the transport/format layer the components share.
 * No DOM is touched here — the reactive/DOM code lives entirely in `.svelte`
 * components, which keeps this file valid under the root (non-DOM) TypeScript
 * program as well as under apps/web's own tsconfig.
 */
export * from './api.ts'
export * from './format.ts'
