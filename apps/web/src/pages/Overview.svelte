<script lang="ts">
  import { formatCompact, formatInt } from '../lib/format.ts'
  import { range } from '../lib/filter.svelte.js'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'
  import Donut from '../components/charts/Donut.svelte'
  import Sparkline from '../components/charts/Sparkline.svelte'
  import Bars from '../components/charts/Bars.svelte'

  let { ov }: { ov: { state: any; run: () => Promise<void> } } = $props()

  const d = $derived(ov.state.status === 'ready' ? ov.state.data : null)
  const gran = $derived(d?.window?.granularity ?? range.since ?? 'day')

  const trendVals = (key: string) => (d ? d.trend.map((r: any) => Number(r[key] ?? 0)) : [])
  const trendLabels = $derived(
    d
      ? d.trend.map((r: any) => {
          const v = r[gran] ?? r.day ?? r.time ?? ''
          return String(v).slice(0, 10)
        })
      : [],
  )
  const costSeries = $derived(
    d
      ? d.trend.map((r: any) => (r.cost_api_equiv === null || r.cost_api_equiv === undefined ? 0 : Number(r.cost_api_equiv)))
      : [],
  )

  const agentDonut = $derived(d ? d.agents.map((r: any) => ({ label: String(r.agent), value: Number(r.tokens_total ?? 0) })) : [])
  const projectDonut = $derived(d ? d.projects.map((r: any) => ({ label: String(r.project || '(none)'), value: Number(r.tokens_total ?? 0) })) : [])
  const capBars = $derived(
    d
      ? d.capabilities
          .map((r: any) => ({ label: String(r.capability_type), value: Number(r.events ?? 0), note: `${formatCompact(Number(r.duration ?? 0))}ms total` }))
          .sort((a: any, b: any) => b.value - a.value)
      : [],
  )
</script>

<div class="mb-4 flex items-end justify-between">
  <div>
    <h1 class="text-lg font-semibold">Overview</h1>
    <p class="text-xs text-mist-500">tokens deduped per request (§3.1) · window granularity {gran}</p>
  </div>
  {#if d}<span class="nums text-[11px] text-mist-500">generated {new Date(d.generatedAt).toISOString().slice(0, 19)}Z</span>{/if}
</div>

{#if ov.state.status !== 'ready'}
  <StatePanel status={ov.state.status} error={ov.state.error} kind={ov.state.kind} />
{:else if d}
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <Card title="Tokens" note="deduped">
      <div class="nums text-3xl font-semibold">{formatCompact(d.cards.tokens.total)}</div>
      <dl class="nums mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-mist-400">
        <div class="flex justify-between"><dt>in</dt><dd>{formatCompact(d.cards.tokens.input)}</dd></div>
        <div class="flex justify-between"><dt>out</dt><dd>{formatCompact(d.cards.tokens.output)}</dd></div>
        <div class="flex justify-between"><dt>cache r</dt><dd>{formatCompact(d.cards.tokens.cacheRead)}</dd></div>
        <div class="flex justify-between"><dt>cache w</dt><dd>{formatCompact(d.cards.tokens.cacheWrite)}</dd></div>
        <div class="flex justify-between"><dt>reason</dt><dd>{formatCompact(d.cards.tokens.reasoning)}</dd></div>
      </dl>
      <p class="mt-2 text-[10px] leading-tight text-mist-500">{d.cards.tokens.basis}</p>
    </Card>

    <Card title="Cost" note={d.cards.cost.pricingConfigured ? '' : 'no price table'}>
      <div class="space-y-1.5">
        <div><CostFigure value={d.cards.cost.actualUsd} basis="actual" partial={d.cards.cost.actualPartial} size="lg" /></div>
        <div class="flex items-center gap-3 text-xs">
          <CostFigure value={d.cards.cost.apiEquivalentUsd} basis="est" partial={d.cards.cost.apiEquivalentPartial} />
        </div>
        {#if d.cards.cost.reportedUsd !== null}
          <CostFigure value={d.cards.cost.reportedUsd} basis="reported" />
        {/if}
      </div>
      {#if d.cards.cost.unpricedAgents.length}
        <p class="mt-2 text-[10px] text-warn">no price for: {d.cards.cost.unpricedAgents.join(', ')} → n/a</p>
      {/if}
    </Card>

    <Card title="Sessions">
      <div class="nums text-3xl font-semibold">{formatInt(d.cards.sessions)}</div>
      <p class="mt-2 text-[11px] text-mist-500">in the current window</p>
    </Card>

    <Card title="Events">
      <div class="nums text-3xl font-semibold">{formatInt(d.cards.events)}</div>
      <p class="mt-2 text-[11px] text-mist-500">metric-layer rows</p>
    </Card>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Card title="Token trend" subtitle="total tokens per {gran}">
      <Sparkline values={trendVals('tokens_total')} labels={trendLabels} color="#4fd1c5" format={formatCompact} />
    </Card>
    <Card title="Event trend" subtitle="metric events per {gran}">
      <Sparkline values={trendVals('events')} labels={trendLabels} color="#7aa2f7" format={formatCompact} />
    </Card>
    <Card title="Est. cost trend" subtitle="cost_api_equiv per {gran} (estimate, not cash)">
      <Sparkline values={costSeries} labels={trendLabels} color="#f6c453" format={(n) => '$' + n.toFixed(2)} />
    </Card>
    <Card title="Activity mix" subtitle="capability + signal counts in window">
      <ul class="nums grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
        {#each Object.entries(d.activity) as [k, v] (k)}
          <li class="flex justify-between border-b border-line/50 pb-1">
            <span class="text-mist-400">{k}</span><span class="text-mist-100">{formatInt(Number(v))}</span>
          </li>
        {/each}
      </ul>
    </Card>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
    <Card title="Tokens by agent">
      <Donut data={agentDonut} format={formatCompact} />
    </Card>
    <Card title="Tokens by project">
      <Donut data={projectDonut} format={formatCompact} />
    </Card>
    <Card title="Capability events" subtitle="tool / skill / mcp / hook …">
      <Bars rows={capBars} format={formatInt} />
    </Card>
  </div>

  {#if !d.content.available}
    <p class="mt-4 rounded-md border border-line bg-ink-900 p-3 text-xs text-mist-400">
      Content layer is off — timelines on the Sessions page are metrics-only. Token, cost and capability
      statistics here are unaffected (§3.2).
    </p>
  {/if}
{/if}
