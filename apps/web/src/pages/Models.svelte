<script lang="ts">
  // GET /api/models — the price-gap surface (§8/§11). `priced: null` means pricing is
  // not configured in this build, which must NOT be shown as "unpriced"; an unpriced
  // model's cost is n/a, never $0.
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatDate } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.models(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.status === 'ready' ? q.state.data : null)
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Models</h1>
  <p class="text-xs text-mist-500">{d?.note ?? 'est. cost is tokens × price; n/a when unpriced'}</p>
</div>

{#if q.state.status !== 'ready'}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} />
{:else if d}
  {#if d.unpriced.length}
    <div class="mb-3 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
      <span class="font-semibold">pricing gap.</span> {d.unpriced.length} model(s) have no price at their last-seen date, so their cost is n/a:
      <span class="nums">{d.unpriced.map((u: any) => u.model).join(', ')}</span>
    </div>
  {/if}
  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs">
        <thead class="border-b border-line text-[11px] uppercase tracking-wide text-mist-500">
          <tr>
            <th class="px-4 py-2 font-medium">Model</th>
            <th class="px-4 py-2 font-medium">Provider</th>
            <th class="px-4 py-2 text-right font-medium">Events</th>
            <th class="px-4 py-2 text-right font-medium">Sessions</th>
            <th class="px-4 py-2 text-right font-medium">Tokens</th>
            <th class="px-4 py-2 text-right font-medium">Est. cost</th>
            <th class="px-4 py-2 font-medium">Price</th>
          </tr>
        </thead>
        <tbody>
          {#each d.rows as m (m.provider + '::' + m.model)}
            <tr class="border-b border-line/50">
              <td class="nums px-4 py-2 text-mist-100">{m.model || '(none)'}</td>
              <td class="px-4 py-2 text-mist-400">{m.provider || '—'}</td>
              <td class="nums px-4 py-2 text-right">{formatInt(m.events)}</td>
              <td class="nums px-4 py-2 text-right">{formatInt(m.sessions)}</td>
              <td class="nums px-4 py-2 text-right">{formatCompact(m.tokensTotal)}</td>
              <td class="px-4 py-2 text-right"><CostFigure value={m.costApiEquiv} basis="est" /></td>
              <td class="px-4 py-2">
                {#if m.priced === null}<span class="text-[10px] text-mist-500">not configured</span>
                {:else if m.priced}<span class="text-[10px] text-ok">priced</span>
                {:else}<span class="text-[10px] text-warn">unpriced</span>{/if}
              </td>
            </tr>
          {:else}
            <tr><td colspan="7" class="px-4 py-10 text-center text-mist-500">no model activity in this window</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  {#if !d.pricingConfigured}
    <p class="mt-3 text-[11px] text-mist-500">No price table injected: est. cost and actual are n/a across the board (§8). Use <span class="nums">agentlens pricing update</span>.</p>
  {/if}
  {#if d.unpriced.length}
    <div class="mt-4">
      <Card title="Unpriced models" subtitle="cost renders n/a, never $0">
        <ul class="nums space-y-1 text-xs">
          {#each d.unpriced as u (u.provider + '::' + u.model)}
            <li class="flex justify-between border-b border-line/40 pb-1">
              <span class="text-mist-200">{u.model} <span class="text-mist-500">· {u.provider}</span></span>
              <span class="text-mist-500">last seen {u.lastSeen ? formatDate(u.lastSeen) : '—'}</span>
            </li>
          {/each}
        </ul>
      </Card>
    </div>
  {/if}
{/if}
