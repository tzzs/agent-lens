<script lang="ts">
  import { formatCompact, formatInt, formatMs, projectLabel, formatClock } from '../lib/format.ts'
  import { range } from '../lib/filter.svelte.js'
  import { halfOverHalf } from '../lib/series.ts'
  import type { OverviewResponse } from '../lib/api.ts'
  import type { LoaderState } from '../lib/pagestate.svelte.js'
  import type { MessageKey } from '@agentlens/i18n'
  import { t } from '../lib/lang.js'
  import Surface from '../components/ui/Surface.svelte'
  import InsightCard from '../components/ui/InsightCard.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'
  import Donut from '../components/charts/Donut.svelte'
  import Sparkline from '../components/charts/Sparkline.svelte'
  import Bars from '../components/charts/Bars.svelte'

  let { ov }: { ov: { state: LoaderState<OverviewResponse>; run: () => Promise<void> } } = $props()

  const d = $derived(ov.state.data)
  const gran = $derived(d?.window?.granularity ?? range.since ?? 'day')
  // The bucket's *name* in a sentence is translatable; the row key looked up by
  // `gran` above is a field name and is not.
  const GRAN_KEYS: Record<string, MessageKey> = { day: 'common.granDay', week: 'common.granWeek', month: 'common.granMonth' }
  const granLabel = $derived(GRAN_KEYS[gran] ? $t(GRAN_KEYS[gran]) : gran)

  const trendVals = (key: string) => (d ? d.trend.map((r) => Number(r[key] ?? 0)) : [])
  const trendLabels = $derived(d ? d.trend.map((r) => String(r[gran] ?? r.day ?? r.time ?? '').slice(0, 10)) : [])
  // An unpriced bucket stays unknown: `null` reaches the chart as a gap rather than a $0
  // point, because a day plotted at zero reads as "nothing was spent" when the truth is
  // "we could not price it" (§8). The card's headline already says n/a; the series must not contradict it.
  const costSeries = $derived<(number | null)[]>(d ? d.trend.map((r) => (r.cost_api_equiv == null ? null : Number(r.cost_api_equiv))) : [])

  const agentSlices = $derived(d ? d.agents.map((r) => ({ label: String(r.agent), value: Number(r.tokens_total ?? 0) })) : [])
  const projectSlices = $derived(
    d ? d.projects.map((r) => ({ label: projectLabel(String(r.project || '')), title: String(r.project || $t('fmt.noProject')), value: Number(r.tokens_total ?? 0) })) : [],
  )
  const capBars = $derived(
    d
      ? d.capabilities
          .map((r) => {
            const ms = Number(r.duration ?? 0)
            return { label: String(r.capability_type), value: Number(r.events ?? 0), note: ms > 0 ? $t('overview.totalNote', { values: { dur: formatMs(ms) } }) : undefined }
          })
          .sort((a, b) => b.value - a.value)
      : [],
  )
  // The activity feed arrives keyed by the API's own counter names, so a key the
  // catalog has no word for still shows up — under its raw name.
  const ACTIVITY_KEY: Record<string, MessageKey> = {
    tool: 'overview.capTool',
    skill: 'overview.capSkill',
    mcp: 'overview.capMcp',
    plugin: 'overview.capPlugin',
    connector: 'overview.capConnector',
    command: 'overview.capCommand',
    subagent: 'overview.capSubagent',
    hook: 'overview.capHook',
    compact: 'overview.capCompact',
    errors: 'overview.capErrors',
  }
  const activity = $derived(d ? Object.entries(d.activity).map(([k, v]) => [k, Number(v)] as const) : [])
</script>

<PageHeader
  title={$t('overview.title')}
  description={$t('overview.description')}
  info={$t('overview.info', { values: { gran: granLabel } })}
  refreshing={ov.state.refreshing}
