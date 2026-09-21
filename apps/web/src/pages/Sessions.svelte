<script lang="ts">
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs, relativeTime } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.sessions({ ...filterParams(), limit: 100 }))

  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Sessions</h1>
  <p class="text-xs text-mist-500">most recent first — open one for the waterfall timeline</p>
</div>

{#if q.state.status !== 'ready'}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} />
{:else if q.state.data}
  {@const rows = q.state.data.rows}
  <div class="mb-3 flex items-center justify-between text-xs text-mist-400">
    <span>{formatInt(q.state.data.totalSessions)} sessions matched{q.state.data.truncated ? ' (truncated)' : ''}</span>
    {#if !q.state.data.content.available}
      <span class="text-warn">content layer off — details will be metrics-only</span>
    {/if}
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs">
        <thead class="border-b border-line text-[11px] uppercase tracking-wide text-mist-500">
          <tr>
            <th class="px-4 py-2 font-medium">Session</th>
            <th class="px-4 py-2 font-medium">Agent · host</th>
            <th class="px-4 py-2 font-medium">Project</th>
            <th class="px-4 py-2 text-right font-medium">Events</th>
            <th class="px-4 py-2 text-right font-medium">Tokens</th>
            <th class="px-4 py-2 text-right font-medium">Duration</th>
            <th class="px-4 py-2 text-right font-medium">Est. cost</th>
            <th class="px-4 py-2 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.sessionId)}
            <tr class="border-b border-line/50 transition-colors hover:bg-ink-850">
              <td class="px-4 py-2">
                <a href="#/sessions/{encodeURIComponent(r.sessionId)}" class="font-medium text-signal hover:underline">
                  {r.title || r.sessionId.slice(0, 16)}
                </a>
                <div class="nums text-[10px] text-mist-500">{r.sessionId.slice(0, 24)}</div>
              </td>
              <td class="px-4 py-2 text-mist-300">{r.agentId}<span class="text-mist-500"> · {r.hostId}</span></td>
              <td class="px-4 py-2 text-mist-300">{r.project}</td>
              <td class="nums px-4 py-2 text-right">{formatInt(r.events)}</td>
              <td class="nums px-4 py-2 text-right">{formatCompact(r.tokensTotal)}</td>
              <td class="nums px-4 py-2 text-right">{formatMs(r.durationMs)}</td>
              <td class="px-4 py-2 text-right"><CostFigure value={r.costApiEquiv} basis="est" /></td>
              <td class="nums px-4 py-2 text-right text-mist-400">{relativeTime(r.lastTimestamp, Date.now())}</td>
            </tr>
          {:else}
            <tr><td colspan="8" class="px-4 py-10 text-center text-mist-500">no sessions in this window</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
{/if}
