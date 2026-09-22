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
  import { projectNote } from '../lib/notes.ts'
  import { t } from '../lib/lang.js'
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

  // The header's count reads "1 project" / "1,234 projects" / "1,234+ projects":
  // the truncated case is never singular, so it is its own message and the
  // one/other agreement lives in the catalog's plural form.
  const projectCount = $derived(
    d ? (d.truncated ? $t('projects.countPlus', { values: { n: formatInt(d.rows.length) } }) : $t('projects.count', { values: { n: formatInt(d.rows.length) } })) : '',
  )
  // The old page capitalised the server's sentence at render time — an English-only
  // operation. The note is the viewer's own text now, so it starts as it should.
  const note = $derived(d ? projectNote(d.noteCode) : '')

  const num = (v: number | null | undefined) => Number(v ?? 0)
  // Rows are keyed and ided by position as well as projectId: the server relabels
  // project ids after grouping, so two repos sharing a basename can share a label
  // (and so a projectId), and a duplicate key would take the whole table down.
  // For the same reason the per-project sub-lists below are not keyed.
  const rowKey = (p: ProjectRow, i: number) => `${i}:${p.projectId}`
  const detailId = (p: ProjectRow) => `project-detail-${d ? d.rows.indexOf(p) : 0}`
  const who = (s: ProjectRow['recentSessions'][number]) =>
    s.hostId && s.hostId !== s.agentId ? `${s.agentId} · ${s.hostId}` : s.agentId
  const agentGrid = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5.5rem] gap-x-3'

  const columns = $derived([
    { key: 'project', label: $t('projects.colProject'), width: '38%' },
    { key: 'agents', label: $t('projects.colAgents'), width: '24%' },
    { key: 'sessions', label: $t('projects.colSessions'), align: 'right' as const, width: '11%' },
    { key: 'tokens', label: $t('projects.colTokens'), align: 'right' as const, width: '12%' },
    { key: 'cost', label: $t('projects.colEstCost'), align: 'right' as const, width: '15%', info: $t('projects.costColumnInfo') },
  ])
</script>

