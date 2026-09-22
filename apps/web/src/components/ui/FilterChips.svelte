<script lang="ts">
  // Beautiful UI filter-table chips: pill toggles with an optional colour dot and
  // count. Single-select (with an implicit "All") or multi-select.
  type Opt = { key: string; label: string; count?: number; dot?: string }
  let {
    options,
    selected = $bindable([]),
    multiple = false,
    allLabel = 'All',
    label = 'Filter',
  }: { options: Opt[]; selected?: string[]; multiple?: boolean; allLabel?: string; label?: string } = $props()

  function toggle(k: string) {
    if (multiple) selected = selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]
    else selected = selected[0] === k ? [] : [k]
  }
  const total = $derived(options.reduce((a, o) => a + (o.count ?? 0), 0))
</script>

<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
  <button
    type="button"
    class="chip"
    aria-pressed={selected.length === 0}
    onclick={() => (selected = [])}
  >{allLabel}{#if total}<span class="nums count">{total.toLocaleString('en')}</span>{/if}</button>
  {#each options as o (o.key)}
    <button type="button" class="chip" aria-pressed={selected.includes(o.key)} onclick={() => toggle(o.key)}>
      {#if o.dot}<span class="h-1.5 w-1.5 rounded-full" style="background:{o.dot}"></span>{/if}
      {o.label}
      {#if o.count !== undefined}<span class="nums count">{o.count.toLocaleString('en')}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-2);
    background: var(--surface);
    box-shadow: var(--shadow-btn);
    transition: background-color 0.12s, color 0.12s;
  }
  .chip:hover {
    color: var(--ink);
    background: var(--hover);
  }
  .chip[aria-pressed='true'] {
    color: var(--ink);
    background: var(--hover-2);
    box-shadow: 0 0 0 1px var(--line-strong);
  }
  .count {
    font-size: 11px;
    color: var(--ink-3);
  }
</style>
