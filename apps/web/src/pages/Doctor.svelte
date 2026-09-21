<script lang="ts">
  // GET /api/doctor (§11) — the trust report. Every block maps to the CLI's output so
  // the two ends can't disagree; the dedup line reuses event-model's fold, so the
  // "inflation avoided" number is the same one the dashboard's tokens rest on.
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatDate, formatInt, pct } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
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
  const d = $derived(q.state.status === 'ready' ? q.state.data : null)

  const icon: Record<string, string> = { ok: '✓', 'ingested-only': '◔', 'not-detected': '—', error: '✗' }
  const iconColor: Record<string, string> = { ok: 'text-ok', 'ingested-only': 'text-mist-400', 'not-detected': 'text-mist-500', error: 'text-danger' }
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Doctor</h1>
  <p class="text-xs text-mist-500">diagnostics for "can I trust these numbers" (§11){d ? ` · generated ${formatDate(d.generatedAt)}` : ''}</p>
</div>

{#if q.state.status !== 'ready'}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} loadingText="running diagnostics…" />
{:else if d}
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Card title="Agents" subtitle={d.adaptersInstalled ? '' : 'no adapters installed in this build'} padded={false}>
      <ul class="divide-y divide-line/50">
        {#each d.agents as a (a.id)}
          <li class="flex items-start gap-3 px-4 py-2 text-xs">
            <span class="nums {iconColor[a.status] ?? 'text-mist-400'}">{icon[a.status] ?? '?'}</span>
            <div class="min-w-0 flex-1">
              <div class="font-medium text-mist-100">{a.displayName || a.id}</div>
              <div class="nums text-[10px] text-mist-500">{a.detectedVersion ?? '—'} · {a.dataRoot ?? '—'}</div>
              {#if a.note}<div class="text-[10px] text-mist-400">{a.note}</div>{/if}
            </div>
            <div class="nums shrink-0 text-right text-mist-400">{formatInt(a.events)} ev<br />{formatInt(a.sources)} src</div>
          </li>
        {/each}
      </ul>
    </Card>

    <div class="space-y-4">
      <Card title="Parsing">
        <ul class="nums space-y-1 text-xs text-mist-300">
          <li class="flex justify-between"><span>events</span><span>{formatInt(d.parsing.events)}</span></li>
          <li class="flex justify-between"><span>parse_errors</span><span class={d.parsing.parseErrors ? 'text-warn' : ''}>{formatInt(d.parsing.parseErrors)} ({d.parsing.parseErrorPct.toFixed(2)}%)</span></li>
          <li class="flex justify-between"><span>unknown types</span><span>{formatInt(d.parsing.unknownTypes)}</span></li>
        </ul>
      </Card>

      <Card title="Usage quality">
        <ul class="nums space-y-1 text-xs text-mist-300">
          <li class="flex justify-between"><span>reported / estimated / missing</span><span>{formatInt(d.usageQuality.reported)} / {formatInt(d.usageQuality.estimated)} / {formatInt(d.usageQuality.missing)}</span></li>
          <li class="flex justify-between"><span>without request_id</span><span>{formatInt(d.usageQuality.withoutRequestId)}</span></li>
          {#if d.usageQuality.dedupActive}
            <li class="mt-1 rounded bg-ok/10 p-1.5 text-ok">
              request_id dedup active: raw {formatCompact(d.usageQuality.naiveTokens)} → {formatCompact(d.usageQuality.dedupedTokens)} ({d.usageQuality.inflationAvoidedPct.toFixed(1)}% inflation avoided)
            </li>
          {:else}
            <li class="text-mist-500">no request-id duplication observed in this data</li>
          {/if}
        </ul>
      </Card>
    </div>

    <Card title="Coverage" padded={false}>
      <div class="px-4 py-2 text-xs {d.coverage.incomplete ? 'text-warn' : 'text-mist-400'}">
        {d.coverage.banner ?? 'history looks complete for ingested sources'}
      </div>
      {#if d.coverage.emptyDirs.length}
        <ul class="nums max-h-40 space-y-1 overflow-y-auto px-4 pb-2 text-[11px] text-mist-400">
          {#each d.coverage.emptyDirs as e (e.dir)}
            <li class="flex justify-between gap-2"><span class="truncate">{e.dir}</span><span class="shrink-0">{formatInt(e.missingSources)} missing · {e.agentIds.join(',')}</span></li>
          {/each}
        </ul>
      {/if}
      {#if d.coverage.projectDirsWithoutSessions.length}
        <div class="border-t border-line px-4 py-2 text-[11px] text-mist-400">
          project dirs with no sessions: {d.coverage.projectDirsWithoutSessions.map((p: any) => p.project).join(', ')}
        </div>
      {/if}
      <p class="border-t border-line px-4 py-2 text-[10px] text-mist-500">{d.coverage.limits}</p>
    </Card>

    <div class="space-y-4">
      <Card title="Capabilities">
        {#if d.capabilities.length === 0}
          <p class="text-xs text-mist-500">no capability events in window</p>
        {:else}
          <ul class="nums space-y-1 text-xs">
            {#each d.capabilities as c (c.type)}
              <li class="flex justify-between"><span class="text-mist-300">{c.type}</span><span>{formatInt(c.events)}{c.errors ? ` · ${formatInt(c.errors)} errors` : ''}</span></li>
            {/each}
          </ul>
        {/if}
        <div class="mt-2 border-t border-line pt-2 text-[10px] text-mist-500">
          catalog: {d.catalog.available ? `${formatInt(d.catalog.installed)} installed · ${formatInt(d.catalog.neverUsed)} never used` : d.catalog.note}
        </div>
      </Card>

      <Card title="Pricing">
        <ul class="nums space-y-1 text-xs text-mist-300">
          {#if d.pricing.pricingConfigured}
            <li class="flex justify-between"><span>models priced</span><span>{d.pricing.modelsPriced === null ? '—' : formatInt(d.pricing.modelsPriced)}</span></li>
            <li class="flex justify-between"><span>models seen</span><span>{formatInt(d.pricing.modelsSeen)}</span></li>
            {#if d.pricing.missing.length}
              <li class="text-warn">! {d.pricing.missing.length} missing price → cost n/a: <span class="nums">{d.pricing.missing.map((m: any) => m.model).join(', ')}</span></li>
            {/if}
          {:else}
            <li class="text-warn">no price table injected — all cost is n/a (§8)</li>
          {/if}
        </ul>
      </Card>
    </div>

    <Card title="Cost" subtitle={d.cost.basis}>
      <div class="space-y-2 text-xs">
        <div class="flex justify-between"><span class="text-mist-400">actual (billing-mode folded)</span><CostFigure value={d.cost.actualUsd} basis="actual" partial={d.cost.actualPartial} /></div>
        <div class="flex justify-between"><span class="text-mist-400">est. API equivalent</span><CostFigure value={d.cost.apiEquivalentUsd} basis="est" partial={d.cost.apiEquivalentPartial} /></div>
        {#if d.cost.reportedUsd !== null}<div class="flex justify-between"><span class="text-mist-400">reported by agents</span><CostFigure value={d.cost.reportedUsd} basis="reported" /></div>{/if}
      </div>
    </Card>

    <div class="space-y-4">
      <Card title="Permissions" padded={false}>
        <ul class="divide-y divide-line/50">
          {#each d.permissions as p (p.path)}
            <li class="flex items-center gap-2 px-4 py-1.5 text-xs">
              <span class={p.readable ? 'text-ok' : 'text-danger'}>{p.readable ? '✓' : '✗'}</span>
              <span class="nums truncate text-mist-400">{p.path}</span>
            </li>
          {:else}
            <li class="px-4 py-2 text-xs text-mist-500">nothing to report</li>
          {/each}
        </ul>
      </Card>
      <Card title="Content layer">
        <p class="text-xs {d.content.available ? 'text-mist-300' : 'text-warn'}">{d.content.note}</p>
        <p class="nums mt-1 text-[10px] text-mist-500">{formatInt(d.content.payloads)} payloads stored</p>
      </Card>
    </div>
  </div>
{/if}
