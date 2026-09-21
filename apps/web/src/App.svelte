<script lang="ts">
  import { onMount } from 'svelte'
  import { route, initRouter } from './lib/router.svelte.js'
  import { live, options } from './lib/live.svelte.js'
  import { range, filterParams } from './lib/filter.svelte.js'
  import { loader } from './lib/pagestate.svelte.js'
  import { api } from './lib/api.ts'
  import { formatCompact, relativeTime } from './lib/format.ts'

  import RangeControls from './components/RangeControls.svelte'
  import Overview from './pages/Overview.svelte'
  import Agents from './pages/Agents.svelte'
  import Projects from './pages/Projects.svelte'
  import Sessions from './pages/Sessions.svelte'
  import SessionDetail from './pages/SessionDetail.svelte'
  import Usage from './pages/Usage.svelte'
  import Capabilities from './pages/Capabilities.svelte'
  import Models from './pages/Models.svelte'
  import Doctor from './pages/Doctor.svelte'
  import Settings from './pages/Settings.svelte'

  const NAV = [
    { label: 'Overview', path: '/' },
    { label: 'Agents', path: '/agents' },
    { label: 'Projects', path: '/projects' },
    { label: 'Sessions', path: '/sessions' },
    { label: 'Usage', path: '/usage' },
    { label: 'Capabilities', path: '/capabilities' },
    { label: 'Models', path: '/models' },
    { label: 'Doctor', path: '/doctor' },
    { label: 'Settings', path: '/settings' },
  ]

  // The overview feed also drives the two §14 header banners, so App owns it and
  // hands the same loader to the Overview page (one fetch, not two).
  const ov = loader(() => api.overview(filterParams()))

  // Filter options for the header selects: populated from the agent directory,
  // hosts folded from each agent's host breakdown.
  // Single-flight like `loader`: a tick mid-request is dropped, not queued.
  let optionsInFlight = false
  async function refreshOptions() {
    if (optionsInFlight) return
    optionsInFlight = true
    try {
      const a = await api.agents()
      options.agents = a.rows.map((r) => ({ agentId: r.agentId, displayName: r.displayName }))
      const hosts = new Set<string>()
      for (const r of a.rows) for (const h of r.hosts) hosts.add(h.host)
      options.hosts = [...hosts].sort()
    } catch {
      /* options are best-effort; a failure just shrinks the filter dropdowns */
    } finally {
      optionsInFlight = false
    }
  }

  const parts = $derived(route.path.split('/').filter(Boolean))
  const page = $derived(parts[0] ?? '')
  const navActive = (p: string) => (p === '/' ? parts.length === 0 : '/' + parts[0] === p)

  let es: EventSource | null = null
  onMount(() => {
    const stop = initRouter()

    // SSE drives the live indicator + tells every page to refetch. Relative URL:
    // same-origin only, per the local-first rule.
    try {
      es = new EventSource('/api/events')
      es.addEventListener('open', () => (live.connected = true))
      es.addEventListener('hello', (e: MessageEvent) => {
        try {
          const t = JSON.parse(e.data)
          live.connected = true
          live.events = t.events ?? 0
          live.maxTimestamp = t.maxTimestamp ?? null
          live.serverTime = t.serverTime ?? null
        } catch { /* keep indicator as-is */ }
      })
      es.addEventListener('change', (e: MessageEvent) => {
        try {
          const t = JSON.parse(e.data)
          live.events = t.events ?? live.events
          live.maxTimestamp = t.maxTimestamp ?? live.maxTimestamp
          live.lastTick = t.emittedAt ?? Date.now()
        } catch { /* ignore malformed frame */ }
      })
      es.onerror = () => {
        live.connected = false
      }
    } catch {
      live.connected = false
    }

    return () => {
      stop?.()
      es?.close()
    }
  })

  // Refetch the shared overview feed whenever the filter or the live stream moves.
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    ov.run()
  })

  // Filter options only change when new data lands, not when the user re-filters.
  $effect(() => {
    void live.lastTick
    refreshOptions()
  })
</script>

<div class="flex min-h-screen">
  <aside class="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-ink-900/80">
    <div class="flex items-center gap-2 px-5 py-5">
      <div class="h-7 w-7 rounded-md bg-signal/20 ring-1 ring-signal/50 grid place-items-center">
        <div class="h-2.5 w-2.5 rounded-full bg-signal"></div>
      </div>
      <div>
        <div class="text-sm font-semibold tracking-tight">AgentLens</div>
        <div class="text-[10px] text-mist-500">activity center</div>
      </div>
    </div>
    <nav class="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
      {#each NAV as n (n.path)}
        <a
          href={'#' + n.path}
          class="block rounded-md px-3 py-1.5 text-sm transition-colors {navActive(n.path)
            ? 'bg-ink-800 text-mist-100 font-medium'
            : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100'}"
        >
          {n.label}
        </a>
      {/each}
    </nav>
    <div class="border-t border-line px-5 py-3 text-[10px] text-mist-500">
      loopback only · no telemetry
    </div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <header class="sticky top-0 z-10 border-b border-line bg-ink-950/85 backdrop-blur">
      <div class="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
        <RangeControls />
        <div class="flex items-center gap-2 text-[11px]">
          <span
            class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 {live.connected
              ? 'border-ok/40 text-ok'
              : 'border-line text-mist-500'}"
            title={live.connected
              ? `SSE connected · ${formatCompact(live.events)} events · last ${live.maxTimestamp ? relativeTime(live.maxTimestamp, Date.now()) : '—'}`
              : 'SSE stream not connected'}
          >
            <span class="h-1.5 w-1.5 rounded-full {live.connected ? 'animate-pulse bg-ok' : 'bg-mist-500'}"></span>
            {live.connected ? 'live' : 'offline'}
          </span>
        </div>
      </div>

      {#if ov.state.status === 'ready' && ov.state.data}
        {@const b = ov.state.data.banners}
        {#if b.hostSplit}
          <div class="border-t border-warn/25 bg-warn/5 px-6 py-1.5 text-xs text-warn">
            <span class="font-semibold">host split.</span> {b.hostSplit.message}
          </div>
        {/if}
        {#if b.coverage.banner}
          <div class="border-t border-danger/25 bg-danger/5 px-6 py-1.5 text-xs text-danger">
            <span class="font-semibold">history.</span> {b.coverage.banner}
          </div>
        {/if}
      {/if}
    </header>

    <main class="min-w-0 flex-1 px-6 py-6">
      {#if page === ''}
        <Overview {ov} />
      {:else if page === 'agents'}
        <Agents />
      {:else if page === 'projects'}
        <Projects />
      {:else if page === 'sessions'}
        {#if parts[1]}
          <SessionDetail id={decodeURIComponent(parts[1])} />
        {:else}
          <Sessions />
        {/if}
      {:else if page === 'usage'}
        <Usage />
      {:else if page === 'capabilities'}
        <Capabilities />
      {:else if page === 'models'}
        <Models />
      {:else if page === 'doctor'}
        <Doctor />
      {:else if page === 'settings'}
        <Settings />
      {:else}
        <div class="rounded-md border border-line bg-ink-900 p-6 text-sm text-mist-400">
          Unknown page <span class="nums text-mist-100">/{page}</span>. Pick one from the left.
        </div>
      {/if}
    </main>
  </div>
</div>
