<script lang="ts">
  // GET /api/agents (§10 priority 5 — functional, not polished). §18 item 6 makes
  // host part of agent identity, so each agent shows its host split instead of one
  // merged line. An agent known but idle in the window renders "not recorded",
  // never a table of zeros (§14).
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const { state, run } = loader(() => api.agents(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    run()
  })
  const d = $derived(state.status === 'ready' ? state.data : null)
  let open = $state<string | null>(null)
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Agents</h1>
  <p class="text-xs text-mist-500">each agent shown with its host split (§18 item 6) · cost is a computed estimate</p>
</div>

{#if state.status !== 'ready'}
  <StatePanel status={state.status} error={state.error} kind={state.kind} />
{:else if d}
  <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
    {#each d.rows as a (a.agentId)}
      <Card padded={false}>
        <button class="flex w-full items-center gap-3 px-4 py-3 text-left" onclick={() => (open = open === a.agentId ? null : a.agentId)}>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold text-mist-100">{a.displayName || a.agentId}</div>
            <div class="nums text-[11px] text-mist-500">{a.agentId}{a.recorded ? '' : ' · not recorded in window'}</div>
          </div>
          <span class="rounded bg-ink-800 px-2 py-0.5 text-[10px] text-mist-400" title="declared §8 billing mode">{a.billingMode}</span>
          {#if a.recorded}
            <span class="nums text-sm">{formatCompact(Number(a.metrics.tokens_total ?? 0))}</span>
            <CostFigure value={a.metrics.cost_api_equiv ?? null} basis="est" />
          {/if}
        </button>

        {#if a.recorded}
          <div class="grid grid-cols-3 gap-2 border-t border-line px-4 py-2 text-center text-xs">
            <div><div class="text-[10px] uppercase text-mist-500">sessions</div><div class="nums">{formatInt(Number(a.metrics.sessions ?? 0))}</div></div>
            <div><div class="text-[10px] uppercase text-mist-500">events</div><div class="nums">{formatInt(Number(a.metrics.events ?? 0))}</div></div>
            <div><div class="text-[10px] uppercase text-mist-500">duration</div><div class="nums">{formatMs(Number(a.metrics.duration ?? 0))}</div></div>
          </div>
        {/if}

        {#if open === a.agentId && a.recorded}
          <div class="space-y-3 border-t border-line px-4 py-3 text-xs">
            {#if a.hosts.length}
              <div>
                <div class="mb-1 text-[10px] uppercase tracking-wide text-mist-500">hosts</div>
                {#each a.hosts as h (h.host)}
                  <div class="flex justify-between border-b border-line/40 py-0.5"><span>{h.host}</span><span class="nums text-mist-400">{formatInt(h.events)} ev · {formatInt(h.sessions)} sess</span></div>
                {/each}
              </div>
            {/if}
            {#if a.capabilities.length}
              <div>
                <div class="mb-1 text-[10px] uppercase tracking-wide text-mist-500">capabilities</div>
                <div class="flex flex-wrap gap-1.5">
                  {#each a.capabilities as c (c.type)}
                    <span class="nums rounded bg-ink-800 px-1.5 py-0.5 text-mist-300">{c.type} <span class="text-mist-500">{formatInt(c.events)}{c.errors ? ` / ${c.errors}err` : ''}</span></span>
                  {/each}
                </div>
              </div>
            {/if}
            {#if a.models.length}
              <div>
                <div class="mb-1 text-[10px] uppercase tracking-wide text-mist-500">models</div>
                {#each a.models as m (m.model)}
                  <div class="flex justify-between border-b border-line/40 py-0.5"><span class="text-mist-200">{m.model}</span><span class="nums text-mist-400">{formatCompact(m.tokensTotal)} · <CostFigure value={m.costApiEquiv} basis="est" /></span></div>
                {/each}
              </div>
            {/if}
            <a class="inline-block text-signal hover:underline" href="#/sessions?agent={encodeURIComponent(a.agentId)}">→ sessions for this agent</a>
          </div>
        {/if}
      </Card>
    {/each}
  </div>
{/if}
