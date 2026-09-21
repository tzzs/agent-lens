<script lang="ts">
  // GET /api/query — a thin UI over the single §7 cube (this page IS the cube; every
  // other page is a fixed slice of it). The returned `explain` is rendered verbatim
  // so the user always sees the basis behind the numbers (§7 "basis is visible").
  import { api, QUERY_METRICS, QUERY_DIMS } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range } from '../lib/filter.svelte.js'
  import { options, live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  let metrics = $state<string[]>(['events', 'tokens_total', 'cost_api_equiv'])
  let dims = $state<string[]>(['agent'])
  let agent = $state('')
  let status = $state('')
  let order = $state('metric:events:desc')
  let limit = $state(50)
  let nonce = $state(0)

  const { state, run } = loader(() =>
    api.query({
      metrics: metrics.join(','),
      dims: dims.join(','),
      since: range.since,
      agent: agent || undefined,
      status: status || undefined,
      order,
      limit,
    }),
  )

  // Debounced reload whenever the spec changes so a checkbox spam does not hammer the
  // cube; the live tick also refreshes the current view.
  $effect(() => {
    void metrics
    void dims
    void agent
    void status
    void order
    void limit
    void range.since
    void live.lastTick
    void nonce
    const t = setTimeout(run, 150)
    return () => clearTimeout(t)
  })

  function toggle(list: string[], v: string) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  }
  const isDim = (c: string) => (QUERY_DIMS as readonly string[]).includes(c)
  const costMetric = (c: string) => c === 'cost_api_equiv' || c === 'cost_reported'

  function cell(col: string, v: unknown) {
    if (v === null || v === undefined) return null
    if (col === 'duration') return formatMs(Number(v))
    if (col.startsWith('tokens')) return formatCompact(Number(v))
    if (col === 'events' || col === 'sessions') return formatInt(Number(v))
    return String(v)
  }
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Usage · query explorer</h1>
  <p class="text-xs text-mist-500">pick metrics + dimensions + filters → run the §7 cube directly (window: last {range.since})</p>
</div>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
  <div class="space-y-3">
    <Card title="Metrics" padded>
      <div class="flex flex-wrap gap-1.5">
        {#each QUERY_METRICS as m}
          <button class="rounded border px-2 py-1 text-[11px] {metrics.includes(m) ? 'border-signal bg-signal/10 text-signal' : 'border-line text-mist-400 hover:text-mist-100'}" onclick={() => (metrics = toggle(metrics, m))}>{m}</button>
        {/each}
      </div>
    </Card>
    <Card title="Dimensions">
      <div class="flex flex-wrap gap-1.5">
        {#each QUERY_DIMS as dm}
          <button class="rounded border px-2 py-1 text-[11px] {dims.includes(dm) ? 'border-accent bg-accent/10 text-accent' : 'border-line text-mist-400 hover:text-mist-100'}" onclick={() => (dims = toggle(dims, dm))}>{dm}</button>
        {/each}
      </div>
    </Card>
    <Card title="Filters">
      <div class="space-y-2 text-xs">
        <label class="block">agent
          <select class="mt-1 w-full rounded border border-line bg-ink-850 px-2 py-1 text-mist-100" bind:value={agent}>
            <option value="">all</option>
            {#each options.agents as a (a.agentId)}<option value={a.agentId}>{a.agentId}</option>{/each}
          </select>
        </label>
        <label class="block">status
          <select class="mt-1 w-full rounded border border-line bg-ink-850 px-2 py-1 text-mist-100" bind:value={status}>
            <option value="">any</option><option value="ok">ok</option><option value="error">error</option><option value="unknown">unknown</option>
          </select>
        </label>
        <label class="block">order
          <input class="nums mt-1 w-full rounded border border-line bg-ink-850 px-2 py-1 text-mist-100" bind:value={order} placeholder="metric:events:desc" />
        </label>
        <label class="block">limit
          <input class="nums mt-1 w-full rounded border border-line bg-ink-850 px-2 py-1 text-mist-100" type="number" min="0" max="5000" bind:value={limit} />
        </label>
      </div>
    </Card>
  </div>

  <div class="space-y-3">
    {#if metrics.length === 0}
      <Card><p class="text-sm text-warn">select at least one metric.</p></Card>
    {:else if state.status !== 'ready'}
      <StatePanel status={state.status} error={state.error} kind={state.kind} />
    {:else}
      {@const res = state.data}
      <Card padded={false} title={res.rows.length + ' rows'} note={res.truncated ? 'truncated by limit' : ''}>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-line text-[11px] uppercase tracking-wide text-mist-500">
              <tr>
                {#each res.columns as c (c)}<th class="px-3 py-2 font-medium {isDim(c) ? '' : 'text-right'}">{c}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each res.rows as r, i (i)}
                <tr class="border-b border-line/40">
                  {#each res.columns as c (c)}
                    <td class="px-3 py-1.5 {isDim(c) ? 'text-mist-200' : 'nums text-right text-mist-100'}">
                      {#if costMetric(c)}<CostFigure value={r[c] as number | null} basis={c === 'cost_reported' ? 'reported' : 'est'} />{:else}{cell(c, r[c]) ?? '—'}{/if}
                    </td>
                  {/each}
                </tr>
              {:else}
                <tr><td colspan={res.columns.length} class="px-3 py-8 text-center text-mist-500">no rows for this spec</td></tr>
              {/each}
            </tbody>
            <tfoot class="border-t border-line">
              <tr>
                {#each res.columns as c, ci (c)}
                  <td class="px-3 py-2 {ci === 0 ? 'text-mist-500' : costMetric(c) ? 'text-right' : 'nums text-right'}">
                    {#if ci === 0}<span>totals</span>
                    {:else if costMetric(c)}<CostFigure value={res.totals[c] ?? null} basis={c === 'cost_reported' ? 'reported' : 'est'} />
                    {:else if c.startsWith('tokens')}<span>{formatCompact(Number(res.totals[c] ?? 0))}</span>
                    {:else if c === 'duration'}<span>{formatMs(Number(res.totals[c] ?? 0))}</span>
                    {:else}<span>{formatInt(Number(res.totals[c] ?? 0))}</span>{/if}
                  </td>
                {/each}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <Card title="Basis" subtitle="the query the server actually ran (§7 explain)">
        <pre class="nums whitespace-pre-wrap break-words text-[11px] leading-relaxed text-mist-400">{res.explain}</pre>
      </Card>
    {/if}
  </div>
</div>
