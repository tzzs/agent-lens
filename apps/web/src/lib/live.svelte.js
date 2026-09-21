// Live SSE state (shared) + discovered filter options (shared). Both are plain
// Svelte-5 module state so App writes them and any page can depend on them.
// `live.lastTick` bumping is what tells pages to refetch; `connected` drives the
// header indicator. Neither holds statistics — only the transport signal.

export const live = $state({
  connected: false,
  events: 0,
  maxTimestamp: null,
  lastTick: 0,
  serverTime: null,
})

export const options = $state({
  agents: [], // { agentId, displayName }
  hosts: [], // string[]
})
