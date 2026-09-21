<script lang="ts">
  // Horizontal bar list: used for capability types & other ranked breakdowns where
  // a donut would be too small to read the labels.
  let {
    rows = [],
    format = (n: number) => String(n),
    color = '#7aa2f7',
    emptyText = 'no data in range',
  }: {
    rows?: { label: string; value: number; note?: string; color?: string }[]
    format?: (n: number) => string
    color?: string
    emptyText?: string
  } = $props()

  const max = $derived(Math.max(0, ...rows.map((r) => r.value)))
</script>

{#if rows.length === 0}
  <div class="py-6 text-center text-xs text-mist-500">{emptyText}</div>
{:else}
  <ul class="space-y-1.5">
    {#each rows as r (r.label)}
      <li>
        <div class="flex items-baseline justify-between gap-3 text-xs">
          <span class="truncate text-mist-300" title={r.label}>{r.label}</span>
          <span class="nums shrink-0 text-mist-100">{format(r.value)}</span>
        </div>
        <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
          <div class="h-full rounded-full" style="width:{max === 0 ? 0 : (r.value / max) * 100}%;background:{r.color ?? color}"></div>
        </div>
        {#if r.note}<div class="mt-0.5 text-[10px] text-mist-500">{r.note}</div>{/if}
      </li>
    {/each}
  </ul>
{/if}