>
  {#snippet actions()}
    {#if d}<span class="nums text-xs text-ink-3" title={new Date(d.generatedAt).toISOString()}>{$t('overview.updated', { values: { time: formatClock(d.generatedAt).slice(0, 8) } })}</span>{/if}
  {/snippet}
</PageHeader>

{#if !d}
  <StatePanel status={ov.state.status} error={ov.state.error} kind={ov.state.kind} since={ov.state.since} loadingText={$t('overview.loading')} />
{:else}
  {#if ov.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title={$t('states.refreshFailed')}>{ov.state.error} — {$t('states.showingLastNumbers')}</Alert></div>
  {/if}

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <InsightCard label={$t('overview.tokens')} info={d.cards.tokens.basis} delta={halfOverHalf(trendVals('tokens_total'))} deltaLabel={$t('overview.deltaInfo')}>
      <div class="nums text-[26px] font-semibold tracking-tight">{formatCompact(d.cards.tokens.total)}</div>
      {#snippet detail()}
        <dl class="nums grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {#each [[$t('viz.tokenInput'), d.cards.tokens.input], [$t('viz.tokenOutput'), d.cards.tokens.output], [$t('viz.tokenCacheRead'), d.cards.tokens.cacheRead], [$t('viz.tokenCacheWrite'), d.cards.tokens.cacheWrite], [$t('viz.tokenReasoning'), d.cards.tokens.reasoning]] as [k, v] (k)}
            <div class="flex justify-between gap-2"><dt class="whitespace-nowrap font-sans text-ink-3">{k}</dt><dd class="text-ink-2">{formatCompact(Number(v))}</dd></div>
          {/each}
        </dl>
      {/snippet}
    </InsightCard>

    <InsightCard label={$t('overview.cost')} info={$t('overview.costInfo')}>
      <CostFigure value={d.cards.cost.totalUsd} basis="actual" partial={d.cards.cost.totalPartial} size="lg" />
      {#snippet detail()}
        <div class="space-y-1 text-xs">
          <div class="flex justify-between gap-2"><span class="text-ink-3">{$t('overview.apiEquivalent')}</span><CostFigure value={d.cards.cost.apiEquivalentUsd} basis="est" partial={d.cards.cost.apiEquivalentPartial} showLabel={false} /></div>
          {#if d.cards.cost.reportedUsd !== null}
            <div class="flex justify-between gap-2"><span class="text-ink-3">{$t('overview.agentReported')}</span><CostFigure value={d.cards.cost.reportedUsd} basis="reported" showLabel={false} /></div>
          {/if}
          {#if !d.cards.cost.pricingConfigured}
            <p class="text-orange">{$t('overview.noPricing', { values: { na: $t('common.na') } })}</p>
          {:else if d.cards.cost.unpricedAgents.length}
            <p class="text-orange" title={$t('overview.noPriceForTitle')}>{$t('overview.noPriceFor', { values: { agents: d.cards.cost.unpricedAgents.join(', ') } })}</p>
          {/if}
        </div>
      {/snippet}
    </InsightCard>

    <InsightCard label={$t('overview.sessions')}>
      <div class="nums text-[26px] font-semibold tracking-tight">{formatInt(d.cards.sessions)}</div>
      {#snippet detail()}<p class="text-xs text-ink-3">{$t('overview.sessionsActive')}</p>{/snippet}
    </InsightCard>

    <InsightCard label={$t('overview.events')} info={$t('overview.eventsInfo')} delta={halfOverHalf(trendVals('events'))} deltaLabel={$t('overview.deltaInfo')}>
      <div class="nums text-[26px] font-semibold tracking-tight">{formatInt(d.cards.events)}</div>
      {#snippet detail()}<p class="text-xs text-ink-3">{$t('overview.perSessionAvg', { values: { n: formatCompact(Math.round(d.cards.events / Math.max(1, d.cards.sessions))) } })}</p>{/snippet}
    </InsightCard>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
    <Surface title={$t('overview.tokenTrend')} subtitle={$t('overview.tokenTrendSubtitle', { values: { gran: granLabel } })} class="xl:col-span-2">
      <Sparkline values={trendVals('tokens_total')} labels={trendLabels} color="var(--cat-1)" format={formatCompact} label={$t('overview.tokensPer', { values: { gran: granLabel } })} height={150} />
    </Surface>
    <Surface title={$t('overview.tokensByAgent')}>
      <Donut data={agentSlices} format={formatCompact} label={$t('overview.tokensByAgent')} />
    </Surface>

    <Surface title={$t('overview.costTrend')} subtitle={$t('overview.costTrendSubtitle', { values: { gran: granLabel } })}>
      <Sparkline values={costSeries} labels={trendLabels} color="var(--cat-3)" format={(n) => '$' + n.toFixed(2)} unknown={$t('overview.noPrice')} label={$t('overview.estCostPer', { values: { gran: granLabel } })} />
    </Surface>
    <Surface title={$t('overview.eventTrend')} subtitle={$t('overview.eventTrendSubtitle', { values: { gran: granLabel } })}>
      <Sparkline values={trendVals('events')} labels={trendLabels} color="var(--cat-4)" format={formatCompact} label={$t('overview.eventsPer', { values: { gran: granLabel } })} />
    </Surface>
    <Surface title={$t('overview.capabilityEvents')} subtitle={$t('overview.capabilityEventsSubtitle')}>
      <Bars rows={capBars} format={formatInt} />
    </Surface>

    <Surface title={$t('overview.tokensByProject')} info={$t('overview.tokensByProjectInfo')}>
      <Donut data={projectSlices} format={formatCompact} label={$t('overview.tokensByProject')} />
    </Surface>
    <Surface title={$t('overview.activityMix')} subtitle={$t('overview.activityMixSubtitle')} class="xl:col-span-2">
      <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {#each activity as [k, v] (k)}
          <div class="rounded-[10px] bg-inset px-3 py-2 ring-1 ring-line-soft">
            <dt class="text-xs capitalize text-ink-3">{ACTIVITY_KEY[k] ? $t(ACTIVITY_KEY[k]) : k}</dt>
            <dd class="nums mt-0.5 text-base font-medium {v === 0 ? 'text-ink-3' : k === 'errors' ? 'text-red' : 'text-ink'}">{formatInt(v)}</dd>
          </div>
        {/each}
      </dl>
    </Surface>
  </div>

  {#if !d.content.available}
    <div class="mt-4">
      <Alert tone="neutral">{$t('overview.contentOff')}</Alert>
    </div>
  {/if}
{/if}
