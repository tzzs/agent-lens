<script lang="ts">
  // GET /api/sessions/:id — the waterfall. Builds the parent_event_id forest and
  // renders it via the recursive TimelineNode; the whole point of the product
  // (§10 priority 2). Degrades honestly to a metrics-only timeline when the
  // content layer is absent, and surfaces 404 / 409 (ambiguous prefix) verbatim.
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs, formatDateTime } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'
  import TimelineNode from '../components/TimelineNode.svelte'

  let { id }: { id: string } = $props()

  const { state, run } = loader(() => api.session(id))
  $effect(() => {
    void id
    void live.lastTick
    run()
  })

  const d = $derived(state.status === 'ready' ? state.data : null)

  // parent_event_id forest. Nodes whose parent is absent (or NULL) are roots; the
  // server returns them in raw_seq order so a root's subtree reads like the log.
  const structure = $derived.by(() => {
    if (!d) return { roots: [], childrenMap: new Map() }
    const byId = new Set(d.nodes.map((n: any) => n.id))
    const childrenMap = new Map<string, any[]>()
    const roots: any[] = []
    for (const n of d.nodes) {
      if (n.parentEventId && byId.has(n.parentEventId)) {
        const arr = childrenMap.get(n.parentEventId) ?? []
        arr.push(n)
        childrenMap.set(n.parentEventId, arr)
      } else {
        roots.push(n)
      }
    }
    return { roots, childrenMap }
  })

  const orphanCount = $derived(d ? state.data.nodes.filter((n: any) => n.parentEventId && !new Set(state.data.nodes.map((x: any) => x.id)).has(n.parentEventId)).length : 0)
</script>

{#if state.status === 'error'}
  <div class="mb-4">
    <a href="#/sessions" class="text-xs text-signal hover:underline">← back to sessions</a>
  </div>
  <Card title="Session unavailable">
    <p class="text-sm text-mist-300">{state.error}</p>
    {#if state.kind === 'conflict' && state.details?.matches}
      <p class="mt-2 text-xs text-mist-500">The id prefix matched more than one session — pick one:</p>
      <ul class="nums mt-2 space-y-1 text-sm">
        {#each state.details.matches as m (m)}
          <li><a class="text-signal hover:underline" href="#/sessions/{encodeURIComponent(m)}">{m}</a></li>
        {/each}
      </ul>
    {:else if state.kind === 'not_found'}
      <p class="mt-2 text-xs text-mist-500">No session id (or prefix) <span class="nums">{id}</span> exists in this database.</p>
    {/if}
  </Card>
{:else if state.status !== 'ready'}
  <StatePanel status={state.status} error={state.error} kind={state.kind} />
{:else if d}
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <a href="#/sessions" class="text-[11px] text-mist-500 hover:text-signal">← sessions</a>
      <h1 class="truncate text-lg font-semibold">{d.session.title || d.session.id}</h1>
      <p class="nums text-xs text-mist-500">
        {d.session.agentId} · {d.session.hostId} · {d.session.project ?? '(no project)'} · {formatInt(d.session.eventCount)} events
      </p>
    </div>
    <div class="flex items-center gap-5 text-xs">
      <div><div class="text-[10px] uppercase text-mist-500">tokens</div><div class="nums text-base">{formatCompact(Number(d.totals.tokens_total ?? 0))}</div></div>
      <div><div class="text-[10px] uppercase text-mist-500">est. cost</div><CostFigure value={d.totals.cost_api_equiv ?? null} basis="est" /></div>
      <div><div class="text-[10px] uppercase text-mist-500">duration</div><div class="nums text-base">{formatMs(Number(d.totals.duration ?? 0))}</div></div>
    </div>
  </div>

  {#if !d.contentAvailable}
    <div class="mb-3 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
      <span class="font-semibold">metrics-only timeline.</span> {d.contentNote}
    </div>
  {/if}

  <Card subtitle={formatDateTime(d.session.firstTimestamp)} note={d.contentAvailable ? 'content layer on' : 'metrics layer only'}>
    {#if structure.roots.length === 0}
      <p class="py-6 text-center text-sm text-mist-500">this session has no events.</p>
    {:else}
      {#each structure.roots as node (node.id)}
        <TimelineNode {node} childrenMap={structure.childrenMap} depth={0} contentAvailable={d.contentAvailable} />
      {/each}
    {/if}
  </Card>

  <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mist-500">
    <span class="nums" title="§7 cube explanation of how these totals were derived">{d.explain}</span>
    {#if orphanCount > 0}
      <span title="subagent/nested events whose parent link is absent render as top-level rows (§4.4 allows parent_event_id = NULL)">
        {formatInt(orphanCount)} event(s) had no parent link and are shown at the top level
      </span>
    {/if}
  </div>
{/if}
