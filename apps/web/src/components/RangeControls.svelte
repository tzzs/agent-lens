<script lang="ts">
  // The global filter bar. Only sends the §7 querystring names the server validates
  // (since/until/agent/host, through filterParams); it never computes anything itself.
  import { SINCE_OPTIONS, range } from '../lib/filter.svelte.js'
  import { options } from '../lib/live.svelte.js'
  import { CUSTOM, isoDay, validCustom } from '../lib/window.ts'
  import { t } from '../lib/lang.js'
  import Segmented from './ui/Segmented.svelte'

  // Display-only pills: the value sent to the server stays the option key, so a locale
  // may widen "24h" into "24 小时" without changing the query.
  const SHORT = $derived<Record<string, string>>({
    '24h': $t('comps.range24h'),
    '7d': $t('comps.range7d'),
    '30d': $t('comps.range30d'),
    '90d': $t('comps.range90d'),
    '365d': $t('comps.range1y'),
    all: $t('comps.rangeAll'),
    custom: $t('comps.rangeCustom'),
  })

  // Choosing "Custom" with no range yet starts from the last 30 days, so the window the
  // viewer was looking at does not jump; the dates are then theirs to move.
  $effect(() => {
    if (range.since !== CUSTOM || validCustom(range.from, range.to)) return
    const today = Date.now()
    range.to = isoDay(today)
    range.from = isoDay(today - 29 * 86_400_000)
  })
  const invalid = $derived(range.since === CUSTOM && range.from !== '' && range.to !== '' && !validCustom(range.from, range.to))

  const sel =
    'h-7 max-w-44 truncate rounded-full bg-surface pl-3 pr-7 text-xs text-ink shadow-btn outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent appearance-none bg-no-repeat transition-colors'
  const chevron =
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\");background-position:right 9px center"
  const date =
    'nums h-7 rounded-full bg-surface px-3 text-xs text-ink shadow-btn outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent'
</script>

<div class="flex flex-wrap items-center gap-2">
  <Segmented label={$t('comps.rangeTitle')} bind:value={range.since} options={SINCE_OPTIONS.map((o) => ({ value: o.value, label: SHORT[o.value] ?? o.label }))} />

  {#if range.since === CUSTOM}
    <div class="range-dates flex items-center gap-1.5" role="group" aria-label={$t('comps.rangeCustom')}>
      <input id="range-from" type="date" class={date} bind:value={range.from} max={range.to || undefined} aria-label={$t('comps.rangeFrom')} aria-invalid={invalid} />
      <span class="text-xs text-ink-3" aria-hidden="true">–</span>
      <input id="range-to" type="date" class={date} bind:value={range.to} min={range.from || undefined} aria-label={$t('comps.rangeTo')} aria-invalid={invalid} />
      {#if invalid}<span class="text-xs text-red" role="alert">{$t('comps.rangeInvalid')}</span>{/if}
    </div>
  {/if}

  <select class={sel} style={chevron} bind:value={range.agent} aria-label={$t('comps.agent')}>
    <option value="">{$t('comps.allAgents')}</option>
    {#each options.agents as a (a.agentId)}
      <option value={a.agentId}>{a.displayName || a.agentId}</option>
    {/each}
  </select>

  <!-- Only agents with more than one real host are listed: a host that just repeats its
       agent's id is the agent itself, which is what made this menu look like a second
       agent menu. Kept visible while a host is selected so the choice can be cleared. -->
  {#if options.hostGroups.length || range.host}
    <select class={sel} style={chevron} bind:value={range.host} aria-label={$t('comps.host')}>
      <option value="">{$t('comps.allHosts')}</option>
      {#each options.hostGroups as g (g.agentId)}
        <optgroup label={g.label}>
          {#each g.hosts as h (h.host)}<option value={h.host}>{h.label}</option>{/each}
        </optgroup>
      {/each}
    </select>
  {/if}
</div>

<style>
  .range-dates {
    animation: range-in 180ms ease-out;
  }
  @keyframes range-in {
    from {
      opacity: 0;
      transform: translateX(-4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .range-dates {
      animation: none;
    }
  }
</style>
