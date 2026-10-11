<script lang="ts">
  // GET /api/models: the price-gap surface (§8/§11). `priced: null` means pricing is
  // not configured in this build, which must NOT be shown as "unpriced"; an unpriced
  // model's cost is n/a, never $0.
  import { api, type ModelRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams, rangeKey, granularity } from '../lib/filter.svelte.js'
  import { pivotSeries } from '../lib/series.ts'
  import { SERIES } from '../lib/eventKinds.ts'
  import { formatUsd } from '../lib/format.ts'
  import type { MessageKey } from '@agentlens/i18n'
  import Donut from '../components/charts/Donut.svelte'
  import Bars from '../components/charts/Bars.svelte'
  import StackedTrend from '../components/charts/StackedTrend.svelte'
  import { href } from '../lib/router.svelte.js'
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
    void rangeKey()
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  // Charts group by model NAME (the cube's `model` dim): one model served by two providers
  // is one line. Its colour is its slot by tokens in this window, the same slot in all
  // three charts, so a model is the same hue wherever it appears on the page.
  const gran = $derived(granularity())
  const trendQ = loader(() => api.query({ ...filterParams(), metrics: 'tokens_total', dims: `${gran},model`, limit: 5000 }))
  $effect(() => {
    void rangeKey()
    void live.lastTick
    trendQ.run()
  })
  const byName = $derived.by(() => {
    const m = new Map<string, { tokens: number; cost: number | null; priced: boolean }>()
    for (const r of d?.rows ?? []) {
      if (!r.model) continue
      const cur = m.get(r.model) ?? { tokens: 0, cost: 0, priced: true }
      cur.tokens += r.tokensTotal
      if (r.costApiEquiv === null) cur.priced = false
      else cur.cost = (cur.cost ?? 0) + r.costApiEquiv
      m.set(r.model, cur)
    }
    return [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.tokens - a.tokens)
  })
  const TOP = 6
  const colorOf = $derived.by(() => {
    const slots = new Map(byName.slice(0, TOP - 1).map((m, i) => [m.name, SERIES[i % SERIES.length]!]))
    return (name: string) => slots.get(name) ?? 'var(--cat-muted)'
  })
  const tokenSlices = $derived(
    byName.map((m) => ({ label: m.name, value: m.tokens, color: colorOf(m.name), href: href('/sessions', { model: m.name }) })),
  )
  // Unpriced models stay out of the cost chart: their cost is unknown, and a bar at $0
  // would say "free". The subtitle counts what was left out.
  const costBars = $derived(
    byName
      .filter((m) => m.priced && (m.cost ?? 0) > 0)
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
      .slice(0, 8)
      .map((m) => ({ label: m.name, value: m.cost ?? 0, color: colorOf(m.name) })),
  )
  const unpricedCount = $derived(byName.filter((m) => !m.priced && m.tokens > 0).length)
  const GRAN_KEYS: Record<string, MessageKey> = { day: 'common.granDay', week: 'common.granWeek', month: 'common.granMonth' }
  const trend = $derived.by(() => {
    const p = pivotSeries(trendQ.state.data?.rows ?? [], gran, 'model', 'tokens_total', TOP)
    return {
      buckets: p.buckets.map((b) => b.slice(0, 10)),
      series: p.series.map((s) => ({
        key: s.key,
        label: s.other ? $t('viz.other') : s.key,
        color: s.other ? 'var(--cat-muted)' : colorOf(s.key),
        values: s.values,
        total: s.total,
      })),
    }
  })

  const modelKey = (provider: string, model: string) => `${provider}::${model}`

  // `unpriced` drives the alert and the list below, so a model in it must never read
  // "Priced" in the table, whatever its own flag says; the page would contradict itself.
  const unpricedKeys = $derived(new Set((d?.unpriced ?? []).map((u) => modelKey(u.provider, u.model))))
  const gapNames = $derived((d?.unpriced ?? []).slice(0, ALERT_NAMES).map((u) => u.model).join(', '))

  /**
   * §8: not every price in the table is the same kind of number. `litellm` is the vendor list
   * price this column means, so it carries no mark; the others are a reseller route price or
   * the user's own pinned figure, and letting a row silently carry one would make the $ column
   * read more authoritative than it is. Words come from the catalog; only the source names are
   * data.
   */
  const MARKS = $derived.by(() => ({
    openrouter: { label: $t('models.chipViaOpenRouter'), title: $t('models.chipViaOpenRouterTitle') },
    override: { label: $t('models.chipPinned'), title: $t('models.chipPinnedTitle') },
    manual: { label: $t('models.chipPinned'), title: $t('models.chipPinnedTitle') },
  }))
  const provenanceFor = (source: ModelRow['priceSource']) =>
    source === 'openrouter' || source === 'override' || source === 'manual' ? MARKS[source] : undefined
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
      info: $t('models.colPriceInfo', {
        values: { chip: $t('models.chipUnconfigured'), via: $t('models.chipViaOpenRouter'), pinned: $t('models.chipPinned') },
      }),
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
          {' '}{$t('models.pricingGapFallbackLead')} <span class="nums">agentlens pricing update --source openrouter</span> {$t('models.pricingGapFallbackTail')}
        </Alert>
      {/if}
    </div>
  {/if}

  <div class="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
    <Surface
      title={$t('models.trendTitle')}
      subtitle={$t('models.trendSubtitle', { values: { gran: GRAN_KEYS[gran] ? $t(GRAN_KEYS[gran]) : gran } })}
      class="xl:col-span-2"
    >
      <StackedTrend buckets={trend.buckets} series={trend.series} format={formatCompact} label={$t('models.trendTitle')} />
    </Surface>
    <Surface title={$t('models.shareTitle')} subtitle={$t('models.shareSubtitle')}>
      <Donut data={tokenSlices} max={TOP} format={formatCompact} label={$t('models.shareTitle')} />
    </Surface>
    <Surface
      title={$t('models.costTitle')}
      subtitle={unpricedCount ? $t('models.costSubtitleGap', { values: { n: unpricedCount } }) : $t('models.costSubtitle')}
      class="xl:col-span-3"
    >
      <Bars rows={costBars} format={(n) => formatUsd(n)} />
    </Surface>
  </div>

  <Surface padded={false}>
    <div class="overflow-x-auto rounded-card">
      <div class="min-w-[720px]">
        <DataTable {columns} rows={d.rows} key={(m: ModelRow) => modelKey(m.provider, m.model)} caption={$t('models.title')} empty={$t('models.empty')}>
          {#snippet row(m: ModelRow)}
            {@const price = priceOf(m)}
            {@const prov = price === 'priced' ? provenanceFor(m.priceSource) : undefined}
            {#if m.model}
              <td class="nums font-medium" title={$t('models.viewSessionsTitle', { values: { model: m.model } })}>
                <a href={href('/sessions', { model: m.model, provider: m.provider || undefined })} class="text-ink hover:text-accent hover:underline">{m.model}</a>
              </td>
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
                <span class="inline-flex flex-wrap items-center gap-1.5">
                  <Chip tone="green" dot>{$t('models.chipPriced')}</Chip>
                  {#if prov}<Chip dashed title={prov.title}>{prov.label}</Chip>{/if}
                </span>
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
