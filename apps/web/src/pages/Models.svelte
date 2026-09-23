<script lang="ts">
  // GET /api/models: the price-gap surface (§8/§11). `priced: null` means pricing is
  // not configured in this build, which must NOT be shown as "unpriced"; an unpriced
  // model's cost is n/a, never $0.
  import { api, type ModelRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatDate, formatDateTime } from '../lib/format.ts'
  import { t } from '../lib/lang.js'
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

  // Derived, not const: the headers and their tooltips are the viewer's language.
  // `n/a` comes from `common.na`, the same string `CostFigure` prints in the cell,
  // so the prose and the figure can never disagree about what the glyph says.
  const na = $derived($t('common.na'))
  const columns = $derived<Column[]>([
    { key: 'model', label: $t('models.colModel'), width: '28%' },
    { key: 'provider', label: $t('models.colProvider'), width: '13%' },
    { key: 'events', label: $t('models.colEvents'), align: 'right', width: '10%' },
    { key: 'sessions', label: $t('models.colSessions'), align: 'right', width: '10%' },
    { key: 'tokens', label: $t('models.colTokens'), align: 'right', width: '10%', info: $t('models.colTokensInfo') },
    {
      key: 'cost',
      label: $t('models.colCost'),
      align: 'right',
      width: '12%',
      info: $t('models.colCostInfo', { values: { na } }),
    },
    {
      key: 'price',
      label: $t('models.colPrice'),
      width: '17%',
      info: $t('models.colPriceInfo', { values: { chip: $t('models.chipUnconfigured') } }),
    },
  ])
</script>

<PageHeader
  title={$t('models.title')}
  description={$t('models.pageDesc')}
  info={$t('models.pageInfo', { values: { na } })}
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('models.loadingText')} />
{:else}
  {#if q.state.status === 'error' || !d.pricingConfigured || d.unpriced.length}
    <div class="mb-4 space-y-2">
      {#if q.state.status === 'error'}
        <Alert tone="red" title={$t('states.refreshFailed')}>{q.state.error} — {$t('states.showingLastNumbers')}</Alert>
      {/if}
      {#if !d.pricingConfigured}
        <Alert tone="neutral" title={$t('models.notConfiguredTitle')}>
          {$t('models.noPriceTableLead', { values: { na } })} <span class="nums">agentlens pricing update</span> {$t('models.noPriceTableTail')}
        </Alert>
      {/if}
      {#if d.unpriced.length}
        {@const n = d.unpriced.length}
        <Alert tone="orange" title={$t('models.pricingGapTitle')}>
          {$t('models.pricingGap', { values: { n: formatInt(n), na } })}
          <span class="nums">{gapNames}</span>{#if n > ALERT_NAMES}{' '}{$t('models.pricingGapMore', { values: { n: formatInt(n - ALERT_NAMES) } })}{/if}{$t('models.period')}
        </Alert>
      {/if}
    </div>
  {/if}

  <Surface padded={false}>
    <div class="overflow-x-auto rounded-card">
      <div class="min-w-[720px]">
        <DataTable {columns} rows={d.rows} key={(m: ModelRow) => modelKey(m.provider, m.model)} caption={$t('models.title')} empty={$t('models.empty')}>
          {#snippet row(m: ModelRow)}
            {@const price = priceOf(m)}
            {#if m.model}
              <td class="nums font-medium text-ink" title={m.model}>{m.model}</td>
            {:else}
              <td class="text-ink-3" title={$t('models.noModelTitle')}>{$t('models.noModel')}</td>
            {/if}
            <td class={m.provider ? 'text-ink-2' : 'text-ink-3'} title={m.provider || undefined}>{m.provider || '—'}</td>
            <td class="nums text-right">{formatInt(m.events)}</td>
            <td class="nums text-right">{formatInt(m.sessions)}</td>
            <td class="nums text-right" title={formatInt(m.tokensTotal)}>{formatCompact(m.tokensTotal)}</td>
            <td class="text-right"><CostFigure value={m.costApiEquiv} basis="est" showLabel={false} /></td>
            <td>
              {#if price === 'priced'}
                <Chip tone="green" dot>{$t('models.chipPriced')}</Chip>
              {:else if price === 'unpriced'}
                <Chip tone="orange" dot title={$t('models.chipUnpricedTitle', { values: { na } })}>{$t('models.chipUnpriced')}</Chip>
              {:else if price === 'unconfigured'}
                <Chip dashed title={$t('models.chipUnconfiguredTitle')}>{$t('models.chipUnconfigured')}</Chip>
              {:else}
                <Chip dashed title={$t('models.chipNoModelTitle')}>{$t('models.chipNoModel')}</Chip>
              {/if}
            </td>
          {/snippet}
        </DataTable>
      </div>
    </div>
  </Surface>
  {#if d.truncated}
    <p class="mt-3 text-xs text-ink-3">{$t('models.truncated', { values: { n: formatInt(d.rows.length) } })}</p>
  {/if}

  {#if d.unpriced.length}
    <div class="mt-4">
      <Surface
        title={$t('models.unpricedTitle')}
        subtitle={$t('models.unpricedSubtitle', { values: { na } })}
        info={$t('models.unpricedInfo')}
      >
        <ul class="max-h-72 divide-y divide-line-soft overflow-y-auto">
          {#each d.unpriced as u (modelKey(u.provider, u.model))}
            <li class="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
              <span class="min-w-0 truncate text-[13px]" title="{u.model} · {u.provider}">
                <span class="nums text-ink">{u.model}</span>
                <span class="text-ink-3">· {u.provider || '—'}</span>
              </span>
              <span class="shrink-0 text-xs text-ink-3" title={u.lastSeen ? formatDateTime(u.lastSeen) : undefined}>
                {$t('models.lastSeen')} <span class="nums">{formatDate(u.lastSeen)}</span>
              </span>
            </li>
          {/each}
        </ul>
      </Surface>
    </div>
  {/if}
{/if}
