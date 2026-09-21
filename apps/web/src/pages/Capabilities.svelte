<script lang="ts">
  // GET /api/capabilities (§10 priority 3) — the axis ccusage has no concept of.
  // §18 item 5 is the honesty rule here: an agent that never instruments hooks must
  // read "not reported by this agent", never "0 hook calls", so the union of
  // declared types comes from `supports`, not only from rows that have counts.
  import { api, CAPABILITY_TYPES } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.capabilities({ ...filterParams(), names: 15 }))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })

  const d = $derived(q.state.status === 'ready' ? q.state.data : null)

  const typeBy = $derived(new Map((d?.types ?? []).map((t: any) => [t.type, t])))
  // For each type: which agents report it at all, and which explicitly don't.
  const supportBy = $derived.by(() => {
    const map: Record<string, { reporting: string[]; missing: string[] }> = {}
    for (const t of CAPABILITY_TYPES) map[t] = { reporting: [], missing: [] }
    for (const s of d?.supports ?? []) {
      for (const t of s.recorded) map[t]?.reporting.push(s.agentId)
      for (const t of s.missing) map[t]?.missing.push(s.agentId)
    }
    return map
  })

  let expanded = $state<string | null>(null)
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Capabilities</h1>
  <p class="text-xs text-mist-500">which tool / skill / MCP / hook / subagent burned what — usage, duration, failures</p>
</div>

{#if q.state.status !== 'ready'}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} />
{:else if d}
  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs">
        <thead class="border-b border-line text-[11px] uppercase tracking-wide text-mist-500">
          <tr>
            <th class="px-4 py-2 font-medium">Capability type</th>
            <th class="px-4 py-2 text-right font-medium">Uses</th>
            <th class="px-4 py-2 text-right font-medium">Duration</th>
            <th class="px-4 py-2 text-right font-medium">Tokens</th>
            <th class="px-4 py-2 text-right font-medium">Failures</th>
            <th class="px-4 py-2 text-right font-medium">Est. cost</th>
            <th class="px-4 py-2 font-medium">Reported by</th>
          </tr>
        </thead>
        <tbody>
          {#each CAPABILITY_TYPES as t (t)}
            {@const row = typeBy.get(t)}
            {@const sup = supportBy[t]}
            <tr class="cursor-pointer border-b border-line/50 hover:bg-ink-850" onclick={() => (expanded = expanded === t ? null : t)}>
              <td class="px-4 py-2 font-medium text-mist-100">
                <span class="mr-1 text-mist-500">{expanded === t && row?.names?.length ? '▾' : row?.names?.length ? '▸' : ' '}</span>{t}
              </td>
              {#if row}
                <td class="nums px-4 py-2 text-right">{formatInt(row.events)}</td>
                <td class="nums px-4 py-2 text-right">{formatMs(row.durationMs)}</td>
                <td class="nums px-4 py-2 text-right">{formatCompact(row.tokensTotal)}</td>
                <td class="nums px-4 py-2 text-right {row.errors ? 'text-danger' : 'text-mist-400'}">{formatInt(row.errors)}</td>
                <td class="px-4 py-2 text-right"><CostFigure value={row.costApiEquiv} basis="est" /></td>
                <td class="px-4 py-2 text-mist-400">{sup.reporting.join(', ') || '—'}</td>
              {:else if sup.reporting.length === 0 && sup.missing.length > 0}
                <td colspan="5" class="px-4 py-2 text-mist-500">not reported by this agent{sup.missing.length > 1 ? 's' : ''} ({sup.missing.join(', ')})</td>
                <td class="px-4 py-2 text-mist-500">{sup.missing.join(', ')}</td>
              {:else}
                <td class="nums px-4 py-2 text-right text-mist-500">0</td>
                <td colspan="4" class="px-4 py-2 text-mist-500">no uses in this window</td>
              {/if}
            </tr>
            {#if expanded === t && row?.names?.length}
              <tr>
                <td colspan="7" class="bg-ink-950/40 px-4 py-2">
                  <div class="overflow-x-auto">
                    <table class="w-full text-[11px]">
                      <thead class="text-mist-500">
                        <tr>
                          <th class="py-1 text-left font-medium">name</th>
                          <th class="py-1 text-right font-medium">uses</th>
                          <th class="py-1 text-right font-medium">duration</th>
                          <th class="py-1 text-right font-medium">tokens</th>
                          <th class="py-1 text-right font-medium">errors</th>
                          <th class="py-1 text-right font-medium">est. cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each row.names as nm (nm.name)}
                          <tr class="border-t border-line/40">
                            <td class="py-1 text-mist-200">{nm.name}</td>
                            <td class="nums py-1 text-right">{formatInt(nm.events)}</td>
                            <td class="nums py-1 text-right">{formatMs(nm.durationMs)}</td>
                            <td class="nums py-1 text-right">{formatCompact(nm.tokensTotal)}</td>
                            <td class="nums py-1 text-right {nm.errors ? 'text-danger' : 'text-mist-400'}">{formatInt(nm.errors)}</td>
                            <td class="py-1 text-right"><CostFigure value={nm.costApiEquiv} basis="est" /></td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Card title="Installed but never used" subtitle="static capability catalog (§5.1)">
      {#if !d.catalog.available}
        <p class="text-xs text-mist-500">{d.catalog.note}</p>
      {:else if d.catalog.neverUsed.length === 0}
        <p class="text-xs text-mist-400">catalogued {formatInt(d.catalog.installed)} entries · all observed in the event stream.</p>
      {:else}
        <p class="mb-2 text-[11px] text-mist-500">{d.catalog.note}</p>
        <ul class="max-h-72 space-y-1 overflow-y-auto text-xs">
          {#each d.catalog.neverUsed as c (`${c.agentId}:${c.type}:${c.name}`)}
            <li class="flex items-center justify-between border-b border-line/40 pb-1">
              <span class="text-mist-200">{c.name}</span>
              <span class="text-[10px] text-mist-500">{c.type}{c.agentId ? ` · ${c.agentId}` : ''}{c.source ? ` · ${c.source}` : ''}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <Card title="Basis" subtitle="how these numbers were derived (§7)">
      <pre class="nums whitespace-pre-wrap break-words text-[11px] leading-relaxed text-mist-400">{d.explain}</pre>
      <p class="mt-3 text-[11px] text-mist-500">
        "not reported" means the agent records no events for that axis at all (§18 item 5) — it is not a zero.
      </p>
    </Card>
  </div>
{/if}
