<script lang="ts">
  let {
    title = '',
    subtitle = '',
    note = '',
    padded = true,
  }: { title?: string; subtitle?: string; note?: string; padded?: boolean } = $props()
</script>

<section class="rounded-card border border-line bg-ink-900/60">
  {#if title || subtitle}
    <header class="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
      <div class="min-w-0">
        <h3 class="truncate text-sm font-semibold text-mist-100">{title}</h3>
        {#if subtitle}<p class="truncate text-xs text-mist-500">{subtitle}</p>{/if}
      </div>
      {#if note}<span class="shrink-0 text-[11px] text-mist-500">{note}</span>{/if}
    </header>
  {/if}
  <div class={padded ? 'p-4' : ''}>
    <slot />
  </div>
</section>
