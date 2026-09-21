<script lang="ts">
  // GET /api/agents (§10 priority 5). Host is part of an agent's identity (§18
  // item 6), so every card carries its own host split instead of one merged line.
  // An agent known but idle in the window reads "Not recorded in this window",
  // never a row of zeros (§14). Per-agent cost is null-dominant server-side: one
  // unpriced model makes the figure n/a rather than a silent undercount.
  import { api, type AgentRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import { SERIES, eventKind } from '../lib/eventKinds.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import InfoTip from '../components/ui/InfoTip.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.agents(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  // The server appends every known-but-idle agent, including the ones the header's
  // agent filter excluded. Those are hidden rather than mislabelled "not recorded".
  const agentFilter = $derived(d?.filter?.agent ?? [])
  const hostFilter = $derived(d?.filter?.host ?? [])
  const cards = $derived(
    (d?.rows ?? []).filter((a) => a.recorded || agentFilter.length === 0 || agentFilter.includes(a.agentId)),
  )
  const hiddenByFilter = $derived((d?.rows.length ?? 0) - cards.length)

  let open = $state<Record<string, boolean>>({})

  const BILLING: Record<string, { label: string; note: string }> = {
    api: { label: 'API', note: 'billed per token, so est. cost tracks real spend' },
    subscription: { label: 'Subscription', note: 'flat plan: actual spend is $0 and est. cost is only the API equivalent' },
    local: { label: 'Local', note: 'local model: actual spend is $0 and est. cost is only the API equivalent' },
  }
  const billing = (mode: string) => BILLING[mode] ?? { label: mode, note: 'est. cost is the API equivalent' }

  const DURATION_INFO = 'Summed time of recorded events (model calls, tool runs), each request counted once — not wall-clock time.'

  const num = (v: number | null | undefined) => Number(v ?? 0)
  /** Exact below a million; compact above so a 4-up stat strip never overflows. The title keeps the exact figure. */
  const count = (n: number) => (n >= 1e6 ? formatCompact(n) : formatInt(n))
  const plural = (n: number, one: string, many: string) => `${formatInt(n)} ${n === 1 ? one : many}`
  const share = (part: number, total: number) => {
    if (total <= 0) return '—'
    const pct = (part / total) * 100
    return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
  }
  const hostColor = (j: number) => SERIES[j % SERIES.length]!
  const subtitle = (a: AgentRow) => {
    const id = a.displayName && a.displayName !== a.agentId ? a.agentId : ''
    const hosts = a.hosts.length === 1 ? `Host ${a.hosts[0]!.host}` : a.hosts.length > 1 ? `${a.hosts.length} hosts` : ''
    return [id, hosts].filter(Boolean).join(' · ')
  }
  const capTitle = (c: AgentRow['capabilities'][number]) =>
    `${plural(c.events, `${c.type} event`, `${c.type} events`)}${c.errors ? `, ${formatInt(c.errors)} with an error status` : ''}`
</script>

<PageHeader
  title="Agents"
  description="Every local agent, split by host."
  info="Host is part of an agent's identity (§18 item 6), so each card shows its own host split. Est. cost is tokens × list price — an estimate, not cash, and n/a when a model has no price. An agent with nothing in the window says so instead of showing zeros (§14)."
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Loading agents" />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title="Refresh failed.">{q.state.error} — showing the last good numbers.</Alert></div>
  {/if}

  {#if cards.length === 0}
    <Surface>
      <p class="py-8 text-center text-[13px] text-ink-3">
        {d.rows.length ? 'No agent matches the agent filter' : 'No agents detected on this machine yet'}
      </p>
    </Surface>
  {:else}
    <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {#each cards as a, i (a.agentId)}
        {@const name = a.displayName || a.agentId}
        {@const mode = billing(a.billingMode)}
        {#if a.recorded}
          {@const isOpen = !!open[a.agentId]}
          {@const hostEvents = a.hosts.reduce((s, h) => s + h.events, 0)}
          {@const duration = num(a.metrics.duration)}
          <Surface title={name} subtitle={subtitle(a)} padded={false}>
            {#snippet actions()}
              <Chip title="Declared billing mode — {mode.note}">{mode.label}</Chip>
            {/snippet}

            <div class="px-4 py-3.5">
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">Sessions</dt>
                  <dd class="nums mt-0.5 text-lg font-semibold text-ink" title="{formatInt(num(a.metrics.sessions))} sessions">{count(num(a.metrics.sessions))}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">Events</dt>
                  <dd class="nums mt-0.5 text-lg font-semibold text-ink" title="{formatInt(num(a.metrics.events))} events">{count(num(a.metrics.events))}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">Tokens</dt>
                  <dd class="nums mt-0.5 text-lg font-semibold text-ink" title="{formatInt(num(a.metrics.tokens_total))} tokens">{formatCompact(num(a.metrics.tokens_total))}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">Est. cost</dt>
                  <dd class="mt-0.5 text-lg font-semibold"><CostFigure value={a.metrics.cost_api_equiv ?? null} basis="est" showLabel={false} /></dd>
                </div>
              </dl>
              <p class="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
                Duration
                <span class="nums text-ink-2" title={duration > 0 ? undefined : 'No event durations recorded'}>{duration > 0 ? formatMs(duration) : '—'}</span>
                <InfoTip text={DURATION_INFO} />
              </p>
            </div>

            <button
              type="button"
              class="flex w-full items-center gap-1.5 border-t border-line-soft px-4 py-2.5 text-left text-xs transition-colors hover:bg-hover {isOpen ? '' : 'rounded-b-card'}"
              aria-expanded={isOpen}
              aria-controls="agent-detail-{i}"
              onclick={() => (open[a.agentId] = !open[a.agentId])}
            >
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} class="text-ink-3" />
              <span class="font-medium text-ink-2">Breakdown</span>
              <span class="ml-auto truncate text-ink-3">
                {plural(a.hosts.length, 'host', 'hosts')} · {plural(a.capabilities.length, 'capability', 'capabilities')} · {plural(a.models.length, 'model', 'models')}
              </span>
            </button>

            {#if isOpen}
              <div id="agent-detail-{i}" class="space-y-5 rounded-b-card border-t border-line-soft bg-inset px-4 py-4">
                {#if a.hosts.length}
                  <section>
                    <h4 class="mb-2 text-xs font-medium text-ink-2">Hosts</h4>
                    {#if a.hosts.length > 1}
                      <div class="mb-2 flex h-1.5 gap-px overflow-hidden rounded-full bg-hover-2" aria-hidden="true">
                        {#each a.hosts as h, j (h.host)}
                          <span class="h-full" style="width:{hostEvents ? (h.events / hostEvents) * 100 : 0}%;background:{hostColor(j)}"></span>
                        {/each}
                      </div>
                    {/if}
                    <table class="w-full table-fixed text-[13px]">
                      <caption class="sr-only">Sessions and events per host for {name}</caption>
                      <thead>
                        <tr class="text-[11px] text-ink-3">
                          <th scope="col" class="pb-1 text-left font-medium">Host</th>
                          <th scope="col" class="w-20 pb-1 text-right font-medium">Sessions</th>
                          <th scope="col" class="w-24 pb-1 text-right font-medium">Events</th>
                          <th scope="col" class="w-14 pb-1 text-right font-medium" title="Share of this agent's events">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each a.hosts as h, j (h.host)}
                          <tr class="border-t border-line-soft">
                            <td class="py-1.5 pr-3">
                              <span class="flex min-w-0 items-center gap-2">
                                {#if a.hosts.length > 1}
                                  <span class="h-2 w-2 shrink-0 rounded-[3px]" style="background:{hostColor(j)}" aria-hidden="true"></span>
                                {/if}
                                <span class="truncate text-ink" title={h.host}>{h.host}</span>
                              </span>
                            </td>
                            <td class="nums py-1.5 text-right text-ink-2">{formatInt(h.sessions)}</td>
                            <td class="nums py-1.5 text-right text-ink-2">{formatInt(h.events)}</td>
                            <td class="nums py-1.5 text-right text-ink-3">{share(h.events, hostEvents)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </section>
                {/if}

                {#if a.capabilities.length}
                  <section>
                    <h4 class="mb-2 text-xs font-medium text-ink-2">Capabilities</h4>
                    <ul class="flex flex-wrap gap-1.5">
                      {#each a.capabilities as c (c.type)}
                        <li class="min-w-0">
                          <Chip title={capTitle(c)}>
                            <span class="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style="background:{eventKind(c.type).color}" aria-hidden="true"></span>{c.type}
                            <span class="nums text-ink-3">{formatInt(c.events)}</span>
                            {#if c.errors}<span class="nums text-red">· {plural(c.errors, 'error', 'errors')}</span>{/if}
                          </Chip>
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/if}

                {#if a.models.length}
                  <section>
                    <h4 class="mb-2 text-xs font-medium text-ink-2">Models</h4>
                    <table class="w-full table-fixed text-[13px]">
                      <caption class="sr-only">Tokens and estimated cost per model for {name}</caption>
                      <thead>
                        <tr class="text-[11px] text-ink-3">
                          <th scope="col" class="pb-1 text-left font-medium">Model</th>
                          <th scope="col" class="w-20 pb-1 text-right font-medium">Tokens</th>
                          <th scope="col" class="w-24 pb-1 text-right font-medium">Est. cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each a.models as m (m.model)}
                          <tr class="border-t border-line-soft">
                            <td class="nums truncate py-1.5 pr-3 text-ink" title={m.model}>{m.model}</td>
                            <td class="nums py-1.5 text-right text-ink-2" title="{formatInt(m.tokensTotal)} tokens">{formatCompact(m.tokensTotal)}</td>
                            <td class="py-1.5 text-right"><CostFigure value={m.costApiEquiv} basis="est" showLabel={false} /></td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </section>
                {/if}

                <a href="#/sessions" class="inline-flex text-[13px] font-medium text-accent-ink hover:underline">View sessions →</a>
              </div>
            {/if}
          </Surface>
        {:else}
          <section class="min-w-0 rounded-card bg-inset px-4 py-3.5 ring-1 ring-line">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="truncate text-[13px] font-semibold text-ink-2">{name}</h3>
                {#if a.displayName && a.displayName !== a.agentId}<p class="nums mt-0.5 truncate text-xs text-ink-3">{a.agentId}</p>{/if}
              </div>
              <Chip title="Declared billing mode — {mode.note}">{mode.label}</Chip>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip dashed title="Known to AgentLens, but it logged no events in the selected range — shown instead of a row of zeros.">Not recorded in this window</Chip>
              {#if hostFilter.length}<span class="text-xs text-ink-3">Host filter: {hostFilter.join(', ')}</span>{/if}
            </div>
          </section>
        {/if}
      {/each}
    </div>
  {/if}

  {#if hiddenByFilter > 0}
    <p class="mt-3 text-xs text-ink-3">{plural(hiddenByFilter, 'other known agent is', 'other known agents are')} hidden by the agent filter.</p>
  {/if}
{/if}
