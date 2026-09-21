<script lang="ts">
  // GET /api/projects (§10 priority 4, §9's example output). One row per canonical
  // repo root; worktrees/subdirs already folded server-side, so the note + the
  // observed-cwd evidence are shown for verifiability rather than trust.
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const { state, run } = loader(() => api.projects({ ...filterParams(), limit: 50 }))
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

<div class="mb-4 flex items-end justify-between">
  <div>
    <h1 class="text-lg font-semibold">Projects</h1>
    <p class="text-xs text-mist-500">cross-agent grouping · {formatInt(state.data?.rows.length ?? 0)} projects in window</p>
  </div>
</div>

{#if state.status !== 'ready'}
  <StatePanel status={state.status} error={state.error} kind={state.kind} />
{:else if d}
  <p class="mb-3 text-[11px] text-mist-500">{d.note}</p>
  <div class="space-y-2">
    {#each d.rows as p (p.projectId)}
      <Card padded={false}>
        <button class="flex w-full flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-left" onclick={() => (open = open === p.projectId ? null : p.projectId)}>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-mist-500">{open === p.projectId ? '▾' : '▸'}</span>
              <span class="truncate text-sm font-semibold text-mist-100">{p.project}</span>
            </div>
            {#if p.canonicalRoot}<div class="nums truncate pl-5 text-[10px] text-mist-500">{p.canonicalRoot}</div>{/if}
          </div>
          <div class="nums flex items-center gap-6 text-xs">
            <span class="text-mist-400">{formatInt(p.agents.length)} agent{p.agents.length === 1 ? '' : 's'}</span>
            <span class="text-mist-400">{formatInt(Number(p.metrics.sessions ?? 0))} sess</span>
            <span>{formatCompact(Number(p.metrics.tokens_total ?? 0))} tokens</span>
            <CostFigure value={p.metrics.cost_api_equiv ?? null} basis="est" />
          </div>
        </button>

        {#if open === p.projectId}
          <div class="border-t border-line px-4 py-3">
            <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <div class="mb-1 text-[11px] uppercase tracking-wide text-mist-500">by agent</div>
                <table class="w-full text-xs">
                  <tbody>
                    {#each p.agents as a (a.agentId)}
                      <tr class="border-b border-line/40">
                        <td class="py-1">
                          <span class="text-mist-500">├─ </span><span class="text-mist-100">{a.agentId}</span>
                        </td>
                        <td class="nums py-1 text-right text-mist-400">{formatInt(a.sessions)} sess</td>
                        <td class="nums py-1 text-right">{formatCompact(a.tokensTotal)}</td>
                        <td class="py-1 text-right"><CostFigure value={a.costApiEquiv} basis="est" /></td>
                      </tr>
                    {:else}
                      <tr><td class="py-1 text-mist-500">no agent rows in window</td></tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <div class="space-y-3">
                {#if p.recentSessions.length}
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-mist-500">recent sessions</div>
                    <ul class="space-y-1 text-xs">
                      {#each p.recentSessions as s (s.id)}
                        <li class="flex items-center justify-between gap-2">
                          <a class="truncate text-signal hover:underline" href="#/sessions/{encodeURIComponent(s.id)}">{s.title || s.id.slice(0, 16)}</a>
                          <span class="nums shrink-0 text-[10px] text-mist-500">{s.agentId}·{s.hostId}</span>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/if}
                {#if p.models.length}
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-mist-500">models</div>
                    <div class="flex flex-wrap gap-1.5 text-[11px]">
                      {#each p.models as m (m.model)}
                        <span class="nums rounded bg-ink-800 px-1.5 py-0.5 text-mist-300">{m.model} <span class="text-mist-500">{formatCompact(m.tokensTotal)}</span></span>
                      {/each}
                    </div>
                  </div>
                {/if}
                {#if p.capabilities.length}
                  <div>
                    <div class="mb-1 text-[11px] uppercase tracking-wide text-mist-500">capabilities</div>
                    <div class="flex flex-wrap gap-1.5 text-[11px]">
                      {#each p.capabilities as c (c.type)}
                        <span class="nums rounded bg-ink-800 px-1.5 py-0.5 text-mist-300">{c.type} <span class="text-mist-500">{formatInt(c.events)}</span></span>
                      {/each}
                    </div>
                  </div>
                {/if}
                {#if p.observedCwds.length}
                  <details class="text-[11px]">
                    <summary class="cursor-pointer text-mist-500">observed cwds ({formatInt(p.observedCwds.length)}) — evidence of worktree/subdir folding</summary>
                    <ul class="nums mt-1 space-y-0.5 pl-4">
                      {#each p.observedCwds as c (c.cwd)}
                        <li class="flex justify-between gap-3"><span class="truncate text-mist-400">{c.cwd}</span><span class="text-mist-500">{formatInt(c.events)}</span></li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </Card>
    {:else}
      <Card><p class="py-6 text-center text-sm text-mist-500">no projects in this window.</p></Card>
    {/each}
  </div>
{/if}
