<script lang="ts">
  // GET /api/models: the price-gap surface (§8/§11). `priced: null` means pricing is
  // not configured in this build, which must NOT be shown as "unpriced"; an unpriced
  // model's cost is n/a, never $0.
  import { api, type ModelRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatDate, formatDateTime } from '../lib/format.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable, { type Column } from '../components/ui/DataTable.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  /** Unpriced models named inline in the alert; the full list sits in its own card. */
  const ALERT_NAMES = 5

  const q = loader(() => api.models(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  const modelKey = (provider: string, model: string) => `${provider}::${model}`

  // `unpriced` drives the alert and the list below, so a model in it must never read
  // "Priced" in the table, whatever its own flag says; the page would contradict itself.
  const unpricedKeys = $derived(new Set((d?.unpriced ?? []).map((u) => modelKey(u.provider, u.model))))
  const gapNames = $derived((d?.unpriced ?? []).slice(0, ALERT_NAMES).map((u) => u.model).join(', '))
  type Price = 'priced' | 'unpriced' | 'unconfigured' | 'no-model'
  function priceOf(m: ModelRow): Price {
    if (!m.model) return 'no-model'
    if (m.priced === null) return 'unconfigured'
    return m.priced && !unpricedKeys.has(modelKey(m.provider, m.model)) ? 'priced' : 'unpriced'
  }

  const columns: Column[] = [
    { key: 'model', label: 'Model', width: '28%' },
    { key: 'provider', label: 'Provider', width: '13%' },
    { key: 'events', label: 'Events', align: 'right', width: '10%' },
    { key: 'sessions', label: 'Sessions', align: 'right', width: '10%' },
    { key: 'tokens', label: 'Tokens', align: 'right', width: '10%', info: 'Counted once per request, then summed (§3.1).' },
    {
      key: 'cost',
      label: 'Est. cost',
      align: 'right',
      width: '12%',
      info: "Each day's tokens × that day's list price. n/a when the model has no price — never $0.",
    },
    {
      key: 'price',
      label: 'Price',
      width: '17%',
      info: 'Whether the price table covers this model at its last-seen date. “Not configured” means no price table is loaded at all.',
    },
  ]
</script>

<PageHeader
  title="Models"
  description="Tokens and estimated cost per model, and which models are missing a price."
  info="Est. cost is tokens × list price. A model with no price shows n/a, never $0 (§8)."
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Loading models" />
{:else}
  {#if q.state.status === 'error' || !d.pricingConfigured || d.unpriced.length}
    <div class="mb-4 space-y-2">
      {#if q.state.status === 'error'}
        <Alert tone="red" title="Refresh failed.">{q.state.error} — showing the last good numbers.</Alert>
      {/if}
      {#if !d.pricingConfigured}
        <Alert tone="neutral" title="Pricing not configured.">
          No price table is loaded, so est. and actual cost show n/a everywhere. Run <span class="nums">agentlens pricing update</span> to fetch one.
        </Alert>
      {/if}
      {#if d.unpriced.length}
        {@const n = d.unpriced.length}
        <Alert tone="orange" title="Pricing gap.">
          {n === 1 ? '1 model has' : `${formatInt(n)} models have`} no price at {n === 1 ? 'its' : 'their'} last-seen date, so {n === 1 ? 'its' : 'their'} cost shows n/a:
          <span class="nums">{gapNames}</span>{#if n > ALERT_NAMES}{' '}and {formatInt(n - ALERT_NAMES)} more, listed below{/if}.
        </Alert>
      {/if}
    </div>
  {/if}

  <Surface padded={false}>
    <div class="overflow-x-auto rounded-card">
      <div class="min-w-[720px]">
        <DataTable {columns} rows={d.rows} key={(m: ModelRow) => modelKey(m.provider, m.model)} caption="Models" empty="No model activity in this window">
          {#snippet row(m: ModelRow)}
            {@const price = priceOf(m)}
            {#if m.model}
              <td class="nums font-medium text-ink" title={m.model}>{m.model}</td>
            {:else}
              <td class="text-ink-3" title="Events recorded without a model, such as tool calls and lifecycle events">(no model)</td>
            {/if}
            <td class={m.provider ? 'text-ink-2' : 'text-ink-3'} title={m.provider || undefined}>{m.provider || '—'}</td>
            <td class="nums text-right">{formatInt(m.events)}</td>
            <td class="nums text-right">{formatInt(m.sessions)}</td>
            <td class="nums text-right" title={formatInt(m.tokensTotal)}>{formatCompact(m.tokensTotal)}</td>
            <td class="text-right"><CostFigure value={m.costApiEquiv} basis="est" showLabel={false} /></td>
            <td>
              {#if price === 'priced'}
                <Chip tone="green" dot>Priced</Chip>
              {:else if price === 'unpriced'}
                <Chip tone="orange" dot title="No price at this model's last-seen date, so its cost shows n/a, never $0.">Unpriced</Chip>
              {:else if price === 'unconfigured'}
                <Chip dashed title="No price table is loaded, so no model can be priced.">Not configured</Chip>
              {:else}
                <Chip dashed title="There is no model on these events, so there is nothing to price.">No model</Chip>
              {/if}
            </td>
          {/snippet}
        </DataTable>
      </div>
    </div>
  </Surface>
  {#if d.truncated}
    <p class="mt-3 text-xs text-ink-3">Showing the first {formatInt(d.rows.length)} {d.rows.length === 1 ? 'model' : 'models'}. Narrow the range or agent to see the rest.</p>
  {/if}

  {#if d.unpriced.length}
    <div class="mt-4">
      <Surface
        title="Unpriced models"
        subtitle="No price at their last-seen date, so their cost shows n/a, never $0"
        info="Checked against the price table at each model's last-seen date (§8), so this can include models outside the selected window."
      >
        <ul class="max-h-72 divide-y divide-line-soft overflow-y-auto">
          {#each d.unpriced as u (modelKey(u.provider, u.model))}
            <li class="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
              <span class="min-w-0 truncate text-[13px]" title="{u.model} · {u.provider}">
                <span class="nums text-ink">{u.model}</span>
                <span class="text-ink-3">· {u.provider || '—'}</span>
              </span>
              <span class="shrink-0 text-xs text-ink-3" title={u.lastSeen ? formatDateTime(u.lastSeen) : undefined}>
                Last seen <span class="nums">{formatDate(u.lastSeen)}</span>
              </span>
            </li>
          {/each}
        </ul>
      </Surface>
    </div>
  {/if}
{/if}
