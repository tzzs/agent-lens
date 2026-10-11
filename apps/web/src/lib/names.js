// People-facing names for agent and host ids. The ids stay the data (filters, URLs,
// search all use them); these only decide what is printed. Both read the shared
// options store, so a template that calls them re-renders once the directory loads.
// Plain JS with JSDoc, like the other modules that read a `.svelte.js` store.
import { msg } from '@agentlens/i18n'
import { options } from './live.svelte.js'
import { SERIES } from './eventKinds.ts'

/**
 * "Claude Code" for `claude-code`, from the adapter's own name; the id until it is known.
 * @param {string} id
 * @returns {string}
 */
export function agentLabel(id) {
  return options.agents.find((a) => a.agentId === id)?.displayName || id
}

/**
 * "Claude Desktop" for `claude-desktop`; a host the adapter does not name stays its id.
 * @param {string} host
 * @returns {string}
 */
export function hostLabel(host) {
  return options.hostLabels[host] ?? host
}

const CAPABILITY_KEYS = {
  tool: 'capabilities.typeTool',
  skill: 'capabilities.typeSkill',
  mcp: 'capabilities.typeMcp',
  plugin: 'capabilities.typePlugin',
  connector: 'capabilities.typeConnector',
  command: 'capabilities.typeCommand',
  subagent: 'capabilities.typeSubagent',
  hook: 'capabilities.typeHook',
}

/**
 * "MCP 服务器" / "Tools" for a capability type id; an unknown type keeps its id. Reads the
 * catalog's active locale, like format.ts: the page remounts when the language changes.
 * @param {string} type
 * @returns {string}
 */
export function capabilityLabel(type) {
  const key = /** @type {Record<string, import('@agentlens/i18n').MessageKey>} */ (CAPABILITY_KEYS)[type]
  return key ? msg(key) : type
}

/**
 * Unpriced models as one list. A name that appears under two providers (GLM-5.3-Flash via
 * two plan accounts) is printed as provider/model, so the two entries can be told apart.
 * @param {{ provider: string, model: string }[]} models
 * @returns {string}
 */
export function modelList(models) {
  /** @type {Record<string, number>} */
  const seen = {}
  for (const m of models) seen[m.model] = (seen[m.model] ?? 0) + 1
  return models.map((m) => ((seen[m.model] ?? 0) > 1 && m.provider ? `${m.provider}/${m.model}` : m.model)).join(', ')
}

/**
 * One colour per agent, the same on every page: slot = the agent's place among every
 * agent the directory knows, sorted by id. Rank-based colours (the donut's old
 * "biggest first") repainted an agent whenever the window changed which one was largest.
 * @param {string} id
 * @returns {string}
 */
export function agentColor(id) {
  const ids = options.agents.map((a) => a.agentId).sort()
  const i = ids.indexOf(id)
  return i < 0 ? 'var(--cat-muted)' : SERIES[i % SERIES.length] ?? 'var(--cat-muted)'
}