<PageHeader
  title={$t('projects.title')}
  description={d ? $t('projects.desc', { values: { count: projectCount } }) : $t('projects.pageDesc')}
  info={note}
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('projects.loadingProjects')} />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title={$t('states.refreshFailed')}>{q.state.error} — {$t('states.showingLastNumbers')}</Alert></div>
  {/if}

  <Surface padded={false}>
    <DataTable
      {columns}
      rows={d.rows}
      key={rowKey}
      caption={$t('projects.title')}
      empty={$t('projects.empty')}
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
            <div class="truncate pl-[19px] text-xs text-ink-3">{$t('projects.noRoot')}</div>
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
        <td class="nums text-right" title={$t('projects.tokensTitle', { values: { n: formatInt(num(p.metrics.tokens_total)) } })}>{formatCompact(num(p.metrics.tokens_total))}</td>
        <td class="text-right"><CostFigure value={p.metrics.cost_api_equiv ?? null} basis="est" showLabel={false} /></td>
      {/snippet}

      {#snippet expanded(p: ProjectRow)}
        <div id={detailId(p)} class="grid grid-cols-1 gap-x-10 gap-y-5 whitespace-normal bg-inset px-4 py-4 sm:pl-[35px] lg:grid-cols-2">
          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">{$t('projects.byAgent')}</h3>
            {#if p.agents.length}
              <div role="table" aria-label={$t('projects.byAgentAria')} class="text-[13px]">
                <div role="row" class="{agentGrid} pb-1 text-[11px] font-medium text-ink-3">
                  <span role="columnheader">{$t('projects.colAgent')}</span>
                  <span role="columnheader" class="text-right">{$t('projects.colSessions')}</span>
                  <span role="columnheader" class="text-right">{$t('projects.colTokens')}</span>
                  <span role="columnheader" class="text-right">{$t('projects.colEstCost')}</span>
                </div>
                {#each p.agents as a}
                  <div role="row" class="{agentGrid} items-center border-t border-line-soft py-1.5">
                    <span role="cell" class="flex min-w-0 items-center gap-2">
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background:{agentColor(a.agentId)}" aria-hidden="true"></span>
                      <span class="truncate text-ink" title={a.agentId}>{a.agentId}</span>
                    </span>
                    <span role="cell" class="nums text-right text-ink-2">{formatInt(a.sessions)}</span>
                    <span role="cell" class="nums text-right text-ink-2" title={$t('projects.tokensTitle', { values: { n: formatInt(a.tokensTotal) } })}>{formatCompact(a.tokensTotal)}</span>
                    <span role="cell" class="text-right"><CostFigure value={a.costApiEquiv} basis="est" showLabel={false} /></span>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-[13px] text-ink-3">{$t('projects.noAgentActivity')}</p>
            {/if}
          </section>

          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">{$t('projects.recentSessions')}</h3>
            {#if p.recentSessions.length}
              <ul class="text-[13px]">
                {#each p.recentSessions as s (s.id)}
                  <li class="flex items-baseline gap-3 border-t border-line-soft py-1.5 first:border-t-0 first:pt-0">
                    <a href="#/sessions/{encodeURIComponent(s.id)}" class="min-w-0 flex-1 truncate text-ink hover:text-accent" title={s.title ?? s.id}>
                      {#if s.title}{s.title}{:else}{$t('projects.untitled')} <span class="nums text-ink-3">{shortId(s.id)}</span>{/if}
                    </a>
                    <span class="shrink-0 text-xs text-ink-3" title={s.lastTimestamp ? new Date(s.lastTimestamp).toISOString() : undefined}>
                      {who(s)} · {relativeTime(s.lastTimestamp, now)}
                    </span>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-[13px] text-ink-3">{$t('projects.noSessions')}</p>
            {/if}
          </section>

          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">{$t('projects.models')}</h3>
            {#if p.models.length}
              <ul class="flex flex-wrap gap-1.5">
                {#each p.models as m}
                  <li class="min-w-0">
                    <Chip mono title={$t('projects.modelChipTitle', { values: { model: m.model, tokens: formatInt(m.tokensTotal), events: formatInt(m.events) } })}>
                      {m.model} <span class="text-ink-3">{formatCompact(m.tokensTotal)}</span>
                    </Chip>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-[13px] text-ink-3">{$t('projects.noModelCalls')}</p>
            {/if}
          </section>

          <section class="min-w-0">
            <h3 class="mb-2 text-xs font-medium text-ink-2">{$t('projects.capabilities')}</h3>
            {#if p.capabilities.length}
              <ul class="flex flex-wrap gap-1.5">
                {#each p.capabilities as c}
                  <li class="min-w-0">
                    <Chip title={$t('projects.capabilityChipTitle', { values: { n: formatInt(c.events), type: c.type } })}>
                      <span class="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style="background:{eventKind(c.type).color}" aria-hidden="true"></span>{c.type}
                      <span class="nums text-ink-3">{formatInt(c.events)}</span>
                    </Chip>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-[13px] text-ink-3">{$t('projects.noCapabilityCalls')}</p>
            {/if}
          </section>

          {#if p.observedCwds.length}
            <details class="min-w-0 lg:col-span-2">
              <summary class="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">
                {$t('projects.observedCwds', { values: { n: formatInt(p.observedCwds.length) } })}
              </summary>
              <p class="mt-1.5 text-xs text-ink-3">
                {$t('projects.observedCwdsNote')}
              </p>
              <ul class="mt-2 text-xs">
                {#each p.observedCwds as c (c.cwd)}
                  <li class="flex items-baseline justify-between gap-3 border-t border-line-soft py-1 first:border-t-0">
                    <span class="nums min-w-0 truncate text-ink-2" title={c.cwd}>{c.cwd}</span>
                    <span class="nums shrink-0 text-ink-3">{$t('projects.eventsCount', { values: { n: formatInt(c.events) } })}</span>
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
      {$t('projects.truncatedNote', { values: { n: formatInt(d.rows.length) } })}
    </p>
  {/if}
{/if}
