<script lang="ts">
  // GET /api/capabilities (§10 priority 3): the axis ccusage has no concept of.
  // §18 item 5 is the honesty rule here: an agent that never instruments hooks must
  // read "Not reported", never "0 hook calls", so every row comes from the full
  // CAPABILITY_TYPES list joined with `supports`, not only from types with counts.
  import { api, CAPABILITY_TYPES, UNNAMED_CAPABILITY, type CapabilityNameRow, type CapabilityTypeRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs, pct } from '../lib/format.ts'
  import { eventKind } from '../lib/eventKinds.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable, { type Column } from '../components/ui/DataTable.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import CodeBlock from '../components/ui/CodeBlock.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  /** Top names the server returns per type (ranked by uses). */
  const NAME_LIMIT = 15
  /** Agent chips shown in "Reported by" before folding the rest into "+N". */
  const AGENT_CHIPS = 3

  const q = loader(() => api.capabilities({ ...filterParams(), names: NAME_LIMIT }))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  const LABELS: Record<string, string> = {
    tool: 'Tools',
    skill: 'Skills',
    mcp: 'MCP',
    plugin: 'Plugins',
    connector: 'Connectors',
    command: 'Commands',
    subagent: 'Subagents',
    hook: 'Hooks',
  }
  const labelOf = (type: string) => LABELS[type] ?? type

  // used: the type has events in the window. unreported: agents are present but none
  // records this type at all (an absence). idle: nothing to attribute, a plain zero.
  type Status = 'used' | 'unreported' | 'idle'
  interface TypeView {
    type: string
    stats: CapabilityTypeRow | null
    reporting: string[]
    missing: string[]
    status: Status
  }

  const rows = $derived.by((): TypeView[] => {
    const data = d
    if (!data) return []
    const byType = new Map(data.types.map((t) => [t.type, t]))
    // A type the server knows but this list does not still gets a row instead of vanishing.
    const known: readonly string[] = CAPABILITY_TYPES
    const types = [...known, ...data.types.map((t) => t.type).filter((t) => !known.includes(t))]
    return types.map((type) => {
      const stats = byType.get(type) ?? null
      const reporting = data.supports.filter((s) => s.recorded.includes(type)).map((s) => s.agentId)
      const missing = data.supports.filter((s) => s.missing.includes(type)).map((s) => s.agentId)
      const status: Status = stats ? 'used' : reporting.length === 0 && missing.length > 0 ? 'unreported' : 'idle'
      return { type, stats, reporting, missing, status }
    })
  })
  const anyNames = $derived(rows.some((r) => (r.stats?.names.length ?? 0) > 0))

  let open = $state<string[]>([])
  const toggle = (type: string) => (open = open.includes(type) ? open.filter((t) => t !== type) : [...open, type])

  const plural = (n: number, word: string) => `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`
  function agentTitle(stats: CapabilityTypeRow, agentId: string): string {
    const a = stats.agents.find((x) => x.agentId === agentId)
    return a ? `${agentId}: ${plural(a.events, 'use')} across ${plural(a.sessions, 'session')}` : agentId
  }

  const columns: Column[] = [
    { key: 'type', label: 'Type', width: '17%' },
    { key: 'uses', label: 'Uses', align: 'right', width: '10%', info: 'Events recorded for this capability type in the selected window.' },
    {
      key: 'duration',
      label: 'Duration',
      align: 'right',
      width: '11%',
      info: 'Total time the agents logged for these calls. A dash means no durations were recorded for this type, not zero time.',
    },
    { key: 'tokens', label: 'Tokens', align: 'right', width: '10%', info: 'Tokens carried by these events, counted once per request (§3.1).' },
    { key: 'failures', label: 'Failures', align: 'right', width: '10%', info: 'Calls that ended in an error status.' },
    {
      key: 'cost',
      label: 'Est. cost',
      align: 'right',
      width: '11%',
      info: 'Tokens × list price. n/a when there is no price or no tokens to price — never $0.',
    },
    { key: 'agents', label: 'Reported by', width: '31%', info: 'Agents that recorded this type in the selected window.' },
  ]
  const nameColumns: Column[] = [
    { key: 'name', label: 'Name', width: '40%' },
    { key: 'uses', label: 'Uses', align: 'right', width: '12%' },
    { key: 'duration', label: 'Duration', align: 'right', width: '12%' },
    { key: 'tokens', label: 'Tokens', align: 'right', width: '12%' },
    { key: 'errors', label: 'Errors', align: 'right', width: '12%' },
    { key: 'cost', label: 'Est. cost', align: 'right', width: '12%' },
  ]
