<script lang="ts">
  import { api, type SessionRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs, relativeTime, projectLabel, shortId } from '../lib/format.ts'
  import { SERIES } from '../lib/eventKinds.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable from '../components/ui/DataTable.svelte'
  import FilterChips from '../components/ui/FilterChips.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Icon from '../components/ui/Icon.svelte'
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

  const d = $derived(q.state.data)
  let agentSel = $state<string[]>([])
  let search = $state('')

  const agentIds = $derived([...new Set((d?.rows ?? []).map((r) => r.agentId))].sort())
  const agentColor = (id: string) => SERIES[Math.max(0, agentIds.indexOf(id)) % SERIES.length]!
  const agentOpts = $derived(
    agentIds.map((id) => ({ key: id, label: id, dot: agentColor(id), count: d!.rows.filter((r) => r.agentId === id).length })),
  )
  const rows = $derived.by(() => {
    const needle = search.trim().toLowerCase()
    return (d?.rows ?? []).filter(
      (r) =>
        (agentSel.length === 0 || agentSel.includes(r.agentId)) &&
        (!needle || [r.title ?? '', r.sessionId, r.project, r.agentId, r.hostId].some((s) => s.toLowerCase().includes(needle))),
    )
  })

  const columns = [
    { key: 'session', label: 'Session', width: '31%' },
    { key: 'agent', label: 'Agent', width: '14%' },
    { key: 'project', label: 'Project', width: '14%' },
    { key: 'events', label: 'Events', align: 'right' as const, width: '8%' },
    { key: 'tokens', label: 'Tokens', align: 'right' as const, width: '8%' },
    { key: 'duration', label: 'Duration', align: 'right' as const, width: '8%' },
    { key: 'cost', label: 'Est. cost', align: 'right' as const, width: '12%', info: 'Tokens × list price. n/a when the model has no price — never $0.' },
    { key: 'last', label: 'Last seen', align: 'right' as const, width: '9%' },
  ]
  const now = $derived(live.lastTick || Date.now())
</script>

<PageHeader title="Sessions" description="Most recent first. Open one for its waterfall timeline." refreshing={q.state.refreshing} />

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Loading sessions" />
{:else}
  {#if !d.content.available}
    <div class="mb-4"><Alert tone="neutral">Content layer is off — session details will be metrics-only.</Alert></div>
  {/if}

  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <FilterChips label="Filter by agent" options={agentOpts} bind:selected={agentSel} multiple />
    <label class="relative flex items-center">
      <span class="sr-only">Search sessions</span>
      <Icon name="search" size={14} class="pointer-events-none absolute left-2.5 text-ink-3" />
      <input
        type="search"
        bind:value={search}
        placeholder="Search title, id, project…"
        class="h-8 w-64 max-w-full rounded-full bg-surface pl-8 pr-3 text-[13px] text-ink shadow-btn outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
      />
    </label>
  </div>

  <Surface padded={false}>
    <DataTable
      {columns}
      {rows}
      key={(r: SessionRow) => r.sessionId}
      caption="Sessions"
      empty={d.rows.length ? 'No sessions match these filters' : 'No sessions in this window'}
    >
      {#snippet row(r: SessionRow)}
        <td>
          <a href="#/sessions/{encodeURIComponent(r.sessionId)}" class="block truncate font-medium text-ink hover:text-accent" title={r.title ?? r.sessionId}>
            {r.title || `Untitled ${r.agentId} session`}
          </a>
          <div class="nums truncate text-xs text-ink-3" title={r.sessionId}>{shortId(r.sessionId, 12)}</div>
        </td>
        <td>
          <span class="inline-flex max-w-full items-center gap-1.5 text-ink-2" title="{r.agentId} · {r.hostId}">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background:{agentColor(r.agentId)}"></span>
            <span class="truncate">{r.agentId}</span>
          </span>
          {#if r.hostId !== r.agentId}<div class="truncate text-xs text-ink-3">{r.hostId}</div>{/if}
        </td>
        <td class="text-ink-2" title={r.project}><span class={projectLabel(r.project) !== r.project ? 'nums' : ''}>{projectLabel(r.project)}</span></td>
        <td class="nums text-right">{formatInt(r.events)}</td>
        <td class="nums text-right">{formatCompact(r.tokensTotal)}</td>
        <td class="nums text-right text-ink-2" title={r.durationMs > 0 ? '' : 'No event durations recorded'}>{r.durationMs > 0 ? formatMs(r.durationMs) : '—'}</td>
        <td class="text-right"><CostFigure value={r.costApiEquiv} basis="est" showLabel={false} /></td>
        <td class="nums text-right text-ink-3" title={r.lastTimestamp ? new Date(r.lastTimestamp).toISOString() : ''}>{relativeTime(r.lastTimestamp, now)}</td>
      {/snippet}
    </DataTable>
  </Surface>
  <p class="mt-3 text-xs text-ink-3">
    Showing {formatInt(rows.length)} of {formatInt(d.totalSessions)} sessions{d.truncated ? ' — the 100 most recent; narrow the range or agent to see older ones' : ''}.
  </p>
{/if}
