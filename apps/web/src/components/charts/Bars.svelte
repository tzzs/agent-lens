<script lang="ts">
  // Horizontal bar list: ranked breakdowns where a donut would be too small to
  // read the labels.
  let {
    rows = [],
    format = (n: number) => String(n),
    color = 'var(--cat-1)',
    emptyText = 'No data in range',
  }: {
    rows?: { label: string; value: number; note?: string; color?: string }[]
    format?: (n: number) => string
    color?: string
    emptyText?: string
  } = $props()

  const max = $derived(Math.max(0, ...rows.map((r) => r.value)))
</script>

{#if rows.length === 0}
  <div class="py-6 text-center text-xs text-ink-3">{emptyText}</div>
{:else}
  <ul class="space-y-2.5">
    {#each rows as r (r.label)}
      <li>
        <div class="flex items-baseline justify-between gap-3 text-[13px]">
          <span class="truncate text-ink-2" title={r.label}>{r.label}</span>
          <span class="flex shrink-0 items-baseline gap-2">
            {#if r.note}<span class="text-xs text-ink-3">{r.note}</span>{/if}
            <span class="nums text-ink">{format(r.value)}</span>
          </span>
        </div>
        <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hover-2" aria-hidden="true">
          <div class="h-full rounded-full" style="width:{max === 0 ? 0 : Math.max(1, (r.value / max) * 100)}%;background:{r.color ?? color}"></div>
        </div>
      </li>
    {/each}
  </ul>
{/if}
