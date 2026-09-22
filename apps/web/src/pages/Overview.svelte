<script lang="ts">
  import { formatCompact, formatInt, formatMs, projectLabel, formatClock } from '../lib/format.ts'
  import { range } from '../lib/filter.svelte.js'
  import { halfOverHalf } from '../lib/series.ts'
  import type { OverviewResponse } from '../lib/api.ts'
  import type { LoaderState } from '../lib/pagestate.svelte.js'
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

  const trendVals = (key: string) => (d ? d.trend.map((r) => Number(r[key] ?? 0)) : [])
  const trendLabels = $derived(d ? d.trend.map((r) => String(r[gran] ?? r.day ?? r.time ?? '').slice(0, 10)) : [])
  // An unpriced bucket stays unknown: `null` reaches the chart as a gap rather than a $0
  // point, because a day plotted at zero reads as "nothing was spent" when the truth is
  // "we could not price it" (§8). The card's headline already says n/a; the series must not contradict it.
  const costSeries = $derived<(number | null)[]>(d ? d.trend.map((r) => (r.cost_api_equiv == null ? null : Number(r.cost_api_equiv))) : [])

  const agentSlices = $derived(d ? d.agents.map((r) => ({ label: String(r.agent), value: Number(r.tokens_total ?? 0) })) : [])
  const projectSlices = $derived(
    d ? d.projects.map((r) => ({ label: projectLabel(String(r.project || '')), title: String(r.project || '(no project)'), value: Number(r.tokens_total ?? 0) })) : [],
  )
  const capBars = $derived(
    d
      ? d.capabilities
          .map((r) => {
            const ms = Number(r.duration ?? 0)
            return { label: String(r.capability_type), value: Number(r.events ?? 0), note: ms > 0 ? `${formatMs(ms)} total` : undefined }
          })
          .sort((a, b) => b.value - a.value)
      : [],
  )
  const activity = $derived(d ? Object.entries(d.activity).map(([k, v]) => [k, Number(v)] as const) : [])
  const deltaInfo = 'Last half of the window vs its first half'
</script>

<PageHeader
  title="Overview"
  description="Tokens, cost and activity across every local agent."
  info="Tokens are de-duplicated per request_id (MAX per request, then SUM — §3.1). Trend bucket: {gran}."
  refreshing={ov.state.refreshing}
