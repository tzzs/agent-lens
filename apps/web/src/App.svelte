<script lang="ts">
  import { onMount } from 'svelte'
  import { route, initRouter } from './lib/router.svelte.js'
  import { live, options } from './lib/live.svelte.js'
  import { range, filterParams } from './lib/filter.svelte.js'
  import { loader } from './lib/pagestate.svelte.js'
  import { initTheme } from './lib/theme.svelte.js'
  import { code, initLang, t } from './lib/lang.js'
  import { coverageText, hostSplitText } from './lib/banners.ts'
  import { api } from './lib/api.ts'
  import { formatCompact, relativeTime } from './lib/format.ts'

  import SidebarNav, { type NavGroup } from './components/ui/SidebarNav.svelte'
  import Icon from './components/ui/Icon.svelte'
  import Alert from './components/ui/Alert.svelte'
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

  // Grouped per plan-v2 §10's nav: overview, the entities, the analysis axes, system.
  // Derived, not const: the labels are the viewer's language.
  const NAV = $derived<NavGroup[]>([
    { label: '', items: [{ label: $t('shell.navOverview'), path: '/', icon: 'overview' }] },
    {
      label: $t('shell.navExplore'),
      items: [
        { label: $t('shell.navSessions'), path: '/sessions', icon: 'sessions' },
        { label: $t('shell.navProjects'), path: '/projects', icon: 'projects' },
        { label: $t('shell.navAgents'), path: '/agents', icon: 'agents' },
      ],
    },
    {
      label: $t('shell.navAnalyze'),
      items: [
        { label: $t('shell.navCapabilities'), path: '/capabilities', icon: 'capabilities' },
        { label: $t('shell.navUsage'), path: '/usage', icon: 'usage' },
        { label: $t('shell.navModels'), path: '/models', icon: 'models' },
      ],
    },
    {
      label: $t('shell.navSystem'),
      items: [
        { label: $t('shell.navDoctor'), path: '/doctor', icon: 'doctor' },
        { label: $t('shell.navSettings'), path: '/settings', icon: 'settings' },
      ],
    },
  ])

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
  let navOpen = $state(false)

  let es: EventSource | null = null
  onMount(() => {
    const stop = initRouter()
    const stopTheme = initTheme()
    const stopLang = initLang()

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
      stopTheme()
      stopLang()
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

  const banners = $derived(ov.state.data?.banners ?? null)
  const hostSplitLine = $derived(banners?.hostSplit ? hostSplitText(banners.hostSplit) : '')
  const coverageLine = $derived(banners ? coverageText(banners.coverage) : '')
</script>

<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-overlay">{$t('shell.skipToContent')}</a>

<div class="flex min-h-screen bg-page">
  <SidebarNav groups={NAV} isActive={navActive} bind:open={navOpen} />

  <div class="flex min-w-0 flex-1 flex-col">
    <header class="sticky top-0 z-20 border-b border-line bg-page/85 backdrop-blur-md">
      <div class="flex h-14 items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-hover-2 lg:hidden"
          onclick={() => (navOpen = true)}
          aria-label={$t('shell.openNav')}
        >
          <Icon name="menu" size={18} />
        </button>
        <div class="no-scrollbar -my-2 min-w-0 flex-1 overflow-x-auto py-2">
          <RangeControls />
        </div>
        <span
          class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium {live.connected
            ? 'bg-green-tint text-green'
            : 'bg-hover-2/70 text-ink-3'}"
          title={live.connected
            ? $t('shell.liveTitle', { values: { events: formatCompact(live.events), ago: live.maxTimestamp ? relativeTime(live.maxTimestamp, Date.now()) : $t('common.dash') } })
            : $t('shell.offlineTitle')}
        >
          <span class="relative flex h-1.5 w-1.5">
            {#if live.connected}<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green opacity-60"></span>{/if}
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full {live.connected ? 'bg-green' : 'bg-ink-3'}"></span>
          </span>
          {live.connected ? $t('shell.live') : $t('shell.offline')}
        </span>
      </div>
    </header>

    <main id="main" class="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
      {#if banners && (hostSplitLine || coverageLine)}
        <div class="mb-5 space-y-2">
          {#if banners.hostSplit}
            <Alert tone="orange" title={$t('banner.hostSplitTitle')} id="host-split">{hostSplitLine}</Alert>
          {/if}
          {#if coverageLine}
            <Alert tone="red" title={$t('banner.coverageTitle')} id="coverage">{coverageLine}</Alert>
          {/if}
        </div>
      {/if}

      <!-- A language change remounts the page. The pure display helpers
           (format.ts, eventKinds.ts, banners.ts) read the catalog's active locale
           instead of subscribing to a store, so re-rendering is what turns an
           already-drawn "55h 52m" into "55 时 52 分". -->
      {#key $code}
      {#if page === ''}
        <Overview {ov} />
      {:else if page === 'agents'}
        <Agents />
      {:else if page === 'projects'}
        <Projects />
      {:else if page === 'sessions'}
        {#if parts[1]}
          {#key parts[1]}<SessionDetail id={decodeURIComponent(parts[1])} />{/key}
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
        <div class="rounded-card bg-surface p-6 text-sm text-ink-2 shadow-card">
          {$t('shell.unknownPageStart')} <span class="nums text-ink">/{page}</span>{$t('shell.unknownPageEnd')}
        </div>
      {/if}
      {/key}
    </main>
  </div>
</div>
