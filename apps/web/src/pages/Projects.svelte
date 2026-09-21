<script lang="ts">
  // GET /api/projects (§10 priority 4, §9's example output). One row per canonical
  // repo root: worktrees and subdirectories are folded server-side (§4.1), so the
  // server's note and each project's observed working directories are shown for
  // verifiability rather than trust. Hash-only projects render as a short id with
  // the full digest in the title.
  import { api, type ProjectRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, relativeTime, projectLabel, shortId, looksLikeHash } from '../lib/format.ts'
  import { SERIES, eventKind } from '../lib/eventKinds.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable from '../components/ui/DataTable.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.projects({ ...filterParams(), limit: 50 }))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)
  let open = $state<Record<string, boolean>>({})

  const now = $derived(live.lastTick || Date.now())
  const agentIds = $derived([...new Set((d?.rows ?? []).flatMap((p) => p.agents.map((a) => a.agentId)))].sort())
  const agentColor = (id: string) => SERIES[Math.max(0, agentIds.indexOf(id)) % SERIES.length]!

  const projectCount = $derived(
    d ? `${formatInt(d.rows.length)}${d.truncated ? '+' : ''} ${d.rows.length === 1 && !d.truncated ? 'project' : 'projects'}` : '',
  )
  const note = $derived(d?.note ? d.note.charAt(0).toUpperCase() + d.note.slice(1) : '')

  const num = (v: number | null | undefined) => Number(v ?? 0)
  const plural = (n: number, one: string, many: string) => `${formatInt(n)} ${n === 1 ? one : many}`
  // Rows are keyed and ided by position as well as projectId: the server relabels
  // project ids after grouping, so two repos sharing a basename can share a label
  // (and so a projectId), and a duplicate key would take the whole table down.
  // For the same reason the per-project sub-lists below are not keyed.
  const rowKey = (p: ProjectRow, i: number) => `${i}:${p.projectId}`
  const detailId = (p: ProjectRow) => `project-detail-${d ? d.rows.indexOf(p) : 0}`
  const who = (s: ProjectRow['recentSessions'][number]) =>
    s.hostId && s.hostId !== s.agentId ? `${s.agentId} · ${s.hostId}` : s.agentId
  const agentGrid = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5.5rem] gap-x-3'

  const columns = [
    { key: 'project', label: 'Project', width: '38%' },
    { key: 'agents', label: 'Agents', width: '24%' },
    { key: 'sessions', label: 'Sessions', align: 'right' as const, width: '11%' },
    { key: 'tokens', label: 'Tokens', align: 'right' as const, width: '12%' },
    { key: 'cost', label: 'Est. cost', align: 'right' as const, width: '15%', info: 'Tokens × list price. n/a when a model has no price — never $0.' },
  ]
</script>