</script>

{#snippet duration(ms: number)}
  {#if ms > 0}
    <td class="nums text-right text-ink-2">{formatMs(ms)}</td>
  {:else}
    <td class="nums text-right text-ink-3" title="No durations recorded">—</td>
  {/if}
{/snippet}

{#snippet failures(errors: number, events: number)}
  <td class="text-right">
    {#if errors > 0}
      <Chip tone="red" mono title="{plural(errors, 'call')} of {formatInt(events)} ended in an error ({pct(errors / Math.max(1, events))})">{formatInt(errors)}</Chip>
    {:else}
      <span class="nums text-ink-3">0</span>
    {/if}
  </td>
{/snippet}

{#snippet nameRow(n: CapabilityNameRow)}
  <td class="nums {n.name ? 'text-ink' : 'text-ink-3'}" title={n.name || undefined}>{n.name || UNNAMED_CAPABILITY}</td>
  <td class="nums text-right">{formatInt(n.events)}</td>
  {@render duration(n.durationMs)}
  <td class="nums text-right {n.tokensTotal > 0 ? '' : 'text-ink-3'}" title={formatInt(n.tokensTotal)}>{formatCompact(n.tokensTotal)}</td>
  {@render failures(n.errors, n.events)}
  <td class="text-right"><CostFigure value={n.costApiEquiv} basis="est" showLabel={false} /></td>
{/snippet}

<PageHeader
  title="Capabilities"
  description="Which tools, skills, MCP servers, hooks and subagents did the work — uses, time, failures and cost."
  info="Grouped by capability type for the selected window (§10). A type an agent does not record reads “Not reported”, never 0 (§18 item 5)."
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Loading capabilities" />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title="Refresh failed.">{q.state.error} — showing the last good numbers.</Alert></div>
  {/if}

  <Surface title="By type" subtitle={anyNames ? 'Expand a type to see its most-used names.' : ''} padded={false}>
    <div class="overflow-x-auto rounded-b-card">
      <div class="min-w-[760px]">
        <DataTable {columns} {rows} key={(r: TypeView) => r.type} caption="Capability use by type" isExpanded={(r: TypeView) => open.includes(r.type)}>
          {#snippet row(r: TypeView)}
            {@const isOpen = open.includes(r.type)}
            {@const dot = r.stats ? eventKind(r.type).color : 'var(--cat-muted)'}
            <td>
              {#if r.stats?.names.length}
                <button
                  type="button"
                  class="-ml-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left font-medium text-ink transition-colors hover:bg-hover-2"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `cap-names-${r.type}` : undefined}
                  onclick={() => toggle(r.type)}
                >
                  <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} class="text-ink-3" />
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background:{dot}" aria-hidden="true"></span>
                  <span class="truncate">{labelOf(r.type)}</span>
                  <span class="sr-only">, top names</span>
                </button>
              {:else}
                <span class="inline-flex max-w-full items-center gap-1.5 py-0.5 font-medium {r.stats ? 'text-ink' : 'text-ink-2'}">
                  <span class="w-3.5 shrink-0" aria-hidden="true"></span>
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background:{dot}" aria-hidden="true"></span>
                  <span class="truncate">{labelOf(r.type)}</span>
                </span>
              {/if}
            </td>

            {#if r.stats}
              {@const s = r.stats}
              <td class="nums text-right">{formatInt(s.events)}</td>
              {@render duration(s.durationMs)}
              <td class="nums text-right {s.tokensTotal > 0 ? '' : 'text-ink-3'}" title={formatInt(s.tokensTotal)}>{formatCompact(s.tokensTotal)}</td>
              {@render failures(s.errors, s.events)}
              <td class="text-right"><CostFigure value={s.costApiEquiv} basis="est" showLabel={false} /></td>
              <td>
                {#if r.reporting.length}
                  <div class="flex items-center gap-1 overflow-hidden">
                    {#each r.reporting.slice(0, AGENT_CHIPS) as agent (agent)}
                      <Chip title={agentTitle(s, agent)}>{agent}</Chip>
                    {/each}
                    {#if r.reporting.length > AGENT_CHIPS}
                      <Chip mono title={r.reporting.slice(AGENT_CHIPS).join(', ')}>+{r.reporting.length - AGENT_CHIPS}</Chip>
                    {/if}
                  </div>
                {:else}
                  <span class="text-ink-3">—</span>
                {/if}
              </td>
            {:else if r.status === 'unreported'}
              <td colspan="5">
                <span class="inline-flex max-w-full items-center gap-2">
                  <Chip dashed title="An absence, not a zero: these agents record no {r.type === 'mcp' ? 'MCP' : r.type} events at all.">Not reported</Chip>
                  <span class="truncate text-xs text-ink-3" title={r.missing.join(', ')}>by {r.missing.join(', ')}</span>
                </span>
              </td>
              <td class="text-ink-3">—</td>
            {:else}
              <td class="nums text-right text-ink-3">0</td>
              <td colspan="4" class="text-xs text-ink-3">No uses in this window</td>
              <td class="text-ink-3">—</td>
            {/if}
          {/snippet}

          {#snippet expanded(r: TypeView)}
            {#if r.stats}
              <div id="cap-names-{r.type}" class="whitespace-normal border-t border-line-soft bg-inset px-4 py-3">
                <div class="overflow-hidden rounded-[10px] bg-surface ring-1 ring-line-soft">
                  <DataTable
                    columns={nameColumns}
                    rows={r.stats.names}
                    key={(n: CapabilityNameRow) => n.name}
                    row={nameRow}
                    dense
                    caption="Most-used {labelOf(r.type)} names"
                  />
                </div>
                <p class="mt-2 text-xs text-ink-3">
                  Top {formatInt(r.stats.names.length)} names by uses. The {labelOf(r.type)} row above totals every name, including ones not listed.
                </p>
              </div>
            {/if}
          {/snippet}
        </DataTable>
      </div>
    </div>
  </Surface>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Surface
      title="Installed but never used"
      subtitle="In an agent's catalog, but no uses in this window"
      info="Read from each agent's static capability catalog (§5.1). An entry is listed when nothing in the selected window used it."
    >
      {#if !d.catalog.available}
        <div class="flex items-start gap-2.5 rounded-[10px] border border-dashed border-line-strong px-3.5 py-3">
          <Icon name="info" size={15} class="mt-0.5 text-ink-3" />
          <div class="min-w-0">
            <p class="text-[13px] text-ink-2">No catalog available, so unused capabilities can't be listed. That is not the same as none.</p>
            <p class="nums mt-1 break-words text-xs text-ink-3">{d.catalog.note}</p>
          </div>
        </div>
      {:else if d.catalog.neverUsed.length === 0}
        <p class="flex items-center gap-2 text-[13px] text-ink-2">
          <Icon name="check" size={15} class="text-green" />
          {#if d.catalog.installed === 0}
            The catalog is empty: no installed capabilities were found.
          {:else}
            All {formatInt(d.catalog.installed)} catalogued {d.catalog.installed === 1 ? 'entry was' : 'entries were'} used in this window.
          {/if}
        </p>
      {:else}
        <p class="mb-2 text-xs text-ink-3">{d.catalog.note}</p>
        <ul class="max-h-72 divide-y divide-line-soft overflow-y-auto">
          {#each d.catalog.neverUsed as c (`${c.agentId}:${c.type}:${c.name}:${c.source}`)}
            <li class="flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <span class="nums min-w-0 truncate text-[13px] text-ink" title={c.name}>{c.name}</span>
              <span class="flex min-w-0 shrink-0 items-center gap-1">
                <Chip color={eventKind(c.type).color}>{c.type}</Chip>
                {#if c.agentId}<Chip>{c.agentId}</Chip>{/if}
                {#if c.source}<span class="inline-flex min-w-0 max-w-40"><Chip mono title={c.source}>{c.source}</Chip></span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </Surface>

    <Surface title="How these numbers were derived" info="The cube query behind this page (§7). “Not reported” follows §18 item 5.">
      <CodeBlock text={d.explain} label="Query" />
      <p class="mt-3 text-xs leading-6 text-ink-3">
        <Chip dashed>Not reported</Chip> means the agent records no events of that type at all. It is an absence, not a zero.
      </p>
    </Surface>
  </div>
{/if}