>
  {#snippet actions()}
    {#if d}<span class="nums text-xs text-ink-3" title={new Date(d.generatedAt).toISOString()}>Updated {formatClock(d.generatedAt).slice(0, 8)} UTC</span>{/if}
  {/snippet}
</PageHeader>

{#if !d}
  <StatePanel status={ov.state.status} error={ov.state.error} kind={ov.state.kind} since={ov.state.since} loadingText="Crunching the overview" />
{:else}
  {#if ov.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title="Refresh failed.">{ov.state.error} — showing the last good numbers.</Alert></div>
  {/if}

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <InsightCard label="Tokens" info={d.cards.tokens.basis} delta={halfOverHalf(trendVals('tokens_total'))} deltaLabel={deltaInfo}>
      <div class="nums text-[26px] font-semibold tracking-tight">{formatCompact(d.cards.tokens.total)}</div>
      {#snippet detail()}
        <dl class="nums grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {#each [['Input', d.cards.tokens.input], ['Output', d.cards.tokens.output], ['Cache read', d.cards.tokens.cacheRead], ['Cache write', d.cards.tokens.cacheWrite], ['Reasoning', d.cards.tokens.reasoning]] as [k, v] (k)}
            <div class="flex justify-between gap-2"><dt class="whitespace-nowrap font-sans text-ink-3">{k}</dt><dd class="text-ink-2">{formatCompact(Number(v))}</dd></div>
          {/each}
        </dl>
      {/snippet}
    </InsightCard>

    <InsightCard label="Cost" info="Actual is what the run cost: the agent's own reported figure where it logs one, otherwise priced tokens folded through its billing mode, so a subscription or local model spends $0 (§8, §18). est. is the same tokens at API list price.">
      <CostFigure value={d.cards.cost.totalUsd} basis="actual" partial={d.cards.cost.totalPartial} size="lg" />
      {#snippet detail()}
        <div class="space-y-1 text-xs">
          <div class="flex justify-between gap-2"><span class="text-ink-3">API equivalent</span><CostFigure value={d.cards.cost.apiEquivalentUsd} basis="est" partial={d.cards.cost.apiEquivalentPartial} showLabel={false} /></div>
          {#if d.cards.cost.reportedUsd !== null}
            <div class="flex justify-between gap-2"><span class="text-ink-3">Agent-reported</span><CostFigure value={d.cards.cost.reportedUsd} basis="reported" showLabel={false} /></div>
          {/if}
          {#if !d.cards.cost.pricingConfigured}
            <p class="text-orange">No price table — cost is n/a.</p>
          {:else if d.cards.cost.unpricedAgents.length}
            <p class="text-orange" title="These agents' tokens are excluded from the totals, which are therefore a floor.">No price for {d.cards.cost.unpricedAgents.join(', ')}</p>
          {/if}
        </div>
      {/snippet}
    </InsightCard>

    <InsightCard label="Sessions">
      <div class="nums text-[26px] font-semibold tracking-tight">{formatInt(d.cards.sessions)}</div>
      {#snippet detail()}<p class="text-xs text-ink-3">Active in the selected window</p>{/snippet}
    </InsightCard>

    <InsightCard label="Events" info="Metric-layer rows — every message, tool call, hook fire and lifecycle event." delta={halfOverHalf(trendVals('events'))} deltaLabel={deltaInfo}>
      <div class="nums text-[26px] font-semibold tracking-tight">{formatInt(d.cards.events)}</div>
      {#snippet detail()}<p class="text-xs text-ink-3">{formatCompact(Math.round(d.cards.events / Math.max(1, d.cards.sessions)))} per session on average</p>{/snippet}
    </InsightCard>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
    <Surface title="Token trend" subtitle="Total tokens per {gran}" class="xl:col-span-2">
      <Sparkline values={trendVals('tokens_total')} labels={trendLabels} color="var(--cat-1)" format={formatCompact} label="Tokens per {gran}" height={150} />
    </Surface>
    <Surface title="Tokens by agent">
      <Donut data={agentSlices} format={formatCompact} label="Tokens by agent" />
    </Surface>

    <Surface title="Est. cost trend" subtitle="API-equivalent $ per {gran} — an estimate, not cash">
      <Sparkline values={costSeries} labels={trendLabels} color="var(--cat-3)" format={(n) => '$' + n.toFixed(2)} unknown="no price" label="Estimated cost per {gran}" />
    </Surface>
    <Surface title="Event trend" subtitle="Metric events per {gran}">
      <Sparkline values={trendVals('events')} labels={trendLabels} color="var(--cat-4)" format={formatCompact} label="Events per {gran}" />
    </Surface>
    <Surface title="Capability events" subtitle="Tool, skill, MCP, hook … calls">
      <Bars rows={capBars} format={formatInt} />
    </Surface>

    <Surface title="Tokens by project" info="Projects are folded across agents and worktrees. Unnamed projects show a short id; hover for the full value.">
      <Donut data={projectSlices} format={formatCompact} label="Tokens by project" />
    </Surface>
    <Surface title="Activity mix" subtitle="Capability and signal counts in the window" class="xl:col-span-2">
      <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {#each activity as [k, v] (k)}
          <div class="rounded-[10px] bg-inset px-3 py-2 ring-1 ring-line-soft">
            <dt class="text-xs capitalize text-ink-3">{k}</dt>
            <dd class="nums mt-0.5 text-base font-medium {v === 0 ? 'text-ink-3' : k === 'errors' ? 'text-red' : 'text-ink'}">{formatInt(v)}</dd>
          </div>
        {/each}
      </dl>
    </Surface>
  </div>

  {#if !d.content.available}
    <div class="mt-4">
      <Alert tone="neutral">Content layer is off — session timelines are metrics-only. Token, cost and capability numbers here are unaffected (§3.2).</Alert>
    </div>
  {/if}
{/if}
