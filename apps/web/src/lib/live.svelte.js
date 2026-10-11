// Live SSE state (shared) + discovered filter options (shared). Both are plain
// Svelte-5 module state so App writes them and any page can depend on them.
// `live.lastTick` bumping is what tells pages to refetch; `connected` drives the
// header indicator. Neither holds statistics — only the transport signal.

/** @type {{ connected: boolean, events: number, maxTimestamp: number | null, lastTick: number, serverTime: number | null }} */
export const live = $state({
  connected: false,
  events: 0,
  maxTimestamp: null,
  lastTick: 0,
  serverTime: null,
})

/**
 * `hostGroups` lists only agents whose hosts say something the agent filter does not:
 * a single host that repeats the agent id is the agent itself, so offering it as a
 * "host" made the host menu read as a second agent menu. `hostLabels` names every host.
 * @type {{
 *   agents: { agentId: string, displayName: string | null }[],
 *   hostGroups: { agentId: string, label: string, hosts: { host: string, label: string }[] }[],
 *   hostLabels: Record<string, string>,
 * }}
 */
export const options = $state({
  agents: [],
  hostGroups: [],
  hostLabels: {},
})
