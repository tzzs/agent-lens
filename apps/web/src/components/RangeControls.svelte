<script lang="ts">
  // The global filter bar. Only sends the §7 querystring names the server validates
  // (since/agent/host); it never computes anything itself.
  import { SINCE_OPTIONS, range } from '../lib/filter.svelte.js'
  import { options } from '../lib/live.svelte.js'

  const sel = 'rounded-md border border-line bg-ink-850 px-2.5 py-1.5 text-xs text-mist-100 outline-none focus:border-signal'
</script>

<div class="flex flex-wrap items-center gap-2">
  <label class="flex items-center gap-1.5 text-[11px] text-mist-500">
    <span>range</span>
    <select class={sel} bind:value={range.since}>
      {#each SINCE_OPTIONS as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  </label>

  <label class="flex items-center gap-1.5 text-[11px] text-mist-500">
    <span>agent</span>
    <select class={sel} bind:value={range.agent}>
      <option value="">all agents</option>
      {#each options.agents as a (a.agentId)}
        <option value={a.agentId}>{a.displayName || a.agentId}</option>
      {/each}
    </select>
  </label>

  <label class="flex items-center gap-1.5 text-[11px] text-mist-500">
    <span>host</span>
    <select class={sel} bind:value={range.host}>
      <option value="">all hosts</option>
      {#each options.hosts as h (h)}
        <option value={h}>{h}</option>
      {/each}
    </select>
  </label>
</div>
