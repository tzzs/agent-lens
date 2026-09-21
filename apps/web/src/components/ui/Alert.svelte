<script lang="ts">
  // Inline banner for the §14 header warnings and page-level notes. Dismissal is
  // per browser session (sessionStorage), so a warning comes back next visit.
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  let {
    tone = 'orange',
    title = '',
    id = '',
    children,
  }: { tone?: 'orange' | 'red' | 'accent' | 'neutral'; title?: string; id?: string; children: Snippet } = $props()

  function wasDismissed(k: string) {
    if (!k) return false
    try {
      return sessionStorage.getItem('agl-dismiss:' + k) === '1'
    } catch {
      return false
    }
  }
  let dismissed = $state(false)
  const hidden = $derived(dismissed || wasDismissed(id))
  function dismiss() {
    dismissed = true
    try {
      sessionStorage.setItem('agl-dismiss:' + id, '1')
    } catch {
      /* dismissal just won't persist */
    }
  }
  const tones = {
    orange: 'bg-orange-tint text-orange',
    red: 'bg-red-tint text-red',
    accent: 'bg-accent-tint text-accent-ink',
    neutral: 'bg-hover-2/60 text-ink-2',
  }
</script>

{#if !hidden}
  <div class="flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] {tones[tone]}" role={tone === 'red' ? 'alert' : 'status'}>
    <Icon name={tone === 'accent' || tone === 'neutral' ? 'info' : 'alert'} size={15} class="mt-0.5" />
    <div class="min-w-0 flex-1 leading-snug">
      {#if title}<span class="font-semibold">{title}</span>{' '}{/if}<span class="text-ink-2">{@render children()}</span>
    </div>
    {#if id}
      <button type="button" class="-m-1 grid h-6 w-6 shrink-0 place-items-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100" onclick={dismiss} aria-label="Dismiss">
        <Icon name="x" size={13} />
      </button>
    {/if}
  </div>
{/if}
