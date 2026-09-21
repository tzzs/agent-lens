<script lang="ts" module>
  import type { IconName } from './Icon.svelte'
  export type NavItem = { label: string; path: string; icon: IconName }
  export type NavGroup = { label: string; items: NavItem[] }
</script>

<script lang="ts">
  // Beautiful UI sidebar: brand, grouped nav with icons, and a footer holding the
  // theme switch plus the local-first promise. Below `lg` it becomes an off-canvas
  // drawer that the header's menu button opens (bind:open).
  import Icon from './Icon.svelte'
  import Segmented from './Segmented.svelte'
  import { theme, setTheme } from '../../lib/theme.svelte.js'

  let {
    groups,
    isActive,
    open = $bindable(false),
  }: { groups: NavGroup[]; isActive: (path: string) => boolean; open?: boolean } = $props()

  let themeValue = $state(theme.pref)
  $effect(() => {
    if (themeValue !== theme.pref) setTheme(themeValue as 'system' | 'light' | 'dark')
  })
</script>

{#if open}
  <button
    type="button"
    class="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] lg:hidden"
    aria-label="Close navigation"
    onclick={() => (open = false)}
  ></button>
{/if}

<aside
  class="fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-canvas transition-transform duration-200
    lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 {open ? 'translate-x-0 shadow-overlay' : '-translate-x-full'}"
  aria-label="Primary"
>
  <div class="flex items-center gap-2.5 px-5 pb-4 pt-5">
    <div class="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-white shadow-btn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />
      </svg>
    </div>
    <div class="min-w-0">
      <div class="text-sm font-semibold tracking-tight text-ink">AgentLens</div>
      <div class="text-xs text-ink-3">Agent activity center</div>
    </div>
    <button type="button" class="ml-auto grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-hover-2 lg:hidden" onclick={() => (open = false)} aria-label="Close navigation">
      <Icon name="x" size={15} />
    </button>
  </div>

  <nav class="flex-1 overflow-y-auto px-3 pb-3">
    {#each groups as g (g.label)}
      <div class="mt-3 first:mt-0">
        {#if g.label}<div class="px-2 pb-1 text-[11px] font-medium text-ink-3">{g.label}</div>{/if}
        <ul class="space-y-px">
          {#each g.items as n (n.path)}
            {@const active = isActive(n.path)}
            <li>
              <a
                href={'#' + n.path}
                aria-current={active ? 'page' : undefined}
                onclick={() => (open = false)}
                class="flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors
                  {active ? 'bg-surface font-medium text-ink shadow-card' : 'text-ink-2 hover:bg-hover-2/70 hover:text-ink'}"
              >
                <Icon name={n.icon} size={16} class={active ? 'text-accent' : 'text-ink-3'} />
                {n.label}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </nav>

  <div class="space-y-3 border-t border-line px-5 py-4">
    <div class="flex items-center justify-between">
      <span class="text-xs text-ink-3">Theme</span>
      <Segmented
        label="Color theme"
        iconOnly
        bind:value={themeValue}
        options={[
          { value: 'system', label: 'System', icon: 'monitor' },
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
        ]}
      />
    </div>
    <p class="text-[11px] leading-snug text-ink-3">Loopback only · no telemetry · nothing leaves this machine</p>
  </div>
</aside>