<PageHeader
  title="Projects"
  description={d ? `${projectCount} in this window, grouped across agents and worktrees.` : 'Grouped across agents and worktrees.'}
  info={note}
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Loading projects" />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title="Refresh failed.">{q.state.error} — showing the last good numbers.</Alert></div>
  {/if}

  <Surface padded={false}>
    <DataTable
      {columns}
      rows={d.rows}
      key={rowKey}
      caption="Projects"
      empty="No projects in this window"
      isExpanded={(p: ProjectRow) => !!open[p.projectId]}
    >
      {#snippet row(p: ProjectRow)}
        {@const isOpen = !!open[p.projectId]}
        <td>
          <button
            type="button"
            class="group flex max-w-full items-center gap-1.5 text-left"
            aria-expanded={isOpen}
            aria-controls={detailId(p)}
            onclick={() => (open[p.projectId] = !open[p.projectId])}
          >
            <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} class="text-ink-3 group-hover:text-ink" />
            <span class="truncate font-medium text-ink group-hover:text-accent {looksLikeHash(p.project) ? 'nums' : ''}" title={p.project}>{projectLabel(p.project)}</span>
          </button>
          {#if p.canonicalRoot}
            <div class="nums truncate pl-[19px] text-xs text-ink-3" title={p.canonicalRoot}>{p.canonicalRoot}</div>
          {:else}
            <div class="truncate pl-[19px] text-xs text-ink-3">No repo root recorded</div>
          {/if}
        </td>
        <td>
          <div class="flex min-w-0 items-center gap-1" title={p.agents.map((a) => a.agentId).join(', ')}>
            {#each p.agents.slice(0, 2) as a}
              <Chip class="min-w-0">
                <span class="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style="background:{agentColor(a.agentId)}" aria-hidden="true"></span>{a.agentId}
              </Chip>
            {:else}
              <span class="text-ink-3">—</span>
            {/each}
            {#if p.agents.length > 2}<Chip class="shrink-0">+{p.agents.length - 2}</Chip>{/if}
          </div>
        </td>
        <td class="nums text-right">{formatInt(num(p.metrics.sessions))}</td>
        <td class="nums text-right" title="{formatInt(num(p.metrics.tokens_total))} tokens">{formatCompact(num(p.metrics.tokens_total))}</td>
        <td class="text-right"><CostFigure value={p.metrics.cost_api_equiv ?? null} basis="est" showLabel={false} /></td>
      {/snippet}

      {#snippet expanded(p: ProjectRow)}
        <div id={detailId(p)} class="grid grid-cols-1 gap-x-10 gap-y-5 whitespace-normal bg-inset px-4 py-4 sm:pl-[35px] lg:grid-cols-2">
          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">By agent</h3>
            {#if p.agents.length}
              <div role="table" aria-label="Usage by agent" class="text-[13px]">
                <div role="row" class="{agentGrid} pb-1 text-[11px] font-medium text-ink-3">
                  <span role="columnheader">Agent</span>
                  <span role="columnheader" class="text-right">Sessions</span>
                  <span role="columnheader" class="text-right">Tokens</span>
                  <span role="columnheader" class="text-right">Est. cost</span>
                </div>
                {#each p.agents as a}
                  <div role="row" class="{agentGrid} items-center border-t border-line-soft py-1.5">
                    <span role="cell" class="flex min-w-0 items-center gap-2">
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background:{agentColor(a.agentId)}" aria-hidden="true"></span>
                      <span class="truncate text-ink" title={a.agentId}>{a.agentId}</span>
                    </span>
                    <span role="cell" class="nums text-right text-ink-2">{formatInt(a.sessions)}</span>
                    <span role="cell" class="nums text-right text-ink-2" title="{formatInt(a.tokensTotal)} tokens">{formatCompact(a.tokensTotal)}</span>
                    <span role="cell" class="text-right"><CostFigure value={a.costApiEquiv} basis="est" showLabel={false} /></span>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-[13px] text-ink-3">No agent activity in this window</p>
            {/if}
          </section>

          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">Recent sessions</h3>
            {#if p.recentSessions.length}
              <ul class="text-[13px]">
                {#each p.recentSessions as s (s.id)}
                  <li class="flex items-baseline gap-3 border-t border-line-soft py-1.5 first:border-t-0 first:pt-0">
                    <a href="#/sessions/{encodeURIComponent(s.id)}" class="min-w-0 flex-1 truncate text-ink hover:text-accent" title={s.title ?? s.id}>
                      {#if s.title}{s.title}{:else}Untitled <span class="nums text-ink-3">{shortId(s.id)}</span>{/if}
                    </a>
                    <span class="shrink-0 text-xs text-ink-3" title={s.lastTimestamp ? new Date(s.lastTimestamp).toISOString() : undefined}>
                      {who(s)} · {relativeTime(s.lastTimestamp, now)}
                    </span>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-[13px] text-ink-3">No sessions recorded</p>
            {/if}
          </section>

          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">Models</h3>
            {#if p.models.length}
              <ul class="flex flex-wrap gap-1.5">
                {#each p.models as m}
                  <li class="min-w-0">
                    <Chip mono title="{m.model} · {formatInt(m.tokensTotal)} tokens · {formatInt(m.events)} events">
                      {m.model} <span class="text-ink-3">{formatCompact(m.tokensTotal)}</span>
                    </Chip>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-[13px] text-ink-3">No model calls in this window</p>
            {/if}
          </section>

          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">Capabilities</h3>
            {#if p.capabilities.length}
              <ul class="flex flex-wrap gap-1.5">
                {#each p.capabilities as c}
                  <li class="min-w-0">
                    <Chip title={plural(c.events, `${c.type} event`, `${c.type} events`)}>
                      <span class="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style="background:{eventKind(c.type).color}" aria-hidden="true"></span>{c.type}
                      <span class="nums text-ink-3">{formatInt(c.events)}</span>
                    </Chip>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-[13px] text-ink-3">No capability calls in this window</p>
            {/if}
          </section>

          {#if p.observedCwds.length}
            <details class="min-w-0 lg:col-span-2">
              <summary class="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">
                Observed working directories ({formatInt(p.observedCwds.length)})
              </summary>
              <p class="mt-1.5 text-xs text-ink-3">
                Every path below resolved to this project — the evidence for folding worktrees and subdirectories into one row. Busiest first; event
                counts cover all recorded history, not just this window.
              </p>
              <ul class="mt-2 text-xs">
                {#each p.observedCwds as c (c.cwd)}
                  <li class="flex items-baseline justify-between gap-3 border-t border-line-soft py-1 first:border-t-0">
                    <span class="nums min-w-0 truncate text-ink-2" title={c.cwd}>{c.cwd}</span>
                    <span class="nums shrink-0 text-ink-3">{plural(c.events, 'event', 'events')}</span>
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
        </div>
      {/snippet}
    </DataTable>
  </Surface>

  {#if d.truncated}
    <p class="mt-3 text-xs text-ink-3">
      Showing {formatInt(d.rows.length)} projects; more were active in this window — narrow the range or agent filter to see the rest.
    </p>
  {/if}
{/if}
