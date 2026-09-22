<script lang="ts">
  // Segmented control (Beautiful UI's Drive / Dots / Orbit switcher): one of N.
  import type { IconName } from './Icon.svelte'
  import Icon from './Icon.svelte'
  type Opt = { value: string; label: string; icon?: IconName }
  let {
    options,
    value = $bindable(''),
    label,
    iconOnly = false,
  }: { options: Opt[]; value?: string; label: string; iconOnly?: boolean } = $props()
</script>

<div class="inline-flex rounded-full bg-hover-2/70 p-0.5" role="radiogroup" aria-label={label}>
  {#each options as o (o.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === o.value}
      aria-label={iconOnly ? o.label : undefined}
      title={iconOnly ? o.label : undefined}
      class="inline-flex h-7 items-center gap-1.5 rounded-full text-xs font-medium transition-colors {iconOnly ? 'w-7 justify-center' : 'px-3'}
        {value === o.value ? 'bg-surface text-ink shadow-btn' : 'text-ink-3 hover:text-ink'}"
      onclick={() => (value = o.value)}
    >
      {#if o.icon}<Icon name={o.icon} size={14} />{/if}
      {#if !iconOnly}{o.label}{/if}
    </button>
  {/each}
</div>
