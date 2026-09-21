<script lang="ts">
  // GET /api/doctor (§11) — the trust report. Every block maps to the CLI's output so
  // the two ends can't disagree; the dedup line reuses event-model's fold, so the
  // "inflation avoided" number is the same one the dashboard's tokens rest on.
  // Parsing, usage quality, coverage and pricing read the whole store; capabilities
  // and cost follow the header's window (the route applies the filter to those only).
  import { api, type DoctorAgentRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatDateTime, formatInt } from '../lib/format.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import InsightCard from '../components/ui/InsightCard.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.doctor(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  // Agent status in words, never a bare glyph or colour.
  const STATUS_LABEL: Record<DoctorAgentRow['status'], string> = {
    ok: 'OK',
    'ingested-only': 'Ingested only',
    'not-detected': 'Not detected',
    error: 'Error',
  }
  const STATUS_TONE: Record<DoctorAgentRow['status'], 'neutral' | 'green' | 'red'> = {
    ok: 'green',
    'ingested-only': 'neutral',
    'not-detected': 'neutral',
    error: 'red',
  }

  const agentsOk = $derived(d ? d.agents.filter((a) => a.status === 'ok').length : 0)
  // "1 error · 2 ingested only" for the summary tile; empty when every agent is OK.
  const agentIssues = $derived(
    d
      ? (['error', 'not-detected', 'ingested-only'] as const)
          .map((s) => [s, d.agents.filter((a) => a.status === s).length] as const)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${formatInt(n)} ${STATUS_LABEL[s].toLowerCase()}`)
          .join(' · ')
      : '',
  )

  const figure = 'nums text-[22px] font-semibold tracking-tight'
  const dlRow = 'flex items-baseline justify-between gap-4 border-b border-line-soft py-1.5 last:border-0'
</script>

<PageHeader
  title="Doctor"
  description="Can you trust these numbers? Parsing, coverage, pricing and permissions checks."
  info="The same report agl doctor prints (§11). Parsing, usage quality, coverage and pricing cover the whole store; capabilities and cost follow the selected window."
  refreshing={q.state.refreshing}
>
  {#snippet actions()}
    {#if d}<span class="nums text-xs text-ink-3" title={new Date(d.generatedAt).toISOString()}>Generated {formatDateTime(d.generatedAt)}</span>{/if}
  {/snippet}
</PageHeader>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Running diagnostics" />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title="Refresh failed.">{q.state.error} — showing the last good report.</Alert></div>
  {/if}

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <InsightCard label="Agents" info="OK means an adapter in this build detected the agent on this machine. Ingested-only agents keep their history but have no adapter here.">
      <div class="flex items-baseline gap-1.5">
        <span class={figure}>{formatInt(agentsOk)}</span>
        <span class="text-[13px] text-ink-3">of <span class="nums">{formatInt(d.agents.length)}</span> OK</span>
      </div>
      {#snippet detail()}
        <p class="text-xs text-ink-3">{agentIssues || (d.agents.length ? 'Every agent detected' : 'No agents known yet')}</p>
      {/snippet}
    </InsightCard>

    <InsightCard label="Parse errors" info="Raw records that failed to parse, as a share of everything read, across the whole store.">
      <div class="{figure} {d.parsing.parseErrors ? 'text-orange' : ''}">{d.parsing.parseErrorPct.toFixed(2)}%</div>
      {#snippet detail()}
        <p class="text-xs text-ink-3">
          <span class="nums">{formatInt(d.parsing.parseErrors)}</span> failed · <span class="nums">{formatInt(d.parsing.events)}</span> events parsed
        </p>
      {/snippet}
    </InsightCard>

    <InsightCard label="Dedup inflation avoided" info="Tokens are de-duplicated per request_id (MAX per request, then SUM — §3.1). This is how much a naive sum would have over-counted.">
      <div class={figure}>{d.usageQuality.inflationAvoidedPct.toFixed(1)}%</div>
      {#snippet detail()}
        {#if d.usageQuality.dedupActive}
          <p class="text-xs text-ink-3">
            Raw <span class="nums">{formatCompact(d.usageQuality.naiveTokens)}</span> → <span class="nums">{formatCompact(d.usageQuality.dedupedTokens)}</span> tokens after dedup
          </p>
        {:else}
          <p class="text-xs text-ink-3">No request_id duplication observed</p>
        {/if}
      {/snippet}
    </InsightCard>

    <InsightCard label="Models missing a price" info="A model without a price shows its cost as n/a — never $0 (§8).">
      {#if d.pricing.pricingConfigured}
        <div class="{figure} {d.pricing.missing.length ? 'text-orange' : ''}">{formatInt(d.pricing.missing.length)}</div>
      {:else}
        <div class="text-[22px] font-semibold tracking-tight text-orange">All</div>
      {/if}
      {#snippet detail()}
        {#if !d.pricing.pricingConfigured}
          <p class="text-xs text-ink-3">No price table injected — all cost is n/a</p>
        {:else if d.pricing.missing.length}
          <p class="text-xs text-ink-3">Of <span class="nums">{formatInt(d.pricing.modelsSeen)}</span> models seen — their cost is n/a</p>
        {:else}
          <p class="text-xs text-ink-3">Every model seen has a price</p>
        {/if}
      {/snippet}
    </InsightCard>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Surface
      title="Agents"
      subtitle={d.adaptersInstalled ? '' : 'No adapters installed in this build'}
      info="Detection is read-only. An agent without an adapter in this build still shows its ingested history."
      padded={false}
    >
      {#if d.agents.length}
        <ul>
          {#each d.agents as a (a.id)}
            <li class="flex items-start gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-[13px] font-medium text-ink" title={a.id}>{a.displayName || a.id}</span>
                  <Chip tone={STATUS_TONE[a.status]} dashed={a.status === 'not-detected'}>{STATUS_LABEL[a.status] ?? a.status}</Chip>
                </div>
                <div class="nums mt-0.5 truncate text-xs text-ink-3" title="{a.detectedVersion ?? '—'} · {a.dataRoot ?? '—'}">
                  {a.detectedVersion ?? '—'} · {a.dataRoot ?? '—'}
                </div>
                {#if a.note}<p class="mt-1 text-xs {a.status === 'error' ? 'text-red' : 'text-ink-2'}">{a.note}</p>{/if}
              </div>
              <div class="shrink-0 text-right text-xs leading-5 text-ink-3">
                <div><span class="nums text-[13px] text-ink">{formatInt(a.events)}</span> events</div>
                <div><span class="nums text-ink-2">{formatInt(a.sources)}</span> sources</div>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-4 py-8 text-center text-[13px] text-ink-3">No agents detected or ingested yet.</p>
      {/if}
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title="Parsing" info="Across the whole store, not only the selected window.">
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="text-ink-3">Events parsed</dt><dd class="nums text-ink">{formatInt(d.parsing.events)}</dd></div>
          <div class={dlRow}>
            <dt class="text-ink-3">Parse errors</dt>
            <dd class="nums {d.parsing.parseErrors ? 'text-orange' : 'text-ink'}">
              {formatInt(d.parsing.parseErrors)} <span class="text-ink-3">({d.parsing.parseErrorPct.toFixed(2)}%)</span>
            </dd>
          </div>
          <div class={dlRow}><dt class="text-ink-3">Unknown event types</dt><dd class="nums text-ink">{formatInt(d.parsing.unknownTypes)}</dd></div>
        </dl>
      </Surface>

      <Surface
        title="Usage quality"
        subtitle="Events by where their token usage came from"
        info="Reported: the agent logged its own usage. Estimated: usage was derived. Missing: none recorded. Across the whole store."
        class="flex-1"
      >
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="text-ink-3">Reported by the agent</dt><dd class="nums text-ink">{formatInt(d.usageQuality.reported)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">Estimated</dt><dd class="nums text-ink">{formatInt(d.usageQuality.estimated)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">Missing</dt><dd class="nums text-ink">{formatInt(d.usageQuality.missing)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">Without a request_id</dt><dd class="nums text-ink">{formatInt(d.usageQuality.withoutRequestId)}</dd></div>
        </dl>
        {#if d.usageQuality.dedupActive}
          <p class="mt-3 flex items-start gap-2 rounded-lg bg-green-tint px-3 py-2 text-[13px] text-green">
            <Icon name="check" size={14} class="mt-0.5" />
            <span>
              request_id dedup active: raw <span class="nums">{formatCompact(d.usageQuality.naiveTokens)}</span> →
              <span class="nums">{formatCompact(d.usageQuality.dedupedTokens)}</span> tokens
              (<span class="nums">{d.usageQuality.inflationAvoidedPct.toFixed(1)}%</span> inflation avoided)
            </span>
          </p>
        {:else}
          <p class="mt-3 text-xs text-ink-3">No request_id duplication observed in this data.</p>
        {/if}
      </Surface>
    </div>

    <Surface
      title="Coverage"
      info="Upstream tools can delete old session files while their folder stays, so a scan can look complete while being partial. These are presence checks, not statistics."
    >
      <div class="space-y-3">
        {#if d.coverage.banner}
          <Alert tone="orange" title="Incomplete history.">{d.coverage.banner}</Alert>
        {:else if d.coverage.incomplete}
          <Alert tone="orange" title="History may be incomplete.">
            {formatInt(d.coverage.unreachable.length)} ingested source{d.coverage.unreachable.length === 1 ? '' : 's'} can't be read right now.
          </Alert>
        {:else}
          <p class="flex items-center gap-2 text-[13px] text-ink-2"><Chip tone="green">Complete</Chip>History looks complete for ingested sources.</p>
        {/if}

        {#if d.coverage.emptyDirs.length}
          <div>
            <h4 class="mb-1 text-xs font-medium text-ink-3">Source dirs whose session files are gone</h4>
            <ul class="max-h-40 overflow-y-auto text-xs">
              {#each d.coverage.emptyDirs as e (e.dir)}
                <li class="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                  <span class="nums min-w-0 truncate text-ink-2" title={e.dir}>{e.dir}</span>
                  <span class="shrink-0 text-ink-3"><span class="nums">{formatInt(e.missingSources)}</span> missing · {e.agentIds.join(', ')}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if d.coverage.projectDirsWithoutSessions.length}
          <div>
            <h4 class="mb-1.5 text-xs font-medium text-ink-3">Project dirs with no sessions left</h4>
            <div class="flex flex-wrap gap-1.5">
              {#each d.coverage.projectDirsWithoutSessions as p, i (i)}
                <Chip mono title={p.root}>{p.project}</Chip>
              {/each}
            </div>
          </div>
        {/if}

        <p class="border-t border-line-soft pt-3 text-xs text-ink-3">{d.coverage.limits}</p>
      </div>
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title="Capabilities" subtitle="In the selected window">
        {#if d.capabilities.length === 0}
          <p class="text-[13px] text-ink-3">No capability events in this window.</p>
        {:else}
          <dl class="text-[13px]">
            {#each d.capabilities as c (c.type)}
              <div class={dlRow}>
                <dt class="text-ink-2">{c.type}</dt>
                <dd class="nums text-ink">
                  {formatInt(c.events)}{#if c.errors}<span class="text-red"> · {formatInt(c.errors)} errors</span>{/if}
                </dd>
              </div>
            {/each}
          </dl>
        {/if}
        <p class="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">
          Catalog: {d.catalog.available ? `${formatInt(d.catalog.installed)} installed · ${formatInt(d.catalog.neverUsed)} never used` : d.catalog.note}
        </p>
      </Surface>

      <Surface title="Pricing" info="Costs use the injected price table. A model without a price shows cost as n/a — never $0 (§8)." class="flex-1">
        {#if d.pricing.pricingConfigured}
          <dl class="text-[13px]">
            <div class={dlRow}>
              <dt class="text-ink-3">Models priced</dt>
              <dd class="nums text-ink">{d.pricing.modelsPriced === null ? '—' : formatInt(d.pricing.modelsPriced)}</dd>
            </div>
            <div class={dlRow}><dt class="text-ink-3">Models seen</dt><dd class="nums text-ink">{formatInt(d.pricing.modelsSeen)}</dd></div>
          </dl>
          {#if d.pricing.missing.length}
            <div class="mt-3">
              <Alert tone="orange" title="{formatInt(d.pricing.missing.length)} missing a price — cost n/a:">
                <span class="nums">{d.pricing.missing.map((m) => m.model).join(', ')}</span>
              </Alert>
            </div>
          {/if}
        {:else}
          <Alert tone="orange" title="No price table injected —">all cost is n/a, never shown as $0.</Alert>
        {/if}
      </Surface>
    </div>

    <Surface title="Cost" subtitle="In the selected window">
      <dl class="text-[13px]">
        <div class={dlRow}>
          <dt class="text-ink-3">Actual, after billing mode</dt>
          <dd><CostFigure value={d.cost.actualUsd} basis="actual" partial={d.cost.actualPartial} /></dd>
        </div>
        <div class={dlRow}>
          <dt class="text-ink-3">API-equivalent estimate</dt>
          <dd><CostFigure value={d.cost.apiEquivalentUsd} basis="est" partial={d.cost.apiEquivalentPartial} /></dd>
        </div>
        {#if d.cost.reportedUsd !== null}
          <div class={dlRow}>
            <dt class="text-ink-3">Reported by agents</dt>
            <dd><CostFigure value={d.cost.reportedUsd} basis="reported" /></dd>
          </div>
        {/if}
      </dl>
      {#if d.cost.unpricedAgents.length}
        <p class="mt-3 text-xs text-orange">No price for {d.cost.unpricedAgents.join(', ')} — the totals above are a floor.</p>
      {/if}
      <p class="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">{d.cost.basis}</p>
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title="Permissions" info="Whether this process can read each detected agent's data root.">
        {#if d.permissions.length}
          <ul>
            {#each d.permissions as p, i (i)}
              <li class="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                <span class="nums min-w-0 truncate text-xs text-ink-2" title={p.path}>{p.path}</span>
                {#if p.readable}<Chip tone="green">Readable</Chip>{:else}<Chip tone="red">Unreadable</Chip>{/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-[13px] text-ink-3">Nothing to report — no agent data roots were detected.</p>
        {/if}
      </Surface>

      <Surface
        title="Content layer"
        info="An optional copy of message and tool text, made only when a scan runs with --content. Statistics never depend on it."
        class="flex-1"
      >
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="text-ink-3">Status</dt>
            <dd>{#if d.content.available}<Chip tone="orange">On</Chip>{:else}<Chip tone="green">Off · metrics only</Chip>{/if}</dd>
          </div>
          <div class={dlRow}><dt class="text-ink-3">Payloads stored</dt><dd class="nums text-ink">{formatInt(d.content.payloads)}</dd></div>
        </dl>
        <p class="mt-3 text-xs text-ink-3">{d.content.note}</p>
      </Surface>
    </div>
  </div>
{/if}
