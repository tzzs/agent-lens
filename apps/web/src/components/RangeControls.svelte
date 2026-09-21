<script lang="ts">
  // The global filter bar. Only sends the §7 querystring names the server validates
  // (since/agent/host); it never computes anything itself.
  import { SINCE_OPTIONS, range } from '../lib/filter.svelte.js'
  import { options } from '../lib/live.svelte.js'
  import Segmented from './ui/Segmented.svelte'

  const SHORT: Record<string, string> = { '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d', '365d': '1y' }
  const sel =
    'h-7 max-w-40 truncate rounded-full bg-surface pl-3 pr-7 text-xs text-ink shadow-btn outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent appearance-none bg-no-repeat'
  const chevron =
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\");background-position:right 9px center"
</script>

<div class="flex items-center gap-2">
  <Segmented label="Time range" bind:value={range.since} options={SINCE_OPTIONS.map((o) => ({ value: o.value, label: SHORT[o.value] ?? o.label }))} />

  <select class={sel} style={chevron} bind:value={range.agent} aria-label="Agent">
    <option value="">All agents</option>
    {#each options.agents as a (a.agentId)}
      <option value={a.agentId}>{a.displayName || a.agentId}</option>
    {/each}
  </select>

  <select class={sel} style={chevron} bind:value={range.host} aria-label="Host">
    <option value="">All hosts</option>
    {#each options.hosts as h (h)}
      <option value={h}>{h}</option>
    {/each}
  </select>
</div>
